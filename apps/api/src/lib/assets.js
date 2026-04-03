import { readFile } from "node:fs/promises";

const ASSET_ICON_REGISTRY = {
  TON: {
    fileName: "ton.png",
    contentType: "image/png",
  },
  STON: {
    fileName: "ston.png",
    contentType: "image/png",
  },
  tsTON: {
    fileName: "tston.svg",
    contentType: "image/svg+xml",
  },
  UTYA: {
    fileName: "utya.png",
    contentType: "image/png",
  },
  MAJOR: {
    fileName: "major.svg",
    contentType: "image/svg+xml",
  },
  REDO: {
    fileName: "redo.png",
    contentType: "image/png",
  },
};

export function getAssetIconDescriptor(asset) {
  return ASSET_ICON_REGISTRY[String(asset ?? "").trim()] ?? null;
}

export function getAssetIconUrl(asset) {
  const descriptor = getAssetIconDescriptor(asset);
  if (!descriptor) {
    return null;
  }

  return `/api/assets/icons/${encodeURIComponent(asset)}`;
}

export async function readAssetIcon(asset) {
  const descriptor = getAssetIconDescriptor(asset);
  if (!descriptor) {
    return null;
  }

  const fileUrl = new URL(`../../public/asset-icons/${descriptor.fileName}`, import.meta.url);
  const body = await readFile(fileUrl);

  return {
    body,
    contentType: descriptor.contentType,
  };
}
