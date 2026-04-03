import { SUPPORTED_ASSETS, formatUsd } from "../../../../packages/shared/src/index.js";
import { toNano } from "@ton/core";
import {
  consumePendingCreate,
  findBlockingCreate,
  getMarketRecord,
  reservePendingCreate,
  saveMarketRecord,
} from "./marketRegistry.js";
import { getResolverWalletInfo } from "./runtimeEnv.js";
import { invalidateMarketViewCache } from "./marketReadModel.js";
import {
  createBetBody,
  createClaimBody,
  createCreateMarketIntent,
  DEFAULT_ACTION_VALUE_NANO,
  DIRECTION_ABOVE,
  formatPrice6,
  getCachedMarketState,
  getCachedUserStake,
  invalidateContractCaches,
  isRateLimitError,
  MIN_BET_NANO,
  OUTCOME_NO,
  OUTCOME_YES,
  parseAddress,
  STATUS_LOCKED,
  STATUS_OPEN,
  STATUS_RESOLVED_NO,
  STATUS_RESOLVED_YES,
  toPrice6,
} from "./tonForecastMarket.js";
import { getAssetSnapshotMap } from "./stonApi.js";
import { scheduleAutoResolve } from "./resolverAutomation.js";

const SUPPORTED_DURATIONS = [300, 900, 1800, 3600];
const CREATE_RESOLVE_DELAY_SEC = 10;
const TRANSACTION_VALIDITY_MS = 5 * 60 * 1000;

function badRequest(message, status = 400) {
  const error = new Error(message);
  error.statusCode = status;
  return error;
}

function ensureSupportedAsset(asset) {
  if (!SUPPORTED_ASSETS.includes(asset)) {
    throw badRequest("asset must be TON, STON, tsTON, UTYA, MAJOR or REDO");
  }
}

function ensureSupportedDuration(durationSec) {
  const numeric = Number(durationSec);
  if (!SUPPORTED_DURATIONS.includes(numeric)) {
    throw badRequest("durationSec must be one of 300, 900, 1800 or 3600");
  }
  return numeric;
}

function formatDurationLabel(durationSec) {
  const minutes = Number(durationSec) / 60;
  return `${minutes} min`;
}

function normalizeSide(side) {
  const normalized = String(side ?? "").trim().toUpperCase();
  if (normalized !== "YES" && normalized !== "NO") {
    throw badRequest("side must be YES or NO");
  }
  return normalized;
}

function normalizeAmountTon(amountTon) {
  const text = String(amountTon ?? "").trim();
  if (!text) {
    throw badRequest("amountTon is required");
  }

  try {
    const valueNano = toNano(text);

    if (valueNano <= 0n) {
      throw badRequest("amountTon must be greater than zero");
    }
    if (valueNano < MIN_BET_NANO) {
      throw badRequest(`Minimum bet is ${formatUsd(Number(MIN_BET_NANO) / 1_000_000_000)} TON`, 409);
    }

    return valueNano;
  } catch {
    throw badRequest("amountTon must be a positive TON value");
  }
}

function buildQuestion(asset, threshold, durationSec) {
  return `Will ${asset} be above $${formatPrice6(threshold)} in ${formatDurationLabel(durationSec)}?`;
}

function buildCreateError(record) {
  const reopenAt = new Date(Number(record.closeAt) * 1000).toLocaleString();
  return `Create blocked: ${record.asset} ${formatDurationLabel(record.durationSec)} market already exists and closes at ${reopenAt}.`;
}

