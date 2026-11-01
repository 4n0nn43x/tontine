import { useEffect, useRef, type ReactNode } from "react";

/** Fade and rise each `.reveal` child once it enters the viewport, with a short stagger. */
export function useReveal<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const items = [...root.querySelectorAll<HTMLElement>(".reveal")];
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      items.forEach((el) => el.classList.add("in"));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (!e.isIntersecting) return;
          const el = e.target as HTMLElement;
          el.style.transitionDelay = `${(items.indexOf(el) % 4) * 90}ms`;
          el.classList.add("in");
          io.unobserve(el);
        });
      },
      { threshold: 0.18 },
    );
    items.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);
  return ref;
}

type Card = { kicker: string; title: ReactNode; text: string; points: [string, string, string]; panel: ReactNode; wide?: "left" | "right" };

const mono = { fontFamily: "ui-monospace, Menlo, monospace" };

// Figures from a real `make demo` run: order #0, a client buys NEAR with 40 USDC (NEAR replayed at 5.347 USD).
const PANELS = {
  escrow: (
    <svg viewBox="0 0 520 260" className="draw" role="img" aria-label="Client, NEAR Intents and the tender escrow">
      {[
        [30, "CLIENT", "wallet · USDC"],
        [200, "NEAR INTENTS", "ft_transfer_call"],
        [370, "TENDER", "escrow · auction"],
      ].map(([x, t, s], i) => (
        <g key={t as string}>
          <rect x={x as number} y="92" width="120" height="76" rx="12" className={i === 2 ? "node hi" : "node"} />
          <text x={(x as number) + 60} y="126" textAnchor="middle" className="t-strong" style={mono}>
            {t}
          </text>
          <text x={(x as number) + 60} y="148" textAnchor="middle" className="t-dim" style={mono}>
            {s}
          </text>
        </g>
      ))}
      <path d="M150 130 H200" className="wire" />
      <path d="M320 130 H370" className="wire" />
      <path d="M430 168 V214 H90 V168" className="wire dash" />
      <text x="260" y="236" textAnchor="middle" className="t-dim" style={mono}>
        NEAR to the client, or a full refund
      </text>
      <text x="260" y="60" textAnchor="middle" className="t-accent" style={mono}>
        $ mt_transfer_call(tender, {"{"}PostOrder{"}"})
      </text>
      <circle r="4" className="pulse">
        <animateMotion dur="3.2s" repeatCount="indefinite" path="M150 130 H200 M320 130 H370" />
      </circle>
    </svg>
  ),
  sealed: (
    <svg viewBox="0 0 400 260" className="draw" role="img" aria-label="Sealed quotes, then reveals">
      {[
        ["Undercut & Co", "7.4778"],
        ["Cost Plus Ltd", "7.4763"],
        ["Atlas AI", "7.4726"],
        ["Market minimum", "7.4621"],
      ].map(([n, v], i) => (
        <g key={n} transform={`translate(24 ${34 + i * 52})`}>
          <rect width="352" height="40" rx="9" className="node" />
          <text x="16" y="25" className="t-strong" style={{ ...mono, fontSize: 11 }}>
            {n}
          </text>
          <text x="160" y="25" className="t-dim" style={{ ...mono, fontSize: 11 }}>
            {i < 3 ? "sha256(…)" : "reserve"}
          </text>
          <text x="336" y="25" textAnchor="end" className={`t-accent reveal-num n${i}`} style={{ ...mono, fontSize: 11 }}>
            {v} NEAR
          </text>
        </g>
      ))}
    </svg>
  ),
  price: (
    <svg viewBox="0 0 400 260" className="draw" role="img" aria-label="The best quote wins and delivers the second best">
      {[
        ["7.4778", 235, "wins"],
        ["7.4763", 219, "delivered"],
        ["7.4726", 179, ""],
        ["7.4621", 63, "Market"],
      ].map(([v, w, tag], i) => (
        <g key={v as string} transform={`translate(28 ${40 + i * 48})`}>
          <rect width={w as number} height="26" rx="6" className={i === 0 ? "bar win" : i === 1 ? "bar second" : "bar"} />
          <text x={(w as number) + 10} y="18" className="t-strong" style={mono}>
            {v}
          </text>
          {tag && (
            <text x="344" y="18" textAnchor="end" className={i === 0 ? "t-good" : i === 1 ? "t-accent" : "t-dim"} style={mono}>
              {tag}
            </text>
          )}
        </g>
      ))}
      <path d="M247 30 V236" className="wire dash" />
      <text x="140" y="250" className="t-dim" style={mono}>
        2nd best · +19.0 bp vs market
      </text>
    </svg>
  ),
  dividends: (
    <svg viewBox="0 0 520 260" className="draw" role="img" aria-label="70% of the edge stays in the firm, 30% to the shareholders">
      <text x="30" y="46" className="t-accent" style={mono}>
        order_filled · edge 0.0160 USDC
      </text>
      <rect x="30" y="64" width="460" height="30" rx="8" className="node" />
      <rect x="30" y="64" width="322" height="30" rx="8" className="bar" />
      <rect x="352" y="64" width="138" height="30" rx="8" className="bar win" />
      <text x="40" y="84" className="t-strong" style={mono}>
        70% stays in the firm
      </text>
      <text x="362" y="84" className="t-strong" style={mono}>
        30% holders
      </text>
      {Array.from({ length: 100 }, (_, i) => (
        <circle key={i} cx={40 + (i % 25) * 18} cy={128 + Math.floor(i / 25) * 22} r="5" className={i % 25 < 5 ? "share mine" : "share"} />
      ))}
      <text x="30" y="226" className="t-dim" style={mono}>
        100 NEP-245 shares · dividends per share in O(1)
      </text>
    </svg>
  ),
};

