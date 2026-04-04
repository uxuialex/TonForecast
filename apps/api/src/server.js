import { timingSafeEqual } from "node:crypto";
import { readAssetIcon } from "./lib/assets.js";
import {
  appendAdminAuditEntry,
  exportRuntimeBackup,
  getRuntimeStoreStats,
  listAdminAuditEntries,
  saveMarketRecord,
} from "./lib/marketRegistry.js";
import {
  bootstrapAutoResolvers,
  getAutoResolverStatus,
  retryAutoResolve,
} from "./lib/resolverAutomation.js";
import {
  confirmCreate,
  createBetIntent,
  createClaimIntent,
  createMarketIntent,
  getCreateContext,
} from "./lib/marketActions.js";
import {
  ensureRuntimeEnvLoaded,
  getAdminAllowedWallets,
  getAdminToken,
  getTonRpcPoolSnapshot,
} from "./lib/runtimeEnv.js";
import { getSourceMonitorSnapshot } from "./lib/sourceMonitor.js";
import { getAssetSnapshots } from "./lib/stonApi.js";
import {
  getMarketById,
  getPositionForUser,
  invalidateMarketViewCache,
  listAdminMarkets,
  listMarkets,
  listPositions,
  listUserMarkets,
} from "./lib/marketReadModel.js";
import { getRuntimeMetricsSnapshot } from "./lib/runtimeMetrics.js";
import { parseAddress } from "./lib/tonForecastMarket.js";

function json(body, init = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init.headers ?? {}),
    },
  });
}

function errorResponse(error) {
  const status = error?.statusCode ?? 500;
  return json(
    {
      error: error instanceof Error ? error.message : String(error),
    },
    { status },
  );
}

function requireAdmin(request) {
  const configuredToken = getAdminToken();
  if (!configuredToken) {
    throw Object.assign(new Error("Admin token is not configured"), { statusCode: 404 });
  }

  const providedToken = request.headers.get("x-admin-token")?.trim();
  if (!tokensMatch(providedToken, configuredToken)) {
    throw Object.assign(new Error("Admin access denied"), { statusCode: 403 });
  }

  const providedWallet = request.headers.get("x-admin-wallet")?.trim();
  const normalizedWallet = normalizeWalletCandidate(providedWallet);
  if (!isAdminWalletAllowed(normalizedWallet)) {
    throw Object.assign(new Error("Admin wallet is not allowed"), { statusCode: 403 });
  }

  return normalizedWallet;
}

function getAdminActor(adminWallet) {
  return adminWallet ? `wallet:${adminWallet}` : "miniapp-admin";
}

function tokensMatch(providedToken, configuredToken) {
  if (!providedToken || !configuredToken) {
    return false;
  }

  const provided = Buffer.from(String(providedToken));
  const configured = Buffer.from(String(configuredToken));
  if (provided.length !== configured.length) {
    return false;
  }

  return timingSafeEqual(provided, configured);
}

function normalizeWalletCandidate(value) {
  try {
    return parseAddress(String(value ?? "").trim()).toString();
  } catch {
    return "";
  }
}

function getAllowedAdminWalletSet() {
  return new Set(
    getAdminAllowedWallets()
      .map((value) => normalizeWalletCandidate(value))
      .filter(Boolean),
  );
}

function isAdminWalletAllowed(userAddress) {
  const normalizedWallet = normalizeWalletCandidate(userAddress);
  if (!normalizedWallet) {
    return false;
  }

  return getAllowedAdminWalletSet().has(normalizedWallet);
}

function buildRuntimeHealthPayload() {
  return {
    ok: true,
    service: "api",
    runtimeStore: getRuntimeStoreStats(),
    tonRpcPool: getTonRpcPoolSnapshot(),
    autoResolver: getAutoResolverStatus(),
  };
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw Object.assign(new Error("Invalid JSON body"), { statusCode: 400 });
  }
}

ensureRuntimeEnvLoaded();
bootstrapAutoResolvers();

