// Market regime guard: calm, alert or storm, from the asset's realised volatility and the news.
// Volatility is a z-score of the last hour against the trailing 7 days. News is one batched LLM call on
// public RSS headlines (validated JSON), else a keyword heuristic. A Guard combines both with hysteresis.
import type { Llm } from "./llm.ts";
import type { AssetSymbol } from "./prices.ts";

export const NEWS_PROMPT =
  "You rate crypto news headlines for a market maker quoting the asset named in the input against USDC. " +
  'Answer with JSON only: {"level": "calm" | "alert" | "storm", "reasons": [string], "ids": [number]}. ' +
  "storm: a hack, exploit, halt, depeg, delisting or legal action that hits the asset or the venues it trades on, " +
  "or a market-wide crash. alert: risk news that may move the market. Else calm. " +
  "At most 3 short reasons, in English whatever the language of the headlines; ids are the ids of the headlines behind them.";

export type Regime = "calm" | "alert" | "storm";
export const RANK: Record<Regime, number> = { calm: 0, alert: 1, storm: 2 };
export type Point = { t: number; mid: number };

/**
 * Thresholds on the z-score of the last hour's log volatility against the hourly baseline. Log hourly
 * volatility is roughly normal: 2 is its top 2.5%, 3 its top 0.15%. With a typical spread of hourly log vol
 * around 0.4, storm means about 3 times the usual volatility. Calibration knobs: tune on `make bench` data.
 */
export const Z_ALERT = 2;
export const Z_STORM = 3;
/** Floor on the baseline's spread, so a very steady week does not turn a small change into a storm. */
const MIN_SD = 0.1;
/** Baseline hours needed before the z-score counts; below, the level is calm. */
const MIN_HOURS = 24;
const HOUR = 3_600_000;
const BASELINE_HOURS = 7 * 24;

export type VolLevel = { level: Regime; z: number; hourVolPct: number; hours: number; reason: string };

/**
 * Realised volatility of the series' log returns (1- or 5-minute bars, sorted by t in ms) over the last hour,
 * against the 168 hourly buckets before it. Each bucket's variance is sum(r^2) / minutes, so uneven spacing
 * is fine; a bucket needs 3 returns and some movement. z = (ln vol now - mean ln vol) / max(sd, MIN_SD).
 */
export function volatilityLevel(series: Point[]): VolLevel {
  const end = series.at(-1)?.t ?? 0;
  const n = BASELINE_HOURS + 1;
  const sq = new Float64Array(n), mins = new Float64Array(n), cnt = new Uint32Array(n);
  for (let i = 1; i < series.length; i++) {
    const a = series[i - 1], b = series[i];
    const k = Math.floor((end - b.t) / HOUR); // 0: the last hour, 1..168: the baseline
    const dt = (b.t - a.t) / 60_000;
    if (k < 0 || k >= n || dt <= 0 || !(a.mid > 0 && b.mid > 0)) continue;
    sq[k] += Math.log(b.mid / a.mid) ** 2;
    mins[k] += dt;
    cnt[k]++;
  }
  const logVol = (k: number) => (cnt[k] >= 3 && sq[k] > 0 ? 0.5 * Math.log(sq[k] / mins[k]) : null);
  const base: number[] = [];
  for (let k = 1; k < n; k++) {
    const v = logVol(k);
    if (v !== null) base.push(v);
  }
  const now = logVol(0);
  const hourVolPct = now === null ? 0 : Math.exp(now) * Math.sqrt(60) * 100;
  if (now === null || base.length < MIN_HOURS)
    return { level: "calm", z: 0, hourVolPct, hours: base.length, reason: now === null ? "no price movement in the last hour" : `baseline of ${base.length} h, under ${MIN_HOURS} h` };
  const mean = base.reduce((a, b) => a + b, 0) / base.length;
  const sd = Math.sqrt(base.reduce((a, b) => a + (b - mean) ** 2, 0) / base.length);
  const z = (now - mean) / Math.max(sd, MIN_SD);
  const level: Regime = z >= Z_STORM ? "storm" : z >= Z_ALERT ? "alert" : "calm";
  return { level, z, hourVolPct, hours: base.length, reason: `volatility ${hourVolPct.toFixed(2)}% in the last hour, z ${z.toFixed(1)} against ${base.length} h` };
}

