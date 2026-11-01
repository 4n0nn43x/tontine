import { test } from "node:test";
import assert from "node:assert/strict";
import type { Completion, Llm } from "./llm.ts";
import { fetchHeadlines, Guard, HOLD_MS, keywordLevel, newsLevel, parseRss, volatilityLevel, type Headline, type Point } from "./guard.ts";

const T0 = Date.UTC(2026, 10, 1);
const MIN = 60_000;
/** 8 days of 5-minute bars zigzagging by `base` (log), the last hour by `last`. */
function zigzag(base: number, last: number): Point[] {
  const n = 8 * 288;
  let x = Math.log(4);
  return Array.from({ length: n }, (_, i) => {
    x += (i % 2 ? 1 : -1) * (i >= n - 12 ? last : base);
    return { t: T0 + i * 5 * MIN, mid: Math.exp(x) };
  });
}
/** Seeded noise around 4 USD, 1-minute bars over 8 days. */
function noisy(sd: number): Point[] {
  let a = 7;
  const u = () => ((a = (a * 1103515245 + 12345) % 2 ** 31) + 1) / (2 ** 31 + 1);
  let x = Math.log(4);
  return Array.from({ length: 8 * 1440 }, (_, i) => {
    x += sd * Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
    return { t: T0 + i * MIN, mid: Math.exp(x) };
  });
}

test("volatility: calm, alert and storm against a 7-day baseline", () => {
  assert.equal(volatilityLevel(noisy(0.0005)).level, "calm");
  assert.equal(volatilityLevel(zigzag(0.001, 0.001)).level, "calm");
  const alert = volatilityLevel(zigzag(0.001, 0.0013));
  assert.equal(alert.level, "alert", alert.reason);
  const storm = volatilityLevel(zigzag(0.001, 0.003));
  assert.equal(storm.level, "storm");
  assert.equal(storm.hours, 168);
  assert.ok(storm.z > 10);
  const young = volatilityLevel(zigzag(0.001, 0.003).slice(-12 * 10));
  assert.equal(young.level, "calm", "under 24 h of baseline");
  assert.match(young.reason, /under 24 h/);
  assert.equal(volatilityLevel([]).level, "calm");
});

const h = (title: string, i = 0): Headline => ({ title, link: `https://x.test/${i}`, at: T0 - i * MIN, source: "x.test" });

test("keyword heuristic: risk words alert, never storm, the asset's headlines first", () => {
  assert.equal(keywordLevel([h("Bitcoin ETF flows steady"), h("NEAR hits new users record")], "NEAR").level, "calm");
  const a = keywordLevel([h("Bitcoin ETF flows steady"), h("Binance hack: withdrawals halted", 1)], "NEAR");
  assert.deepEqual([a.level, a.ids], ["alert", [1]]);
  assert.equal(keywordLevel([h("SEC sues a DeFi lender")], "NEAR").level, "alert");
  assert.equal(keywordLevel([h("Rates near 5% for a while")], "NEAR").level, "calm", "the English word near is not the ticker");
  assert.equal(keywordLevel([h("Prices near record after the sec filing")], "NEAR").level, "calm", "sec in lower case is not the SEC");
  const s = keywordLevel([h("Bridge exploit drains a lender", 0), h("NEAR Protocol bridge exploited", 1), h("Solana outage", 2)], "NEAR");
  assert.equal(s.level, "alert", "a keyword alone never pauses the firms");
  assert.equal(s.ids[0], 1, "the asset's headline first");
  assert.equal(keywordLevel([h("Solana validators outage")], "SOL").level, "alert");
});

const fake = (text: string): Llm & { calls: number } => ({
  live: true,
  calls: 0,
  async complete(): Promise<Completion> {
    this.calls++;
    return { text, chatId: "c", model: "fake", signature: { s: 1 }, source: "near-ai-cloud" };
  },
});

