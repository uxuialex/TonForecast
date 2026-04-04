import fs from 'fs';
import path from 'path';
import { mnemonicToWalletKey } from '@ton/crypto';
import { Address, Cell, SendMode, beginCell, toNano } from '@ton/core';
import { TonClient, WalletContractV4, WalletContractV5R1, internal } from '@ton/ton';
import {
    DIRECTION_ABOVE,
    DIRECTION_BELOW,
    OP_RESOLVE_MARKET,
    OUTCOME_DRAW,
    OUTCOME_NO,
    OUTCOME_YES,
    STATUS_LOCKED,
    STATUS_OPEN,
    type MarketState,
    formatPrice6,
    outcomeToText,
    statusToText,
    TonForecastMarket,
} from '../wrappers/TonForecastMarket';
import { fetchDefaultAssetQuote } from './lib/ston';

const DEFAULT_MAINNET_ENDPOINT = 'https://toncenter.com/api/v2/jsonRPC';
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_SEND_VALUE = toNano('0.05');
const DEFAULT_RESOLVER_WALLET_VERSION = 'v5r1';
const DEFAULT_MAX_RETRIES = 6;
const AUTO_RESOLVE_BLOCKED_EXIT_CODE = 42;
const BLOCKED_PREFIX = '[resolver-blocked]';
const buildArtifactPath = path.resolve(process.cwd(), 'build/TonForecastMarket.compiled.json');
const buildArtifact = JSON.parse(fs.readFileSync(buildArtifactPath, 'utf8')) as {
    hash?: string;
};
const CURRENT_CONTRACT_CODE_HASH = String(buildArtifact.hash ?? '').trim().toLowerCase();

type OpenedTonForecastMarket = {
    address: Address;
    getMarketState: () => Promise<MarketState>;
};

type OpenedResolverWallet = {
    address: Address;
    getSeqno: () => Promise<number>;
    sendTransfer: (args: any) => Promise<void>;
};

function loadLocalEnv() {
    const candidates = ['.env.local', '.env'];

    for (const candidate of candidates) {
        const filePath = path.resolve(process.cwd(), candidate);
        if (!fs.existsSync(filePath)) {
            continue;
        }

        const source = fs.readFileSync(filePath, 'utf8');
        for (const rawLine of source.split(/\r?\n/)) {
            const line = rawLine.trim();
            if (!line || line.startsWith('#')) {
                continue;
            }

            const separatorIndex = line.indexOf('=');
            if (separatorIndex <= 0) {
                continue;
            }

            const key = line.slice(0, separatorIndex).trim();
            if (!key || process.env[key] !== undefined) {
                continue;
            }

            let value = line.slice(separatorIndex + 1).trim();
            if (
                (value.startsWith('"') && value.endsWith('"')) ||
                (value.startsWith("'") && value.endsWith("'"))
            ) {
                value = value.slice(1, -1);
            }

            process.env[key] = value;
        }
    }
}

function getRequiredEnv(name: string): string {
    const value = process.env[name]?.trim();
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}

function getEndpoint(): string {
    return process.env.TON_API_ENDPOINT?.trim() || DEFAULT_MAINNET_ENDPOINT;
}

function getApiKey(): string | undefined {
    return process.env.TON_API_KEY?.trim() || process.env.TONCENTER_API_KEY?.trim() || undefined;
}

function getPollIntervalMs(): number {
    const raw = process.env.RESOLVER_POLL_INTERVAL_MS?.trim();
    if (!raw) {
        return DEFAULT_POLL_INTERVAL_MS;
    }

    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`Invalid RESOLVER_POLL_INTERVAL_MS: ${raw}`);
    }
    return parsed;
}

function getResolverWalletVersion(): 'v4' | 'v5r1' {
    const raw = process.env.RESOLVER_WALLET_VERSION?.trim().toLowerCase();
    if (!raw) {
        return DEFAULT_RESOLVER_WALLET_VERSION as 'v5r1';
    }

    if (raw === 'v4' || raw === 'v5r1') {
        return raw;
    }

    throw new Error(`Invalid RESOLVER_WALLET_VERSION: ${raw}`);
}

