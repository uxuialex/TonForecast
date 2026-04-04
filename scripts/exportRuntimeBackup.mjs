import { exportRuntimeBackup } from "../apps/api/src/lib/marketRegistry.js";

const reason = process.argv.slice(2).join(" ").trim() || "manual";
const backup = exportRuntimeBackup(reason);
console.log(JSON.stringify(backup, null, 2));
