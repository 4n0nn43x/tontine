// Link previews. Crawlers (X, Discord, Slack, Telegram, LinkedIn...) do not run the app's JavaScript, so the
// server writes each page's title, description and Open Graph tags into index.html, from the cached chain state.

export type Meta = { title: string; description: string };
export type MetaData = { state: { firms: any[]; orders: any[] }; stats: Record<string, any>; thesis: { result: any } };

const HOME: Meta = {
  title: "Tontine | The Firm Layer Of The Agent Economy",
  description: "AI market-making firms with shares and dividends quote NEAR swaps by sealed bid, go bankrupt and get bought by their rivals, all settled on NEAR.",
};
const IMAGE_ALT = "A pixel-art city at dusk where every tower is an AI firm, under the words The Firm Layer Of The Agent Economy.";
const STATUS: Record<string, string> = { Solvent: "Solvent", Illiquid: "Under its cash floor", Liquidating: "In liquidation", Closed: "Closed" };

const usdc = (base: unknown) => (Number(base ?? 0) / 1e6).toFixed(2);
const near = (base: unknown) => (Number(BigInt(String(base ?? 0))) / 1e24).toFixed(3);
/** At most `n` characters, cut at the end of a word. */
function clip(s: string, n: number): string {
  if (s.length <= n) return s;
  const cut = s.lastIndexOf(" ", n - 1);
  return s.slice(0, cut > n / 2 ? cut : n - 1).replace(/[\s,.:;]+$/, "") + "…";
}
const count = (n: unknown, word: string) => `${Number(n ?? 0)} ${word}${Number(n) === 1 ? "" : "s"}`;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function firmName(f: any): string {
  try {
    const spec = f?.profile ? JSON.parse(f.profile) : null;
    if (typeof spec?.name === "string" && spec.name) return spec.name;
  } catch {}
  return f?.strategy?.name ?? `Firm #${f?.id}`;
}

function order(id: number, d: MetaData): Meta {
  const o = d.state.orders.find((x) => x.id === id);
  if (!o) return { title: `Order #${id}`, description: "A NEAR/USDC order on Tontine: AI firms quote by sealed bid, the best fills at the second best, never worse than NEAR Intents 1Click." };
  const what = o.side === "Buy" ? `Buy NEAR with ${usdc(o.amount_in)} USDC` : `Sell ${near(o.amount_in)} NEAR for USDC`;
  const got = (v: unknown) => (o.side === "Buy" ? `${near(v)} NEAR` : `${usdc(v)} USDC`);
  const firm = d.state.firms.find((f) => f.id === o.firm);
  const bids = o.auctionState?.bids?.length ?? 0;
  const ref = o.reference_out ? BigInt(o.reference_out) : 0n;
  const better = o.out && ref > 0n ? ` That is ${((Number(BigInt(o.out) - ref) / Number(ref)) * 1e4).toFixed(1)} bp better than NEAR Intents 1Click.` : "";
  const outcome: Record<string, string> = {
    Open: `Open auction: AI firms are sealing their quotes. The best fills at the second best, and never under ${got(o.min_out)}.`,
    Filled: `Filled by ${firm ? firmName(firm) : `firm #${o.firm}`} out of ${count(bids, "sealed bid")}: the client got ${got(o.out)}, the second best quote.${better}`,
    Refunded: "No quote beat the client's minimum: refunded.",
  };
  return { title: `Order #${id}: ${what}`, description: outcome[o.status] ?? HOME.description };
}

function firm(id: number, d: MetaData): Meta {
  const f = d.state.firms.find((x) => x.id === id);
  if (!f) return { title: `Firm #${id}`, description: "An AI market-making firm on Tontine: 100 shares, a cash treasury, a NEAR inventory, dividends, a bond, and a takeover if it fails." };
  let pitch = "";
  try {
    const spec = f.profile ? JSON.parse(f.profile) : null;
    if (typeof spec?.description === "string") pitch = clip(spec.description, 120) + " ";
  } catch {}
  const figures = `${STATUS[f.status] ?? f.status}, ${usdc(f.treasury)} USDC and ${near(f.inventory)} NEAR, ${count(f.fills, "fill")}, ${usdc(f.dividends)} USDC paid to its shareholders.`;
  return { title: firmName(f), description: pitch + "AI firm with 100 shares. " + figures };
}

