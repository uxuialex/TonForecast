import {
  MARKET_DURATIONS,
  SUPPORTED_ASSETS,
  formatAssetUsd,
  formatDurationLabel as formatSharedDurationLabel,
  formatUsd,
} from "../../../../packages/shared/src/index.js";
import { toNano } from "@ton/core";
import {
  consumePendingCreate,
  findBlockingCreate,
  getMarketRecord,
  reservePendingCreate,
  saveMarketRecord,
} from "./marketRegistry.js";
import { getResolverWalletInfo, getTreasuryAddress } from "./runtimeEnv.js";
import { invalidateMarketViewCache } from "./marketReadModel.js";
import {
  createBetBody,
  createClaimBody,
  createCreateMarketIntent,
  DEFAULT_ACTION_VALUE_NANO,
  DIRECTION_ABOVE,
  DIRECTION_BELOW,
  formatPrice6,
  getCachedMarketState,
  getCachedUserStake,
  invalidateContractCaches,
  isRateLimitError,
  MIN_BET_NANO,
  OUTCOME_NO,
  OUTCOME_DRAW,
  OUTCOME_YES,
  parseAddress,
  STATUS_LOCKED,
  STATUS_OPEN,
  STATUS_RESOLVED_DRAW,
  STATUS_RESOLVED_NO,
  STATUS_RESOLVED_YES,
  TON_FORECAST_MARKET_CODE_HASH,
  TON_FORECAST_MARKET_CODE_HASH_BASE64,
  TON_FORECAST_MARKET_CONTRACT_VERSION,
  toPrice6,
} from "./tonForecastMarket.js";
import { getAssetSnapshotMap, getThresholdPresets } from "./stonApi.js";
import { scheduleAutoResolveForRecord } from "./resolverAutomation.js";

const SUPPORTED_DURATIONS = MARKET_DURATIONS;
const CREATE_RESOLVE_DELAY_SEC = 10;
const TRANSACTION_VALIDITY_MS = 5 * 60 * 1000;

function badRequest(message, status = 400) {
  const error = new Error(message);
  error.statusCode = status;
  return error;
}

function isDegradablePreflightError(error) {
  if (isRateLimitError(error)) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error);
  return /timed out|fetch failed|eai_again|network/i.test(message);
}

function ensureSupportedAsset(asset) {
  if (!SUPPORTED_ASSETS.includes(asset)) {
    throw badRequest("asset must be TON, STON, tsTON, UTYA, MAJOR or REDO");
  }
}

function ensureSupportedDuration(durationSec) {
  const numeric = Number(durationSec);
  if (!SUPPORTED_DURATIONS.includes(numeric)) {
    throw badRequest(`durationSec must be one of ${SUPPORTED_DURATIONS.join(", ")}`);
  }
  return numeric;
}

function formatDurationLabel(durationSec) {
  return formatSharedDurationLabel(durationSec);
}

function ensureSupportedDirection(direction) {
  const normalized = String(direction ?? "above").trim().toLowerCase();
  if (normalized !== "above" && normalized !== "below") {
    throw badRequest("direction must be above or below");
  }
  return normalized;
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

function normalizeThreshold(asset, threshold, fallbackPrice) {
  if (threshold == null || threshold === "") {
    return toPrice6(fallbackPrice);
  }

  const numeric = Number(threshold);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw badRequest(`threshold must be a positive USD price for ${asset}`);
  }

  return toPrice6(numeric);
}

function buildQuestion(asset, threshold, durationSec, direction = "above") {
  const normalizedDirection = ensureSupportedDirection(direction);
  return `Will ${asset} be ${normalizedDirection} $${formatPrice6(threshold)} in ${formatDurationLabel(durationSec)}?`;
}

function buildCreateError(record) {
  const reopenAt = new Date(Number(record.closeAt) * 1000).toLocaleString();
  return `Create blocked: ${record.asset} ${formatDurationLabel(record.durationSec)} market already exists and closes at ${reopenAt}.`;
}

