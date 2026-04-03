import fs from "node:fs";
import path from "node:path";

const runtimeDir = path.resolve(process.cwd(), "apps/api/data/runtime");
const runtimeFile = path.join(runtimeDir, "markets.json");
const pendingCreates = new Map();
const PENDING_TTL_MS = 2 * 60 * 1000;

function ensureStore() {
  fs.mkdirSync(runtimeDir, { recursive: true });
  if (!fs.existsSync(runtimeFile)) {
    fs.writeFileSync(runtimeFile, JSON.stringify({ version: 1, markets: [] }, null, 2));
  }
}

function readStore() {
  ensureStore();
  return JSON.parse(fs.readFileSync(runtimeFile, "utf8"));
}

function writeStore(store) {
  ensureStore();
  fs.writeFileSync(runtimeFile, JSON.stringify(store, null, 2));
}

function cleanupPendingCreates() {
  const nowMs = Date.now();
  for (const [key, value] of pendingCreates.entries()) {
    if (value.expiresAtMs <= nowMs) {
      pendingCreates.delete(key);
    }
  }
}

export function listMarketRecords() {
  return readStore().markets ?? [];
}

export function getMarketRecord(contractAddress) {
  return listMarketRecords().find((item) => item.contractAddress === contractAddress) ?? null;
}

export function saveMarketRecord(record) {
  const store = readStore();
  const items = store.markets ?? [];
  const existingIndex = items.findIndex((item) => item.contractAddress === record.contractAddress);

  if (existingIndex >= 0) {
    items[existingIndex] = {
      ...items[existingIndex],
      ...record,
    };
  } else {
    items.unshift(record);
  }

  writeStore({
    ...store,
    markets: items,
  });

  return record;
}

export function reservePendingCreate(record) {
  cleanupPendingCreates();
  pendingCreates.set(record.contractAddress, {
    ...record,
    expiresAtMs: Date.now() + PENDING_TTL_MS,
  });
  return record;
}

export function consumePendingCreate(contractAddress) {
  cleanupPendingCreates();
  const pending = pendingCreates.get(contractAddress) ?? null;
  if (pending) {
    pendingCreates.delete(contractAddress);
  }
  return pending;
}

export function listPendingCreates() {
  cleanupPendingCreates();
  return [...pendingCreates.values()];
}

export function findBlockingCreate(asset, durationSec, nowSec = Math.floor(Date.now() / 1000)) {
  const duration = Number(durationSec);
  const persisted = listMarketRecords().find(
    (item) =>
      item.asset === asset &&
      Number(item.durationSec) === duration &&
      Number(item.closeAt) > nowSec,
  );

  if (persisted) {
    return persisted;
  }

  cleanupPendingCreates();
  return (
    listPendingCreates().find(
      (item) =>
        item.asset === asset &&
        Number(item.durationSec) === duration &&
        Number(item.closeAt) > nowSec,
    ) ?? null
  );
}

