import { SUPPORTED_ASSETS, formatUsd } from "../../../../packages/shared/src/index.js";
import { assetSnapshots as fallbackSnapshots } from "../data/mockMarkets.js";

const STON_API_BASE = "https://api.ston.fi";
const SNAPSHOT_CACHE_TTL_MS = 5_000;
const PRECISION_BY_ASSET = {
  TON: 4,
  STON: 6,
  tsTON: 6,
  UTYA: 6,
  MAJOR: 6,
  REDO: 6,
};
let snapshotCache = null;
let snapshotCacheExpiresAtMs = 0;
let snapshotInflight = null;

function toSnapshotMap(items) {
  return new Map(items.map((item) => [item.asset, item]));
}

function normalizePrice(raw, asset) {
  const precision = PRECISION_BY_ASSET[asset] ?? 6;
  return Number(raw).toFixed(precision);
}

async function fetchLiveSnapshots() {
  const response = await fetch(`${STON_API_BASE}/v1/assets`);
  if (!response.ok) {
    throw new Error(`STON API returned HTTP ${response.status}`);
  }

  const payload = await response.json();
  const capturedAt = new Date().toISOString();

  return SUPPORTED_ASSETS.map((asset) => {
    const match = payload.asset_list.find(
      (item) =>
        item.symbol === asset &&
        item.default_symbol === true &&
        item.dex_price_usd,
    );

    if (!match?.dex_price_usd) {
      throw new Error(`No STON API snapshot for ${asset}`);
    }

    return {
      asset,
      priceUsd: normalizePrice(match.dex_price_usd, asset),
      source: "ston.fi",
      capturedAt,
      contractAddress: match.contract_address ?? null,
    };
  });
}

export async function getAssetSnapshots() {
  const nowMs = Date.now();
  if (snapshotCache && snapshotCacheExpiresAtMs > nowMs) {
    return snapshotCache;
  }

  if (snapshotInflight) {
    return snapshotInflight;
  }

  snapshotInflight = (async () => {
    try {
      const snapshots = await fetchLiveSnapshots();
      snapshotCache = snapshots;
      snapshotCacheExpiresAtMs = Date.now() + SNAPSHOT_CACHE_TTL_MS;
      return snapshots;
    } catch (error) {
      const fallback = fallbackSnapshots.map((item) => ({
        ...item,
        fallback: true,
        error: error instanceof Error ? error.message : String(error),
      }));
      snapshotCache = fallback;
      snapshotCacheExpiresAtMs = Date.now() + SNAPSHOT_CACHE_TTL_MS;
      return fallback;
    } finally {
      snapshotInflight = null;
    }
  })();

  return snapshotInflight;
}

export async function getAssetSnapshotMap() {
  return toSnapshotMap(await getAssetSnapshots());
}

export async function getThresholdPresets(asset, direction = "above") {
  const snapshotMap = await getAssetSnapshotMap();
  const snapshot = snapshotMap.get(asset);
  if (!snapshot) {
    return { currentPrice: null, thresholds: [] };
  }

  const current = Number(snapshot.priceUsd);
  const precision = PRECISION_BY_ASSET[asset] ?? 6;
  const multipliers =
    direction === "below" ? [0.995, 0.99, 0.985] : [1.005, 1.01, 1.015];
  const thresholds = multipliers.map((multiplier) =>
    (current * multiplier).toFixed(precision),
  );

  return {
    currentPrice: snapshot.priceUsd,
    currentPriceLabel: `$${formatUsd(snapshot.priceUsd)}`,
    thresholds,
  };
}
