import {
  buildMarketQuestion,
  buildMarketView,
  buildPositionView,
  formatPercent,
  formatTon,
  formatUsd,
  getMarketOutcomeLabel,
  getPositionStatusLabel,
} from "../../../../packages/shared/src/index.js";
import {
  getIndexedMarketRecordsForUser,
  getMarketRecord,
  getUserPositionSnapshot,
  listMarketRecords,
  saveMarketRecords,
  saveMarketRecord,
  saveUserPositionSnapshot,
} from "./marketRegistry.js";
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
  TON_FORECAST_MARKET_CONTRACT_VERSION,
  invalidateContractCaches,
  nanosToTonDecimal,
  parseAddress,
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
const MARKET_READ_CONCURRENCY = 4;
const POSITION_READ_CONCURRENCY = 2;
const POSITION_RECENT_SCAN_LIMIT = 16;
const POSITION_CACHE_TTL_MS = 45_000;
const CHAIN_CONFIRM_TIMEOUT_SEC = 120;
const POSITION_SCOPE_RECENT = "recent";
const POSITION_SCOPE_FULL = "full";
const POSITION_SNAPSHOT_LIMIT = 200;
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

function buildPersistedSnapshot(record) {
  if (!record.lastKnownStatus) {
    return null;
  }

  return {
    threshold: Number(record.lastKnownThreshold ?? record.threshold ?? 0),
    direction: record.lastKnownDirection ?? record.direction ?? "above",
    status: record.lastKnownStatus,
    yesPool: Number(record.lastKnownYesPool ?? 0),
    noPool: Number(record.lastKnownNoPool ?? 0),
    finalPrice:
      record.lastKnownFinalPrice == null
        ? null
        : Number(record.lastKnownFinalPrice),
    outcome: record.lastKnownOutcome ?? null,
  };
}

function buildSnapshotPatchIfChanged(record, snapshot, nowSec) {
  const nextPatch = {
    lastKnownThreshold: snapshot.threshold,
    lastKnownDirection: snapshot.direction,
    lastKnownStatus: snapshot.status,
    lastKnownYesPool: snapshot.yesPool,
    lastKnownNoPool: snapshot.noPool,
    lastKnownFinalPrice: snapshot.finalPrice,
    lastKnownOutcome: snapshot.outcome,
    lastKnownSyncedAt: nowSec,
  };

  const hasChanged =
    record.lastKnownThreshold !== nextPatch.lastKnownThreshold ||
    record.lastKnownDirection !== nextPatch.lastKnownDirection ||
    record.lastKnownStatus !== nextPatch.lastKnownStatus ||
    record.lastKnownYesPool !== nextPatch.lastKnownYesPool ||
    record.lastKnownNoPool !== nextPatch.lastKnownNoPool ||
    record.lastKnownFinalPrice !== nextPatch.lastKnownFinalPrice ||
    record.lastKnownOutcome !== nextPatch.lastKnownOutcome;

  if (!hasChanged) {
    return null;
  }

  return nextPatch;
}

function queueRecordPatch(recordPatches, record, patch) {
  if (!patch || !record?.contractAddress) {
    return;
  }

  const nextPatch = {
    contractAddress: record.contractAddress,
    ...patch,
  };

  if (recordPatches instanceof Map) {
    const existingPatch = recordPatches.get(record.contractAddress);
    recordPatches.set(
      record.contractAddress,
      existingPatch ? { ...existingPatch, ...nextPatch } : nextPatch,
    );
    return;
  }

  saveMarketRecord(nextPatch);
}

function persistQueuedRecordPatches(recordPatches) {
  if (!(recordPatches instanceof Map) || recordPatches.size === 0) {
    return;
  }

  saveMarketRecords([...recordPatches.values()]);
}

function isBrokenPendingChainRecord(record, nowSec) {
  if (record.createFailedAt) {
    return true;
  }

  if (record.lastKnownStatus) {
    return false;
  }

  const confirmationBaseSec = Number(record.confirmedAt ?? record.createdAt ?? 0);
  if (!confirmationBaseSec) {
    return false;
  }

  return confirmationBaseSec + CHAIN_CONFIRM_TIMEOUT_SEC <= nowSec;
}

function isHiddenFromPublic(record) {
  return Boolean(record?.adminHiddenAt);
}