test("news: a valid LLM answer is used, an invalid one falls back to keywords", async () => {
  const hs = [h("Binance hack: withdrawals halted"), h("NEAR hits new users record", 1)];
  const ok = await newsLevel(fake('{"level":"storm","reasons":["largest exchange hacked"],"ids":[0]}'), hs, "NEAR");
  assert.deepEqual([ok.level, ok.source, ok.chatId], ["storm", "llm", "c"]);
  for (const bad of ['{"level":"panic","reasons":[],"ids":[]}', '{"level":"calm","reasons":["a","b","c","d"],"ids":[]}', '{"level":"calm","reasons":[],"ids":[7]}', '{"level":"calm","reasons":[],"ids":[],"x":1}', "no json"]) {
    const v = await newsLevel(fake(bad), hs, "NEAR");
    assert.deepEqual([v.level, v.source], ["alert", "keywords"], bad);
  }
  assert.equal((await newsLevel(fake("{}"), [], "NEAR")).level, "calm");
});

test("guard: rises at once, holds 15 minutes before dropping, one news call per 10 minutes", async () => {
  const llm = fake('{"level":"alert","reasons":["exchange hack"],"ids":[0]}');
  const g = new Guard(llm, "NEAR");
  const calm = zigzag(0.001, 0.001), storm = zigzag(0.001, 0.003);
  const t = T0 + 10 * 86_400_000;
  assert.deepEqual(await g.update(t, calm), { level: "calm", since: t, reasons: [volatilityLevel(calm).reason], source: "volatility" });
  const s = await g.update(t + MIN, storm);
  assert.deepEqual([s.level, s.since, s.source], ["storm", t + MIN, "volatility"]);
  assert.equal((await g.update(t + 5 * MIN, calm)).level, "storm", "held");
  const hs = [h("Binance hack")];
  const a = await g.update(t + MIN + HOLD_MS, calm, hs);
  assert.deepEqual([a.level, a.source, a.reasons], ["alert", "llm", ["exchange hack"]], "after 15 minutes it drops, to the news level");
  await g.update(t + MIN + HOLD_MS + MIN, calm, hs);
  await g.update(t + MIN + HOLD_MS + 9 * MIN, calm, hs);
  assert.equal(llm.calls, 1, "news re-rated at most every 10 minutes");
  await g.update(t + MIN + HOLD_MS + 10 * MIN, calm, hs);
  assert.equal(llm.calls, 2);
});

const RSS = `<?xml version="1.0"?><rss><channel><title>Feed</title>
<item><title><![CDATA[Hackers drain a bridge &amp; more]]></title><link>https://a.test/1?utm=x</link><pubDate>Sun, 01 Nov 2026 10:00:00 +0000</pubDate></item>
<item><title>Old news</title><link>https://a.test/0</link><pubDate>Sat, 24 Oct 2026 10:00:00 +0000</pubDate></item>
<item><title>No date</title><link>https://a.test/2</link></item>
</channel></rss>`;
const RSS2 = `<rss><channel><item><title>Hackers drain a bridge &amp; more</title><link>https://b.test/9</link><pubDate>Sun, 01 Nov 2026 09:00:00 +0000</pubDate></item>
<item><title>ETH &#8216;steady&#x2019;</title><link>https://b.test/8</link><pubDate>Sun, 01 Nov 2026 11:00:00 +0000</pubDate></item>
<item><title>Same story, new title</title><link>https://a.test/1?utm=y</link><pubDate>Sun, 01 Nov 2026 08:00:00 +0000</pubDate></item></channel></rss>`;

test("RSS: parse, since, dedupe, newest first, 4 s timeout, failures skipped (fetch stubbed)", async () => {
  assert.deepEqual(parseRss(RSS, "a.test").map((x) => x.title), ["Hackers drain a bridge & more", "Old news"]);
  const seen: unknown[] = [];
  const stub = (async (url: string, init: RequestInit) => {
    seen.push(init.signal);
    if (url.includes("down")) throw new Error("timeout");
    if (url.includes("500")) return new Response("x", { status: 500 });
    return new Response(url.includes("a.test") ? RSS : RSS2);
  }) as typeof fetch;
  const got = await fetchHeadlines(["https://a.test/rss", "https://b.test/rss", "https://down.test/rss", "https://500.test/rss"], Date.UTC(2026, 9, 31), stub);
  assert.deepEqual(got.map((x) => [x.title, x.source]), [["ETH ‘steady’", "b.test"], ["Hackers drain a bridge & more", "a.test"]]);
  assert.equal(seen.length, 4);
  assert.ok(seen.every((s) => s instanceof AbortSignal));
});
