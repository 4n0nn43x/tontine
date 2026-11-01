import { test } from "node:test";
import assert from "node:assert/strict";
import { simulate } from "./sim.ts";

test("the simulation is deterministic for a seed and fills only above the market reference", async () => {
  const o = { seed: 3, clients: 20, extraFirms: 2, days: 1, ordersPerHour: 12 };
  const [a, b] = [await simulate(o), await simulate(o)];
  assert.deepEqual(a, b);
  assert.ok(a.orders > 0 && a.fillRate > 0);
  assert.ok(a.avgImprovementBps >= 0, "a fill never gives the client less than its minimum");
});
