import { calculateSpreadBps, getMinimumSourceCount } from "./marketResolvePolicy.js";
import { getResolutionQuoteCandidates } from "./stonApi.js";
import { formatPrice6 } from "./tonForecastMarket.js";
import { incrementMetric, recordRuntimeEvent, setGauge } from "./runtimeMetrics.js";

const DEFAULT_MONITOR_ASSET = "TON";
const DEFAULT_MAX_SPREAD_BPS = 100n;
const MONITOR_CACHE_TTL_MS = 15_000;

const monitorCache = new Map();
const monitorInflight = new Map();

function normalizeBigInt(value) {
  return typeof value === "bigint" ? value : BigInt(value);
}

export function summarizeSourceMonitor(assetIdText = DEFAULT_MONITOR_ASSET, quotes = [], options = {}) {
  const normalizedQuotes = Array.isArray(quotes)
    ? quotes
        .filter((quote) => quote?.source && quote?.finalPrice != null)
        .map((quote) => ({
          source: String(quote.source),
          finalPrice: normalizeBigInt(quote.finalPrice),
          capturedAt: quote.capturedAt ?? new Date().toISOString(),
        }))
    : [];

  const minimumSourceCount = getMinimumSourceCount(assetIdText);
  const maxSpreadBps = normalizeBigInt(options.maxSpreadBps ?? DEFAULT_MAX_SPREAD_BPS);
  const spreadBps = calculateSpreadBps(normalizedQuotes);
  const withinSpread = spreadBps <= maxSpreadBps;
  const hasEnoughSources = normalizedQuotes.length >= minimumSourceCount;

  let status = "ok";
  let reason = "";

  if (!hasEnoughSources) {
    status = "warn";
    reason = `Need at least ${minimumSourceCount} source(s), got ${normalizedQuotes.length}`;
  } else if (!withinSpread) {
    status = "warn";
    reason = `Spread ${spreadBps}bps exceeds ${maxSpreadBps}bps`;
  }

  return {
    assetIdText,
    status,
    ok: hasEnoughSources && withinSpread,
    reason,
    sourceCount: normalizedQuotes.length,
    minimumSourceCount,
    spreadBps,
    maxSpreadBps,
    quotes: normalizedQuotes.map((quote) => ({
      source: quote.source,
      finalPrice: quote.finalPrice,
      priceLabel: `$${formatPrice6(quote.finalPrice)}`,
      capturedAt: quote.capturedAt,
    })),
    summary: normalizedQuotes.map((quote) => `${quote.source}:$${formatPrice6(quote.finalPrice)}`).join(" | "),
    generatedAt: new Date().toISOString(),
  };
}

function updateMonitorMetrics(snapshot) {
  setGauge("resolver_source_spread_bps", Number(snapshot.spreadBps), { asset: snapshot.assetIdText });
  setGauge("resolver_source_count", snapshot.sourceCount, { asset: snapshot.assetIdText });
  setGauge(
    "resolver_source_monitor_ok",
    snapshot.ok ? 1 : 0,
    { asset: snapshot.assetIdText },
  );
  incrementMetric("resolver_source_monitor_checks_total", 1, { asset: snapshot.assetIdText, status: snapshot.status });

  if (!snapshot.ok) {
    recordRuntimeEvent("resolver-source-monitor-warn", {
      asset: snapshot.assetIdText,
      reason: snapshot.reason,
      spreadBps: Number(snapshot.spreadBps),
      sourceCount: snapshot.sourceCount,
      minimumSourceCount: snapshot.minimumSourceCount,
      summary: snapshot.summary,
    });
  }
}

export async function getSourceMonitorSnapshot(assetIdText = DEFAULT_MONITOR_ASSET, options = {}) {
  const normalizedAsset = String(assetIdText || DEFAULT_MONITOR_ASSET).trim().toUpperCase();
  const cacheKey = `${normalizedAsset}:${String(options.maxSpreadBps ?? DEFAULT_MAX_SPREAD_BPS)}`;
  const nowMs = Date.now();
  const cached = monitorCache.get(cacheKey);
  if (cached && cached.expiresAtMs > nowMs) {
    return cached.snapshot;
  }

  if (monitorInflight.has(cacheKey)) {
    return monitorInflight.get(cacheKey);
  }

  const nextPromise = (async () => {
    try {
      const snapshot = summarizeSourceMonitor(
        normalizedAsset,
        await getResolutionQuoteCandidates(normalizedAsset),
        options,
      );
      updateMonitorMetrics(snapshot);
      monitorCache.set(cacheKey, {
        snapshot,
        expiresAtMs: Date.now() + MONITOR_CACHE_TTL_MS,
      });
      return snapshot;
    } finally {
      monitorInflight.delete(cacheKey);
    }
  })();

  monitorInflight.set(cacheKey, nextPromise);
  return nextPromise;
}
