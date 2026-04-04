import { listMarketRecords, saveMarketRecord } from "./marketRegistry.js";
import {
  AUTO_RESOLVE_BLOCKED_EXIT_CODE,
  BLOCKED_PREFIX,
  runAutoResolveJob,
} from "./marketAutoResolver.js";
import { logError, logInfo, logWarn } from "./runtimeLogger.js";
import { incrementMetric, setGauge } from "./runtimeMetrics.js";

const scheduledResolvers = new Map();
const runningResolvers = new Set();
const queuedResolvers = [];
const resolverRetryCounts = new Map();
const INITIAL_DELAY_MS = 10_000;
const MAX_RETRY_DELAY_MS = 60_000;
const AUTO_RESOLVE_LOOKAHEAD_SEC = 10 * 60;
const AUTO_RESOLVE_SWEEP_INTERVAL_MS = 60_000;
const AUTO_RESOLVE_WATCHDOG_INTERVAL_MS = 30_000;
const AUTO_RESOLVE_STALL_MS = 3 * 60_000;
const MAX_PARALLEL_AUTO_RESOLVERS = 1;
let sweepTimer = null;
let watchdogTimer = null;
let lastSweepAtMs = 0;
let lastSweepCandidateCount = 0;
let lastSweepError = "";
const runningResolverMeta = new Map();

function syncResolverMetrics() {
  setGauge("auto_resolver_scheduled", scheduledResolvers.size);
  setGauge("auto_resolver_running", runningResolvers.size);
  setGauge("auto_resolver_queued", queuedResolvers.length);
  setGauge("auto_resolver_retrying", resolverRetryCounts.size);
}

function getStalledResolvers(nowMs = Date.now()) {
  return [...runningResolverMeta.entries()]
    .filter(([, value]) => nowMs - Number(value.startedAtMs ?? 0) >= AUTO_RESOLVE_STALL_MS)
    .map(([marketAddress, value]) => ({
      marketAddress,
      startedAt: value.startedAtMs,
      runningForMs: nowMs - Number(value.startedAtMs ?? 0),
    }));
}

function getResolverIssues() {
  const issues = [];
  if (!sweepTimer) {
    issues.push("sweep_timer_missing");
  }
  if (lastSweepError) {
    issues.push("last_sweep_failed");
  }
  if (getStalledResolvers().length) {
    issues.push("stalled_jobs");
  }
  return issues;
}

function ensureResolverWatchdog() {
  if (watchdogTimer) {
    return;
  }

  watchdogTimer = setInterval(() => {
    const stalledResolvers = getStalledResolvers();
    if (stalledResolvers.length) {
      incrementMetric("auto_resolver_watchdog_stall_total", stalledResolvers.length);
      logWarn("resolver.watchdog.stalled", {
        stalledMarkets: stalledResolvers.map((item) => item.marketAddress),
        stallThresholdMs: AUTO_RESOLVE_STALL_MS,
      });
    }
  }, AUTO_RESOLVE_WATCHDOG_INTERVAL_MS);

  watchdogTimer.unref?.();
}

function getRetryDelayMs(marketAddress) {
  const nextAttempt = (resolverRetryCounts.get(marketAddress) ?? 0) + 1;
  resolverRetryCounts.set(marketAddress, nextAttempt);
  syncResolverMetrics();
  return Math.min(MAX_RETRY_DELAY_MS, 5_000 * nextAttempt);
}

function clearScheduledResolver(marketAddress) {
  const scheduled = scheduledResolvers.get(marketAddress);
  if (!scheduled) {
    return;
  }

  clearTimeout(scheduled.timer);
  scheduledResolvers.delete(marketAddress);
  syncResolverMetrics();
}

function enqueueResolver(marketAddress) {
  if (!marketAddress || runningResolvers.has(marketAddress) || queuedResolvers.includes(marketAddress)) {
    return;
  }

  queuedResolvers.push(marketAddress);
  syncResolverMetrics();
  void pumpResolverQueue();
}