/** Public crypto news feeds, checked live on 2026-11-01 (RSS 2.0, 20 to 40 items each). */
export const NEWS_SOURCES = ["https://www.coindesk.com/arc/outboundfeeds/rss", "https://cointelegraph.com/rss", "https://decrypt.co/feed"];
export type Headline = { title: string; link: string; at: number; source: string };

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (s: string) =>
  s
    .replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) =>
      e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENTITIES[e.toLowerCase()],
    )
    .trim();
const tag = (item: string, name: string) => decode(item.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`))?.[1] ?? "");

/** Minimal RSS 2.0 parse: title, link and pubDate of each item; items without a title or a date are dropped. */
export function parseRss(xml: string, source: string): Headline[] {
  return [...xml.matchAll(/<item\b[\s\S]*?<\/item>/g)]
    .map(([it]) => ({ title: tag(it, "title"), link: tag(it, "link"), at: Date.parse(tag(it, "pubDate")), source }))
    .filter((h) => h.title && Number.isFinite(h.at));
}

/** The latest 25 headlines since `sinceMs` across `sources`, newest first, deduped by link and title. 4 s per feed. */
export async function fetchHeadlines(sources: string[] = NEWS_SOURCES, sinceMs = Date.now() - 6 * HOUR, get: typeof fetch = fetch): Promise<Headline[]> {
  const lists = await Promise.all(
    sources.map(async (url) => {
      try {
        const r = await get(url, { signal: AbortSignal.timeout(4000), headers: { "User-Agent": "tontine-guard" } });
        return r.ok ? parseRss(await r.text(), new URL(url).hostname) : [];
      } catch {
        return [];
      }
    }),
  );
  const seen = new Set<string>();
  return lists
    .flat()
    .filter((h) => h.at >= sinceMs)
    .sort((a, b) => b.at - a.at)
    .filter((h) => {
      const keys = [h.link.split("?")[0], h.title.toLowerCase()].filter(Boolean);
      if (keys.some((k) => seen.has(k))) return false;
      keys.forEach((k) => seen.add(k));
      return true;
    })
    .slice(0, 25);
}

export type NewsVerdict = { level: Regime; reasons: string[]; ids: number[]; source: "llm" | "keywords"; chatId?: string; signature?: unknown };

const RISK = /\b(hack(?:s|ed|ers?)?|exploit(?:s|ed)?|halt(?:s|ed)?|delist(?:s|ed|ing)?|lawsuits?|outages?|depeg(?:s|ged)?|liquidation cascades?)\b/i;
const SEC = /\bSEC\b/; // case-sensitive: "sec" is also seconds
/** Tickers match case-sensitively ("near" is an English word), full names do not. */
const NAMES: Record<AssetSymbol, RegExp[]> = {
  NEAR: [/\bNEAR\b/, /\bnear (?:protocol|intents|foundation)\b/i],
  ETH: [/\bETH\b/, /\b(?:ethereum|ether)\b/i],
  SOL: [/\bSOL\b/, /\bsolana\b/i],
};

/**
 * Without an LLM: a headline with a risk keyword (hack, exploit, halt, delist, SEC, lawsuit, outage, depeg,
 * liquidation cascade) makes it alert, the asset's own headlines listed first. Keywords never make a storm:
 * a storm pauses the managed firms, and only measured volatility or an LLM that read the headline may do that.
 * ponytail: keyword match, no context ("hackathon" is safe, "hack fears ease" is not); the LLM path reads context.
 */
export function keywordLevel(headlines: Headline[], asset: AssetSymbol): NewsVerdict {
  const hot = headlines.map((h, id) => ({ h, id, named: NAMES[asset].some((r) => r.test(h.title)) })).filter(({ h }) => RISK.test(h.title) || SEC.test(h.title));
  hot.sort((a, b) => Number(b.named) - Number(a.named));
  const top = hot.slice(0, 3);
  const level: Regime = hot.length ? "alert" : "calm";
  return { level, reasons: top.map((x) => x.h.title.slice(0, 160)), ids: top.map((x) => x.id), source: "keywords" };
}

/** Strict check of the LLM's answer: exactly level, reasons (at most 3 strings) and ids (indexes of `n` headlines). */
export function validateNews(j: unknown, n: number): Omit<NewsVerdict, "source"> | null {
  if (typeof j !== "object" || j === null || Array.isArray(j)) return null;
  const o = j as Record<string, unknown>;
  if (Object.keys(o).some((k) => !["level", "reasons", "ids"].includes(k))) return null;
  if (typeof o.level !== "string" || !Object.hasOwn(RANK, o.level)) return null;
  // Reasons in English (Latin script): the site shows them as they are (one came back in Chinese, 2026-11-01).
  if (!Array.isArray(o.reasons) || o.reasons.length > 3 || !o.reasons.every((r) => typeof r === "string" && LATIN.test(r))) return null;
  if (!Array.isArray(o.ids) || !o.ids.every((i) => Number.isInteger(i) && i >= 0 && i < n)) return null;
  return { level: o.level as Regime, reasons: (o.reasons as string[]).map((r) => r.slice(0, 160)), ids: o.ids as number[] };
}

const LATIN = /^[\x20-\x7e\u00a0-\u024f\u2010-\u2027\u20ac]*$/;

/** One batched LLM call on the headlines; without a live LLM, or on an invalid answer, the keyword heuristic. */
export async function newsLevel(llm: Llm | null, headlines: Headline[], asset: AssetSymbol): Promise<NewsVerdict> {
  if (!headlines.length) return { level: "calm", reasons: [], ids: [], source: "keywords" };
  if (llm?.live) {
    try {
      const c = await llm.complete(NEWS_PROMPT, JSON.stringify({ asset, headlines: headlines.map((h, id) => ({ id, title: h.title })) }));
      const v = validateNews(JSON.parse(c.text.slice(c.text.indexOf("{"), c.text.lastIndexOf("}") + 1)), headlines.length);
      if (v) return { ...v, source: "llm", chatId: c.chatId, signature: c.signature };
    } catch {}
  }
  return keywordLevel(headlines, asset);
}

export type GuardState = { level: Regime; since: number; reasons: string[]; source: "llm" | "keywords" | "volatility" };

/** A level holds at least this long before it may drop. Rising is immediate: a storm is acted on at once. */
export const HOLD_MS = 15 * 60_000;
/** News is re-rated at most once per 10 minutes, so the LLM costs at most one call per 10 minutes per Guard. */
export const NEWS_EVERY_MS = 10 * 60_000;
/** A news verdict not refreshed for an hour (feeds down) is dropped. */
const NEWS_TTL_MS = 60 * 60_000;

/**
 * The regime of one asset: the higher of volatility and news, with hysteresis. News alone raises an alert at
 * most: a storm takes a price that moves too (volatility at alert or above), or the volatility alone. With calm
 * prices, a headline (the Binance hack, 2026-11-01) had put every market in a storm for hours, quotes 30 to
 * 40 bp from the mid.
 */
export class Guard {
  private state: GuardState | null = null;
  private news: (NewsVerdict & { at: number }) | null = null;
  constructor(private llm: Llm | null, private asset: AssetSymbol = "NEAR") {}

  async update(now: number, series: Point[], headlines?: Headline[]): Promise<GuardState> {
    if (headlines && (!this.news || now - this.news.at >= NEWS_EVERY_MS)) this.news = { ...(await newsLevel(this.llm, headlines, this.asset)), at: now };
    if (this.news && now - this.news.at > NEWS_TTL_MS) this.news = null;
    const vol = volatilityLevel(series);
    const n = this.news;
    const cap: Regime = RANK[vol.level] >= RANK.alert ? "storm" : "alert";
    const fromNews: Regime | null = n && n.level !== "calm" ? (RANK[n.level] > RANK[cap] ? cap : n.level) : null;
    const byNews = n !== null && fromNews !== null && RANK[fromNews] >= RANK[vol.level];
    const next: GuardState = { level: byNews ? fromNews! : vol.level, since: now, reasons: byNews ? n!.reasons : [vol.reason], source: byNews ? n!.source : "volatility" };
    const cur = this.state;
    if (!cur || (next.level !== cur.level && (RANK[next.level] > RANK[cur.level] || now - cur.since >= HOLD_MS))) this.state = next;
    else if (next.level === cur.level) this.state = { ...next, since: cur.since };
    return this.state!;
  }
}
