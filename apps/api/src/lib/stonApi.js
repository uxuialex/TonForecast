import { SUPPORTED_ASSETS, formatAssetUsd, getAssetUsdPrecision } from "../../../../packages/shared/src/index.js";
import { assetSnapshots as fallbackSnapshots } from "../data/mockMarkets.js";
import { getAssetIconUrl } from "./assets.js";
import { ensureRuntimeEnvLoaded } from "./runtimeEnv.js";

const STON_API_BASE = "https://api.ston.fi";
const CMC_API_BASE = "https://pro-api.coinmarketcap.com";
const EXTERNAL_FETCH_TIMEOUT_MS = 4_000;
const CMC_SLUG_BY_ASSET = {
  TON: "toncoin",
};
const SNAPSHOT_CACHE_TTL_MS = 15_000;
let snapshotCache = null;
let snapshotCacheExpiresAtMs = 0;
let snapshotInflight = null;

function toSnapshotMap(items) {
  return new Map(items.map((item) => [item.asset, item]));
}

function normalizePrice(raw, asset) {
  const precision = getAssetUsdPrecision(asset);
  return Number(raw).toFixed(precision);
}

function snapshotToResolutionQuote(snapshot) {
  if (!snapshot?.asset || snapshot.priceUsd == null) {
    return null;
  }

  return {
    asset: snapshot.asset,
    source: snapshot.source,
    finalPrice: BigInt(Math.round(Number(snapshot.priceUsd) * 1_000_000)),
    capturedAt: snapshot.capturedAt ?? new Date().toISOString(),
    contractAddress: snapshot.contractAddress ?? null,
  };
}

function getCmcApiKey() {
  ensureRuntimeEnvLoaded();
  return process.env.CMC_API_KEY?.trim() || undefined;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = EXTERNAL_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Fetch timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function extractCmcQuote(payload, expectedSlug) {
  const values = Object.values(payload?.data ?? {});
  const rows = values.flatMap((value) => (Array.isArray(value) ? value : value ? [value] : []));
  return rows.find(
    (item) =>
      item &&
      typeof item === "object" &&
      item.slug === expectedSlug &&
      item.quote?.USD?.price != null,
  ) ?? null;
}

async function fetchCmcSnapshot(asset) {
  const apiKey = getCmcApiKey();
  const slug = CMC_SLUG_BY_ASSET[asset];
  if (!apiKey || !slug) {
    return null;
  }

  const response = await fetchWithTimeout(
    `${CMC_API_BASE}/v2/cryptocurrency/quotes/latest?slug=${encodeURIComponent(slug)}&convert=USD`,
    {
      headers: {
        Accept: "application/json",
        "X-CMC_PRO_API_KEY": apiKey,
      },
    },
  );

  if (!response.ok) {
    throw new Error(`CMC API returned HTTP ${response.status}`);
  }

  const payload = await response.json();
  const match = extractCmcQuote(payload, slug);
  if (!match?.quote?.USD?.price) {
    throw new Error(`No CMC quote found for ${asset}`);
  }

  return {
    asset,
    priceUsd: normalizePrice(match.quote.USD.price, asset),
    source: "coinmarketcap",
    capturedAt: new Date().toISOString(),
    contractAddress: null,
    iconUrl: getAssetIconUrl(asset),
  };
}

async function fetchStonAssetsPayload() {
  const response = await fetchWithTimeout(`${STON_API_BASE}/v1/assets`);
  if (!response.ok) {
    throw new Error(`STON API returned HTTP ${response.status}`);
  }

  return response.json();
}

function buildStonSnapshotFromPayload(payload, asset, capturedAt = new Date().toISOString()) {
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
    iconUrl: getAssetIconUrl(asset),
  };
}

async function fetchLiveSnapshots() {
  const [payload, tonCmcSnapshot] = await Promise.all([
    fetchStonAssetsPayload(),
    fetchCmcSnapshot("TON").catch((error) => {
      console.warn(`[api] CMC TON price failed, fallback to STON: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }),
  ]);
  const capturedAt = new Date().toISOString();

  return SUPPORTED_ASSETS.map((asset) => {
    if (asset === "TON" && tonCmcSnapshot) {
      return tonCmcSnapshot;
    }

    return buildStonSnapshotFromPayload(payload, asset, capturedAt);
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
        iconUrl: item.iconUrl ?? getAssetIconUrl(item.asset),
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

export async function getResolutionQuoteCandidates(asset) {
  const [stonResult, cmcResult] = await Promise.allSettled([
    fetchStonAssetsPayload().then((payload) => buildStonSnapshotFromPayload(payload, asset)),
    asset === "TON" ? fetchCmcSnapshot(asset) : Promise.resolve(null),
  ]);

  const quotes = [];

  if (stonResult.status === "fulfilled") {
    const quote = snapshotToResolutionQuote(stonResult.value);
    if (quote) {
      quotes.push(quote);
    }
  }

  if (cmcResult.status === "fulfilled" && cmcResult.value) {
    const quote = snapshotToResolutionQuote(cmcResult.value);
    if (quote) {
      quotes.push(quote);
    }
  }

  return quotes;
}

export async function getThresholdPresets(asset, direction = "above") {
  const snapshotMap = await getAssetSnapshotMap();
  const snapshot = snapshotMap.get(asset);
  if (!snapshot) {
    return { currentPrice: null, thresholds: [] };
  }

  const current = Number(snapshot.priceUsd);
  const precision = getAssetUsdPrecision(asset);
  const multipliers =
    direction === "below" ? [0.995, 0.99, 0.985] : [1.005, 1.01, 1.015];
  const thresholds = multipliers.map((multiplier) =>
    (current * multiplier).toFixed(precision),
  );

  return {
    currentPrice: snapshot.priceUsd,
    currentPriceLabel: `$${formatAssetUsd(snapshot.priceUsd, asset)}`,
    thresholds,
  };
}
