// Link previews. Crawlers (X, Discord, Slack, Telegram, LinkedIn...) do not run the app's JavaScript, so the
// server writes each page's title, description and Open Graph tags into index.html, from the cached chain state.

export type Meta = { title: string; description: string };
export type MetaData = { state: { firms: any[]; jobs: any[] }; stats: Record<string, any>; thesis: { result: any } };

const HOME: Meta = {
  title: "Tontine | The Firm Layer Of The Agent Economy",
  description: "AI micro-firms win jobs by sealed bid, pay dividends, go bankrupt and get bought by their rivals, all settled on NEAR.",
};
const IMAGE_ALT = "A pixel-art city at dusk where every tower is an AI firm, under the words The Firm Layer Of The Agent Economy.";
const STATUS: Record<string, string> = { Solvent: "Solvent", Illiquid: "Under its treasury floor", Liquidating: "In liquidation", Closed: "Closed" };

const usdc = (base: unknown) => (Number(base ?? 0) / 1e6).toFixed(2);
/** At most `n` characters, cut at the end of a word. */
function clip(s: string, n: number): string {
  if (s.length <= n) return s;
  const cut = s.lastIndexOf(" ", n - 1);
  return s.slice(0, cut > n / 2 ? cut : n - 1).replace(/[\s,.:;]+$/, "") + "…";
}
const jobs = (n: unknown) => `${Number(n ?? 0)} job${Number(n) === 1 ? "" : "s"}`;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function firmName(f: any): string {
  try {
    const spec = f?.profile ? JSON.parse(f.profile) : null;
    if (typeof spec?.name === "string" && spec.name) return spec.name;
  } catch {}
  return f?.strategy?.name ?? `Firm #${f?.id}`;
}

function job(id: number, d: MetaData): Meta {
  const j = d.state.jobs.find((x) => x.id === id);
  if (!j) return { title: `Job #${id}`, description: "A job on Tontine: sealed bids, the winner, the second price it is paid, the deliverable and the 70/30 split." };
  const a = j.auctionState ?? {};
  const firm = d.state.firms.find((f) => f.id === a.winner);
  const won = firm ? `Won by ${firmName(firm)} at ${usdc(a.price)} USDC, the second-lowest of ${a.bids?.length ?? 0} sealed bids` : "";
  const outcome: Record<string, string> = {
    Bidding: `Open auction with a ${usdc(j.budget)} USDC budget: AI firms are sealing their bids, the lowest wins and is paid the second-lowest price.`,
    Assigned: `${won}. The firm is doing the work.`,
    Delivered: `${won}. Delivered, under review.`,
    Disputed: `${won}. The client disputed the delivery and a panel of rival firms is voting.`,
    Paid: `${won}, and paid on delivery: after Tontine's fee, 70% to the firm and 30% to its shareholders.`,
    Rejected: `${won}. The delivery was rejected: the client was refunded and the owner's bond slashed.`,
    Cancelled: "Cancelled: the client got its money back.",
  };
  return { title: `Job #${id}: ${clip(j.brief, 60)}`, description: outcome[j.status] ?? HOME.description };
}

function firm(id: number, d: MetaData): Meta {
  const f = d.state.firms.find((x) => x.id === id);
  if (!f) return { title: `Firm #${id}`, description: "An AI firm on Tontine: 100 shares, a treasury, dividends, a bond, and a takeover if it goes bankrupt." };
  let pitch = "";
  try {
    const spec = f.profile ? JSON.parse(f.profile) : null;
    if (typeof spec?.description === "string") pitch = clip(spec.description, 120) + " ";
  } catch {}
  const figures = `${STATUS[f.status] ?? f.status}, ${usdc(f.treasury)} USDC in its treasury, ${usdc(f.revenue)} USDC earned, ${usdc(f.dividends)} USDC paid to its shareholders, ${jobs(f.delivered)} delivered.`;
  return { title: firmName(f), description: pitch + "AI firm with 100 shares. " + figures };
}

export function pageMeta(pathname: string, d: MetaData): Meta {
  const p = pathname.replace(/\/+$/, "") || "/";
  const id = (prefix: string) => (p.startsWith(prefix) && /^\d+$/.test(p.slice(prefix.length)) ? Number(p.slice(prefix.length)) : null);
  const jobId = id("/app/jobs/");
  if (jobId !== null) return job(jobId, d);
  const firmId = id("/app/firms/");
  if (firmId !== null) return firm(firmId, d);
  const s = d.stats;
  switch (p) {
    case "/app":
      return { title: "Live market", description: `${jobs(s.paid)} paid, ${usdc(s.volume)} USDC settled and ${usdc(s.dividends)} USDC paid to shareholders so far on a live NEAR devnet. Every figure is read from the chain.` };
    case "/app/jobs":
      return { title: "Jobs", description: "Every job: the sealed bids, the winner, the second price it is paid, the deliverable and the 70/30 split." };
    case "/app/post":
      return { title: "Post a job", description: "Pay in USDC through NEAR Intents, and AI firms bid for the work in a sealed second-price auction." };
    case "/app/firms":
      return { title: "Firms", description: `${d.state.firms.length} AI firms with 100 shares each: treasuries, dividends, bonds and takeovers. Buy shares, lend, or launch your own.` };
    case "/app/portfolio":
      return { title: "Portfolio", description: "Your wallet, NEAR Intents and Tontine balances, your jobs and your shares." };
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
