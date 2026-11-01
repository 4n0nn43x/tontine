import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { faucet } from "../lib/api";
import { near, short } from "../lib/format";
import { announceTx, useBalances, useWallet } from "../lib/hooks";
import { connectEthereum, createWallet, forgetWallet, type Wallet } from "../lib/near";
import { InMarkets, TOKENS, tokenText } from "./Funds";
import "../styles/funds.css";

export function AccountMenu() {
  const wallet = useWallet();
  const bal = useBalances(wallet?.accountId);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, []);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      announceTx();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!wallet) {
    return (
      <div className="account" ref={ref}>
        <button className="btn primary" disabled={busy} onClick={() => act(async () => (await createWallet(), setOpen(true)))}>
          {busy ? <i className="fa-solid fa-circle-notch fa-spin" aria-hidden="true" /> : <i className="fa-solid fa-wallet" aria-hidden="true" />} Create demo account
        </button>
        <button className="btn eth-connect" disabled={busy} title="Connect an Ethereum wallet" aria-label="Connect an Ethereum wallet" onClick={() => act(async () => (await connectEthereum(), setOpen(true)))}>
          <i className="fa-brands fa-ethereum" aria-hidden="true" />
          <span className="eth-label">Ethereum wallet</span>
        </button>
        {error && <span className="tx-error account-error">{error}</span>}
      </div>
    );
  }

  const usdcText = bal ? tokenText("USDC", bal.usdc.intents) : "…";
  return (
    <div className="account" ref={ref}>
      <button className="btn account-btn" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="live-dot" aria-hidden="true" />
        <span className="account-name">
          {wallet.evm && <i className="fa-brands fa-ethereum" aria-hidden="true" />} {short(wallet.accountId, 18)}
        </span>
        <span className="account-usdc" title="Trading balance (NEAR Intents)">
          {usdcText} USDC
        </span>
      </button>
      {open && (
        <div className="account-panel" role="dialog" aria-label={wallet.evm ? "Ethereum account" : "Demo account"}>
          <p className="account-id">{wallet.accountId}</p>
          <div className="account-main">
            <span>Trading balance</span>
            <b>{usdcText} USDC</b>
          </div>
          <dl className="balances">
            {TOKENS.slice(1).map((t) => (
              <Row key={t.key} label={t.name} value={bal ? tokenText(t.key, t.spot(bal)?.intents) : "…"} />
            ))}
            {!wallet.evm && <Row label="Gas" value={bal ? `${near(bal.near, 2)} NEAR` : "…"} />}
          </dl>
          <InMarkets wallet={wallet} bal={bal} />
          <div className="account-actions">
            <button className="btn" disabled={busy} onClick={() => act(() => faucet(wallet.accountId))}>
              <i className="fa-solid fa-faucet-drip" aria-hidden="true" /> {wallet.evm ? "Simulate a Base deposit" : "Get test tokens"}
            </button>
            <Link className="btn" to="/app/portfolio" onClick={() => setOpen(false)}>
              <i className="fa-solid fa-briefcase" aria-hidden="true" /> Portfolio
            </Link>
          </div>
          {error && <p className="tx-error">{error}</p>}
          <Fine wallet={wallet} />
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}

function Fine({ wallet }: { wallet: Wallet }) {
  const forget = (q: string) => confirm(q) && forgetWallet();
  return wallet.evm ? (
    <p className="fine">
      Ethereum account: your 0x address is your NEAR Intents account. You sign each order in your wallet, the relay pays the gas. Withdrawing back to Base is mainnet only.{" "}
      <button className="link" onClick={() => forget("Disconnect this Ethereum wallet?")}>
        Disconnect
      </button>
    </p>
  ) : (
    <p className="fine">
      Devnet account: its key was generated in this browser and never left it. Test tokens only.{" "}
      <button className="link" onClick={() => forget("Forget this demo account? Its key is only stored in this browser.")}>
        Forget it
      </button>
    </p>
  );
}
