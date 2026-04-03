import { Address } from '@ton/core';
import fs from 'fs';
import path from 'path';
import { formatPrice6, toPrice6 } from '../../wrappers/TonForecastMarket';

const STON_API_BASE = 'https://api.ston.fi';
const CMC_API_BASE = 'https://pro-api.coinmarketcap.com';
const CMC_SLUG_BY_ASSET: Record<string, string> = {
    TON: 'toncoin',
};

type StonAsset = {
    contract_address: string;
    symbol: string | null;
    display_name?: string | null;
    default_symbol?: boolean;
    dex_price_usd?: string | null;
    dex_usd_price?: string | null;
};

type AssetsResponse = {
    asset_list: StonAsset[];
};

export type StonAssetQuote = {
    symbol: string;
    contractAddress: Address;
    priceUsd: bigint;
    source: string;
};

let envLoaded = false;

function loadLocalEnv() {
    if (envLoaded) {
        return;
    }

    envLoaded = true;

    for (const candidate of ['.env.local', '.env']) {
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

function getCmcApiKey() {
    loadLocalEnv();
    return process.env.CMC_API_KEY?.trim() || undefined;
}

function extractCmcQuote(payload: any, expectedSlug: string) {
    const values = Object.values(payload?.data ?? {});
    const rows = values.flatMap((value) => (Array.isArray(value) ? value : value ? [value] : []));
    return rows.find(
        (item: any) =>
            item &&
            typeof item === 'object' &&
            item.slug === expectedSlug &&
            item.quote?.USD?.price != null,
    ) ?? null;
}

async function fetchCmcAssetQuote(symbol: string): Promise<StonAssetQuote | null> {
    const apiKey = getCmcApiKey();
    const slug = CMC_SLUG_BY_ASSET[symbol];
    if (!apiKey || !slug) {
        return null;
    }

    const response = await fetch(
        `${CMC_API_BASE}/v2/cryptocurrency/quotes/latest?slug=${encodeURIComponent(slug)}&convert=USD`,
        {
            headers: {
                Accept: 'application/json',
                'X-CMC_PRO_API_KEY': apiKey,
            },
        },
    );

    if (!response.ok) {
        throw new Error(`CMC API returned HTTP ${response.status}`);
    }

    const payload = await response.json();
    const match = extractCmcQuote(payload, slug);
    if (!match?.quote?.USD?.price) {
        throw new Error(`No CMC quote found for ${symbol}`);
    }

    return {
        symbol,
        contractAddress: Address.parse('EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c'),
        priceUsd: toPrice6(match.quote.USD.price),
        source: `CMC slug ${slug}`,
    };
}

export async function fetchDefaultAssetQuote(symbol: string): Promise<StonAssetQuote> {
    if (symbol === 'TON') {
        try {
            const cmcQuote = await fetchCmcAssetQuote(symbol);
            if (cmcQuote) {
                return cmcQuote;
            }
        } catch (error) {
            console.warn(`[scripts] CMC TON price failed, fallback to STON: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    const response = await fetch(`${STON_API_BASE}/v1/assets`);
    if (!response.ok) {
        throw new Error(`STON API returned HTTP ${response.status}`);
    }

    const payload = (await response.json()) as AssetsResponse;
    const match = payload.asset_list.find(
        (item) => item.symbol === symbol && item.default_symbol === true && item.dex_price_usd,
    );

    if (!match || !match.dex_price_usd) {
        throw new Error(`No default STON asset quote found for ${symbol}`);
    }

    return {
        symbol,
        contractAddress: Address.parse(match.contract_address),
        priceUsd: toPrice6(match.dex_price_usd),
        source: 'STON default symbol',
    };
}

export async function fetchAssetQuoteByAddress(contractAddress: Address | string): Promise<StonAssetQuote> {
    const target = typeof contractAddress === 'string'
        ? Address.parse(contractAddress)
        : contractAddress;

    const response = await fetch(`${STON_API_BASE}/v1/assets`);
    if (!response.ok) {
        throw new Error(`STON API returned HTTP ${response.status}`);
    }

    const payload = (await response.json()) as AssetsResponse;
    const targetText = target.toString();
    const match = payload.asset_list.find((item) => {
        if (!item.contract_address || !item.dex_price_usd || !item.symbol) {
            return false;
        }

        try {
            return Address.parse(item.contract_address).toString() === targetText;
        } catch {
            return false;
        }
    });

    if (!match || !match.dex_price_usd || !match.symbol) {
        throw new Error(`No STON asset quote found for ${targetText}`);
    }

    return {
        symbol: match.symbol,
        contractAddress: Address.parse(match.contract_address),
        priceUsd: toPrice6(match.dex_price_usd),
        source: 'STON asset address',
    };
}

export function buildSuggestedThreshold(priceUsd: bigint, direction: 'above' | 'below'): bigint {
    if (direction === 'above') {
        return (priceUsd * 101n) / 100n;
    }
    return (priceUsd * 99n) / 100n;
}

export function describeSuggestedThreshold(priceUsd: bigint, threshold: bigint, direction: 'above' | 'below') {
    return [
        `Current price: $${formatPrice6(priceUsd)}`,
        `Suggested threshold for ${direction}: $${formatPrice6(threshold)}`,
    ].join('\n');
}
