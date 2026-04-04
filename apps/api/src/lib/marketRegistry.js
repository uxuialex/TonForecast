import fs from "node:fs";
import path from "node:path";

const runtimeDir = path.resolve(process.cwd(), "apps/api/data/runtime");
const runtimeFile = path.join(runtimeDir, "markets.json");
const pendingCreates = new Map();
const PENDING_TTL_MS = 2 * 60 * 1000;

function createEmptyStore() {
  return { version: 2, markets: [], userMarketIndex: {} };
}

function ensureStore() {
  fs.mkdirSync(runtimeDir, { recursive: true });
  if (!fs.existsSync(runtimeFile)) {
    fs.writeFileSync(runtimeFile, JSON.stringify(createEmptyStore(), null, 2));
  }
}

function readStore() {
  ensureStore();
  const parsed = JSON.parse(fs.readFileSync(runtimeFile, "utf8"));
  return {
    ...createEmptyStore(),
    ...parsed,
    markets: Array.isArray(parsed.markets) ? parsed.markets : [],
    userMarketIndex:
      parsed.userMarketIndex && typeof parsed.userMarketIndex === "object"
        ? parsed.userMarketIndex
        : {},
  };
}

function writeStore(store) {
  ensureStore();
  fs.writeFileSync(runtimeFile, JSON.stringify(store, null, 2));
}

function uniqueNonEmpty(values) {
  return [...new Set((values ?? []).filter(Boolean))];
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

export function rememberUserMarket(contractAddress, userAddress) {
  if (!contractAddress || !userAddress) {
    return null;
  }

  const store = readStore();
  const items = store.markets ?? [];
  const existingIndex = items.findIndex((item) => item.contractAddress === contractAddress);
  if (existingIndex < 0) {
    return null;
  }

  const existingRecord = items[existingIndex];
  const nextParticipantAddresses = uniqueNonEmpty([
    ...(Array.isArray(existingRecord.participantAddresses) ? existingRecord.participantAddresses : []),
    userAddress,
  ]);
  const nextUserContracts = uniqueNonEmpty([
    contractAddress,
    ...(((store.userMarketIndex ?? {})[userAddress]) ?? []),
  ]);

  items[existingIndex] = {
    ...existingRecord,
    participantAddresses: nextParticipantAddresses,
  };

  writeStore({
    ...store,
    markets: items,
    userMarketIndex: {
      ...(store.userMarketIndex ?? {}),
      [userAddress]: nextUserContracts,
    },
  });

  return items[existingIndex];
}

export function getIndexedMarketRecordsForUser(userAddress) {
  if (!userAddress) {
    return [];
  }

  const store = readStore();
  const items = store.markets ?? [];
  const byAddress = new Map();
  const indexedContracts = ((store.userMarketIndex ?? {})[userAddress]) ?? [];

  for (const contractAddress of indexedContracts) {
    const record = items.find((item) => item.contractAddress === contractAddress);
    if (record) {
      byAddress.set(record.contractAddress, record);
    }
  }

  for (const record of items) {
    if (Array.isArray(record.participantAddresses) && record.participantAddresses.includes(userAddress)) {
      byAddress.set(record.contractAddress, record);
    }
  }

  return [...byAddress.values()];
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
      !item.createFailedAt &&
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
