import type { TestnetOrder } from "../lib/api";
import { ASSETS, gotText, paidText, short } from "../lib/format";
import { useTestnet } from "../lib/hooks";
import { Badge, Card } from "./ui";

const ago = (at: number) => {
  const m = Math.round((Date.now() - at) / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};

/**
 * The testnet showcase next to the devnet: the same contracts on NEAR testnet, a public chain, with links to
 * every transaction on nearblocks and the Chain Signatures proof. Nothing when the server runs no showcase.
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
        The same contracts on a public chain: every transaction below can be checked on nearblocks. NEAR Intents is not deployed on testnet, so it runs our copy of the
        intents.near mainnet code, as the devnet does; the site you trade on stays the devnet.
      </p>
      {t.status !== "running" && <p className="fine">{t.status === "waiting-funds" ? `${t.master} holds ${t.balance?.toFixed(2) ?? "…"} testnet NEAR; the setup needs about ${t.need}.` : t.message}</p>}
      {t.contracts && (
        <dl className="testnet-contracts">
          <dt>Tender</dt>
          <dd>{link(addr(t.contracts.tender), t.contracts.tender)}</dd>
          <dt>NEAR Intents (copy)</dt>
          <dd>{link(addr(t.contracts.intents), t.contracts.intents)}</dd>
          <dt>Firms</dt>
          <dd>
            {t.firms.map((f, i) => (
              <span key={f.id}>
                {i > 0 && ", "}
                {link(addr(f.account), f.name)}
              </span>
            ))}
          </dd>
        </dl>
      )}
      {t.orders.length > 0 && <TestnetOrders orders={t.orders.slice(0, 6)} tx={tx} />}
      {t.status === "running" && (
        <div className="testnet-evm">
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
  const near = ASSETS.NEAR;
  return (
    <div className="testnet-orders">
      {orders.map((o) => (
        <div key={o.id} className="testnet-order">
          <span className="order-id">#{o.id}</span>
          <span className="order-what">{o.side === "Buy" ? `Buy NEAR with ${paidText(o.side, o.amountIn, near)}` : `Sell ${paidText(o.side, o.amountIn, near)}`}</span>
          <span className="order-amount">{o.out ? `got ${gotText(o.side, o.out, near)}` : ""}</span>
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
      ))}
    </div>
  );
}
