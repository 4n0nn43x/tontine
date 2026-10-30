import { test } from "node:test";
import assert from "node:assert/strict";
import { pageMeta, withMeta } from "./meta.ts";

const data = {
  state: {
    firms: [{ id: 1, status: "Solvent", treasury: "4200000", revenue: "6000000", dividends: "1800000", delivered: 1, profile: '{"name":"Cost Plus Ltd"}' }],
    jobs: [{ id: 7, brief: "Summarize the NEAR Intents fee page", budget: "10000000", status: "Paid", auctionState: { winner: 1, price: "5500000", bids: [{}, {}, {}] } }],
  },
  stats: { paid: 1, volume: "5500000", dividends: "1633500" },
  thesis: { result: { multiple_2_5: 5.43, P3: { status: "pending (0/12 days)" } } },
};

test("link previews describe the page from the chain state", () => {
  const job = pageMeta("/app/jobs/7", data);
  assert.equal(job.title, "Job #7: Summarize the NEAR Intents fee page");
  assert.match(job.description, /^Won by Cost Plus Ltd at 5\.50 USDC, the second-lowest of 3 sealed bids, and paid/);
  assert.equal(pageMeta("/app/firms/1/", data).title, "Cost Plus Ltd");
  assert.match(pageMeta("/thesis", data).description, /5\.4x.*verdict on 2026-11-14\./);
  const long = { ...data, state: { ...data.state, firms: [{ ...data.state.firms[0], profile: JSON.stringify({ description: "word ".repeat(40) }) }] } };
  assert.match(pageMeta("/app/firms/1", long).description, /word… AI firm/, "cut at the end of a word");
  assert.equal(pageMeta("/app/jobs/99", data).title, "Job #99", "a job out of the cache still gets a title");
  assert.equal(pageMeta("/nowhere", data).title, "Tontine | The Firm Layer Of The Agent Economy");
});

test("withMeta replaces the marked block, escapes values and makes URLs absolute", () => {
  const html = "<head>\n<!-- meta -->\n<title>old</title>\n<!-- /meta -->\n</head>";
  const out = withMeta(html, { title: 'A "quoted" <b>', description: "d" }, "https://tontine.fyra.fun", "/app/jobs/7");
  assert.ok(!out.includes("<title>old</title>"));
  assert.ok(out.includes("<title>A &quot;quoted&quot; &lt;b&gt; | Tontine</title>"));
  assert.ok(out.includes('<meta property="og:image" content="https://tontine.fyra.fun/og.png" />'));
  assert.ok(out.includes('<meta property="og:url" content="https://tontine.fyra.fun/app/jobs/7" />'));
  assert.equal(withMeta("<head></head>", { title: "t", description: "d" }, "x", "/"), "<head></head>", "no markers: unchanged");
});