export async function handleRequest(request) {
  const url = new URL(request.url);

  try {
    if (url.pathname === "/healthz") {
      return json(buildRuntimeHealthPayload());
    }

    if (url.pathname === "/api/runtime/health") {
      return json(buildRuntimeHealthPayload());
    }

    if (url.pathname.startsWith("/api/assets/icons/")) {
      const asset = decodeURIComponent(url.pathname.split("/").pop() ?? "");
      const icon = await readAssetIcon(asset);
      if (!icon) {
        return json({ error: "Asset icon not found" }, { status: 404 });
      }

      return new Response(icon.body, {
        headers: {
          "content-type": icon.contentType,
          "cache-control": "public, max-age=60, stale-while-revalidate=3600",
        },
      });
    }

    if (url.pathname === "/api/prices") {
      return json({ items: await getAssetSnapshots() });
    }

    if (url.pathname === "/api/markets") {
      const status = url.searchParams.get("status") ?? undefined;
      return json({ items: await listMarkets(status) });
    }

    if (url.pathname.startsWith("/api/markets/")) {
      const marketId = url.pathname.split("/").pop() ?? "";
      const market = await getMarketById(marketId);
      if (!market) {
        return json({ error: "Market not found" }, { status: 404 });
      }

      return json(market);
    }

    if (url.pathname === "/api/my-markets") {
      const userAddress = url.searchParams.get("userAddress");
      if (!userAddress) {
        return json({ error: "userAddress is required" }, { status: 400 });
      }

      return json({ items: await listUserMarkets(userAddress) });
    }

    if (url.pathname === "/api/admin/session") {
      requireAdmin(request);
      return json({ ok: true });
    }

    if (url.pathname === "/api/admin/eligibility") {
      const userAddress = url.searchParams.get("userAddress");
      if (!userAddress) {
        return json({ allowed: false });
      }

      return json({ allowed: isAdminWalletAllowed(userAddress) });
    }

    if (url.pathname === "/api/admin/markets") {
      requireAdmin(request);
      const status = url.searchParams.get("status") ?? undefined;
      return json({ items: await listAdminMarkets(status) });
    }

    if (url.pathname === "/api/admin/audit-log") {
      requireAdmin(request);
      const limit = Number(url.searchParams.get("limit") ?? 100);
      return json({ items: listAdminAuditEntries(limit) });
    }

    if (url.pathname === "/api/admin/metrics") {
      requireAdmin(request);
      return json(
        getRuntimeMetricsSnapshot({
          runtimeStore: getRuntimeStoreStats(),
          tonRpcPool: getTonRpcPoolSnapshot(),
          autoResolver: getAutoResolverStatus(),
          sourceMonitor: await getSourceMonitorSnapshot("TON"),
        }),
      );
    }

    if (url.pathname === "/api/admin/source-monitor") {
      requireAdmin(request);
      const asset = url.searchParams.get("asset") ?? "TON";
      return json(await getSourceMonitorSnapshot(asset));
    }

    if (url.pathname === "/api/admin/runtime/backup" && request.method === "POST") {
      const adminWallet = requireAdmin(request);
      const body = await readJson(request);
      const backup = exportRuntimeBackup(body.reason ?? "admin");
      appendAdminAuditEntry({
        actor: getAdminActor(adminWallet),
        action: "runtime.backup",
        details: backup,
      });
      return json(backup);
    }

    if (url.pathname.endsWith("/retry-resolve") && request.method === "POST") {
      const adminWallet = requireAdmin(request);
      const contractAddress = parseAddress(
        decodeURIComponent(url.pathname.split("/").slice(-2)[0] ?? ""),
      ).toString();
      saveMarketRecord({
        contractAddress,
        autoResolveBlockedAt: null,
        autoResolveBlockedReason: "",
      });
      invalidateMarketViewCache();
      retryAutoResolve(contractAddress, 1_000);
      appendAdminAuditEntry({
        actor: getAdminActor(adminWallet),
        action: "market.retry_resolve",
        contractAddress,
      });
      return json({ ok: true, contractAddress });
    }

    if (url.pathname.endsWith("/auto-resolve-block") && request.method === "POST") {
      const adminWallet = requireAdmin(request);
      const contractAddress = parseAddress(
        decodeURIComponent(url.pathname.split("/").slice(-2)[0] ?? ""),
      ).toString();
      const body = await readJson(request);
      const nowSec = Math.floor(Date.now() / 1000);
      const nextRecord = saveMarketRecord({
        contractAddress,
        autoResolveBlockedAt: body.blocked === false ? null : nowSec,
        autoResolveBlockedReason:
          body.blocked === false ? "" : String(body.reason ?? "").trim(),
      });
      invalidateMarketViewCache();
      appendAdminAuditEntry({
        actor: getAdminActor(adminWallet),
        action: body.blocked === false ? "market.unblock_auto_resolve" : "market.block_auto_resolve",
        contractAddress,
        details: {
          blocked: body.blocked !== false,
          reason: body.blocked === false ? "" : String(body.reason ?? "").trim(),
        },
      });
      return json(nextRecord);
    }

    if (url.pathname.startsWith("/api/admin/markets/") && request.method === "POST") {
      const adminWallet = requireAdmin(request);
      const contractAddress = parseAddress(
        decodeURIComponent(url.pathname.split("/").pop() ?? ""),
      ).toString();
      const body = await readJson(request);
      const nowSec = Math.floor(Date.now() / 1000);
      const nextRecord = saveMarketRecord({
        contractAddress,
        adminHiddenAt: body.hidden === true ? nowSec : null,
        adminHiddenReason:
          body.hidden === true ? String(body.hiddenReason ?? "").trim() : "",
        adminLegacyFlagAt: body.legacy === true ? nowSec : null,
        adminLegacyReason:
          body.legacy === true ? String(body.legacyReason ?? "").trim() : "",
      });
      invalidateMarketViewCache();
      appendAdminAuditEntry({
        actor: getAdminActor(adminWallet),
        action: "market.flags",
        contractAddress,
        details: {
          hidden: body.hidden === true,
          hiddenReason: body.hidden === true ? String(body.hiddenReason ?? "").trim() : "",
          legacy: body.legacy === true,
          legacyReason: body.legacy === true ? String(body.legacyReason ?? "").trim() : "",
        },
      });
      return json(nextRecord);
    }

    if (url.pathname === "/api/positions") {
      const userAddress = url.searchParams.get("userAddress");
      const fresh = url.searchParams.get("fresh") === "1";
      const full = url.searchParams.get("full") === "1";
      const cachedOnly = url.searchParams.get("cached") === "1";
      if (!userAddress) {
        return json({ error: "userAddress is required" }, { status: 400 });
      }

      return json({ items: await listPositions(userAddress, { fresh, full, cachedOnly }) });
    }

    if (url.pathname.startsWith("/api/positions/market/")) {
      const contractAddress = decodeURIComponent(url.pathname.split("/").pop() ?? "");
      const userAddress = url.searchParams.get("userAddress");
      const fresh = url.searchParams.get("fresh") === "1";
      if (!userAddress) {
        return json({ error: "userAddress is required" }, { status: 400 });
      }

      return json({
        item: await getPositionForUser(contractAddress, userAddress, { fresh }),
      });
    }

    if (url.pathname === "/api/create-context") {
      const asset = url.searchParams.get("asset");
      const durationSec = url.searchParams.get("durationSec");
      return json(await getCreateContext(asset, durationSec));
    }

    if (url.pathname === "/api/actions/create-intent" && request.method === "POST") {
      return json(await createMarketIntent(await readJson(request)));
    }

    if (url.pathname === "/api/actions/create-confirm" && request.method === "POST") {
      const body = await readJson(request);
      return json(await confirmCreate(body.contractAddress));
    }

    if (url.pathname === "/api/actions/bet-intent" && request.method === "POST") {
      return json(await createBetIntent(await readJson(request)));
    }

    if (url.pathname === "/api/actions/claim-intent" && request.method === "POST") {
      return json(await createClaimIntent(await readJson(request)));
    }

    return json({ error: "Not found" }, { status: 404 });
  } catch (error) {
    return errorResponse(error);
  }
}
