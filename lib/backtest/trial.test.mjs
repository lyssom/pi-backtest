import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { parseTrialPeriod, createTrialRunner, tradeHref } = await jiti.import("./trial.ts");

const base = { runId: "b0", report: { strategy: { fast: 3, slow: 8 } } };

test("accepts exactly one bounded, non-baseline fast period", () => {
  for (const fast of ["1", "2", "4", "5", "6", "7"]) assert.equal(parseTrialPeriod(fast, base), Number(fast));
  for (const raw of [undefined, "", "0", "3", "8", "-1", "1.5", " 5", "05", "1e0", "5;anything", ["5", "6"]]) {
    assert.equal(parseTrialPeriod(raw, base), null, String(raw));
  }
  assert.equal(tradeHref(2, 5), "/backtest?fast=5&trade=2#sample-chart");
  assert.equal(tradeHref(2), "/backtest?trade=2#sample-chart");
});

test("coalesces identical requests, rejects invalid periods before execution and retries failures", async () => {
  let calls = 0;
  const runner = createTrialRunner(async (_baseline, fast) => {
    calls++;
    if (fast === 6 && calls === 2) throw new Error("runner failed");
    return { runId: `trial-${fast}` };
  });
  assert.equal((await runner(base, "3")).status, "invalid");
  const requests = await Promise.all([runner(base, "5"), runner(base, "5"), runner(base, "5")]);
  assert.equal(calls, 1);
  assert.deepEqual(requests, Array(3).fill({ status: "ready", run: { runId: "trial-5" } }));
  assert.equal((await runner(base, "6")).status, "failed");
  assert.equal((await runner(base, "6")).status, "ready");
  assert.equal(calls, 3);
});
