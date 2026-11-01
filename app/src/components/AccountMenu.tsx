import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { faucet } from "../lib/api";
import { near, short } from "../lib/format";
import { announceTx, useBalances, useWallet } from "../lib/hooks";
import { CHAINS, createWallet, forgetWallet, type Wallet } from "../lib/near";
import { InMarkets, TOKENS, tokenText } from "./Funds";
import { ChainMark, WalletPicker } from "./Wallets";
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
        <button className="btn wallet-connect" disabled={busy} aria-expanded={open} title="Connect a wallet of another chain" aria-label="Connect a wallet" onClick={() => setOpen((o) => !o)}>
          <i className="fa-solid fa-link" aria-hidden="true" />
          <span className="wallet-label">Connect wallet</span>
        </button>
        {error && <span className="tx-error account-error">{error}</span>}
        {open && (
          <div className="account-panel wallet-panel" role="dialog" aria-label="Connect a wallet">
            <p className="fine">Trade from your own wallet: it signs each order, the relay pays the gas.</p>
            <WalletPicker />
          </div>
        )}
      </div>
    );
  }

  const usdcText = bal ? tokenText("USDC", bal.usdc.intents) : "…";
  return (
    <div className="account" ref={ref}>
      <button className="btn account-btn" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="live-dot" aria-hidden="true" />
        <span className="account-name">
          {wallet.chain && <ChainMark chain={wallet.chain} />} {short(wallet.accountId, 18)}
        </span>
        <span className="account-usdc" title="Trading balance (NEAR Intents)">
          {usdcText} USDC
        </span>
      </button>
      {open && (
        <div className="account-panel" role="dialog" aria-label={wallet.chain ? `${CHAINS[wallet.chain].name} wallet` : "Demo account"}>
          <p className="account-id">{wallet.accountId}</p>
          <div className="account-main">
            <span>Trading balance</span>
            <b>{usdcText} USDC</b>
          </div>
          <dl className="balances">
            {TOKENS.slice(1).map((t) => (
              <Row key={t.key} label={t.name} value={bal ? tokenText(t.key, t.spot(bal)?.intents) : "…"} />
            ))}
            {!wallet.chain && <Row label="Gas" value={bal ? `${near(bal.near, 2)} NEAR` : "…"} />}
          </dl>
          <InMarkets wallet={wallet} bal={bal} />
          <div className="account-actions">
            <button className="btn" disabled={busy} onClick={() => act(() => faucet(wallet.accountId))}>
              <i className="fa-solid fa-faucet-drip" aria-hidden="true" /> {wallet.chain ? `Simulate a deposit from ${CHAINS[wallet.chain].from}` : "Get test tokens"}
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
  // A wallet disconnects at once. A demo key or a passkey's public key lives only in this browser: forgetting it
  // loses the account, so a second click confirms, in place (no browser dialog).
  const [sure, setSure] = useState(false);
  const forget = (
    <button className="link" onClick={() => (sure ? forgetWallet() : setSure(true))}>
      {sure ? "Click again: the account cannot be opened again" : "Forget it"}
    </button>
  );
  return wallet.chain === "passkey" ? (
    <p className="fine">
      Passkey account: derived from the passkey's key, which this browser keeps. You confirm each order with your face, fingerprint or PIN; the relay pays the gas. {forget}
    </p>
  ) : wallet.chain ? (
    <p className="fine">
      {CHAINS[wallet.chain].name} wallet: its key gives your NEAR Intents account. You sign each order in your wallet, the relay pays the gas. Withdrawing back to {CHAINS[wallet.chain].from} is mainnet only.{" "}
      <button className="link" onClick={forgetWallet}>
        Disconnect
      </button>
    </p>
  ) : (
    <p className="fine">
      Devnet account: its key was generated in this browser and never left it. Test tokens only. {forget}
    </p>
  );
}
