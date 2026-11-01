import { useState } from "react";
import { faucet, marketBySymbol, SYMBOLS, type Config, type MarketSymbol } from "../lib/api";
import { amount, ASSETS, digitsOf, toBase, wrapped } from "../lib/format";
import { useConfig } from "../lib/hooks";
import { CHAINS, depositToIntents, inMarkets, moveToTrading, withdrawToWallet, type Balances, type Spots, type Wallet } from "../lib/near";
import { TxButton } from "./ui";

export type Move = "deposit" | "withdraw";
/** USDC or a market's asset (wNEAR, wETH, wSOL), by symbol. */
export type TokenKey = "USDC" | MarketSymbol;

type Token = { key: TokenKey; name: string; decimals: number; digits: number; spot: (b: Balances) => Spots | undefined; ft: (c: Config) => string | undefined };
/** The tokens of the trading balance: USDC, then each market's asset. */
export const TOKENS: Token[] = [
  { key: "USDC", name: "USDC", decimals: 6, digits: 2, spot: (b) => b.usdc, ft: (c) => c.usdc },
  ...SYMBOLS.map((s): Token => ({ key: s, name: wrapped(ASSETS[s]), decimals: ASSETS[s].decimals, digits: digitsOf(ASSETS[s]), spot: (b) => b.markets[s]?.asset, ft: (c) => marketBySymbol(c, s)?.ft })),
];
const tokenOf = (k: TokenKey) => TOKENS.find((t) => t.key === k)!;
/** A token amount as the balances show it: "12.50", "0.010512". */
export const tokenText = (k: TokenKey, v: string | bigint | undefined) => (v === undefined ? "…" : amount(v, tokenOf(k).decimals, tokenOf(k).digits));

/** "12.5" from base units, cut (never rounded up) to `digits` decimals: what an input accepts. */
export function plain(base: bigint, decimals: number, digits = 6): string {
  const s = (base / 10n ** BigInt(decimals - digits)).toString().padStart(digits + 1, "0");
  return `${s.slice(0, -digits)}.${s.slice(-digits)}`.replace(/\.?0+$/, "");
}

/** Wallet to the trading balance (NEAR Intents) and back, one transaction each way. */
export function MoveFunds({ wallet, bal, move: m0 = "deposit", token: t0 = "USDC", onDone }: { wallet: Wallet; bal: Balances | null; move?: Move; token?: TokenKey; onDone?: () => void }) {
  const config = useConfig();
  const [move, setMove] = useState<Move>(m0);
  const [key, setKey] = useState<TokenKey>(t0);
  const [amountText, setAmount] = useState("");
  const t = tokenOf(key);
  const spot = bal ? t.spot(bal) : undefined;
  const from = spot ? BigInt(move === "deposit" ? spot.wallet : spot.intents) : null;
  let base = 0n;
  try {
    base = toBase(amountText, t.decimals);
  } catch {
    /* not a number: the button stays disabled */
  }
  const over = from !== null && base > from;
  const ft = config ? t.ft(config) : undefined;

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
        {TOKENS.map((x) => (
          <button key={x.key} type="button" role="radio" aria-checked={key === x.key} className={key === x.key ? "on" : ""} onClick={() => setKey(x.key)}>
            {x.name}
          </button>
        ))}
      </div>
      <label className="field">
        <span>{move === "deposit" ? "From your wallet" : "From your trading balance"}</span>
        <div className="input-unit">
          <input inputMode="decimal" value={amountText} placeholder="0" onChange={(e) => setAmount(e.target.value)} aria-label={`Amount in ${t.name}`} />
          <button type="button" className="btn small" disabled={!from} onClick={() => from && setAmount(plain(from, t.decimals))}>
            Max
          </button>
          <span>{t.name}</span>
        </div>
      </label>
      <p className="hint">
        {move === "deposit" ? "Wallet" : "Trading balance"}: {from === null ? "…" : `${tokenText(key, from)} ${t.name}`}
      </p>
      {over && <p className="tx-error">More than you have.</p>}
      <TxButton
        className="btn primary big go"
        disabled={base <= 0n || over || !ft}
        run={() => (move === "deposit" ? depositToIntents(wallet, base, ft!) : withdrawToWallet(wallet, base, ft!))}
        onDone={onDone}
      >
        {move === "deposit" ? "Deposit" : "Withdraw"} {base > 0n ? `${plain(base, t.decimals)} ${t.name}` : ""}
      </TxButton>
      <p className="fine">{move === "deposit" ? "One transaction: your wallet to NEAR Intents, your trading balance for every market." : "One transaction: NEAR Intents to your wallet."}</p>
    </div>
  );
}

/** For a wallet of another chain: simulated USDC on the devnet; deposits from its chain and the way back are mainnet only. */
export function ChainFunds({ wallet }: { wallet: Wallet }) {
  const from = wallet.chain ? CHAINS[wallet.chain].from : "another chain";
  return (
    <div className="move">
      <TxButton className="btn primary big go" run={() => faucet(wallet.accountId)}>
        <i className="fa-solid fa-faucet-drip" aria-hidden="true" /> Simulate a deposit from {from}: 100 USDC
      </TxButton>
      <p className="fine">On mainnet your USDC comes from {from} through NEAR Intents (any chain it bridges, for a passkey). Withdrawing back is mainnet only.</p>
    </div>
  );
}

/** The trading balance per token, and the wallet beside it (not for an Ethereum account: it has no NEAR wallet). */
export function BalanceRows({ bal, tokens = TOKENS.map((t) => t.key), wallet = true }: { bal: Balances | null; tokens?: TokenKey[]; wallet?: boolean }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Token</th>
            <th className="num">Trading balance</th>
            {wallet && <th className="num">Wallet</th>}
          </tr>
        </thead>
        <tbody>
          {tokens.map(tokenOf).map((t) => {
            const s = bal ? t.spot(bal) : undefined;
            return (
              <tr key={t.key}>
                <td>{t.name}</td>
                <td className="num strong">{tokenText(t.key, s?.intents)}</td>
                {wallet && <td className="num">{tokenText(t.key, s?.wallet)}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Money still in a market's tender ledger (dividends, share sales): one click moves it to the trading balance. */
export function InMarkets({ wallet, bal }: { wallet: Wallet; bal: Balances | null }) {
  const list = inMarkets(bal);
  if (!list.length || !bal) return null;
  const text = list
    .map(([s, b]) => `${[b.usdc.tender !== "0" && `${tokenText("USDC", b.usdc.tender)} USDC`, b.asset.tender !== "0" && `${tokenText(s as MarketSymbol, b.asset.tender)} ${wrapped(ASSETS[s])}`].filter(Boolean).join(" + ")} (${s})`)
    .join(", ");
  return (
    <div className="avail in-markets">
      <span className="muted">In markets</span>
      <span>{text}</span>
      {wallet.chain ? (
        <span className="avail-wallet">Paid back to your trading balance after each fill.</span>
      ) : (
        <TxButton className="btn small" run={() => moveToTrading(wallet, bal)}>
          Move to trading balance
        </TxButton>
      )}
    </div>
  );
}
