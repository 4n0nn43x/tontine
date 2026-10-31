// Publish the sha256 of thesis/predictions.json on NEAR mainnet, in NEAR Social (social.near).
//
//   npx tsx src/publish-hash.ts            dry run: print the hash and the exact call, send nothing
//   npx tsx src/publish-hash.ts --send     sign and send with NEAR_ACCOUNT_ID / NEAR_PRIVATE_KEY
//   npx tsx src/publish-hash.ts verify <account>   read the hash back from the chain and compare
//
// The human runs --send: it signs a mainnet transaction with 0.02 NEAR attached, social.near's minimum
// storage balance for an account writing there for the first time (the rest stays as its storage balance).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JsonRpcProvider, nearToYocto, type KeyPairString } from "near-api-js";
import { account, call, view } from "./chain.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FILE = path.join(ROOT, "thesis", "predictions.json");
const SOCIAL = process.env.SOCIAL_CONTRACT ?? "social.near";
const provider = new JsonRpcProvider({ url: process.env.NEAR_RPC ?? "https://rpc.mainnet.fastnear.com" });

const sha = () => createHash("sha256").update(readFileSync(FILE)).digest("hex");

function payload(accountId: string) {
  return { data: { [accountId]: { tontine: { thesis: { predictions_sha256: sha(), file: "thesis/predictions.json", repo: "https://github.com/4n0nn43x/tontine" } } } } };
}

async function verify(accountId: string) {
  const r: any = await view(provider, SOCIAL, "get", { keys: [`${accountId}/tontine/thesis/**`] });
  const onchain = r?.[accountId]?.tontine?.thesis?.predictions_sha256;
  const local = sha();
  console.log(`on chain: ${onchain ?? "(none)"}\nfile:     ${local}`);
  console.log(onchain === local ? "MATCH" : "MISMATCH");
  process.exit(onchain === local ? 0 : 1);
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === "verify") {
  if (!arg) throw new Error("usage: publish-hash.ts verify <account>");
  await verify(arg);
} else {
  const accountId = process.env.NEAR_ACCOUNT_ID;
  console.log(`predictions.json sha256: ${sha()}`);
  const p = payload(accountId ?? "<your-account.near>");
  console.log(`call ${SOCIAL}.set(${JSON.stringify(p)}) with 0.02 NEAR attached`);
  if (cmd !== "--send") {
    console.log("dry run: nothing sent. Re-run with --send and NEAR_ACCOUNT_ID, NEAR_PRIVATE_KEY set.");
  } else {
    if (!accountId || !process.env.NEAR_PRIVATE_KEY) throw new Error("set NEAR_ACCOUNT_ID and NEAR_PRIVATE_KEY");
    const signer = account(accountId, provider, process.env.NEAR_PRIVATE_KEY as KeyPairString);
    const r = await call(signer, SOCIAL, "set", p, nearToYocto("0.02"));
    console.log(`sent: https://nearblocks.io/txns/${r.txHash}`);
  }
}