async function pumpResolverQueue() {
  while (runningResolvers.size < MAX_PARALLEL_AUTO_RESOLVERS && queuedResolvers.length) {
    const marketAddress = queuedResolvers.shift();
    if (!marketAddress || runningResolvers.has(marketAddress)) {
      continue;
    }

    runningResolvers.add(marketAddress);
    runningResolverMeta.set(marketAddress, { startedAtMs: Date.now() });
    syncResolverMetrics();
    logInfo("resolver.job.started", {
      marketAddress,
      queued: queuedResolvers.length,
      running: runningResolvers.size,
    });

    void runAutoResolveJob(marketAddress)
      .then((result) => {
        if (result.status === "blocked") {
          incrementMetric("auto_resolver_result_total", 1, { status: "blocked" });
          resolverRetryCounts.delete(marketAddress);
          saveMarketRecord({
            contractAddress: marketAddress,
            autoResolveBlockedAt: Math.floor(Date.now() / 1000),
            autoResolveBlockedReason:
              String(result.reason ?? "").replace(BLOCKED_PREFIX, "").trim() ||
              "Permanent auto-resolve failure detected",
          });
          logWarn("resolver.job.blocked", {
            marketAddress,
            reason: result.reason || "permanent failure",
          });
          return;
        }

        if (result.status === "retry") {
          incrementMetric("auto_resolver_result_total", 1, { status: "retry" });
          const retryDelayMs = Number(result.delayMs ?? getRetryDelayMs(marketAddress));
          logWarn("resolver.job.retry", {
            marketAddress,
            delayMs: retryDelayMs,
            reason: result.reason || "retry requested",
          });
          scheduleAutoResolve(marketAddress, retryDelayMs);
          return;
        }

        resolverRetryCounts.delete(marketAddress);
        incrementMetric("auto_resolver_result_total", 1, { status: result.status });
        logInfo("resolver.job.completed", {
          marketAddress,
          result: result.status,
          reason: result.reason || "completed",
        });
      })
      .catch((error) => {
        incrementMetric("auto_resolver_result_total", 1, { status: "error" });
        const retryDelayMs = getRetryDelayMs(marketAddress);
        const message = error instanceof Error ? error.message : String(error);
        logError("resolver.job.failed", {
          marketAddress,
          delayMs: retryDelayMs,
          reason: message,
        });
        scheduleAutoResolve(marketAddress, retryDelayMs);
      })
      .finally(() => {
        runningResolvers.delete(marketAddress);
        runningResolverMeta.delete(marketAddress);
        syncResolverMetrics();
        void pumpResolverQueue();
      });
  }
}

export function scheduleAutoResolve(marketAddress, delayMs = INITIAL_DELAY_MS) {
  if (!marketAddress || runningResolvers.has(marketAddress) || queuedResolvers.includes(marketAddress)) {
    return;
  }

  const nextDueAt = Date.now() + Math.max(1_000, delayMs);
  const existing = scheduledResolvers.get(marketAddress);
  if (existing && existing.dueAtMs <= nextDueAt) {
    return;
  }

  clearScheduledResolver(marketAddress);

  const timer = setTimeout(() => {
    scheduledResolvers.delete(marketAddress);
    syncResolverMetrics();
    enqueueResolver(marketAddress);
  }, Math.max(1_000, delayMs));

  timer.unref?.();
  scheduledResolvers.set(marketAddress, {
    timer,
    dueAtMs: nextDueAt,
  });
  syncResolverMetrics();
}

function isResolvedRecord(record) {
  return typeof record?.lastKnownStatus === "string" && record.lastKnownStatus.startsWith("RESOLVED");
}

function isAutoResolvableRecord(record, nowSec) {
  if (
    !record?.contractAddress ||
    record.createFailedAt ||
    record.autoResolveBlockedAt ||
    isResolvedRecord(record)
  ) {
    return false;
  }

  const resolveAt = Number(record.resolveAt ?? 0);
  if (!Number.isFinite(resolveAt) || resolveAt <= 0) {
    return false;
  }

  return resolveAt <= nowSec + AUTO_RESOLVE_LOOKAHEAD_SEC;
}

