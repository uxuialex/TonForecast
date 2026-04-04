import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const pendingCreates = new Map();
const PENDING_TTL_MS = 2 * 60 * 1000;
const DEFAULT_BACKUP_RETENTION_COUNT = 20;
const DEFAULT_BACKUP_RETENTION_DAYS = 14;
const DEFAULT_AUDIT_RETENTION_COUNT = 5_000;
const DEFAULT_AUDIT_RETENTION_DAYS = 30;

let db = null;
let dbFilePath = null;

function getRuntimeDir() {
  return path.resolve(process.cwd(), "apps/api/data/runtime");
}

function getLegacyRuntimeFile() {
  return path.join(getRuntimeDir(), "markets.json");
}

function getRuntimeDbFile() {
  return path.join(getRuntimeDir(), "markets.db");
}

function getRuntimeBackupDir() {
  return path.join(getRuntimeDir(), "backups");
}

function createEmptyStore() {
  return { version: 5, markets: [], userMarketIndex: {}, userPositionSnapshots: {} };
}

function ensureRuntimeDir() {
  fs.mkdirSync(getRuntimeDir(), { recursive: true });
  fs.mkdirSync(getRuntimeBackupDir(), { recursive: true });
}

function readLegacyStore() {
  const legacyRuntimeFile = getLegacyRuntimeFile();
  if (!fs.existsSync(legacyRuntimeFile)) {
    return createEmptyStore();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(legacyRuntimeFile, "utf8"));
    return {
      ...createEmptyStore(),
      ...parsed,
      markets: Array.isArray(parsed.markets) ? parsed.markets : [],
      userMarketIndex:
        parsed.userMarketIndex && typeof parsed.userMarketIndex === "object"
          ? parsed.userMarketIndex
          : {},
      userPositionSnapshots:
        parsed.userPositionSnapshots && typeof parsed.userPositionSnapshots === "object"
          ? parsed.userPositionSnapshots
          : {},
    };
  } catch (error) {
    console.warn(
      `[api] failed to read legacy runtime store: ${error instanceof Error ? error.message : String(error)}`,
    );
    return createEmptyStore();
  }
}

function uniqueNonEmpty(values) {
  return [...new Set((values ?? []).filter(Boolean))];
}

function readPositiveEnvInt(name, fallback) {
  const numeric = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallback;
  }

  return Math.floor(numeric);
}

function getBackupRetentionCount() {
  return readPositiveEnvInt("RUNTIME_BACKUP_RETENTION_COUNT", DEFAULT_BACKUP_RETENTION_COUNT);
}

function getBackupRetentionDays() {
  return readPositiveEnvInt("RUNTIME_BACKUP_RETENTION_DAYS", DEFAULT_BACKUP_RETENTION_DAYS);
}

function getAuditRetentionCount() {
  return readPositiveEnvInt("RUNTIME_AUDIT_RETENTION_COUNT", DEFAULT_AUDIT_RETENTION_COUNT);
}

function getAuditRetentionDays() {
  return readPositiveEnvInt("RUNTIME_AUDIT_RETENTION_DAYS", DEFAULT_AUDIT_RETENTION_DAYS);
}

function getRuntimeBackupEntries() {
  ensureRuntimeDir();
  const runtimeBackupDir = getRuntimeBackupDir();
  return fs
    .readdirSync(runtimeBackupDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => {
      const filePath = path.join(runtimeBackupDir, entry.name);
      const stats = fs.statSync(filePath);
      return {
        fileName: entry.name,
        filePath,
        sizeBytes: stats.size,
        modifiedAt: stats.mtime.toISOString(),
        modifiedAtMs: stats.mtimeMs,
      };
    })
    .sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
}

function pruneRuntimeBackups() {
  const backups = getRuntimeBackupEntries();
  const retentionCount = getBackupRetentionCount();
  const retentionDays = getBackupRetentionDays();
  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let removed = 0;

  backups.forEach((entry, index) => {
    const removeByCount = index >= retentionCount;
    const removeByAge = entry.modifiedAtMs < cutoffMs;
    if (!removeByCount && !removeByAge) {
      return;
    }

    fs.rmSync(entry.filePath, { force: true });
    removed += 1;
  });

  return removed;
}

