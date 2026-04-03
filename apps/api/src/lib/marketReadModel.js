import {
  buildMarketQuestion,
  buildMarketView,
  buildPositionView,
  formatUsd,
} from "../../../../packages/shared/src/index.js";
import { getMarketRecord, listMarketRecords } from "./marketRegistry.js";
import { getAssetSnapshotMap } from "./stonApi.js";
import {
  DIRECTION_ABOVE,
  DIRECTION_BELOW,
  getCachedMarketState,
  getCachedUserStake,
  OUTCOME_NO,
  OUTCOME_NONE,
  OUTCOME_DRAW,
  OUTCOME_YES,
  STATUS_LOCKED,
  STATUS_OPEN,
  STATUS_RESOLVED_DRAW,
  STATUS_RESOLVED_NO,
  STATUS_RESOLVED_YES,
  nanosToTonDecimal,
} from "./tonForecastMarket.js";

const PRECISION_BY_ASSET = {
  TON: 4,
  STON: 6,
  tsTON: 6,
  UTYA: 6,
  MAJOR: 6,
  REDO: 6,
};
const MARKET_VIEW_CACHE_TTL_MS = 8_000;
const POSITION_READ_CONCURRENCY = 2;
const POSITION_SCAN_LIMIT = 8;
const POSITION_CACHE_TTL_MS = 15_000;
const marketViewCache = new Map();
const marketViewInflight = new Map();
const positionsCache = new Map();
const positionsInflight = new Map();

function toFixedPrice(asset, value) {
  const precision = PRECISION_BY_ASSET[asset] ?? 6;
  return Number(value.toFixed(precision));
}

function toDirectionLabel(direction) {
  return direction === DIRECTION_ABOVE ? "above" : direction === DIRECTION_BELOW ? "below" : "above";
}

function toOutcomeLabel(outcome) {
  if (outcome === OUTCOME_YES) return "YES";
  if (outcome === OUTCOME_NO) return "NO";
  if (outcome === OUTCOME_DRAW) return "DRAW";
  return null;
}

function toStatusLabel(status) {
  if (status === STATUS_OPEN) return "OPEN";
  if (status === STATUS_LOCKED) return "LOCKED";
  if (status === STATUS_RESOLVED_YES) return "RESOLVED_YES";
  if (status === STATUS_RESOLVED_NO) return "RESOLVED_NO";
  if (status === STATUS_RESOLVED_DRAW) return "RESOLVED_DRAW";
  return "OPEN";
}

async function buildMarketFromRecord(record, snapshotMap, nowSec) {
  const snapshot = snapshotMap.get(record.asset);
  const currentPrice = Number(snapshot?.priceUsd ?? record.currentPriceAtCreate ?? 0);
  const iconUrl = snapshot?.iconUrl ?? `/api/assets/icons/${encodeURIComponent(record.asset)}`;
  let status = "OPEN";
  let threshold = Number(record.threshold ?? 0);
  let direction = record.direction ?? "above";
  let finalPrice = null;
  let outcome = null;
  let yesPool = 0;
  let noPool = 0;
  let onchainReady = false;

  try {
    const state = await getCachedMarketState(record.contractAddress);
    onchainReady = true;
    threshold = Number(state.threshold) / 1_000_000;
    direction = toDirectionLabel(state.direction);
    status = toStatusLabel(state.status);
    yesPool = nanosToTonDecimal(state.yesPool);
    noPool = nanosToTonDecimal(state.noPool);
    finalPrice = state.finalPrice > 0n ? Number(state.finalPrice) / 1_000_000 : null;
    outcome = toOutcomeLabel(state.resolvedOutcome);
  } catch (error) {
    const fallbackStatus =
      Number(record.resolveAt) <= nowSec
        ? "LOCKED"
        : Number(record.closeAt) <= nowSec
          ? "LOCKED"
          : "OPEN";
    status = fallbackStatus;
  }

  return buildMarketView(
    {
      id: record.contractAddress,
      marketId: String(record.marketId),
      token: record.asset,
      question: buildMarketQuestion({
        token: record.asset,
        direction,
        threshold,
        durationSec: Number(record.durationSec),
      }),
      currentPrice,
      threshold: toFixedPrice(record.asset, threshold),
      direction,
      durationSec: Number(record.durationSec),
      createdAt: Number(record.createdAt),
      closeAt: Number(record.closeAt),
      resolveAt: Number(record.resolveAt),
      status,
      yesPool,
      noPool,
      finalPrice,
      outcome,
      contractAddress: record.contractAddress,
      ownerAddress: record.ownerAddress,
      resolverAddress: record.resolverAddress,
      onchainReady,
      iconUrl,
    },
    nowSec,
  );
}

function getCandidateRecords(records, status, nowSec) {
  if (status === "OPEN") {
    return records.filter((record) => Number(record.closeAt) > nowSec);
  }

  if (status === "LOCKED") {
    return records.filter(
      (record) => Number(record.closeAt) <= nowSec && Number(record.resolveAt) > nowSec,
    );
  }

  if (status === "RESOLVED") {
    return records.filter((record) => Number(record.resolveAt) <= nowSec);
  }

  return records;
}

