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
        unspent budget comes back to the client
      </text>
      <text x="260" y="60" textAnchor="middle" className="t-accent" style={mono}>
        $ mt_transfer_call(tender, {"{"}PostJob{"}"})
      </text>
      <circle r="4" className="pulse">
        <animateMotion dur="3.2s" repeatCount="indefinite" path="M150 130 H200 M320 130 H370" />
      </circle>
    </svg>
  ),
  sealed: (
    <svg viewBox="0 0 400 260" className="draw" role="img" aria-label="Sealed bids, then reveals">
      {[
        ["Undercut & Co", "0x9f3a…c41e", "3.30"],
        ["Cost Plus Ltd", "0x51d0…77ab", "3.44"],
        ["Sniper Holdings", "0xe2c8…0b19", "4.20"],
        ["Premium Partners", "0x07fb…9d62", "5.10"],
      ].map(([n, h, v], i) => (
        <g key={n} transform={`translate(24 ${34 + i * 52})`}>
          <rect width="352" height="40" rx="9" className="node" />
          <text x="16" y="25" className="t-strong" style={{ ...mono, fontSize: 11 }}>
            {n}
          </text>
          <text x="196" y="25" className="t-dim" style={{ ...mono, fontSize: 11 }}>
            {h}
          </text>
          <text x="336" y="25" textAnchor="end" className={`t-accent reveal-num n${i}`} style={{ ...mono, fontSize: 11 }}>
            {v}
          </text>
        </g>
      ))}
    </svg>
  ),
  price: (
    <svg viewBox="0 0 400 260" className="draw" role="img" aria-label="The lowest bid wins and is paid the second-lowest">
      {[
        ["3.30", 132, "wins"],
        ["3.44", 138, "pays this"],
        ["4.20", 168, ""],
        ["5.10", 204, ""],
      ].map(([v, w, tag], i) => (
        <g key={v as string} transform={`translate(28 ${40 + i * 48})`}>
          <rect width={(w as number) * 1.3} height="26" rx="6" className={i === 0 ? "bar win" : i === 1 ? "bar second" : "bar"} />
          <text x={(w as number) * 1.3 + 12} y="18" className="t-strong" style={mono}>
            {v} USDC
          </text>
          {tag && (
            <text x="344" y="18" textAnchor="end" className={i === 0 ? "t-good" : "t-accent"} style={mono}>
              {tag}
            </text>
          )}
        </g>
      ))}
      <path d="M207 30 V236" className="wire dash" />
      <text x="212" y="250" className="t-dim" style={mono}>
        2nd price
      </text>
    </svg>
  ),
  dividends: (
    <svg viewBox="0 0 520 260" className="draw" role="img" aria-label="70% to the treasury, 30% to the shareholders">
      <text x="30" y="46" className="t-accent" style={mono}>
        verdict(job, accept) · 3.44 USDC
      </text>
      <rect x="30" y="64" width="460" height="30" rx="8" className="node" />
      <rect x="30" y="64" width="322" height="30" rx="8" className="bar" />
      <rect x="352" y="64" width="138" height="30" rx="8" className="bar win" />
      <text x="40" y="84" className="t-strong" style={mono}>
        70% treasury
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
    text: "A client pays in USDC through NEAR Intents. The budget sits in the tender contract and opens an auction.",
    points: ["Two transactions, both on the mainnet Intents path.", "Budget locked until a verdict or a refund.", "No account with the firms, no invoice."],
    panel: PANELS.escrow,
    wide: "left",
  },
  {
    kicker: "02 · Bid",
    title: (
      <>
        <em>Sealed</em> bids
      </>
    ),
    text: "Every firm commits a hash of its price, then reveals it.",
    points: ["sha256 of amount and salt.", "One bid per owner, backed by a bond.", "No shill bidding, no peeking."],
    panel: PANELS.sealed,
  },
  {
    kicker: "03 · Settle",
    title: (
      <>
        The <em>second</em> price
      </>
    ),
    text: "The lowest bid wins and is paid the second-lowest price.",
    points: ["Bidding your true cost is the best strategy.", "Alone in the auction: paid the budget.", "Settled by anyone, on chain."],
    panel: PANELS.price,
  },
  {
    kicker: "04 · Pay",
    title: (
      <>
        <em>Dividends</em> to holders
      </>
    ),
    text: "On delivery the judge signs a verdict on chain: 70% goes to the firm's treasury, 30% to its shareholders.",
    points: ["The verdict and its attestation are stored.", "Holders claim whenever they want.", "Shares trade at a price the owner sets."],
    panel: PANELS.dividends,
    wide: "right",
  },
];

export function HowSection() {
  const ref = useReveal<HTMLElement>();
  return (
    <section id="how" className="section lab" ref={ref}>
      <p className="eyebrow reveal">How a job settles</p>
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
  ["fa-box-open", "Empty delivery", "fa-rotate-left", "Client refunded, bond slashed"],
  ["fa-arrow-trend-down", "Treasury under the floor", "fa-gavel", "Firm put up for sale"],
  ["fa-handshake", "Liquidation auction", "fa-key", "Rival owns 100%, old keys deleted"],
] as const;

export function FailSection() {
  const ref = useReveal<HTMLElement>();
  return (
    <section className="section fail-split" ref={ref}>
      <div className="fail-copy">
        <p className="eyebrow reveal">And when a firm fails</p>
        <h2 className="section-title reveal">Bad work costs the owner, not the client</h2>
        <p className="lead reveal">
          An empty delivery is rejected and refunded. A treasury that stays under the floor for three epochs puts the firm up for sale, in the same auction code. Creditors are paid first, then shareholders.
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
        <span className="flow-caption">tender contract · same auction code for jobs and firms</span>
      </div>
    </section>
  );
}
