import type { TestnetOrder, TestnetWallet } from "../lib/api";
import { ASSETS, gotText, paidText, short } from "../lib/format";
import { useTestnet } from "../lib/hooks";
import { Badge, Card } from "./ui";

const ago = (at: number) => {
  const m = Math.round((Date.now() - at) / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};
const WALLETS: [string, string][] = [
  ["erc191", "EVM (ERC-191)"],
  ["tip191", "Tron (TIP-191)"],
  ["raw_ed25519", "Solana (Ed25519)"],
  ["sep53", "Stellar (SEP-53)"],
  ["ton_connect", "TON (TonConnect)"],
  ["webauthn", "Passkey (WebAuthn)"],
];

/**
 * The whole system on NEAR testnet, a public chain, next to the devnet the site plays on: its contracts, the
 * house orders of the three markets, one order relayed from each wallet standard and the Chain Signatures proof,
 * each with its nearblocks link. Nothing when the server runs no testnet showcase.
 */
export function TestnetCard() {
  const { data: t } = useTestnet();
  if (!t?.enabled) return null;
  const tx = (h: string) => `${t.explorer}/txns/${h}`;
  const addr = (a: string) => `${t.explorer}/address/${a}`;
  const link = (href: string, text: string) => (
    <a href={href} target="_blank" rel="noreferrer">
      {text}
    </a>
  );
  const status = { running: "live", "setting-up": "setting up", "waiting-funds": "waiting for testnet NEAR", error: "error" }[t.status];
  return (
    <Card
      className="testnet-card"
      title={
        <>
          <i className="fa-solid fa-globe" aria-hidden="true" /> Live on NEAR testnet
        </>
      }
      action={<span className={`testnet-status ${t.status}`}>{status}</span>}
    >
      <p className="caption">
        The same system on a public chain, run by the server: every transaction below can be checked on nearblocks. The site you trade on stays the devnet, which answers in
        a second. NEAR Intents is not deployed on testnet, so it runs our copy of the intents.near mainnet code.
      </p>
      {t.status !== "running" && <p className="fine">{t.status === "waiting-funds" ? `${t.master} holds ${t.balance?.toFixed(2) ?? "…"} testnet NEAR; the setup needs about ${t.need}.` : t.message}</p>}
      {t.contracts && (
        <dl className="testnet-contracts">
          <dt>NEAR Intents (copy)</dt>
          <dd>{link(addr(t.contracts.intents), t.contracts.intents)}</dd>
          {t.markets.map((m) => (
            <div key={m.symbol} className="testnet-market">
              <dt>{m.symbol}/USDC</dt>
              <dd>
                {link(addr(m.tender), m.tender)}
                {m.firms.length > 0 && " · "}
                {m.firms.map((f, i) => (
                  <span key={f.id}>
                    {i > 0 && ", "}
                    {link(addr(f.account), f.name)}
                  </span>
                ))}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {t.orders.length > 0 && <TestnetOrders orders={t.orders.slice(0, 6)} tx={tx} />}
      {t.status === "running" && (
        <div className="testnet-evm">
          <h3>
            <i className="fa-solid fa-wallet" aria-hidden="true" /> Wallets of other chains
          </h3>
          <ul className="testnet-wallets">
            {WALLETS.map(([std, label]) => {
              // Its filled order, else its latest try (a try refunded after an RPC refusal is tried again).
              const tries = t.wallets.filter((x: TestnetWallet) => x.standard === std);
              const w = tries.find((x) => x.status === "Filled") ?? tries.at(-1);
              return (
                <li key={std}>
                  <span>{label}</span>
                  {w ? (
                    <span className="testnet-links">
                      {link(tx(w.relayTx), "relayed")}
                      {w.settleTx && <> · {link(tx(w.settleTx), "settled")}</>} <Badge status={w.status} />
                    </span>
                  ) : (
                    <span className="muted">pending</span>
                  )}
                </li>
              );
            })}
          </ul>
          <h3>
            <i className="fa-solid fa-signature" aria-hidden="true" /> Chain Signatures
          </h3>
          {t.evm ? (
            <p>
              The MPC network ({t.evm.signer}) signed a Base Sepolia USDC transfer for {link(addr(t.evm.firm), short(t.evm.firm))}, within its owner&apos;s policy:{" "}
              {link(tx(t.evm.nearTx), "the NEAR transaction")}. The signature recovers to the firm&apos;s address{" "}
              {link(`https://sepolia.basescan.org/address/${t.evm.address}`, short(t.evm.address, 16))} {t.evm.ok ? "(checked)" : "(mismatch)"}; signed, not broadcast (no Base Sepolia ETH for gas).
            </p>
          ) : (
            <p className="fine">Pending{t.evmError ? `: ${t.evmError}` : ""}.</p>
          )}
        </div>
      )}
    </Card>
  );
}

function TestnetOrders({ orders, tx }: { orders: TestnetOrder[]; tx: (h: string) => string }) {
  return (
    <div className="testnet-orders">
      {orders.map((o) => {
        const a = ASSETS[o.symbol] ?? ASSETS.NEAR;
        return (
          <div key={`${o.symbol}${o.id}`} className="testnet-order">
            <span className="order-id">#{o.id}</span>
            <span className="order-what">
              <span className="mk-tag">{o.symbol}</span>
              {o.side === "Buy" ? `Buy ${o.symbol} with ${paidText(o.side, o.amountIn, a)}` : `Sell ${paidText(o.side, o.amountIn, a)}`}
            </span>
            <span className="order-amount">{o.out ? `got ${gotText(o.side, o.out, a)}` : ""}</span>
            <span className="testnet-links">
              <a href={tx(o.postTx)} target="_blank" rel="noreferrer">
                posted
              </a>
              {o.settleTx && (
                <>
                  {" · "}
                  <a href={tx(o.settleTx)} target="_blank" rel="noreferrer">
                    settled
                  </a>
                </>
              )}{" "}
              <span className="muted">{ago(o.at)}</span>
            </span>
            <Badge status={o.status} />
          </div>
        );
      })}
    </div>
  );
}
