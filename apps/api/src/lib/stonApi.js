import { assetSnapshots } from "../data/mockMarkets.js";

export async function getAssetSnapshots() {
  return assetSnapshots;
}

export async function getThresholdPresets(asset) {
  const snapshot = assetSnapshots.find((item) => item.asset === asset);
  if (!snapshot) {
    return [];
  }

  const current = Number(snapshot.priceUsd);
  const step = asset === "TON" ? 0.01 : asset === "BTC" ? 50 : 10;

  return [current, current + step, current + step * 2].map((value) =>
    value.toFixed(asset === "TON" ? 2 : 0),
  );
}