function getMarketAddress(): Address {
    const input = process.argv[2]?.trim() || process.env.MARKET_ADDRESS?.trim();
    if (!input) {
        throw new Error('Provide market address as argv[2] or MARKET_ADDRESS env');
    }
    return Address.parse(input);
}

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitError(error: unknown) {
    if (!error || typeof error !== 'object') {
        return false;
    }

    const candidate = error as {
        response?: { status?: number };
        status?: number;
        message?: string;
    };

    return candidate.response?.status === 429 ||
        candidate.status === 429 ||
        candidate.message?.includes('429') === true;
}

async function withRateLimitRetry<T>(label: string, task: () => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < DEFAULT_MAX_RETRIES; attempt += 1) {
        try {
            return await task();
        } catch (error) {
            if (!isRateLimitError(error) || attempt === DEFAULT_MAX_RETRIES - 1) {
                throw error;
            }

            const delayMs = Math.min(30_000, 1_500 * (attempt + 1));
            console.log(`[resolver] ${label} hit RPC rate limit, retry in ${delayMs}ms`);
            await sleep(delayMs);
        }
    }

    throw new Error(`[resolver] ${label} exceeded retry budget`);
}

async function fetchAutomaticFinalPrice(contract: OpenedTonForecastMarket) {
    const state = await withRateLimitRetry('get_market_state', () => contract.getMarketState());

    if (state.assetIdText) {
        const quote = await fetchDefaultAssetQuote(state.assetIdText);
        return {
            finalPrice: quote.priceUsd,
            priceSource: quote.source,
            state,
        };
    }

    throw new Error('Market asset id is missing');
}

function deriveExpectedOutcome(
    direction: number,
    threshold: bigint,
    finalPrice: bigint,
) {
    if (
        (direction === DIRECTION_ABOVE && finalPrice > threshold) ||
        (direction === DIRECTION_BELOW && finalPrice < threshold)
    ) {
        return OUTCOME_YES;
    }

    if (finalPrice === threshold) {
        return OUTCOME_DRAW;
    }

    return OUTCOME_NO;
}

async function getOnchainContractCodeHash(client: TonClient, address: Address) {
    const state = await withRateLimitRetry('get_contract_state', () => client.getContractState(address));
    if (!state.code) {
        return null;
    }

    const [codeCell] = Cell.fromBoc(state.code);
    return codeCell.hash().toString('hex').toLowerCase();
}

function isLegacyUncontestedMarket(onchainCodeHash: string | null, state: MarketState) {
    if (!onchainCodeHash || !CURRENT_CONTRACT_CODE_HASH || onchainCodeHash === CURRENT_CONTRACT_CODE_HASH) {
        return false;
    }

    return state.yesPool <= 0n || state.noPool <= 0n;
}

async function waitForSeqnoIncrement(wallet: OpenedResolverWallet, currentSeqno: number) {
    for (let attempt = 0; attempt < 30; attempt += 1) {
        await sleep(1_500);
        const nextSeqno = await withRateLimitRetry('get_seqno', () => wallet.getSeqno());
        if (nextSeqno > currentSeqno) {
            return nextSeqno;
        }
    }

    throw new Error('Timed out waiting for resolver wallet seqno increment');
}

async function waitForResolvableState(contract: OpenedTonForecastMarket, pollIntervalMs: number) {
    for (;;) {
        const state = await withRateLimitRetry('get_market_state', () => contract.getMarketState());
        const now = BigInt(Math.floor(Date.now() / 1000));

        if (state.status !== STATUS_OPEN && state.status !== STATUS_LOCKED) {
            console.log(`Skip: market already finalized with status ${statusToText(state.status)}`);
            return null;
        }

        if (state.resolveTime <= now) {
            return state;
        }

        const secondsLeft = Number(state.resolveTime - now);
        console.log(
            `[resolver] waiting ${secondsLeft}s until resolve_time for ${contract.address.toString()}`,
        );
        await sleep(Math.min(pollIntervalMs, Math.max(secondsLeft * 1000, 1_000)));
    }
}