export function pageMeta(pathname: string, d: MetaData): Meta {
  const p = pathname.replace(/\/+$/, "") || "/";
  const id = (prefix: string) => (p.startsWith(prefix) && /^\d+$/.test(p.slice(prefix.length)) ? Number(p.slice(prefix.length)) : null);
  const orderId = id("/app/orders/");
  if (orderId !== null) return order(orderId, d);
  const firmId = id("/app/firms/");
  if (firmId !== null) return firm(firmId, d);
  const s = d.stats;
  switch (p) {
    case "/app":
      return { title: "Live market", description: `${count(s.fills, "order")} filled, ${usdc(s.volume)} USDC traded and ${usdc(s.dividends)} USDC paid to shareholders so far on a live NEAR devnet. Every figure is read from the chain.` };
    case "/city":
      return { title: "Tontine City", description: "A live pixel city where every tower is an AI firm on a NEAR devnet: it grows with its fills, goes dark when it is for sale, moves next to its buyer and comes down when it is wound up." };
    case "/app/orders":
      return { title: "Orders", description: "Every NEAR/USDC order: the sealed quotes, the winner, the second best it delivers, and how it compares with NEAR Intents 1Click." };
    case "/app/trade":
      return { title: "Trade", description: "Swap NEAR and USDC through NEAR Intents: AI firms quote by sealed bid, and you never get less than the 1Click price." };
    case "/app/firms":
      return { title: "Firms", description: `${d.state.firms.length} AI market-making firms with 100 shares each: cash, inventory, dividends, bonds and takeovers. Buy shares, lend, or launch your own.` };
    case "/app/portfolio":
      return { title: "Portfolio", description: "Your wallet, NEAR Intents and Tontine balances, your orders and your shares." };
    case "/thesis": {
      const r = d.thesis.result;
      const multiple = r ? `Intents volume must grow ${r.multiple_2_5.toFixed(1)}x for buybacks to match NEAR emission. ` : "";
      return {
        title: "NEAR captures agent value through Intents-funded buybacks, not gas",
        description: `${multiple}Pre-registered test: the take rate stays at or above 4 bp from 2026-11-01 to 2026-11-12, ${!r || r.P3.status.startsWith("pending") ? "verdict on 2026-11-14" : `verdict: ${r.P3.status}`}. Rebuilt from public data with one command.`,
      };
    }
    default:
      return HOME;
  }
}

/** Replace the block between `<!-- meta -->` and `<!-- /meta -->` in index.html with the page's tags. */
export function withMeta(html: string, m: Meta, origin: string, pathname: string): string {
  const start = html.indexOf("<!-- meta -->");
  const end = html.indexOf("<!-- /meta -->");
  if (start < 0 || end < start) return html;
  const docTitle = m === HOME ? m.title : `${m.title} | Tontine`;
  const url = origin + pathname;
  const tags = [
    `<title>${esc(docTitle)}</title>`,
    `<meta name="description" content="${esc(m.description)}" />`,
    `<link rel="canonical" href="${esc(url)}" />`,
    `<meta property="og:site_name" content="Tontine" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:url" content="${esc(url)}" />`,
    `<meta property="og:title" content="${esc(m.title)}" />`,
    `<meta property="og:description" content="${esc(m.description)}" />`,
    `<meta property="og:image" content="${esc(origin)}/og.png" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta property="og:image:alt" content="${esc(IMAGE_ALT)}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
  ].join("\n    ");
  return html.slice(0, start) + tags + html.slice(end + "<!-- /meta -->".length);
}
