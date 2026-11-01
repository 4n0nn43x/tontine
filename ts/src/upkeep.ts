// House accounts pay gas and tender storage on every order and bid, and a bid left unrevealed (a restart in the
// middle of an auction) costs its owner's bond. On a chain that runs for weeks they are kept topped up from a
// funder (the devnet's root, the testnet master), or the market stops within a day: measured on 2026-11-01, the
// firm that settles burned 1.4 NEAR a day of its 0.9 free, and the house client's storage lasted ~200 orders.
import { nearToYocto, type Account, type JsonRpcProvider } from "near-api-js";
import { call, view } from "./chain.ts";

/** A signer with less free NEAR (past its storage) than GAS_LOW gets back to GAS_TO. */
const GAS_LOW = nearToYocto("0.5");
const GAS_TO = nearToYocto("1");
/** Tender storage (NEP-145) of a house account, topped up by STORAGE under STORAGE_LOW. */
export const STORAGE = nearToYocto("0.2");
export const STORAGE_LOW = nearToYocto("0.05");

export type House = {
  tender: string;
  /** Accounts that sign transactions: their free NEAR pays the gas. */
  signers: string[];
  /** Accounts the tender bills for the storage of their orders and bids. */
  stored: string[];
  /** Owners whose bond answers for their firms' bids: back to 3 times the tender's minimum under 2 times. */
  owners: Account[];
  minBond: bigint;
  /** Puts `amount` of USDC in `owner`'s tender ledger (mint, then deposit: test chains only). */
  credit(owner: Account, amount: bigint): Promise<unknown>;
};

/** One pass over a market's house accounts; returns what it topped up. */
export async function upkeep(provider: JsonRpcProvider, funder: Account, h: House): Promise<string[]> {
  const done: string[] = [];
  for (const a of new Set(h.signers)) {
    const r: any = await provider.query({ request_type: "view_account", account_id: a, finality: "optimistic" } as any);
    const free = BigInt(r.amount) - BigInt(r.storage_usage) * 10n ** 19n;
    if (free >= GAS_LOW) continue;
    await funder.transfer({ receiverId: a, amount: GAS_TO - free });
    done.push(`${a} gas`);
  }
  for (const a of new Set(h.stored)) {
    if (BigInt(await view(provider, h.tender, "storage_balance_of", { account_id: a })) >= STORAGE_LOW) continue;
    await call(funder, h.tender, "storage_deposit", { account_id: a }, STORAGE);
    done.push(`${a} storage`);
  }
  for (const o of h.owners) {
    const bond = BigInt(await view(provider, h.tender, "bond_of", { account_id: o.accountId }));
    if (bond >= 2n * h.minBond) continue;
    const need = 3n * h.minBond - bond;
    const cash = BigInt(await view(provider, h.tender, "balance_of", { account_id: o.accountId }));
    if (cash < need) await h.credit(o, need - cash);
    await call(o, h.tender, "deposit_bond", { amount: need.toString() }, 1n);
    done.push(`${o.accountId} bond`);
  }
  return done;
}