function pruneAdminAuditLog(database) {
  const retentionCount = getAuditRetentionCount();
  const retentionDays = getAuditRetentionDays();
  const cutoffSec = Math.floor(Date.now() / 1000) - retentionDays * 24 * 60 * 60;

  database.prepare(`
    DELETE FROM admin_audit_log
    WHERE created_at < ?
  `).run(cutoffSec);

  database.prepare(`
    DELETE FROM admin_audit_log
    WHERE id NOT IN (
      SELECT id
      FROM admin_audit_log
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    )
  `).run(retentionCount);
}

function getDb() {
  const nextDbFilePath = getRuntimeDbFile();
  if (db && dbFilePath === nextDbFilePath) {
    return db;
  }

  if (db && dbFilePath !== nextDbFilePath) {
    try {
      db.close();
    } catch {
      // Ignore close errors when switching runtime roots in tests.
    }
    db = null;
  }

  ensureRuntimeDir();
  db = new Database(nextDbFilePath);
  dbFilePath = nextDbFilePath;
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS markets (
      contract_address TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL DEFAULT 0,
      payload TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_markets_created_at
      ON markets(created_at DESC);

    CREATE TABLE IF NOT EXISTS user_market_index (
      user_address TEXT NOT NULL,
      contract_address TEXT NOT NULL,
      PRIMARY KEY (user_address, contract_address)
    );

    CREATE INDEX IF NOT EXISTS idx_user_market_index_user
      ON user_market_index(user_address);

    CREATE TABLE IF NOT EXISTS user_position_snapshots (
      user_address TEXT PRIMARY KEY,
      synced_at INTEGER NOT NULL DEFAULT 0,
      items_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS admin_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at INTEGER NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      contract_address TEXT,
      details_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_admin_audit_log_created_at
      ON admin_audit_log(created_at DESC, id DESC);
  `);

  migrateLegacyStore(db);
  return db;
}

function withTransaction(task) {
  const database = getDb();
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = task(database);
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function migrateLegacyStore(database) {
  const migrated = database
    .prepare(`SELECT value FROM meta WHERE key = 'runtime_store_version'`)
    .get();
  if (migrated?.value) {
    return;
  }

  const existingCount = database.prepare("SELECT COUNT(*) AS count FROM markets").get().count;
  const legacyStore = readLegacyStore();

  withTransaction((tx) => {
    if (existingCount === 0) {
      const upsertMarket = tx.prepare(`
        INSERT INTO markets (contract_address, created_at, payload)
        VALUES (?, ?, ?)
        ON CONFLICT(contract_address) DO UPDATE SET
          created_at = excluded.created_at,
          payload = excluded.payload
      `);

      for (const record of legacyStore.markets ?? []) {
        if (!record?.contractAddress) {
          continue;
        }
        upsertMarket.run(
          record.contractAddress,
          Number(record.createdAt ?? 0),
          JSON.stringify(record),
        );
      }

      const insertUserMarketIndex = tx.prepare(`
        INSERT OR IGNORE INTO user_market_index (user_address, contract_address)
        VALUES (?, ?)
      `);

      for (const [userAddress, contractAddresses] of Object.entries(legacyStore.userMarketIndex ?? {})) {
        for (const contractAddress of uniqueNonEmpty(contractAddresses)) {
          insertUserMarketIndex.run(userAddress, contractAddress);
        }
      }

      const upsertSnapshot = tx.prepare(`
        INSERT INTO user_position_snapshots (user_address, synced_at, items_json)
        VALUES (?, ?, ?)
        ON CONFLICT(user_address) DO UPDATE SET
          synced_at = excluded.synced_at,
          items_json = excluded.items_json
      `);

      for (const [userAddress, entry] of Object.entries(legacyStore.userPositionSnapshots ?? {})) {
        const normalizedEntry = Array.isArray(entry)
          ? { items: entry, syncedAt: 0 }
          : entry && typeof entry === "object"
            ? entry
            : { items: [], syncedAt: 0 };

        upsertSnapshot.run(
          userAddress,
          Number(normalizedEntry.syncedAt ?? 0),
          JSON.stringify(Array.isArray(normalizedEntry.items) ? normalizedEntry.items : []),
        );
      }
    }

    tx.prepare(`
      INSERT INTO meta (key, value)
      VALUES ('runtime_store_version', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(String(createEmptyStore().version));
  });
}

function rowToMarketRecord(row) {
  if (!row?.payload) {
    return null;
  }

  try {
    const parsed = JSON.parse(row.payload);
    return {
      ...parsed,
      contractAddress: parsed.contractAddress ?? row.contract_address,
      createdAt: Number(parsed.createdAt ?? row.created_at ?? 0),
    };
  } catch (error) {
    console.warn(
      `[api] failed to parse market record ${row.contract_address}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

function getStoredMarketRecord(contractAddress) {
  const row = getDb()
    .prepare("SELECT contract_address, created_at, payload FROM markets WHERE contract_address = ?")
    .get(contractAddress);
  return rowToMarketRecord(row);
}

function upsertMarketRecord(database, record) {
  database.prepare(`
    INSERT INTO markets (contract_address, created_at, payload)
    VALUES (?, ?, ?)
    ON CONFLICT(contract_address) DO UPDATE SET
      created_at = excluded.created_at,
      payload = excluded.payload
  `).run(
    record.contractAddress,
    Number(record.createdAt ?? 0),
    JSON.stringify(record),
  );
}

function cleanupPendingCreates() {
  const nowMs = Date.now();
  for (const [key, value] of pendingCreates.entries()) {
    if (value.expiresAtMs <= nowMs) {
      pendingCreates.delete(key);
    }
  }
}

function getAllUserMarketIndex() {
  const grouped = {};
  const rows = getDb().prepare(`
    SELECT user_address, contract_address
    FROM user_market_index
    ORDER BY user_address ASC, contract_address ASC
  `).all();

  for (const row of rows) {
    if (!grouped[row.user_address]) {
      grouped[row.user_address] = [];
    }
    grouped[row.user_address].push(row.contract_address);
  }

  return grouped;
}

function getAllUserPositionSnapshots() {
  const grouped = {};
  const rows = getDb().prepare(`
    SELECT user_address, synced_at, items_json
    FROM user_position_snapshots
    ORDER BY user_address ASC
  `).all();

  for (const row of rows) {
    let items = [];
    try {
      items = JSON.parse(row.items_json ?? "[]");
    } catch {
      items = [];
    }

    grouped[row.user_address] = {
      syncedAt: Number(row.synced_at ?? 0),
      items: Array.isArray(items) ? items : [],
    };
  }

  return grouped;
}

function normalizeImportedStore(payload) {
  return {
    version: Number(payload?.version ?? createEmptyStore().version),
    markets: Array.isArray(payload?.markets) ? payload.markets.filter((item) => item?.contractAddress) : [],
    userMarketIndex:
      payload?.userMarketIndex && typeof payload.userMarketIndex === "object"
        ? payload.userMarketIndex
        : {},
    userPositionSnapshots:
      payload?.userPositionSnapshots && typeof payload.userPositionSnapshots === "object"
        ? payload.userPositionSnapshots
        : {},
    adminAuditLog: Array.isArray(payload?.adminAuditLog) ? payload.adminAuditLog : [],
  };
}

function replaceRuntimeStore(database, store) {
  database.prepare("DELETE FROM markets").run();
  database.prepare("DELETE FROM user_market_index").run();
  database.prepare("DELETE FROM user_position_snapshots").run();
  database.prepare("DELETE FROM admin_audit_log").run();

  const upsertMarket = database.prepare(`
    INSERT INTO markets (contract_address, created_at, payload)
    VALUES (?, ?, ?)
    ON CONFLICT(contract_address) DO UPDATE SET
      created_at = excluded.created_at,
      payload = excluded.payload
  `);

  for (const record of store.markets) {
    upsertMarket.run(
      record.contractAddress,
      Number(record.createdAt ?? 0),
      JSON.stringify(record),
    );
  }

  const insertUserMarketIndex = database.prepare(`
    INSERT OR IGNORE INTO user_market_index (user_address, contract_address)
    VALUES (?, ?)
  `);
  for (const [userAddress, contractAddresses] of Object.entries(store.userMarketIndex)) {
    for (const contractAddress of uniqueNonEmpty(contractAddresses)) {
      insertUserMarketIndex.run(userAddress, contractAddress);
    }
  }

  const upsertSnapshot = database.prepare(`
    INSERT INTO user_position_snapshots (user_address, synced_at, items_json)
    VALUES (?, ?, ?)
    ON CONFLICT(user_address) DO UPDATE SET
      synced_at = excluded.synced_at,
      items_json = excluded.items_json
  `);
  for (const [userAddress, entry] of Object.entries(store.userPositionSnapshots)) {
    const normalizedEntry = Array.isArray(entry)
      ? { items: entry, syncedAt: 0 }
      : entry && typeof entry === "object"
        ? entry
        : { items: [], syncedAt: 0 };

    upsertSnapshot.run(
      userAddress,
      Number(normalizedEntry.syncedAt ?? 0),
      JSON.stringify(Array.isArray(normalizedEntry.items) ? normalizedEntry.items : []),
    );
  }

  const insertAuditEntry = database.prepare(`
    INSERT INTO admin_audit_log (created_at, actor, action, contract_address, details_json)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const entry of store.adminAuditLog) {
    const action = String(entry?.action ?? "").trim();
    if (!action) {
      continue;
    }

    insertAuditEntry.run(
      Number(entry.createdAt ?? 0),
      String(entry.actor ?? "restore"),
      action,
      entry.contractAddress ?? null,
      JSON.stringify(entry.details ?? {}),
    );
  }

  database.prepare(`
    INSERT INTO meta (key, value)
    VALUES ('runtime_store_version', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(String(store.version || createEmptyStore().version));
}

export function listMarketRecords() {
  const rows = getDb().prepare(`
    SELECT contract_address, created_at, payload
    FROM markets
    ORDER BY created_at DESC, contract_address DESC
  `).all();

  return rows.map((row) => rowToMarketRecord(row)).filter(Boolean);
}

export function getMarketRecord(contractAddress) {
  return getStoredMarketRecord(contractAddress) ?? null;
}

export function saveMarketRecord(record) {
  if (!record?.contractAddress) {
    return null;
  }

  const existing = getStoredMarketRecord(record.contractAddress);
  const nextRecord = existing
    ? {
        ...existing,
        ...record,
      }
    : {
        ...record,
      };

  withTransaction((tx) => {
    upsertMarketRecord(tx, nextRecord);
  });

  return nextRecord;
}

export function saveMarketRecords(records) {
  const normalizedRecords = Array.isArray(records)
    ? records.filter((record) => record?.contractAddress)
    : [];

  if (!normalizedRecords.length) {
    return [];
  }

  const mergedRecords = [];
  withTransaction((tx) => {
    for (const record of normalizedRecords) {
      const existingRow = tx.prepare(`
        SELECT contract_address, created_at, payload
        FROM markets
        WHERE contract_address = ?
      `).get(record.contractAddress);
      const existingRecord = rowToMarketRecord(existingRow);
      const nextRecord = existingRecord
        ? {
            ...existingRecord,
            ...record,
          }
        : {
            ...record,
          };

      upsertMarketRecord(tx, nextRecord);
      mergedRecords.push(nextRecord);
    }
  });

  return mergedRecords;
}

export function rememberUserMarket(contractAddress, userAddress) {
  if (!contractAddress || !userAddress) {
    return null;
  }

  const existingRecord = getStoredMarketRecord(contractAddress);
  if (!existingRecord) {
    return null;
  }

  const nextRecord = {
    ...existingRecord,
    participantAddresses: uniqueNonEmpty([
      ...(Array.isArray(existingRecord.participantAddresses) ? existingRecord.participantAddresses : []),
      userAddress,
    ]),
  };

  withTransaction((tx) => {
    upsertMarketRecord(tx, nextRecord);
    tx.prepare(`
      INSERT OR IGNORE INTO user_market_index (user_address, contract_address)
      VALUES (?, ?)
    `).run(userAddress, contractAddress);
  });

  return nextRecord;
}

export function getIndexedMarketRecordsForUser(userAddress) {
  if (!userAddress) {
    return [];
  }

  const byAddress = new Map();
  const database = getDb();
  const indexedRows = database.prepare(`
    SELECT contract_address
    FROM user_market_index
    WHERE user_address = ?
  `).all(userAddress);

  for (const row of indexedRows) {
    const record = getStoredMarketRecord(row.contract_address);
    if (record) {
      byAddress.set(record.contractAddress, record);
    }
  }

  for (const record of listMarketRecords()) {
    if (Array.isArray(record.participantAddresses) && record.participantAddresses.includes(userAddress)) {
      byAddress.set(record.contractAddress, record);
    }
  }

  return [...byAddress.values()].sort(
    (left, right) => Number(right.createdAt ?? 0) - Number(left.createdAt ?? 0),
  );
}

export function getUserPositionSnapshot(userAddress) {
  if (!userAddress) {
    return null;
  }

  const row = getDb().prepare(`
    SELECT synced_at, items_json
    FROM user_position_snapshots
    WHERE user_address = ?
  `).get(userAddress);

  if (!row) {
    return null;
  }

  let items = [];
  try {
    items = JSON.parse(row.items_json ?? "[]");
  } catch (error) {
    console.warn(
      `[api] failed to parse user position snapshot for ${userAddress}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return {
    items: Array.isArray(items) ? items : [],
    syncedAt: Number(row.synced_at ?? 0),
  };
}

export function saveUserPositionSnapshot(userAddress, items) {
  if (!userAddress) {
    return null;
  }

  const normalizedItems = Array.isArray(items)
    ? items.filter((item) => item?.id && item?.contractAddress)
    : [];

  const syncedAt = Math.floor(Date.now() / 1000);
  const nextUserContracts = uniqueNonEmpty(normalizedItems.map((item) => item.contractAddress));

  withTransaction((tx) => {
    tx.prepare(`
      INSERT INTO user_position_snapshots (user_address, synced_at, items_json)
      VALUES (?, ?, ?)
      ON CONFLICT(user_address) DO UPDATE SET
        synced_at = excluded.synced_at,
        items_json = excluded.items_json
    `).run(userAddress, syncedAt, JSON.stringify(normalizedItems));

    const insertIndex = tx.prepare(`
      INSERT OR IGNORE INTO user_market_index (user_address, contract_address)
      VALUES (?, ?)
    `);

    for (const contractAddress of nextUserContracts) {
      insertIndex.run(userAddress, contractAddress);
    }
  });

  return {
    items: normalizedItems,
    syncedAt,
  };
}

export function appendAdminAuditEntry({ actor = "admin", action, contractAddress = null, details = {} }) {
  const normalizedAction = String(action ?? "").trim();
  if (!normalizedAction) {
    return null;
  }

  const createdAt = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify(details ?? {});
  const result = withTransaction((tx) => {
    const insertResult = tx.prepare(`
      INSERT INTO admin_audit_log (created_at, actor, action, contract_address, details_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(createdAt, String(actor || "admin"), normalizedAction, contractAddress, payload);
    pruneAdminAuditLog(tx);
    return insertResult;
  });

  return {
    id: Number(result.lastInsertRowid ?? 0),
    createdAt,
    actor: String(actor || "admin"),
    action: normalizedAction,
    contractAddress,
    details,
  };
}

export function listAdminAuditEntries(limit = 100) {
  const normalizedLimit = Math.max(1, Math.min(500, Number(limit) || 100));
  const rows = getDb().prepare(`
    SELECT id, created_at, actor, action, contract_address, details_json
    FROM admin_audit_log
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(normalizedLimit);

  return rows.map((row) => {
    let details = {};
    try {
      details = JSON.parse(row.details_json ?? "{}");
    } catch {
      details = {};
    }

    return {
      id: Number(row.id ?? 0),
      createdAt: Number(row.created_at ?? 0),
      actor: row.actor,
      action: row.action,
      contractAddress: row.contract_address ?? null,
      details,
    };
  });
}

export function getRuntimeStoreStats() {
  const database = getDb();
  const runtimeDbFile = getRuntimeDbFile();
  const backupEntries = getRuntimeBackupEntries();
  return {
    dbFile: runtimeDbFile,
    dbFileSizeBytes: fs.existsSync(runtimeDbFile) ? fs.statSync(runtimeDbFile).size : 0,
    marketCount: Number(database.prepare("SELECT COUNT(*) AS count FROM markets").get().count ?? 0),
    userMarketIndexCount: Number(
      database.prepare("SELECT COUNT(*) AS count FROM user_market_index").get().count ?? 0,
    ),
    userSnapshotCount: Number(
      database.prepare("SELECT COUNT(*) AS count FROM user_position_snapshots").get().count ?? 0,
    ),
    auditEntryCount: Number(
      database.prepare("SELECT COUNT(*) AS count FROM admin_audit_log").get().count ?? 0,
    ),
    backupCount: backupEntries.length,
    backupRetentionCount: getBackupRetentionCount(),
    backupRetentionDays: getBackupRetentionDays(),
    auditRetentionCount: getAuditRetentionCount(),
    auditRetentionDays: getAuditRetentionDays(),
  };
}

export function exportRuntimeBackup(reason = "manual") {
  ensureRuntimeDir();
  const runtimeBackupDir = getRuntimeBackupDir();
  const safeReason = String(reason ?? "manual")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "") || "manual";
  const createdAt = new Date();
  const fileName = `runtime-${createdAt.toISOString().replaceAll(":", "-")}-${safeReason}.json`;
  const filePath = path.join(runtimeBackupDir, fileName);
  const payload = {
    version: createEmptyStore().version,
    exportedAt: createdAt.toISOString(),
    reason: safeReason,
    storeStats: getRuntimeStoreStats(),
    markets: listMarketRecords(),
    userMarketIndex: getAllUserMarketIndex(),
    userPositionSnapshots: getAllUserPositionSnapshots(),
    adminAuditLog: listAdminAuditEntries(500),
  };

  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
  pruneRuntimeBackups();

  return {
    filePath,
    fileName,
    exportedAt: payload.exportedAt,
    reason: safeReason,
    marketCount: payload.markets.length,
    userCount: Object.keys(payload.userMarketIndex).length,
  };
}

export function listRuntimeBackups(limit = 12) {
  pruneRuntimeBackups();
  const normalizedLimit = Math.max(1, Math.min(100, Number(limit) || 12));
  return getRuntimeBackupEntries()
    .map(({ modifiedAtMs, ...entry }) => entry)
    .slice(0, normalizedLimit);
}

export function restoreRuntimeBackup(fileName) {
  ensureRuntimeDir();
  const runtimeBackupDir = getRuntimeBackupDir();
  const normalizedFileName = path.basename(String(fileName ?? "").trim());
  if (!normalizedFileName || normalizedFileName.includes("..")) {
    throw new Error("backup fileName is required");
  }

  const filePath = path.join(runtimeBackupDir, normalizedFileName);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Backup not found: ${normalizedFileName}`);
  }

  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(
      `Failed to read backup ${normalizedFileName}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const backupBeforeRestore = exportRuntimeBackup("pre-restore");
  const normalizedStore = normalizeImportedStore(payload);
  withTransaction((tx) => {
    replaceRuntimeStore(tx, normalizedStore);
    pruneAdminAuditLog(tx);
  });
  pruneRuntimeBackups();

  return {
    fileName: normalizedFileName,
    filePath,
    restoredAt: new Date().toISOString(),
    backupBeforeRestore: backupBeforeRestore.fileName,
    marketCount: normalizedStore.markets.length,
    userCount: Object.keys(normalizedStore.userMarketIndex).length,
    auditEntryCount: normalizedStore.adminAuditLog.length,
  };
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

export function findBlockingCreate(
  asset,
  durationSec,
  nowSec = Math.floor(Date.now() / 1000),
  direction = "above",
) {
  const duration = Number(durationSec);
  const normalizedDirection = String(direction ?? "above").trim().toLowerCase();
  const persisted = listMarketRecords().find(
    (item) =>
      !item.createFailedAt &&
      item.asset === asset &&
      Number(item.durationSec) === duration &&
      String(item.direction ?? "above").trim().toLowerCase() === normalizedDirection &&
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
        String(item.direction ?? "above").trim().toLowerCase() === normalizedDirection &&
        Number(item.closeAt) > nowSec,
    ) ?? null
  );
}