export async function getCreateContext(asset, durationSec) {
  if (!asset) {
    throw badRequest("asset is required");
  }
  if (durationSec == null) {
    throw badRequest("durationSec is required");
  }

  ensureSupportedAsset(asset);
  const normalizedDuration = ensureSupportedDuration(durationSec);
  const snapshotMap = await getAssetSnapshotMap();
  const snapshot = snapshotMap.get(asset);
  if (!snapshot) {
    throw badRequest(`No live price for ${asset}`, 503);
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const blockingMarket = findBlockingCreate(asset, normalizedDuration, nowSec);
  const currentPrice = Number(snapshot.priceUsd);
  const threshold = Number(snapshot.priceUsd);

  return {
    asset,
    durationSec: normalizedDuration,
    durationLabel: formatDurationLabel(normalizedDuration),
    currentPrice,
    currentPriceLabel: `$${formatUsd(currentPrice)}`,
    threshold,
    thresholdLabel: `$${formatUsd(threshold)}`,
    question: buildQuestion(asset, toPrice6(snapshot.priceUsd), normalizedDuration),
    canCreate: !blockingMarket,
    blockedReason: blockingMarket ? buildCreateError(blockingMarket) : "",
    blockingMarket: blockingMarket
      ? {
          contractAddress: blockingMarket.contractAddress,
          marketId: String(blockingMarket.marketId),
          closeAt: Number(blockingMarket.closeAt),
        }
      : null,
  };
}

export async function createMarketIntent({ ownerAddress, asset, durationSec }) {
  const owner = parseAddress(ownerAddress);
  const context = await getCreateContext(asset, durationSec);
  if (!context.canCreate) {
    throw badRequest(context.blockedReason || "Create blocked", 409);
  }

  const { address: resolverAddress } = await getResolverWalletInfo();
  const nowSec = Math.floor(Date.now() / 1000);
  const marketId = BigInt(Date.now());
  const deploymentSalt = marketId;
  const closeAt = nowSec + Number(durationSec);
  const resolveAt = closeAt + CREATE_RESOLVE_DELAY_SEC;
  const threshold = toPrice6(context.currentPrice);

  const intent = createCreateMarketIntent({
    ownerAddress: owner,
    resolverAddress,
    deploymentSalt,
    marketId,
    assetId: asset,
    threshold,
    closeTime: BigInt(closeAt),
    resolveTime: BigInt(resolveAt),
    direction: DIRECTION_ABOVE,
  });

  const draft = {
    id: intent.address.toString(),
    contractAddress: intent.address.toString(),
    marketId: marketId.toString(),
    deploymentSalt: deploymentSalt.toString(),
    asset,
    direction: "above",
    currentPriceAtCreate: context.currentPrice,
    threshold: Number(context.currentPrice),
    durationSec: Number(durationSec),
    createdAt: nowSec,
    closeAt,
    resolveAt,
    ownerAddress: owner.toString(),
    resolverAddress: resolverAddress.toString(),
  };

  reservePendingCreate(draft);

  return {
    validUntil: Date.now() + TRANSACTION_VALIDITY_MS,
    message: intent.message,
    draft: {
      ...draft,
      question: context.question,
      currentPriceLabel: context.currentPriceLabel,
      thresholdLabel: context.thresholdLabel,
    },
  };
}

export async function confirmCreate(contractAddress) {
  const normalizedAddress = parseAddress(contractAddress).toString();
  const pending = consumePendingCreate(normalizedAddress);

  if (!pending) {
    const existing = getMarketRecord(normalizedAddress);
    if (existing) {
      return existing;
    }
    throw badRequest("No pending create intent found for this contract address", 404);
  }

  const record = saveMarketRecord({
    ...pending,
    confirmedAt: Math.floor(Date.now() / 1000),
  });

  invalidateContractCaches(record.contractAddress);
  invalidateMarketViewCache();
  scheduleAutoResolve(record.contractAddress, 5_000);
  return record;
}

export async function createBetIntent({
  contractAddress,
  userAddress,
  side,
  amountTon,
}) {
  const record = getMarketRecord(parseAddress(contractAddress).toString());
  if (!record) {
    throw badRequest("Market not found", 404);
  }

  const normalizedSide = normalizeSide(side);
  const amountNano = normalizeAmountTon(amountTon);
  let preflightStatus = "checked";

  try {
    const state = await getCachedMarketState(record.contractAddress);
    const stake = await getCachedUserStake(record.contractAddress, userAddress);
    const nowSec = BigInt(Math.floor(Date.now() / 1000));

    if (state.status !== STATUS_OPEN || nowSec >= state.closeTime) {
      throw badRequest("Bet blocked: market is not OPEN.", 409);
    }
    if (normalizedSide === "YES" && stake.noAmount > 0n) {
      throw badRequest("Bet blocked: this wallet already bet NO on this market.", 409);
    }
    if (normalizedSide === "NO" && stake.yesAmount > 0n) {
      throw badRequest("Bet blocked: this wallet already bet YES on this market.", 409);
    }
  } catch (error) {
    if (!isRateLimitError(error)) {
      throw error;
    }

    preflightStatus = "degraded";
    console.warn(
      `[api] bet preflight degraded for ${record.contractAddress}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return {
    validUntil: Date.now() + TRANSACTION_VALIDITY_MS,
    message: {
      address: record.contractAddress,
      amount: amountNano.toString(),
      payload: createBetBody(normalizedSide).toBoc({ idx: false }).toString("base64"),
    },
    market: {
      contractAddress: record.contractAddress,
      side: normalizedSide,
      question: buildQuestion(record.asset, toPrice6(record.threshold), record.durationSec),
    },
    preflightStatus,
  };
}

export async function createClaimIntent({ contractAddress, userAddress }) {
  const record = getMarketRecord(parseAddress(contractAddress).toString());
  if (!record) {
    throw badRequest("Market not found", 404);
  }

  const state = await getCachedMarketState(record.contractAddress);
  const stake = await getCachedUserStake(record.contractAddress, userAddress);

  if (state.status !== STATUS_RESOLVED_YES && state.status !== STATUS_RESOLVED_NO) {
    throw badRequest("Claim blocked: market is not resolved yet.", 409);
  }
  if (stake.claimed) {
    throw badRequest("Claim blocked: reward already claimed.", 409);
  }

  const winningYes = state.resolvedOutcome === OUTCOME_YES;
  const winningNo = state.resolvedOutcome === OUTCOME_NO;
  const isWinner = (winningYes && stake.yesAmount > 0n) || (winningNo && stake.noAmount > 0n);
  if (!isWinner) {
    throw badRequest("Claim blocked: this wallet is not on the winning side.", 409);
  }

  return {
    validUntil: Date.now() + TRANSACTION_VALIDITY_MS,
    message: {
      address: record.contractAddress,
      amount: DEFAULT_ACTION_VALUE_NANO.toString(),
      payload: createClaimBody().toBoc({ idx: false }).toString("base64"),
    },
    market: {
      contractAddress: record.contractAddress,
      resolvedStatus:
        state.status === STATUS_RESOLVED_YES ? "RESOLVED_YES" : "RESOLVED_NO",
    },
  };
}