function isLegacyRecord(record) {
  return Boolean(
    record?.adminLegacyFlagAt ||
      !record?.contractVersion ||
      record.contractVersion !== TON_FORECAST_MARKET_CONTRACT_VERSION,
  );
}

async function buildMarketFromRecord(record, snapshotMap, nowSec, options = {}) {
  const recordPatches = options.recordPatches ?? null;
  if (isBrokenPendingChainRecord(record, nowSec)) {
    if (!record.createFailedAt) {
      queueRecordPatch(recordPatches, record, {
        createFailedAt: nowSec,
      });
    }
    return null;
  }

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

    queueRecordPatch(
      recordPatches,
      record,
      buildSnapshotPatchIfChanged(
        record,
        {
          threshold,
          direction,
          status,
          yesPool,
          noPool,
          finalPrice,
          outcome,
        },
        nowSec,
      ),
    );
  } catch (error) {
    const persistedSnapshot = buildPersistedSnapshot(record);
    if (persistedSnapshot) {
      threshold = persistedSnapshot.threshold;
      direction = persistedSnapshot.direction;
      status = persistedSnapshot.status;
      yesPool = persistedSnapshot.yesPool;
      noPool = persistedSnapshot.noPool;
      finalPrice = persistedSnapshot.finalPrice;
      outcome = persistedSnapshot.outcome;
      onchainReady = true;
    } else {
      if (isBrokenPendingChainRecord(record, nowSec)) {
        if (!record.createFailedAt) {
          queueRecordPatch(recordPatches, record, {
            createFailedAt: nowSec,
          });
        }
        return null;
      }

      const fallbackStatus =
        Number(record.resolveAt) <= nowSec
          ? "LOCKED"
          : Number(record.closeAt) <= nowSec
            ? "LOCKED"
            : "OPEN";
      status = fallbackStatus;
    }
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
      contractVersion: record.contractVersion ?? null,
      contractCodeHash: record.contractCodeHash ?? null,
      contractCodeHashBase64: record.contractCodeHashBase64 ?? null,
      isLegacyMarket: isLegacyRecord(record),
      adminHiddenAt: record.adminHiddenAt ?? null,
      adminHiddenReason: record.adminHiddenReason ?? "",
      adminLegacyFlagAt: record.adminLegacyFlagAt ?? null,
      adminLegacyReason: record.adminLegacyReason ?? "",
      autoResolveBlockedAt: record.autoResolveBlockedAt ?? null,
      autoResolveBlockedReason: record.autoResolveBlockedReason ?? "",
      createFailedAt: record.createFailedAt ?? null,
      onchainReady,
      iconUrl,
    },
    nowSec,
  );
}

