import { readAssetIcon } from "./lib/assets.js";
import { bootstrapAutoResolvers } from "./lib/resolverAutomation.js";
import {
  confirmCreate,
  createBetIntent,
  createClaimIntent,
  createMarketIntent,
  getCreateContext,
} from "./lib/marketActions.js";
import { ensureRuntimeEnvLoaded } from "./lib/runtimeEnv.js";
import { getAssetSnapshots } from "./lib/stonApi.js";
import {
  getMarketById,
  listMarkets,
  listPositions,
} from "./lib/marketReadModel.js";

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
      return json({ ok: true, service: "api" });
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
          "cache-control": "public, max-age=300, stale-while-revalidate=86400",
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

    if (url.pathname === "/api/positions") {
      const userAddress = url.searchParams.get("userAddress");
      if (!userAddress) {
        return json({ error: "userAddress is required" }, { status: 400 });
      }

      return json({ items: await listPositions(userAddress) });
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