function getCachedMarketViews(cacheKey) {
  const entry = marketViewCache.get(cacheKey);
  if (!entry) {
    return null;
  }

  if (entry.expiresAtMs <= Date.now()) {
    marketViewCache.delete(cacheKey);
    return null;
  }

  return entry.items;
}

function getCachedPositions(cacheKey, { allowStale = false } = {}) {
  const entry = positionsCache.get(cacheKey);
  if (!entry) {
    return null;
  }

  if (entry.expiresAtMs <= Date.now()) {
    if (!allowStale) {
      return null;
    }

    return entry.items;
  }

  return entry.items;
}

async function buildMarkets(status = "") {
  const cacheKey = status || "ALL";
  const cached = getCachedMarketViews(cacheKey);
  if (cached) {
    return cached;
  }

  if (marketViewInflight.has(cacheKey)) {
    return marketViewInflight.get(cacheKey);
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const snapshotMap = await getAssetSnapshotMap();
  const records = getCandidateRecords(listMarketRecords(), status, nowSec);
  const inflight = Promise.all(
    records.map((record) => buildMarketFromRecord(record, snapshotMap, nowSec)),
  )
    .then((items) => {
      marketViewCache.set(cacheKey, {
        items,
        expiresAtMs: Date.now() + MARKET_VIEW_CACHE_TTL_MS,
      });
      return items;
    })
    .finally(() => {
      marketViewInflight.delete(cacheKey);
    });

  marketViewInflight.set(cacheKey, inflight);
  return inflight;
}

async function mapConcurrent(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const currentIndex = cursor;
      cursor += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length || 1)) },
    () => worker(),
  );

  await Promise.all(workers);
  return results;
}

export async function listMarkets(status) {
  const items = await buildMarkets(status);
  if (!status) {
    return items;
  }

  if (status === "RESOLVED") {
    return items.filter((item) => item.effectiveStatus.startsWith("RESOLVED"));
  }

  return items.filter((item) => item.effectiveStatus === status);
}

export async function getMarketById(marketId) {
  const market = (await buildMarkets()).find(
    (item) => item.id === marketId || item.contractAddress === marketId || item.marketId === marketId,
  );
  return market ?? null;
}

async function buildPositions(userAddress) {
  const records = listMarketRecords();
  const sortedRecords = [...records]
    .sort((left, right) => Number(right.createdAt) - Number(left.createdAt))
    .slice(0, POSITION_SCAN_LIMIT);
  const nowSec = Math.floor(Date.now() / 1000);
  const snapshotMap = await getAssetSnapshotMap();
  const entries = await mapConcurrent(
    sortedRecords,
    POSITION_READ_CONCURRENCY,
    async (record) => {
      try {
        const stake = await getCachedUserStake(record.contractAddress, userAddress);
        const amountYesTon = nanosToTonDecimal(stake.yesAmount);
        const amountNoTon = nanosToTonDecimal(stake.noAmount);
        const totalAmountTon = amountYesTon + amountNoTon;

        if (totalAmountTon <= 0) {
          return null;
        }

        const marketView = await buildMarketFromRecord(record, snapshotMap, nowSec);
        const side = amountYesTon > 0 ? "YES" : "NO";
        return buildPositionView(
          {
            id: `${record.contractAddress}:${userAddress}`,
            userAddress,
            contractAddress: record.contractAddress,
            side,
            amountTon: totalAmountTon,
            claimed: stake.claimed,
          },
          marketView,
        );
      } catch (error) {
        console.warn(
          `[api] failed to read position for ${record.contractAddress}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
      }
    },
  );

  return entries.filter(Boolean);
}

export async function listPositions(userAddress, options = {}) {
  const normalizedUser = String(userAddress);
  const fresh = options.fresh === true;
  const cacheKey = normalizedUser;

  if (!fresh) {
    const cached = getCachedPositions(cacheKey);
    if (cached) {
      return cached;
    }
  }

  if (positionsInflight.has(cacheKey)) {
    return positionsInflight.get(cacheKey);
  }

  const inflight = buildPositions(normalizedUser)
    .then((items) => {
      positionsCache.set(cacheKey, {
        items,
        expiresAtMs: Date.now() + POSITION_CACHE_TTL_MS,
      });
      return items;
    })
    .catch((error) => {
      const stale = getCachedPositions(cacheKey, { allowStale: true });
      if (stale) {
        console.warn(
          `[api] positions refresh failed for ${normalizedUser}, serving stale cache: ${error instanceof Error ? error.message : String(error)}`,
        );
        return stale;
      }

      throw error;
    })
    .finally(() => {
      positionsInflight.delete(cacheKey);
    });

  positionsInflight.set(cacheKey, inflight);
  return inflight;
}

export function invalidateMarketViewCache() {
  marketViewCache.clear();
  marketViewInflight.clear();
}
