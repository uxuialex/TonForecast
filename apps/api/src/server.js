import { getAssetSnapshots, getThresholdPresets } from "./lib/stonApi.js";
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

export async function handleRequest(request) {
  const url = new URL(request.url);

  if (url.pathname === "/healthz") {
    return json({ ok: true, service: "api" });
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

  if (url.pathname === "/api/presets") {
    const asset = url.searchParams.get("asset");
    if (asset !== "TON" && asset !== "BTC" && asset !== "ETH") {
      return json({ error: "asset must be TON, BTC or ETH" }, { status: 400 });
    }

    return json({ asset, thresholds: await getThresholdPresets(asset) });
  }

  return json({ error: "Not found" }, { status: 404 });
}
