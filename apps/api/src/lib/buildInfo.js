import fs from "node:fs";
import path from "node:path";

const packageJsonPath = path.resolve(import.meta.dirname, "../../../../package.json");

let cachedPackageVersion = null;

function readPackageVersion() {
  if (cachedPackageVersion !== null) {
    return cachedPackageVersion;
  }

  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    cachedPackageVersion = String(packageJson.version ?? "").trim() || "0.0.0";
  } catch {
    cachedPackageVersion = "0.0.0";
  }

  return cachedPackageVersion;
}

function normalizeString(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

export function getBuildInfo() {
  const version = normalizeString(process.env.BUILD_VERSION) ?? readPackageVersion();
  const commit = normalizeString(process.env.BUILD_COMMIT);
  const ref = normalizeString(process.env.BUILD_REF);
  const builtAt = normalizeString(process.env.BUILD_TIME);
  const shortCommit = commit ? commit.slice(0, 12) : null;

  return {
    version,
    commit,
    shortCommit,
    ref,
    builtAt,
    nodeVersion: process.version,
    release: shortCommit ? `${version}+${shortCommit}` : version,
  };
}
