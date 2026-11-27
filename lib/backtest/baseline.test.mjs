import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { compareRuns, marketHash } = await jiti.import("./baseline.ts");
const trade = (entry, exit, net) => ({ entry: { bar: entry, price: 100 }, exit: { bar: exit, price: 120 }, exitReason: "cross", net, fees: 1 });
const bar = { time: 0, open: 100, high: 105, low: 98, close: 101.23 };

function run(fast, trades, parentRunId = null) {
  return {
    engine: "ema-cross-v1", dataSha256: marketHash([bar]), runId: `run-${fast}`, parentRunId,
    report: { strategy: { fast, slow: 8, notional: 1000, feeBps: 5 }, trades },
  };
}

test("hashes candle values as integer cents, independent of EMA overlays", () => {
  assert.equal(marketHash([{ ...bar, fastEma: 103 }]), createHash("sha256").update("[[0,10000,10500,9800,10123]]").digest("hex"));
  assert.notEqual(marketHash([bar]), marketHash([{ ...bar, open: 100.01 }]));
  assert.throws(() => marketHash([{ ...bar, open: 100.001 }]), /precision/);
});

test("matches by entry bar, keeping different entry signals separate", () => {
  const baseline = run(3, [trade(1, 3, 2), trade(4, 5, -3), trade(7, 9, 1)]);
  const variant = run(4, [trade(1, 2, 4), trade(6, 8, 5), trade(7, 9, 1)], baseline.runId);
  const comparison = compareRuns(baseline, variant);
  assert.equal(comparison.unchanged, 1);
  assert.deepEqual(comparison.rows.map(({ entryBar, kind }) => [entryBar, kind]), [[1, "changed"], [4, "baseline-only"], [6, "variant-only"]]);
  assert.equal(compareRuns(baseline, { ...variant, dataSha256: "different" }), null);
  assert.equal(compareRuns(baseline, { ...variant, parentRunId: "other" }), null);
  assert.equal(compareRuns(baseline, { ...variant, report: { ...variant.report, strategy: { ...variant.report.strategy, feeBps: 10 } } }), null);
});
