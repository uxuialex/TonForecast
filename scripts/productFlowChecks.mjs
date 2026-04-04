import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const projectRoot = path.resolve(import.meta.dirname, "..");
const originalCwd = process.cwd();
const sampleContract = "EQD1dCBqi2fMi31ijxu-pMgVUJW68_VMZW-Dh8OtzVzAyBJA";
const sampleUser = "EQD-PbGKh8fb3Ky1rzxXM78fsjcBr-12JQXp19LFq8K04-JF";

async function importFresh(relativePath) {
  const absolutePath = path.resolve(projectRoot, relativePath);
  return import(`${pathToFileURL(absolutePath).href}?t=${Date.now()}-${Math.random()}`);
}

async function withTempRuntimeDir(callback) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ton-forecast-product-"));
  try {
    process.chdir(tempDir);
    fs.mkdirSync(path.join(tempDir, "apps/api/data/runtime"), { recursive: true });
    return await callback(tempDir);
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function buildHeaders(extra = {}) {
  return {
    "x-forwarded-for": "10.10.10.10",
    ...extra,
  };
}

function createSampleMarket(contractAddress = sampleContract) {
  return {
    contractAddress,
    marketId: "1",
    asset: "TON",
    durationSec: 300,
    createdAt: 1,
    closeAt: 2,
    resolveAt: 3,
    threshold: 1.2,
    direction: "above",
    ownerAddress: sampleUser,
    resolverAddress: sampleUser,
    treasuryAddress: sampleUser,
    question: "Will TON be above $1.2000 in 5 min?",
    lastKnownStatus: "RESOLVED_DRAW",
    lastKnownYesPool: 1,
    lastKnownNoPool: 1,
    lastKnownFinalPrice: 1.2,
    lastKnownOutcome: "DRAW",
  };
}

async function testProductReadFlowAndRateLimits() {
  await withTempRuntimeDir(async () => {
    process.env.ADMIN_TOKEN = "secret-token";
    process.env.ADMIN_ALLOWED_WALLETS = sampleUser;
    process.env.BUILD_VERSION = "1.2.3";
    process.env.BUILD_COMMIT = "1234567890abcdef";
    process.env.BUILD_REF = "refs/tags/v1.2.3";
    process.env.BUILD_TIME = "2026-04-04T11:30:00Z";
    process.env.RATE_LIMIT_POSITIONS_LIMIT = "2";
    process.env.RATE_LIMIT_ADMIN_WRITE_LIMIT = "1";

    const registry = await importFresh("apps/api/src/lib/marketRegistry.js");
    const rateLimiter = await importFresh("apps/api/src/lib/rateLimiter.js");
    const { handleRequest } = await importFresh("apps/api/src/server.js");

    rateLimiter.resetRateLimiter();
    registry.saveMarketRecord(createSampleMarket());
    registry.saveUserPositionSnapshot(sampleUser, [
      {
        id: `${sampleContract}:${sampleUser}`,
        contractAddress: sampleContract,
        userAddress: sampleUser,
        marketId: sampleContract,
        createdAt: 1,
        claimable: true,
      },
    ]);

    const myMarketsResponse = await handleRequest(
      new Request(`http://localhost/api/my-markets?userAddress=${encodeURIComponent(sampleUser)}`, {
        headers: buildHeaders(),
      }),
    );
    assert.equal(myMarketsResponse.status, 200);
    const myMarketsPayload = await myMarketsResponse.json();
    assert.equal(myMarketsPayload.items.length, 1);

    const positionsUrl = `http://localhost/api/positions?userAddress=${encodeURIComponent(sampleUser)}&cached=1`;
    const positionsResponseOne = await handleRequest(
      new Request(positionsUrl, {
        headers: buildHeaders(),
      }),
    );
    assert.equal(positionsResponseOne.status, 200);
    assert.equal(positionsResponseOne.headers.get("x-ratelimit-limit"), "2");

    const positionsResponseTwo = await handleRequest(
      new Request(positionsUrl, {
        headers: buildHeaders(),
      }),
    );
    assert.equal(positionsResponseTwo.status, 200);

    const positionsResponseThree = await handleRequest(
      new Request(positionsUrl, {
        headers: buildHeaders(),
      }),
    );
    assert.equal(positionsResponseThree.status, 429);
    assert.ok(Number(positionsResponseThree.headers.get("retry-after") ?? 0) >= 1);

    const createContextResponse = await handleRequest(
      new Request("http://localhost/api/create-context?asset=TON&durationSec=300&direction=below", {
        headers: buildHeaders({ "x-forwarded-for": "10.10.10.20" }),
      }),
    );
    assert.equal(createContextResponse.status, 200);
    const createContextPayload = await createContextResponse.json();
    assert.equal(createContextPayload.direction, "below");
    assert.match(createContextPayload.question, /below/i);

    const adminWriteUrl = `http://localhost/api/admin/markets/${sampleContract}`;
    const adminWriteInit = {
      method: "POST",
      headers: buildHeaders({
        "content-type": "application/json",
        "x-admin-token": "secret-token",
        "x-admin-wallet": sampleUser,
        "x-forwarded-for": "10.10.10.30",
      }),
      body: JSON.stringify({
        hidden: true,
        hiddenReason: "product-check",
      }),
    };
    const adminWriteResponseOne = await handleRequest(new Request(adminWriteUrl, adminWriteInit));
    assert.equal(adminWriteResponseOne.status, 200);

    const adminWriteResponseTwo = await handleRequest(new Request(adminWriteUrl, adminWriteInit));
    assert.equal(adminWriteResponseTwo.status, 429);

    delete process.env.ADMIN_TOKEN;
    delete process.env.ADMIN_ALLOWED_WALLETS;
    delete process.env.BUILD_VERSION;
    delete process.env.BUILD_COMMIT;
    delete process.env.BUILD_REF;
    delete process.env.BUILD_TIME;
    delete process.env.RATE_LIMIT_POSITIONS_LIMIT;
    delete process.env.RATE_LIMIT_ADMIN_WRITE_LIMIT;
  });
}

async function testRetentionRotation() {
  await withTempRuntimeDir(async () => {
    process.env.RUNTIME_BACKUP_RETENTION_COUNT = "2";
    process.env.RUNTIME_BACKUP_RETENTION_DAYS = "365";
    process.env.RUNTIME_AUDIT_RETENTION_COUNT = "2";
    process.env.RUNTIME_AUDIT_RETENTION_DAYS = "365";

    const registry = await importFresh("apps/api/src/lib/marketRegistry.js");
    registry.saveMarketRecord(createSampleMarket(sampleContract));

    registry.exportRuntimeBackup("one");
    await new Promise((resolve) => setTimeout(resolve, 10));
    registry.exportRuntimeBackup("two");
    await new Promise((resolve) => setTimeout(resolve, 10));
    registry.exportRuntimeBackup("three");

    const backups = registry.listRuntimeBackups(10);
    assert.equal(backups.length, 2);
    assert.equal(backups.some((item) => item.fileName.includes("one")), false);

    registry.appendAdminAuditEntry({ actor: "test", action: "one" });
    registry.appendAdminAuditEntry({ actor: "test", action: "two" });
    registry.appendAdminAuditEntry({ actor: "test", action: "three" });

    const auditEntries = registry.listAdminAuditEntries(10);
    assert.equal(auditEntries.length, 2);
    assert.equal(auditEntries.some((item) => item.action === "one"), false);

    delete process.env.RUNTIME_BACKUP_RETENTION_COUNT;
    delete process.env.RUNTIME_BACKUP_RETENTION_DAYS;
    delete process.env.RUNTIME_AUDIT_RETENTION_COUNT;
    delete process.env.RUNTIME_AUDIT_RETENTION_DAYS;
  });
}

await testProductReadFlowAndRateLimits();
await testRetentionRotation();

console.log("product flow checks passed");
