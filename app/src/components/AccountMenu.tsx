import { Fragment, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { faucet } from "../lib/api";
import { usdc, near, short } from "../lib/format";
import { announceTx, useBalances, useWallet } from "../lib/hooks";
import { createWallet, forgetWallet } from "../lib/near";

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

  if (!wallet) {
    return (
      <div className="account" ref={ref}>
        <button
          className="btn primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await createWallet();
              setOpen(true);
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? <i className="fa-solid fa-circle-notch fa-spin" aria-hidden="true" /> : <i className="fa-solid fa-wallet" aria-hidden="true" />} Create demo account
        </button>
        {error && <span className="tx-error account-error">{error}</span>}
      </div>
    );
  }

  return (
    <div className="account" ref={ref}>
      <button className="btn account-btn" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="live-dot" aria-hidden="true" />
        {short(wallet.accountId, 18)}
        <span className="account-usdc">{bal ? usdc(BigInt(bal.usdc.wallet) + BigInt(bal.usdc.intents) + BigInt(bal.usdc.tender)) : "…"} USDC</span>
      </button>
      {open && (
        <div className="account-panel" role="dialog" aria-label="Demo account">
          <p className="account-id">{wallet.accountId}</p>
          <dl className="balances">
            {(["wallet", "intents", "tender"] as const).map((k) => (
              <Fragment key={k}>
                <dt>{k === "wallet" ? "Wallet" : k === "intents" ? "In NEAR Intents" : "In Tontine"}</dt>
                <dd>
                  {bal ? usdc(bal.usdc[k]) : "…"} USDC · {bal ? near(bal.wnear[k]) : "…"} wNEAR
                </dd>
              </Fragment>
            ))}
            <dt>Gas</dt>
            <dd>{bal ? near(bal.near, 2) : "…"} NEAR</dd>
          </dl>
          <div className="account-actions">
            <button
              className="btn"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  await faucet(wallet.accountId);
                  announceTx();
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <i className="fa-solid fa-faucet-drip" aria-hidden="true" /> Get 100 USDC and 20 wNEAR
            </button>
            <Link className="btn" to="/app/portfolio" onClick={() => setOpen(false)}>
              <i className="fa-solid fa-briefcase" aria-hidden="true" /> Portfolio
            </Link>
          </div>
          {error && <p className="tx-error">{error}</p>}
          <p className="fine">
            Devnet account: its key was generated in this browser and never left it. Test USDC and wNEAR only.{" "}
            <button
              className="link"
              onClick={() => {
                if (confirm("Forget this demo account? Its key is only stored in this browser.")) forgetWallet();
              }}
            >
              Forget it
            </button>
          </p>
        </div>
      )}
    </div>
  );
}
