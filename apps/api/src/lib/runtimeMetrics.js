const counters = new Map();
const gauges = new Map();
const recentEvents = [];
const MAX_RECENT_EVENTS = 100;

function normalizeTags(tags = {}) {
  return Object.entries(tags)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
}

function metricKey(name, tags = {}) {
  const normalizedTags = normalizeTags(tags);
  if (!normalizedTags.length) {
    return name;
  }

  return `${name}{${normalizedTags.map(([key, value]) => `${key}=${value}`).join(",")}}`;
}

export function incrementMetric(name, value = 1, tags = {}) {
  const key = metricKey(name, tags);
  counters.set(key, (counters.get(key) ?? 0) + Number(value || 0));
}

export function setGauge(name, value, tags = {}) {
  gauges.set(metricKey(name, tags), Number(value || 0));
}

export function recordRuntimeEvent(name, payload = {}) {
  recentEvents.unshift({
    name,
    payload,
    createdAt: new Date().toISOString(),
  });
  if (recentEvents.length > MAX_RECENT_EVENTS) {
    recentEvents.length = MAX_RECENT_EVENTS;
  }
}

export function getRuntimeMetricsSnapshot(extra = {}) {
  return {
    generatedAt: new Date().toISOString(),
    counters: Object.fromEntries([...counters.entries()].sort(([left], [right]) => left.localeCompare(right))),
    gauges: Object.fromEntries([...gauges.entries()].sort(([left], [right]) => left.localeCompare(right))),
    recentEvents: [...recentEvents],
    ...extra,
  };
}

export function resetRuntimeMetrics() {
  counters.clear();
  gauges.clear();
  recentEvents.length = 0;
}
