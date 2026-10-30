// Deployment shared by the sandbox demo and real networks.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Account, KeyPair, actions, nearToYocto, type JsonRpcProvider } from "near-api-js";
import { TGAS, account, call } from "./chain.ts";
import type { FirmHandle } from "./swarm.ts";
import type { Strategy } from "./strategy.ts";

const WASM_DIR = process.env.WASM_DIR ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "wasm");
export const wasm = (name: string) => new Uint8Array(readFileSync(path.join(WASM_DIR, `${name}.wasm`)));

/** Methods a firm agent may call on tender. None of them takes a deposit, so none moves money out. */
export const AGENT_TENDER_METHODS = ["commit_bid", "reveal_bid", "deliver", "settle", "epoch_tick", "expire", "settle_dividends"];

export async function createAccount(parent: Account, id: string, near: string, provider: JsonRpcProvider) {
  const kp = KeyPair.fromRandom("ed25519");
  await parent.createAccount({ newAccountId: id, publicKey: kp.getPublicKey(), nearToTransfer: nearToYocto(near as `${number}`) });
  return { acct: account(id, provider, kp), key: kp };
}

export async function deployContract(acct: Account, code: Uint8Array, init: string, args: object) {
  await acct.signAndSendTransaction({
    receiverId: acct.accountId,
    actions: [actions.deployContract(code), actions.functionCall(init, args, TGAS(100), 0n)],
    throwOnFailure: true,
  });
}

/**
 * Create `w{n}.{tender}` in ONE transaction signed by the tender account: create, fund, deploy the firm
 * contract, init, add two function call keys. A full access key never exists on the firm account.
 */
export async function createFirm(opts: {
  tenderAcct: Account;
  provider: JsonRpcProvider;
  n: number;
  owner: Account;
  strategy: Strategy;
  budget: bigint;
  maxPerCall: bigint;
  budgetEpochSecs: number;
}): Promise<FirmHandle & { keys: { tender: string; firm: string } }> {
  const { tenderAcct, provider, n, owner } = opts;
  const id = `w${n}.${tenderAcct.accountId}`;
  const kTender = KeyPair.fromRandom("ed25519");
  const kFirm = KeyPair.fromRandom("ed25519");
  await tenderAcct.signAndSendTransaction({
    receiverId: id,
    actions: [
      actions.createAccount(),
      actions.transfer(nearToYocto("3")),
      actions.deployContract(wasm("firm")),
      actions.functionCall(
        "new",
        {
          tender: tenderAcct.accountId,
          owner: owner.accountId,
          budget: opts.budget.toString(),
          max_per_call: opts.maxPerCall.toString(),
          epoch_secs: opts.budgetEpochSecs,
          agent_keys: [kTender.getPublicKey().toString(), kFirm.getPublicKey().toString()],
        },
        TGAS(50),
        0n,
      ),
      actions.addFunctionCallAccessKey(kTender.getPublicKey(), tenderAcct.accountId, AGENT_TENDER_METHODS),
      actions.addFunctionCallAccessKey(kFirm.getPublicKey(), id, ["spend"]),
    ],
    throwOnFailure: true,
  });
  const r = await call<number>(tenderAcct, tenderAcct.accountId, "register_firm", { account: id, owner: owner.accountId });
  return { id: r.value, account: id, owner, agentTender: account(id, provider, kTender), agentFirm: account(id, provider, kFirm), strategy: opts.strategy, keys: { tender: kTender.toString(), firm: kFirm.toString() } };
}
