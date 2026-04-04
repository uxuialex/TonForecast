import { mnemonicToWalletKey } from "@ton/crypto";
import { Address, beginCell, Cell, SendMode, toNano } from "@ton/core";
import { WalletContractV4, WalletContractV5R1, internal } from "@ton/ton";
import {
  ensureRuntimeEnvLoaded,
  getPreferredTonClient,
  getResolverWalletVersion,
  withTonClientFailover,
} from "./runtimeEnv.js";
import { appendAdminAuditEntry, saveMarketRecord } from "./marketRegistry.js";
import { evaluateResolutionQuotes, formatResolutionQuotes } from "./marketResolvePolicy.js";
import { getResolutionQuoteCandidates } from "./stonApi.js";
import { incrementMetric } from "./runtimeMetrics.js";
import {
  STATUS_LOCKED,
  STATUS_OPEN,
  TON_FORECAST_MARKET_CODE_HASH,
  formatPrice6,
  openMarketContract,
  parseAddress,
} from "./tonForecastMarket.js";

const OP_RESOLVE_MARKET = 0x9dfc7b54;
const DEFAULT_SEND_VALUE = toNano("0.05");
const DEFAULT_RESOLVER_WALLET_VERSION = "v5r1";
const DEFAULT_MAX_RETRIES = 6;
const AUTO_RESOLVE_BLOCKED_EXIT_CODE = 42;
const BLOCKED_PREFIX = "[resolver-blocked]";

let resolverWalletMaterialPromise = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRequiredEnv(name) {
  ensureRuntimeEnvLoaded();
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function isRateLimitError(error) {
  if (!error || typeof error !== "object") {
    return false;
  }

  const candidate = error;
  return candidate.response?.status === 429 ||
    candidate.status === 429 ||
    candidate.message?.includes("429") === true;
}

async function withRateLimitRetry(label, task) {
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

async function getResolverWalletMaterial() {
  if (!resolverWalletMaterialPromise) {
    resolverWalletMaterialPromise = (async () => {
      const mnemonic = getRequiredEnv("RESOLVER_MNEMONIC")
        .split(/\s+/)
        .filter(Boolean);
      const keyPair = await mnemonicToWalletKey(mnemonic);
      const walletVersion = getResolverWalletVersion?.() ?? DEFAULT_RESOLVER_WALLET_VERSION;
      const walletContract = walletVersion === "v4"
        ? WalletContractV4.create({
            workchain: 0,
            publicKey: keyPair.publicKey,
          })
        : WalletContractV5R1.create({
            workchain: 0,
            publicKey: keyPair.publicKey,
          });

      return {
        keyPair,
        walletVersion,
        walletContract,
      };
    })();
  }

  return resolverWalletMaterialPromise;
}

async function getResolverRuntime() {
  const material = await getResolverWalletMaterial();
  const preferredProvider = getPreferredTonClient();
  return {
    ...material,
    client: preferredProvider.client,
    providerId: preferredProvider.id,
    wallet: preferredProvider.client.open(material.walletContract),
  };
}

async function waitForSeqnoIncrement(wallet, currentSeqno) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await sleep(1_500);
    const nextSeqno = await withRateLimitRetry("get_seqno", () => wallet.getSeqno());
    if (nextSeqno > currentSeqno) {
      return nextSeqno;
    }
  }

  throw new Error("Timed out waiting for resolver wallet seqno increment");
}

async function getOnchainContractCodeHash(client, address) {
  const state = await withRateLimitRetry("get_contract_state", () => client.getContractState(address));
  if (!state.code) {
    return null;
  }

  const [codeCell] = Cell.fromBoc(state.code);
  return codeCell.hash().toString("hex").toLowerCase();
}

function isLegacyUncontestedMarket(onchainCodeHash, state) {
  if (
    !onchainCodeHash ||
    !TON_FORECAST_MARKET_CODE_HASH ||
    onchainCodeHash === String(TON_FORECAST_MARKET_CODE_HASH).trim().toLowerCase()
  ) {
    return false;
  }

  return state.yesPool <= 0n || state.noPool <= 0n;
}

export { AUTO_RESOLVE_BLOCKED_EXIT_CODE, BLOCKED_PREFIX };