function getAutoResolveDelayMs(record, nowSec) {
  const resolveAt = Number(record.resolveAt ?? 0);
  if (!Number.isFinite(resolveAt) || resolveAt <= nowSec) {
    return 1_000;
  }

  return Math.max(1_000, (resolveAt - nowSec) * 1_000 + 1_000);
}

export function scheduleAutoResolveForRecord(record, nowSec = Math.floor(Date.now() / 1000)) {
  if (!isAutoResolvableRecord(record, nowSec)) {
    return false;
  }

  scheduleAutoResolve(record.contractAddress, getAutoResolveDelayMs(record, nowSec));
  return true;
}

export function runAutoResolverSweep() {
  const nowSec = Math.floor(Date.now() / 1000);
  const candidates = listMarketRecords()
    .filter((record) => isAutoResolvableRecord(record, nowSec))
    .sort((left, right) => Number(left.resolveAt) - Number(right.resolveAt));

  for (const record of candidates) {
    scheduleAutoResolveForRecord(record, nowSec);
  }

  lastSweepAtMs = Date.now();
  lastSweepCandidateCount = candidates.length;
  lastSweepError = "";
  incrementMetric("auto_resolver_sweep_total", 1);
  setGauge("auto_resolver_sweep_candidates", candidates.length);
  logInfo("resolver.sweep.completed", {
    candidateCount: candidates.length,
    scheduled: scheduledResolvers.size,
    queued: queuedResolvers.length,
    running: runningResolvers.size,
  });
  return candidates.length;
}

export function bootstrapAutoResolvers() {
  runAutoResolverSweep();

  if (sweepTimer) {
    return;
  }

  sweepTimer = setInterval(() => {
    try {
      runAutoResolverSweep();
    } catch (error) {
      lastSweepError = error instanceof Error ? error.message : String(error);
      logError("resolver.sweep.failed", {
        reason: lastSweepError,
      });
    }
  }, AUTO_RESOLVE_SWEEP_INTERVAL_MS);

  sweepTimer.unref?.();
  ensureResolverWatchdog();
  syncResolverMetrics();
}

export { AUTO_RESOLVE_BLOCKED_EXIT_CODE };

export function retryAutoResolve(contractAddress, delayMs = 1_000) {
  const normalizedAddress = String(contractAddress ?? "").trim();
  if (!normalizedAddress) {
    return false;
  }

  resolverRetryCounts.delete(normalizedAddress);
  clearScheduledResolver(normalizedAddress);
  scheduleAutoResolve(normalizedAddress, delayMs);
  incrementMetric("auto_resolver_manual_retry_total", 1);
  return true;
}

export function getAutoResolverStatus() {
  const stalledResolvers = getStalledResolvers();
  const issues = getResolverIssues();
  return {
    healthy: issues.length === 0,
    issues,
    scheduled: scheduledResolvers.size,
    running: runningResolvers.size,
    queued: queuedResolvers.length,
    retrying: resolverRetryCounts.size,
    sweepActive: Boolean(sweepTimer),
    watchdogActive: Boolean(watchdogTimer),
    sweepIntervalMs: AUTO_RESOLVE_SWEEP_INTERVAL_MS,
    watchdogIntervalMs: AUTO_RESOLVE_WATCHDOG_INTERVAL_MS,
    lastSweepAt: lastSweepAtMs ? new Date(lastSweepAtMs).toISOString() : null,
    lastSweepCandidateCount,
    lastSweepError: lastSweepError || null,
    stalledMarkets: stalledResolvers,
    scheduledMarkets: [...scheduledResolvers.keys()],
    queuedMarkets: [...queuedResolvers],
    runningMarkets: [...runningResolvers],
  };
}
