import { restoreRuntimeBackup } from "../apps/api/src/lib/marketRegistry.js";

const fileName = process.argv[2];

if (!fileName) {
  console.error("Usage: node scripts/restoreRuntimeBackup.mjs <backup-file-name>");
  process.exit(1);
}

const result = restoreRuntimeBackup(fileName);
console.log(JSON.stringify(result, null, 2));
