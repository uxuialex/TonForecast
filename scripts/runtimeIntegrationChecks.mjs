import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const projectRoot = path.resolve(import.meta.dirname, "..");
const originalCwd = process.cwd();
const sampleContract = "EQD1dCBqi2fMi31ijxu-pMgVUJW68_VMZW-Dh8OtzVzAyBJA";

async function importFresh(relativePath) {
  const absolutePath = path.resolve(projectRoot, relativePath);
  return import(`${pathToFileURL(absolutePath).href}?t=${Date.now()}-${Math.random()}`);
}

async function withTempRuntimeDir(callback) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ton-forecast-runtime-"));
  try {
    process.chdir(tempDir);
    fs.mkdirSync(path.join(tempDir, "apps/api/data/runtime"), { recursive: true });
    return await callback(tempDir);
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testRuntimeEnvFailover() {
  await withTempRuntimeDir(async () => {
    process.env.TON_API_ENDPOINTS = "https://rpc-one.invalid,https://rpc-two.invalid";
    process.env.TON_API_ENDPOINT = "https://rpc-one.invalid";
    process.env.TON_RPC_FAILURE_THRESHOLD = "1";
    process.env.TON_RPC_COOLDOWN_MS = "60000";

    const runtimeEnv = await importFresh("apps/api/src/lib/runtimeEnv.js");
    const winner = await runtimeEnv.withTonClientFailover(
      "integration_test",
      async (_client, provider) => {
        if (provider.id === "rpc1") {
          throw new Error("network timeout");
        }
        return provider.id;
      },
    );

    assert.equal(winner, "rpc2");
    const snapshot = runtimeEnv.getTonRpcPoolSnapshot();
    assert.equal(snapshot.length, 2);
    assert.equal(snapshot[0].id, "rpc1");
    assert.equal(snapshot[0].blocked, true);
    assert.equal(snapshot[1].id, "rpc2");
    assert.ok(snapshot[1].successes >= 1);
    assert.equal(runtimeEnv.getTreasuryAddress(sampleContract), sampleContract);

    process.env.TREASURY_ADDRESS = sampleContract;
    const runtimeEnvWithTreasury = await importFresh("apps/api/src/lib/runtimeEnv.js");
    assert.equal(runtimeEnvWithTreasury.getTreasuryAddress(""), sampleContract);

    delete process.env.TON_API_ENDPOINTS;
    delete process.env.TON_API_ENDPOINT;
    delete process.env.TON_RPC_FAILURE_THRESHOLD;
    delete process.env.TON_RPC_COOLDOWN_MS;
    delete process.env.TREASURY_ADDRESS;
  });
}

async function testResolvePolicyConsensus() {
  const resolvePolicy = await importFresh("apps/api/src/lib/marketResolvePolicy.js");

  const okDecision = resolvePolicy.evaluateResolutionQuotes({
    assetIdText: "TON",
    direction: 0,
    threshold: 1_000_000n,
    quotes: [
      { source: "ston.fi", finalPrice: 1_010_000n },
      { source: "coinmarketcap", finalPrice: 1_011_000n },
    ],
  });
  assert.equal(okDecision.ok, true);
  assert.equal(okDecision.outcome, 1);

  const disagreement = resolvePolicy.evaluateResolutionQuotes({
    assetIdText: "TON",
    direction: 0,
    threshold: 1_000_000n,
    quotes: [
      { source: "ston.fi", finalPrice: 999_000n },
      { source: "coinmarketcap", finalPrice: 1_001_000n },
    ],
  });
  assert.equal(disagreement.ok, false);

  const insufficient = resolvePolicy.evaluateResolutionQuotes({
    assetIdText: "TON",
    direction: 0,
    threshold: 1_000_000n,
    quotes: [{ source: "ston.fi", finalPrice: 1_010_000n }],
  });
  assert.equal(insufficient.ok, false);
}

async function testRuntimeStoreMigrationAndBackup() {
  await withTempRuntimeDir(async (tempDir) => {
    fs.writeFileSync(
      path.join(tempDir, "apps/api/data/runtime/markets.json"),
      JSON.stringify(
        {
          version: 4,
          markets: [
            {
              contractAddress: sampleContract,
              marketId: "1",
              asset: "TON",
              durationSec: 300,
              createdAt: 1,
              closeAt: 2,
              resolveAt: 3,
              threshold: 1.2,
              direction: "above",
              ownerAddress: sampleContract,
              resolverAddress: sampleContract,
              treasuryAddress: sampleContract,
              lastKnownStatus: "RESOLVED_DRAW",
              lastKnownYesPool: 1,
              lastKnownNoPool: 1,
              lastKnownFinalPrice: 1.2,
              lastKnownOutcome: "DRAW",
            },
          ],
          userMarketIndex: {
            "0:test-user": [sampleContract],
          },
          userPositionSnapshots: {},
        },
        null,
        2,
      ),
    );

    const registry = await importFresh("apps/api/src/lib/marketRegistry.js");
    const records = registry.listMarketRecords();
    assert.equal(records.length, 1);
    assert.equal(records[0].contractAddress, sampleContract);

    const snapshot = registry.saveUserPositionSnapshot("0:test-user", [
      {
        id: `${sampleContract}:0:test-user`,
        contractAddress: sampleContract,
        userAddress: "0:test-user",
        marketId: sampleContract,
        createdAt: 1,
      },
    ]);

    assert.equal(snapshot.items.length, 1);
    assert.equal(registry.getIndexedMarketRecordsForUser("0:test-user").length, 1);

    registry.appendAdminAuditEntry({
      actor: "integration-test",
      action: "market.hide",
      contractAddress: sampleContract,
      details: { reason: "legacy test" },
    });

    const backup = registry.exportRuntimeBackup("integration");
    assert.equal(fs.existsSync(backup.filePath), true);

    const stats = registry.getRuntimeStoreStats();
    assert.equal(stats.marketCount, 1);
    assert.equal(stats.auditEntryCount, 1);
    assert.equal(stats.userSnapshotCount, 1);
  });
}

async function testServerAdminRoutes() {
  await withTempRuntimeDir(async () => {
    process.env.ADMIN_TOKEN = "secret-token";
    process.env.ADMIN_ALLOWED_WALLETS = sampleContract;
    const registry = await importFresh("apps/api/src/lib/marketRegistry.js");
    registry.saveMarketRecord({
      contractAddress: sampleContract,
      marketId: "1",
      asset: "TON",
      durationSec: 300,
      createdAt: 1,
      closeAt: 2,
      resolveAt: 3,
      threshold: 1.2,
      direction: "above",
      ownerAddress: sampleContract,
      resolverAddress: sampleContract,
      treasuryAddress: sampleContract,
      lastKnownStatus: "RESOLVED_DRAW",
      lastKnownYesPool: 1,
      lastKnownNoPool: 1,
      lastKnownFinalPrice: 1.2,
      lastKnownOutcome: "DRAW",
    });

    const { handleRequest } = await importFresh("apps/api/src/server.js");

    const sessionResponse = await handleRequest(
        new Request("http://localhost/api/admin/session", {
        headers: { "x-admin-token": "secret-token", "x-admin-wallet": sampleContract },
      }),
    );
    assert.equal(sessionResponse.status, 200);

    const updateResponse = await handleRequest(
      new Request(`http://localhost/api/admin/markets/${sampleContract}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-admin-token": "secret-token",
          "x-admin-wallet": sampleContract,
          "x-admin-actor": "integration-test",
        },
        body: JSON.stringify({
          hidden: true,
          hiddenReason: "cleanup",
          legacy: true,
          legacyReason: "old bytecode",
        }),
      }),
    );
    assert.equal(updateResponse.status, 200);

    const updatedRecord = registry.getMarketRecord(sampleContract);
    assert.ok(updatedRecord.adminHiddenAt);
    assert.ok(updatedRecord.adminLegacyFlagAt);

    const healthResponse = await handleRequest(new Request("http://localhost/api/runtime/health"));
    assert.equal(healthResponse.status, 200);
    const healthPayload = await healthResponse.json();
    assert.equal(healthPayload.ok, true);
    assert.equal(healthPayload.runtimeStore.marketCount, 1);

    const auditResponse = await handleRequest(
      new Request("http://localhost/api/admin/audit-log?limit=5", {
        headers: { "x-admin-token": "secret-token", "x-admin-wallet": sampleContract },
      }),
    );
    assert.equal(auditResponse.status, 200);
    const auditPayload = await auditResponse.json();
    assert.ok(auditPayload.items.length >= 1);
    assert.equal(auditPayload.items[0].action, "market.flags");
    assert.equal(auditPayload.items[0].actor, `wallet:${sampleContract}`);

    delete process.env.ADMIN_TOKEN;
    delete process.env.ADMIN_ALLOWED_WALLETS;
  });
}

await testRuntimeEnvFailover();
await testResolvePolicyConsensus();
await testRuntimeStoreMigrationAndBackup();
await testServerAdminRoutes();

console.log("runtime integration checks passed");