export async function runAutoResolveJob(marketAddress) {
  ensureRuntimeEnvLoaded();

  const normalizedAddress = parseAddress(marketAddress).toString();
  const contract = openMarketContract(normalizedAddress);
  const { keyPair, wallet, providerId } = await getResolverRuntime();

  const state = await withRateLimitRetry("get_market_state", () => contract.getMarketState());
  const nowSec = Math.floor(Date.now() / 1000);

  if (state.status !== STATUS_OPEN && state.status !== STATUS_LOCKED) {
    return { status: "noop", reason: "Market already finalized" };
  }

  if (Number(state.resolveTime) > nowSec) {
    return {
      status: "retry",
      delayMs: Math.max(1_000, (Number(state.resolveTime) - nowSec) * 1_000 + 1_000),
      reason: "Resolve time not reached yet",
    };
  }

  const onchainCodeHash = await withTonClientFailover("get_contract_state", (client) =>
    getOnchainContractCodeHash(client, Address.parse(normalizedAddress)),
  );
  if (isLegacyUncontestedMarket(onchainCodeHash, state)) {
    incrementMetric("auto_resolver_blocked_total", 1, { reason: "legacy_uncontested" });
    saveMarketRecord({
      contractAddress: normalizedAddress,
      lastResolveDecisionAt: Math.floor(Date.now() / 1000),
      lastResolveDecision: "blocked",
      lastResolveDecisionReason: "legacy_uncontested",
      lastResolveSourceSummary: "",
      lastResolveQuotes: [],
      lastResolveSpreadBps: null,
    });
    appendAdminAuditEntry({
      actor: `resolver:${wallet.address.toString()}`,
      action: "market.resolve_blocked",
      contractAddress: normalizedAddress,
      details: {
        reason: "legacy_uncontested",
        codeHash: onchainCodeHash,
      },
    });
    return {
      status: "blocked",
      code: AUTO_RESOLVE_BLOCKED_EXIT_CODE,
      reason: `${BLOCKED_PREFIX} legacy uncontested market cannot resolve on current bytecode (codeHash=${onchainCodeHash})`,
    };
  }

  const resolutionDecision = evaluateResolutionQuotes({
    assetIdText: state.assetIdText,
    direction: state.direction,
    threshold: state.threshold,
    quotes: await getResolutionQuoteCandidates(state.assetIdText),
  });

  saveMarketRecord({
    contractAddress: normalizedAddress,
    lastResolveDecisionAt: nowSec,
    lastResolveDecision: resolutionDecision.ok ? "ready" : "blocked_retry",
    lastResolveDecisionReason: resolutionDecision.reason ?? "",
    lastResolveSourceSummary: formatResolutionQuotes(resolutionDecision.quotes),
    lastResolveQuotes: resolutionDecision.quotes.map((quote) => ({
      source: quote.source,
      finalPrice: quote.finalPrice.toString(),
      capturedAt: quote.capturedAt,
      outcome: quote.outcome ?? null,
    })),
    lastResolveSpreadBps: resolutionDecision.spreadBps != null ? Number(resolutionDecision.spreadBps) : null,
  });

  appendAdminAuditEntry({
    actor: `resolver:${wallet.address.toString()}`,
    action: resolutionDecision.ok ? "market.resolve_decision" : "market.resolve_blocked",
    contractAddress: normalizedAddress,
    details: {
      asset: state.assetIdText,
      threshold: formatPrice6(state.threshold),
      reason: resolutionDecision.reason ?? "",
      sourceCount: resolutionDecision.sourceCount,
      minimumSourceCount: resolutionDecision.minimumSourceCount,
      spreadBps:
        resolutionDecision.spreadBps != null ? Number(resolutionDecision.spreadBps) : null,
      quotes: resolutionDecision.quotes.map((quote) => ({
        source: quote.source,
        finalPrice: formatPrice6(quote.finalPrice),
        capturedAt: quote.capturedAt,
        outcome: quote.outcome ?? null,
      })),
    },
  });

  if (!resolutionDecision.ok) {
    incrementMetric("auto_resolver_blocked_total", 1, { reason: "quote_policy" });
    return {
      status: "retry",
      delayMs: 30_000,
      reason: resolutionDecision.reason || "Resolver quote policy blocked settlement",
    };
  }

  const finalPrice = resolutionDecision.finalPrice;
  const expectedOutcome = resolutionDecision.outcome;

  console.log(`[resolver] market=${normalizedAddress}`);
  console.log(`[resolver] threshold=$${formatPrice6(state.threshold)}`);
  console.log(`[resolver] final price=$${formatPrice6(finalPrice)}`);
  console.log(`[resolver] price sources=${resolutionDecision.summary}`);
  console.log(`[resolver] spread=${resolutionDecision.spreadBps}bps`);
  console.log(`[resolver] expected outcome=${expectedOutcome}`);

  const body = beginCell()
    .storeUint(OP_RESOLVE_MARKET, 32)
    .storeUint(finalPrice, 128)
    .endCell();

  const seqno = await withRateLimitRetry("get_seqno", () => wallet.getSeqno());
  await withRateLimitRetry("send_resolve_transfer", () => wallet.sendTransfer({
    seqno,
    secretKey: keyPair.secretKey,
    sendMode: SendMode.PAY_GAS_SEPARATELY,
    messages: [
      internal({
        to: normalizedAddress,
        value: DEFAULT_SEND_VALUE,
        bounce: true,
        body,
      }),
    ],
  }));

  await waitForSeqnoIncrement(wallet, seqno);
  await sleep(3_000);

  const nextState = await withRateLimitRetry("get_market_state", () => contract.getMarketState());
  if (nextState.status === STATUS_OPEN || nextState.status === STATUS_LOCKED) {
    incrementMetric("auto_resolver_retry_total", 1, { provider: providerId });
    return {
      status: "retry",
      delayMs: 15_000,
      reason: "Resolve transaction sent but market is not finalized yet",
    };
  }

  saveMarketRecord({
    contractAddress: normalizedAddress,
    lastResolvedAt: Math.floor(Date.now() / 1000),
    lastResolvedFinalPrice: formatPrice6(finalPrice),
    lastResolvedSourceSummary: resolutionDecision.summary,
    lastResolvedSpreadBps: Number(resolutionDecision.spreadBps),
  });
  appendAdminAuditEntry({
    actor: `resolver:${wallet.address.toString()}`,
    action: "market.resolved",
    contractAddress: normalizedAddress,
    details: {
      finalPrice: formatPrice6(finalPrice),
      sourceSummary: resolutionDecision.summary,
      spreadBps: Number(resolutionDecision.spreadBps),
      provider: providerId,
    },
  });

  return {
    status: "resolved",
    reason: "Market resolved successfully",
  };
}
