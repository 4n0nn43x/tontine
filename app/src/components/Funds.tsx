import { useState } from "react";
import { near, toBase, usdc } from "../lib/format";
import { depositToTender, withdrawToWallet, type Balances, type TokenName, type Wallet } from "../lib/near";
import { TxButton } from "./ui";

export type Move = "deposit" | "withdraw";

/** "12.5" from base units, cut (never rounded up) to `digits` decimals: what an input accepts. */
export function plain(base: bigint, decimals: number, digits = 6): string {
  const s = (base / 10n ** BigInt(decimals - digits)).toString().padStart(digits + 1, "0");
  return `${s.slice(0, -digits)}.${s.slice(-digits)}`.replace(/\.?0+$/, "");
}

/** Wallet to trading balance (via NEAR Intents) and back. */
export function MoveFunds({ wallet, bal, move: m0 = "deposit", token: t0 = "usdc", onDone }: { wallet: Wallet; bal: Balances | null; move?: Move; token?: TokenName; onDone?: () => void }) {
  const [move, setMove] = useState<Move>(m0);
  const [token, setToken] = useState<TokenName>(t0);
  const [amount, setAmount] = useState("");
  const decimals = token === "usdc" ? 6 : 24;
  const unit = token === "usdc" ? "USDC" : "wNEAR";
  const from = bal ? BigInt(move === "deposit" ? bal[token].wallet : bal[token].tender) : null;
  let base = 0n;
  try {
    base = toBase(amount, decimals);
  } catch {
    /* not a number: the button stays disabled */
  }
  const over = from !== null && base > from;
  const fmt = (v: bigint) => (token === "usdc" ? usdc(v) : near(v));

  return (
    <div className="move">
      <div className="segmented" role="radiogroup" aria-label="Direction">
        {(["deposit", "withdraw"] as const).map((k) => (
          <button key={k} type="button" role="radio" aria-checked={move === k} className={move === k ? "on" : ""} onClick={() => setMove(k)}>
            {k === "deposit" ? "Deposit" : "Withdraw"}
          </button>
        ))}
      </div>
      <div className="segmented small" role="radiogroup" aria-label="Token">
        {(["usdc", "wnear"] as const).map((k) => (
          <button key={k} type="button" role="radio" aria-checked={token === k} className={token === k ? "on" : ""} onClick={() => setToken(k)}>
            {k === "usdc" ? "USDC" : "wNEAR"}
          </button>
        ))}
      </div>
      <label className="field">
        <span>{move === "deposit" ? "From your wallet" : "From your trading balance"}</span>
        <div className="input-unit">
          <input inputMode="decimal" value={amount} placeholder="0" onChange={(e) => setAmount(e.target.value)} aria-label={`Amount in ${unit}`} />
          <button type="button" className="btn small" disabled={!from} onClick={() => from && setAmount(plain(from, decimals))}>
            Max
          </button>
          <span>{unit}</span>
        </div>
      </label>
      <p className="hint">
        {move === "deposit" ? "Wallet" : "Trading balance"}: {from === null ? "…" : `${fmt(from)} ${unit}`}
      </p>
      {over && <p className="tx-error">More than you have.</p>}
      <TxButton
        className="btn primary big go"
        disabled={base <= 0n || over}
        run={() => (move === "deposit" ? depositToTender(wallet, base, undefined, token) : withdrawToWallet(wallet, base, token))}
        onDone={onDone}
      >
        {move === "deposit" ? "Deposit" : "Withdraw"} {base > 0n ? `${plain(base, decimals)} ${unit}` : ""}
      </TxButton>
      <p className="fine">{move === "deposit" ? "Two transactions: wallet to NEAR Intents, then to tender." : "Two transactions: tender to NEAR Intents, then to your wallet."}</p>
    </div>
  );
}

/** Trading balance first, the wallet next; NEAR Intents only when something sits there (a refunded deposit). */
export function BalanceRows({ bal }: { bal: Balances | null }) {
  const intents = !!bal && (bal.usdc.intents !== "0" || bal.wnear.intents !== "0");
  const rows = [
    ["USDC", bal?.usdc, (v: string) => usdc(v)],
    ["wNEAR", bal?.wnear, (v: string) => near(v)],
  ] as const;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Token</th>
            <th className="num">Trading balance</th>
            <th className="num">Wallet</th>
            {intents && <th className="num">In NEAR Intents</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map(([name, spot, fmt]) => (
            <tr key={name}>
              <td>{name}</td>
              <td className="num strong">{spot ? fmt(spot.tender) : "…"}</td>
              <td className="num">{spot ? fmt(spot.wallet) : "…"}</td>
              {intents && <td className="num">{spot ? fmt(spot.intents) : "…"}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