function getCandidateRecords(records, status, nowSec, options = {}) {
  const includeHidden = options.includeHidden === true;
  const validRecords = records
    .filter((record) => !record.createFailedAt)
    .filter((record) => includeHidden || !isHiddenFromPublic(record))
    .sort((left, right) => Number(right.createdAt) - Number(left.createdAt));

  if (status === "OPEN") {
    return validRecords.filter((record) => Number(record.closeAt) > nowSec);
  }

  if (status === "LOCKED") {
    return validRecords.filter(
      (record) => Number(record.closeAt) <= nowSec && Number(record.resolveAt) > nowSec,
    );
  }

  if (status === "RESOLVED") {
    return validRecords.filter((record) => Number(record.resolveAt) <= nowSec);
  }

  return validRecords;
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

function getPositionsCacheKey(normalizedUser, scope = POSITION_SCOPE_RECENT) {
  return `${normalizedUser}:${scope}`;
}

function getScopedCachedPositions(normalizedUser, scope, options = {}) {
  return getCachedPositions(getPositionsCacheKey(normalizedUser, scope), options);
}

function mergePositionItems(previousItems = [], nextItems = []) {
  const merged = new Map();

  for (const item of previousItems) {
    if (item?.id) {
      merged.set(item.id, item);
    }
  }

  for (const item of nextItems) {
    if (item?.id) {
      merged.set(item.id, item);
    }
  }

  return [...merged.values()].sort(
    (left, right) => Number(right.createdAt ?? 0) - Number(left.createdAt ?? 0),
  );
}

function getMergedCachedPositions(normalizedUser, { allowStale = false } = {}) {
  return mergePositionItems(
    getScopedCachedPositions(normalizedUser, POSITION_SCOPE_FULL, { allowStale }) ?? [],
    getScopedCachedPositions(normalizedUser, POSITION_SCOPE_RECENT, { allowStale }) ?? [],
  );
}

function getPreferredCachedPositions(normalizedUser, { full = false, allowStale = false } = {}) {
  const preferredScope = full ? POSITION_SCOPE_FULL : POSITION_SCOPE_RECENT;
  const fallbackScope = full ? POSITION_SCOPE_RECENT : POSITION_SCOPE_FULL;

  return (
    getScopedCachedPositions(normalizedUser, preferredScope, { allowStale }) ??
    getScopedCachedPositions(normalizedUser, fallbackScope, { allowStale })
  );
}

function writePositionsCaches(normalizedUser, items, { includeFull = false } = {}) {
  const expiresAtMs = Date.now() + POSITION_CACHE_TTL_MS;

  positionsCache.set(getPositionsCacheKey(normalizedUser, POSITION_SCOPE_RECENT), {
    items,
    expiresAtMs,
  });

  if (includeFull) {
    positionsCache.set(getPositionsCacheKey(normalizedUser, POSITION_SCOPE_FULL), {
      items,
      expiresAtMs,
    });
  }
}

function normalizePersistedPositionItems(items = []) {
  return items
    .filter((item) => item?.id && item?.contractAddress)
    .sort((left, right) => Number(right.createdAt ?? 0) - Number(left.createdAt ?? 0))
    .slice(0, POSITION_SNAPSHOT_LIMIT)
    .map((item) => ({
      id: item.id,
      userAddress: item.userAddress,
      contractAddress: item.contractAddress,
      side: item.side,
      amountTon: Number(item.amountTon ?? 0),
      claimed: Boolean(item.claimed),
      marketId: item.marketId,
      createdAt: Number(item.createdAt ?? 0),
      closeAt: Number(item.closeAt ?? 0),
      resolveAt: Number(item.resolveAt ?? 0),
      token: item.token ?? "",
      iconUrl: item.iconUrl ?? null,
      question: item.question ?? "",
      marketStatus: item.marketStatus ?? "OPEN",
      marketStatusLabel: item.marketStatusLabel ?? "Open",
      marketOutcome: item.marketOutcome ?? null,
      sideLabel: item.sideLabel ?? "",
      totalPoolTon: Number(item.totalPoolTon ?? 0),
      winningPoolTon: Number(item.winningPoolTon ?? 0),
      sharePercent: Number(item.sharePercent ?? 0),
      payoutTon: String(item.payoutTon ?? "0"),
      protocolFeeTon: String(item.protocolFeeTon ?? "0"),
      positionStatus: item.positionStatus ?? "NO_POSITION",
    }));
}

function hydratePersistedPositionItem(item) {
  if (!item?.id || !item.contractAddress) {
    return null;
  }

  if ("amountLabel" in item && "positionStatusLabel" in item) {
    return item;
  }

  const amountTon = Number(item.amountTon ?? 0);
  const totalPoolTon = Number(item.totalPoolTon ?? 0);
  const winningPoolTon = Number(item.winningPoolTon ?? 0);
  const sharePercent = Number(item.sharePercent ?? 0);
  const payoutTon = String(item.payoutTon ?? "0");
  const protocolFeeTon = String(item.protocolFeeTon ?? "0");
  const marketOutcomeLabel = getMarketOutcomeLabel(item.marketOutcome);
  const positionStatus = item.positionStatus ?? "NO_POSITION";

  return {
    ...item,
    amountTon,
    claimed: Boolean(item.claimed),
    betLabel: item.side === "YES" ? "Yes" : "No",
    resultLabel: marketOutcomeLabel,
    amountLabel: `${formatTon(amountTon)} TON`,
    totalPoolTon,
    totalPoolLabel: `${formatTon(totalPoolTon)} TON`,
    winningPoolTon,
    winningPoolLabel: `${formatTon(winningPoolTon)} TON`,
    sharePercent,
    shareLabel: formatPercent(sharePercent),
    payoutTon,
    payoutLabel: payoutTon === "0" ? "0 TON" : `${formatTon(payoutTon)} TON`,
    protocolFeeTon,
    protocolFeeLabel: protocolFeeTon === "0" ? "0 TON" : `${formatTon(protocolFeeTon)} TON`,
    marketOutcomeLabel,
    positionStatus,
    positionStatusLabel: getPositionStatusLabel(positionStatus),
    claimable: positionStatus === "CLAIMABLE",
  };
}

function getPersistedPositionItems(normalizedUser) {
  return (getUserPositionSnapshot(normalizedUser)?.items ?? [])
    .map((item) => hydratePersistedPositionItem(item))
    .filter(Boolean)
    .sort((left, right) => Number(right.createdAt ?? 0) - Number(left.createdAt ?? 0));
}

function normalizeUserAddress(userAddress) {
  return parseAddress(userAddress).toString();
}

async function buildMarkets(status = "", options = {}) {
  const includeHidden = options.includeHidden === true;
  const cacheKey = `${status || "ALL"}:${includeHidden ? "admin" : "public"}`;
  const cached = getCachedMarketViews(cacheKey);
  if (cached) {
    return cached;
  }

  if (marketViewInflight.has(cacheKey)) {
    return marketViewInflight.get(cacheKey);
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const snapshotMap = await getAssetSnapshotMap();
  const records = getCandidateRecords(listMarketRecords(), status, nowSec, { includeHidden });
  const recordPatches = new Map();
  const inflight = mapConcurrent(
    records,
    MARKET_READ_CONCURRENCY,
    (record) => buildMarketFromRecord(record, snapshotMap, nowSec, { recordPatches }),
  )
    .then((items) => {
      persistQueuedRecordPatches(recordPatches);
      const normalizedItems = items.filter(Boolean);
      marketViewCache.set(cacheKey, {
        items: normalizedItems,
        expiresAtMs: Date.now() + MARKET_VIEW_CACHE_TTL_MS,
      });
      return normalizedItems;
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

export async function getMarketById(marketId, options = {}) {
  const market = (await buildMarkets("", options)).find(
    (item) => item.id === marketId || item.contractAddress === marketId || item.marketId === marketId,
  );
  return market ?? null;
}

export async function listAdminMarkets(status) {
  const items = await buildMarkets(status, { includeHidden: true });
  return items.map((item) => ({
    ...item,
    isProblemMarket: Boolean(
      item.isLegacyMarket ||
        item.adminHiddenAt ||
        item.autoResolveBlockedAt ||
        item.createFailedAt,
    ),
  }));
}

function getPositionCandidateRecords(userAddress, { full = false } = {}) {
  const records = listMarketRecords();
  const sortedRecords = [...records]
    .filter((record) => !record.createFailedAt)
    .sort((left, right) => Number(right.createdAt) - Number(left.createdAt));

  if (full) {
    return sortedRecords;
  }

  const recentRecords = sortedRecords.slice(0, POSITION_RECENT_SCAN_LIMIT);
  const hintedRecords = getIndexedMarketRecordsForUser(userAddress);
  const seen = new Set();
  return [...hintedRecords, ...recentRecords].filter((record) => {
    if (seen.has(record.contractAddress)) {
      return false;
    }
    seen.add(record.contractAddress);
    return true;
  }).sort((left, right) => Number(right.createdAt) - Number(left.createdAt));
}

async function buildPositions(userAddress, options = {}) {
  const normalizedUser = normalizeUserAddress(userAddress);
  const sortedRecords = getPositionCandidateRecords(normalizedUser, options);
  const nowSec = Math.floor(Date.now() / 1000);
  const snapshotMap = await getAssetSnapshotMap();
  const recordPatches = new Map();
  const entries = await mapConcurrent(
    sortedRecords,
    POSITION_READ_CONCURRENCY,
    async (record) => {
      try {
        const stake = await getCachedUserStake(record.contractAddress, normalizedUser);
        const amountYesTon = nanosToTonDecimal(stake.yesAmount);
        const amountNoTon = nanosToTonDecimal(stake.noAmount);
        const totalAmountTon = amountYesTon + amountNoTon;

        if (totalAmountTon <= 0) {
          return null;
        }

        const marketView = await buildMarketFromRecord(record, snapshotMap, nowSec, {
          recordPatches,
        });
        if (!marketView) {
          return null;
        }

        const side = amountYesTon > 0 ? "YES" : "NO";
        return buildPositionView(
          {
            id: `${record.contractAddress}:${normalizedUser}`,
            userAddress: normalizedUser,
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

  persistQueuedRecordPatches(recordPatches);

  return entries
    .filter(Boolean)
    .sort((left, right) => Number(right.createdAt ?? 0) - Number(left.createdAt ?? 0));
}

async function buildSinglePosition(contractAddress, userAddress, options = {}) {
  const normalizedUser = normalizeUserAddress(userAddress);
  const normalizedAddress = parseAddress(contractAddress).toString();
  const record = getMarketRecord(normalizedAddress);
  if (!record || record.createFailedAt) {
    return null;
  }

  if (options.fresh) {
    invalidateContractCaches(normalizedAddress);
  }

  const snapshotMap = await getAssetSnapshotMap();
  const nowSec = Math.floor(Date.now() / 1000);
  const recordPatches = new Map();

  try {
    const stake = await getCachedUserStake(normalizedAddress, normalizedUser);
    const amountYesTon = nanosToTonDecimal(stake.yesAmount);
    const amountNoTon = nanosToTonDecimal(stake.noAmount);
    const totalAmountTon = amountYesTon + amountNoTon;

    if (totalAmountTon <= 0) {
      return null;
    }

    const marketView = await buildMarketFromRecord(record, snapshotMap, nowSec, {
      recordPatches,
    });
    if (!marketView) {
      persistQueuedRecordPatches(recordPatches);
      return null;
    }

    persistQueuedRecordPatches(recordPatches);
    return buildPositionView(
      {
        id: `${normalizedAddress}:${normalizedUser}`,
        userAddress: normalizedUser,
        contractAddress: normalizedAddress,
        side: amountYesTon > 0 ? "YES" : "NO",
        amountTon: totalAmountTon,
        claimed: stake.claimed,
      },
      marketView,
    );
  } catch (error) {
    console.warn(
      `[api] failed to read single position for ${normalizedAddress}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

export async function listPositions(userAddress, options = {}) {
  const normalizedUser = normalizeUserAddress(userAddress);
  const fresh = options.fresh === true;
  const full = options.full === true;
  const cachedOnly = options.cachedOnly === true;
  const inflightKey = getPositionsCacheKey(
    normalizedUser,
    full ? POSITION_SCOPE_FULL : POSITION_SCOPE_RECENT,
  );
  const recentInflightKey = getPositionsCacheKey(normalizedUser, POSITION_SCOPE_RECENT);
  const fullInflightKey = getPositionsCacheKey(normalizedUser, POSITION_SCOPE_FULL);
  const persistedItems = getPersistedPositionItems(normalizedUser);

  if (!fresh) {
    const cached = mergePositionItems(
      persistedItems,
      getPreferredCachedPositions(normalizedUser, { full }) ?? [],
    );
    if (cached.length || cachedOnly) {
      return cached;
    }
  }

  if (cachedOnly) {
    return [];
  }

  if (full) {
    if (positionsInflight.has(fullInflightKey)) {
      return positionsInflight.get(fullInflightKey);
    }
  } else {
    if (positionsInflight.has(recentInflightKey)) {
      return positionsInflight.get(recentInflightKey);
    }
    if (positionsInflight.has(fullInflightKey)) {
      return positionsInflight.get(fullInflightKey);
    }
  }

  const inflight = buildPositions(normalizedUser, { full })
    .then((items) => {
      const previousItems = mergePositionItems(
        persistedItems,
        getMergedCachedPositions(normalizedUser, { allowStale: true }),
      );
      const mergedItems = mergePositionItems(previousItems, items);
      writePositionsCaches(normalizedUser, mergedItems, { includeFull: full });
      saveUserPositionSnapshot(normalizedUser, normalizePersistedPositionItems(mergedItems));
      return mergedItems;
    })
    .catch((error) => {
      const stale = getPreferredCachedPositions(normalizedUser, {
        full,
        allowStale: true,
      }) ?? getMergedCachedPositions(normalizedUser, { allowStale: true });
      const fallback = mergePositionItems(persistedItems, stale ?? []);
      if (fallback.length) {
        console.warn(
          `[api] positions refresh failed for ${normalizedUser}, serving stale cache: ${error instanceof Error ? error.message : String(error)}`,
        );
        return fallback;
      }

      throw error;
    })
    .finally(() => {
      positionsInflight.delete(inflightKey);
    });

  positionsInflight.set(inflightKey, inflight);
  return inflight;
}

export async function getPositionForUser(contractAddress, userAddress, options = {}) {
  return buildSinglePosition(contractAddress, userAddress, options);
}

export function invalidateMarketViewCache() {
  marketViewCache.clear();
  marketViewInflight.clear();
}
