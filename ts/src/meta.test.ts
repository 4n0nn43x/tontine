import { test } from "node:test";
import assert from "node:assert/strict";
import { pageMeta, withMeta } from "./meta.ts";

const NEAR = 10n ** 24n;
const data = {
  state: {
    firms: [{ id: 1, status: "Solvent", treasury: "400000000", inventory: (60n * NEAR).toString(), fills: 1, dividends: "1800000", profile: '{"name":"Cost Plus Ltd"}' }],
    orders: [{ id: 7, side: "Buy", amount_in: "40000000", min_out: (7n * NEAR).toString(), reference_out: (746n * NEAR / 100n).toString(), out: (7476n * NEAR / 1000n).toString(), status: "Filled", firm: 1, auctionState: { bids: [{}, {}, {}] } }],
  },
  stats: { fills: 1, volume: "40000000", dividends: "1800000" },
  thesis: { result: { multiple_2_5: 5.43, P3: { status: "pending (0/12 days)" } } },
};

test("link previews describe the page from the chain state", () => {
  const o = pageMeta("/app/orders/7", data);
  assert.equal(o.title, "Order #7: Buy NEAR with 40.00 USDC");
  assert.match(o.description, /^Filled by Cost Plus Ltd out of 3 sealed bids: the client got 7\.476 NEAR, the second best quote\. That is 21\.4 bp better than NEAR Intents 1Click\.$/);
  assert.equal(pageMeta("/app/firms/1/", data).title, "Cost Plus Ltd");
  assert.match(pageMeta("/thesis", data).description, /5\.4x.*verdict on 2026-11-14\./);
  assert.equal(pageMeta("/app/orders/99", data).title, "Order #99", "an order out of the cache still gets a title");
  assert.equal(pageMeta("/nowhere", data).title, "Tontine | The Firm Layer Of The Agent Economy");
  const long = { ...data, state: { ...data.state, firms: [{ ...data.state.firms[0], profile: JSON.stringify({ description: "word ".repeat(40) }) }] } };
  assert.match(pageMeta("/app/firms/1", long).description, /word… AI firm/, "cut at the end of a word");
});

test("withMeta replaces the marked block, escapes values and makes URLs absolute", () => {
  const html = "<head>\n<!-- meta -->\n<title>old</title>\n<!-- /meta -->\n</head>";
  const out = withMeta(html, { title: 'A "quoted" <b>', description: "d" }, "https://tontine.fyra.fun", "/app/orders/7");
  assert.ok(!out.includes("<title>old</title>"));
  assert.ok(out.includes("<title>A &quot;quoted&quot; &lt;b&gt; | Tontine</title>"));
  assert.ok(out.includes('<meta property="og:image" content="https://tontine.fyra.fun/og.png" />'));
  assert.ok(out.includes('<meta property="og:url" content="https://tontine.fyra.fun/app/orders/7" />'));
  assert.equal(withMeta("<head></head>", { title: "t", description: "d" }, "x", "/"), "<head></head>", "no markers: unchanged");
});
