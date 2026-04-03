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
  OUTCOME_YES,
  STATUS_LOCKED,
  STATUS_OPEN,
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
const MARKET_VIEW_CACHE_TTL_MS = 4_000;
let marketViewCache = null;
let marketViewCacheExpiresAtMs = 0;
let marketViewInflight = null;

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
  return null;
}

function toStatusLabel(status) {
  if (status === STATUS_OPEN) return "OPEN";
  if (status === STATUS_LOCKED) return "LOCKED";
  if (status === STATUS_RESOLVED_YES) return "RESOLVED_YES";
  if (status === STATUS_RESOLVED_NO) return "RESOLVED_NO";
  return "OPEN";
}

async function buildMarketFromRecord(record, snapshotMap, nowSec) {
  const snapshot = snapshotMap.get(record.asset);
  const currentPrice = Number(snapshot?.priceUsd ?? record.currentPriceAtCreate ?? 0);
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
    },
    nowSec,
  );
}

async function buildMarkets() {
  const nowMs = Date.now();
  if (marketViewCache && marketViewCacheExpiresAtMs > nowMs) {
    return marketViewCache;
  }

  if (marketViewInflight) {
    return marketViewInflight;
  }

  const snapshotMap = await getAssetSnapshotMap();
  const nowSec = Math.floor(Date.now() / 1000);
  const records = listMarketRecords();
  marketViewInflight = Promise.all(
    records.map((record) => buildMarketFromRecord(record, snapshotMap, nowSec)),
  )
    .then((items) => {
      marketViewCache = items;
      marketViewCacheExpiresAtMs = Date.now() + MARKET_VIEW_CACHE_TTL_MS;
      return items;
    })
    .finally(() => {
      marketViewInflight = null;
    });

  return marketViewInflight;
}

export async function listMarkets(status) {
  const items = await buildMarkets();
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

export async function listPositions(userAddress) {
  const records = listMarketRecords();
  const markets = await buildMarkets();
  const marketMap = new Map(markets.map((item) => [item.contractAddress, item]));

  const entries = await Promise.all(
    records.map(async (record) => {
      const marketView = marketMap.get(record.contractAddress);
      if (!marketView) {
        return null;
      }

      try {
        const stake = await getCachedUserStake(record.contractAddress, userAddress);
        const amountYesTon = nanosToTonDecimal(stake.yesAmount);
        const amountNoTon = nanosToTonDecimal(stake.noAmount);
        const totalAmountTon = amountYesTon + amountNoTon;

        if (totalAmountTon <= 0) {
          return null;
        }

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
    }),
  );

  return entries.filter(Boolean);
}

export function invalidateMarketViewCache() {
  marketViewCache = null;
  marketViewCacheExpiresAtMs = 0;
  marketViewInflight = null;
}