export async function getCreateContext(asset, durationSec, direction = "above", threshold = null) {
  if (!asset) {
    throw badRequest("asset is required");
  }
  if (durationSec == null) {
    throw badRequest("durationSec is required");
  }

  ensureSupportedAsset(asset);
  const normalizedDuration = ensureSupportedDuration(durationSec);
  const normalizedDirection = ensureSupportedDirection(direction);
  const snapshotMap = await getAssetSnapshotMap();
  const snapshot = snapshotMap.get(asset);
  if (!snapshot) {
    throw badRequest(`No live price for ${asset}`, 503);
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const blockingMarket = findBlockingCreate(asset, normalizedDuration, nowSec, normalizedDirection);
  const currentPrice = Number(snapshot.priceUsd);
  const presetContext = await getThresholdPresets(asset, normalizedDirection);
  const thresholdPresets = Array.isArray(presetContext.thresholds)
    ? presetContext.thresholds.map((value) => Number(value))
    : [];
  const selectedThreshold = Number(
    thresholdPresets.includes(Number(threshold))
      ? Number(threshold)
      : thresholdPresets[0] ?? currentPrice,
  );

  return {
    asset,
    direction: normalizedDirection,
    directionLabel: normalizedDirection === "below" ? "Below" : "Above",
    durationSec: normalizedDuration,
    durationLabel: formatDurationLabel(normalizedDuration),
    currentPrice,
    currentPriceLabel: `$${formatAssetUsd(currentPrice, asset)}`,
    threshold: selectedThreshold,
    thresholdLabel: `$${formatAssetUsd(selectedThreshold, asset)}`,
    thresholdPresets: thresholdPresets.map((value) => ({
      value,
      label: `$${formatAssetUsd(value, asset)}`,
    })),
    question: buildQuestion(asset, toPrice6(selectedThreshold), normalizedDuration, normalizedDirection),
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

export async function createMarketIntent({ ownerAddress, asset, durationSec, direction, threshold }) {
  const owner = parseAddress(ownerAddress);
  const normalizedDirection = ensureSupportedDirection(direction);
  const context = await getCreateContext(asset, durationSec, normalizedDirection, threshold);
  if (!context.canCreate) {
    throw badRequest(context.blockedReason || "Create blocked", 409);
  }

  const { address: resolverAddress } = await getResolverWalletInfo();
  const treasuryAddress = parseAddress(
    getTreasuryAddress(resolverAddress.toString()),
  );
  const nowSec = Math.floor(Date.now() / 1000);
  const marketId = BigInt(Date.now());
  const deploymentSalt = marketId;
  const closeAt = nowSec + Number(durationSec);
  const resolveAt = closeAt + CREATE_RESOLVE_DELAY_SEC;
  const thresholdValue = normalizeThreshold(asset, context.threshold, context.currentPrice);
  const directionFlag = normalizedDirection === "below" ? DIRECTION_BELOW : DIRECTION_ABOVE;

  const intent = createCreateMarketIntent({
    ownerAddress: owner,
    resolverAddress,
    treasuryAddress,
    deploymentSalt,
    marketId,
    assetId: asset,
    threshold: thresholdValue,
    closeTime: BigInt(closeAt),
    resolveTime: BigInt(resolveAt),
    direction: directionFlag,
  });

  const draft = {
    id: intent.address.toString(),
    contractAddress: intent.address.toString(),
    marketId: marketId.toString(),
    deploymentSalt: deploymentSalt.toString(),
    contractVersion: TON_FORECAST_MARKET_CONTRACT_VERSION,
    contractCodeHash: TON_FORECAST_MARKET_CODE_HASH,
    contractCodeHashBase64: TON_FORECAST_MARKET_CODE_HASH_BASE64,
    asset,
    direction: normalizedDirection,
    currentPriceAtCreate: context.currentPrice,
    threshold: Number(context.threshold),
    durationSec: Number(durationSec),
    createdAt: nowSec,
    closeAt,
    resolveAt,
    ownerAddress: owner.toString(),
    resolverAddress: resolverAddress.toString(),
    treasuryAddress: treasuryAddress.toString(),
  };

  reservePendingCreate(draft);

  return {
    validUntil: Date.now() + TRANSACTION_VALIDITY_MS,
    message: intent.message,
    draft: {
      ...draft,
      question: buildQuestion(asset, thresholdValue, Number(durationSec), normalizedDirection),
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
  scheduleAutoResolveForRecord(record);
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
    if (!isDegradablePreflightError(error)) {
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

  let preflightStatus = "checked";
  let resolvedStatus = null;

  try {
    const state = await getCachedMarketState(record.contractAddress);
    const stake = await getCachedUserStake(record.contractAddress, userAddress);

    if (
      state.status !== STATUS_RESOLVED_YES &&
      state.status !== STATUS_RESOLVED_NO &&
      state.status !== STATUS_RESOLVED_DRAW
    ) {
      throw badRequest("Claim blocked: market is not resolved yet.", 409);
    }
    if (stake.claimed) {
      throw badRequest("Claim blocked: reward already claimed.", 409);
    }

    const winningYes = state.resolvedOutcome === OUTCOME_YES;
    const winningNo = state.resolvedOutcome === OUTCOME_NO;
    const isDraw = state.resolvedOutcome === OUTCOME_DRAW;
    const isWinner =
      (winningYes && stake.yesAmount > 0n) ||
      (winningNo && stake.noAmount > 0n) ||
      (isDraw && (stake.yesAmount > 0n || stake.noAmount > 0n));
    if (!isWinner) {
      throw badRequest("Claim blocked: this wallet is not on the winning side.", 409);
    }

    resolvedStatus =
      state.status === STATUS_RESOLVED_YES
        ? "RESOLVED_YES"
        : state.status === STATUS_RESOLVED_NO
          ? "RESOLVED_NO"
          : "RESOLVED_DRAW";
  } catch (error) {
    if (!isDegradablePreflightError(error)) {
      throw error;
    }

    preflightStatus = "degraded";
    console.warn(
      `[api] claim preflight degraded for ${record.contractAddress}: ${error instanceof Error ? error.message : String(error)}`,
    );
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
      resolvedStatus,
    },
    preflightStatus,
  };
}