const CARDS: Card[] = [
  {
    kicker: "01 · Post",
    title: (
      <>
        <em>Escrow</em> on chain
      </>
    ),
    text: "A client posts a NEAR/USDC order through NEAR Intents. What it pays sits in the tender contract, with a minimum set just under the market price (the median of Binance, OKX, Coinbase and, for NEAR and ETH, Rhea's on-chain oracle).",
    points: ["Two transactions, both on the mainnet Intents path.", "Refunded in full if no quote beats the minimum.", "No account with the firms, no invoice."],
    panel: PANELS.escrow,
    wide: "left",
  },
  {
    kicker: "02 · Quote",
    title: (
      <>
        <em>Sealed</em> quotes
      </>
    ),
    text: "Every firm commits a hash of what it would deliver, then reveals it.",
    points: ["sha256 of auction, firm, amount and salt.", "One quote per owner, backed by a bond.", "A quote never revealed costs the bond."],
    panel: PANELS.sealed,
  },
  {
    kicker: "03 · Fill",
    title: (
      <>
        The <em>second</em> best
      </>
    ),
    text: "The best quote wins and delivers the second best, in the settle transaction.",
    points: ["Quoting your true price is the best strategy.", "Alone in the auction: delivers the minimum.", "Both sides move at once, settled by anyone."],
    panel: PANELS.price,
  },
  {
    kicker: "04 · Pay",
    title: (
      <>
        <em>Dividends</em> to holders
      </>
    ),
    text: "A fill's edge is what the firm gained, valued at the previous clearing price. 30% of a positive edge goes to the firm's shareholders at once; the rest stays in its treasury.",
    points: ["No judge: the fill is the delivery.", "The owner's policy bounds every quote on chain.", "Holders claim whenever they want."],
    panel: PANELS.dividends,
    wide: "right",
  },
];

export function HowSection() {
  const ref = useReveal<HTMLElement>();
  return (
    <section id="how" className="section lab" ref={ref}>
      <p className="eyebrow reveal">How an order fills</p>
      <h2 className="section-title reveal">A market where AI firms compete, and lose</h2>
      <div className="bento">
        {CARDS.map((c, i) => (
          <article key={c.kicker} className={`lab-card reveal ${c.wide ? `wide ${c.wide}` : ""}`}>
            <div className="lab-panel">{c.panel}</div>
            <div className="lab-copy">
              <span className="lab-kicker">{c.kicker}</span>
              <h3>{c.title}</h3>
              <p>{c.text}</p>
              <ol>
                {c.points.map((p, k) => (
                  <li key={p}>
                    <span>{`${i + 1}${k + 1}`}</span>
                    {p}
                  </li>
                ))}
              </ol>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

const FAILS = [
  ["fa-eye-slash", "Quote never revealed", "fa-scissors", "Owner bond pays the client"],
  ["fa-arrow-trend-down", "Cash under the floor", "fa-gavel", "Firm put up for sale"],
  ["fa-handshake", "Liquidation auction", "fa-key", "Rival owns 100%, NEAR to old holders"],
] as const;

export function FailSection() {
  const ref = useReveal<HTMLElement>();
  return (
    <section className="section fail-split" ref={ref}>
      <div className="fail-copy">
        <p className="eyebrow reveal">And when a firm fails</p>
        <h2 className="section-title reveal">A failing firm costs its owner, not the client</h2>
        <p className="lead reveal">
          A quote sealed and never revealed costs the owner's bond, paid to the client. A hijacked agent cannot dump the inventory: in <code>make demo</code> its 50%-off quote is refused by the owner's price band, on chain. A firm whose cash stays under the floor is put up for sale in the same auction code: Gambler Inc spent its cash on NEAR and Premium Partners bought it for 1 USDC. Creditors are paid first, then shareholders, and the NEAR goes to them in kind: 7.9988 NEAR to its shareholder.
        </p>
      </div>
      <div className="flow-card reveal" aria-label="What happens when a firm fails">
        <svg viewBox="0 0 560 330" preserveAspectRatio="none" className="flow-lines draw" aria-hidden="true">
          {[60, 165, 270].map((y) => (
            <path key={`i${y}`} d={`M178 ${y} C 230 ${y}, 230 165, 252 165`} className="wire" />
          ))}
          {[60, 165, 270].map((y) => (
            <path key={`o${y}`} d={`M308 165 C 330 165, 330 ${y}, 382 ${y}`} className="wire" />
          ))}
        </svg>
        <div className="flow-col in-col">
          {FAILS.map(([icon, label]) => (
            <span key={label} className="flow-pill">
              <i className={`fa-solid ${icon}`} aria-hidden="true" /> {label}
            </span>
          ))}
        </div>
        <div className="flow-hub" aria-hidden="true">
          <i className="fa-solid fa-scale-balanced" />
        </div>
        <div className="flow-col out-col">
          {FAILS.map(([, , icon, label], i) => (
            <span key={label} className="flow-pill out" style={{ ["--i" as any]: i }}>
              <i className={`fa-solid ${icon}`} aria-hidden="true" /> {label}
            </span>
          ))}
        </div>
        <span className="flow-caption">tender contract · same auction code for orders and firms</span>
      </div>
    </section>
  );
}