async function main() {
    loadLocalEnv();

    const marketAddress = getMarketAddress();
    const endpoint = getEndpoint();
    const pollIntervalMs = getPollIntervalMs();
    const walletVersion = getResolverWalletVersion();
    const mnemonic = getRequiredEnv('RESOLVER_MNEMONIC')
        .split(/\s+/)
        .filter(Boolean);

    const keyPair = await mnemonicToWalletKey(mnemonic);
    const apiKey = getApiKey();
    const client = new TonClient({ endpoint, apiKey });
    const walletContract = walletVersion === 'v4'
        ? WalletContractV4.create({
            workchain: 0,
            publicKey: keyPair.publicKey,
        })
        : WalletContractV5R1.create({
            workchain: 0,
            publicKey: keyPair.publicKey,
        });
    const wallet: OpenedResolverWallet = client.open(
        walletContract,
    );
    const contract: OpenedTonForecastMarket = client.open(
        TonForecastMarket.createFromAddress(marketAddress),
    );

    console.log(`[resolver] endpoint=${endpoint}`);
    console.log(`[resolver] api_key=${apiKey ? 'configured' : 'not set'}`);
    console.log(`[resolver] wallet_version=${walletVersion}`);
    console.log(`[resolver] wallet=${wallet.address.toString()}`);
    console.log(`[resolver] market=${contract.address.toString()}`);

    const dueState = await waitForResolvableState(contract, pollIntervalMs);
    if (!dueState) {
        return;
    }

    const onchainCodeHash = await getOnchainContractCodeHash(client, contract.address);
    if (isLegacyUncontestedMarket(onchainCodeHash, dueState)) {
        console.error(
            `${BLOCKED_PREFIX} legacy uncontested market cannot resolve on current bytecode (codeHash=${onchainCodeHash})`,
        );
        process.exit(AUTO_RESOLVE_BLOCKED_EXIT_CODE);
    }

    const { finalPrice, priceSource, state } = await fetchAutomaticFinalPrice(contract);
    const expectedOutcome = deriveExpectedOutcome(
        state.direction,
        state.threshold,
        finalPrice,
    );

    console.log(`[resolver] current status=${statusToText(state.status)}`);
    console.log(`[resolver] threshold=$${formatPrice6(state.threshold)}`);
    console.log(`[resolver] final price=$${formatPrice6(finalPrice)}`);
    console.log(`[resolver] price source=${priceSource}`);
    console.log(`[resolver] expected outcome=${outcomeToText(expectedOutcome)}`);

    const body = beginCell()
        .storeUint(OP_RESOLVE_MARKET, 32)
        .storeUint(finalPrice, 128)
        .endCell();

    const seqno = await withRateLimitRetry('get_seqno', () => wallet.getSeqno());
    await withRateLimitRetry('send_resolve_transfer', () => wallet.sendTransfer({
        seqno,
        secretKey: keyPair.secretKey,
        sendMode: SendMode.PAY_GAS_SEPARATELY,
        messages: [
            internal({
                to: contract.address,
                value: DEFAULT_SEND_VALUE,
                bounce: true,
                body,
            }),
        ],
    }));

    await waitForSeqnoIncrement(wallet, seqno);
    await sleep(3_000);

    const nextState = await withRateLimitRetry('get_market_state', () => contract.getMarketState());
    console.log(`[resolver] resolved status=${statusToText(nextState.status)}`);
    console.log(`[resolver] resolved outcome=${outcomeToText(nextState.resolvedOutcome)}`);
    console.log(`[resolver] stored final price=$${formatPrice6(nextState.finalPrice)}`);
}

main().catch((error) => {
    console.error(`[resolver] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
});
