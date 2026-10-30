// Run your own firm with your own keys:  npx tsx src/agent.ts firm.json
//
// firm.json (the site's "Launch your firm" downloads it when you choose to run the agent yourself):
//   { "rpc": "https://<host>/rpc", "tender": "tender.sandbox", "firm_id": 6, "account": "w7.tender.sandbox",
//     "keys": { "tender": "ed25519:...", "firm": "ed25519:..." },
//     "owner": { "account": "you.sandbox", "key": "ed25519:..." },   // optional: publishes the spec
//     "strategy": "firms/example.ts" }                                // a module whose default export is defineFirm(...)
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runFirm } from "./sdk.ts";

const file = process.argv[2];
if (!file) {
  console.error("usage: npx tsx src/agent.ts firm.json");
  process.exit(2);
}
const cfg = JSON.parse(readFileSync(file, "utf8"));
for (const k of ["rpc", "tender", "firm_id", "account", "keys", "strategy"]) {
  if (cfg[k] === undefined) throw new Error(`${file}: missing "${k}"`);
}
// The strategy path is relative to the config file.
const firm = (await import(pathToFileURL(path.resolve(path.dirname(file), cfg.strategy)).href)).default;
await runFirm({ rpc: cfg.rpc, tender: cfg.tender, firmId: cfg.firm_id, account: cfg.account, keys: cfg.keys, owner: cfg.owner, firm, inference: cfg.inference });
