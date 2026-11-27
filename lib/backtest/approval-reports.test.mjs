import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createApprovalReports } = await jiti.import("./approval-reports.ts");
const { marketHash } = await jiti.import("./baseline.ts");
const bars = [0, 3_600_000].map((time) => ({ time, open: 100, high: 110, low: 90, close: 100, fastEma: 100, slowEma: 100 }));
const makeRun = (fast, parentRunId) => {
  const dataSha256 = marketHash(bars);
  const engine = "ema-cross-v1";
  const report = { version: 1, bars, trades: [], strategy: { fast, slow: 8, notional: 1000, feeBps: 5 }, summary: { closed: 0, wins: 0, net: 0, fees: 0 } };
  const runId = createHash("sha256").update(JSON.stringify([engine, dataSha256, fast, 8, 1000, 5])).digest("hex");
  return { engine, dataSha256, report, runId, parentRunId };
};

test("pins candidate bytes, refuses replacements, and never silently replays a damaged pinned report", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-backtest-report-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const base = makeRun(3, null);
  const run = makeRun(5, base.runId);
  let replays = 0;
  const store = createApprovalReports(directory, base, async () => { replays++; return { status: "ready", run }; });
  const legacy = { baselineRunId: base.runId, fast: "5", runId: run.runId };
  assert.deepEqual(await store.resolve(legacy), run);
  assert.equal(await store.resolve({ ...legacy, runId: "f".repeat(64) }), null);
  assert.equal(replays, 2);
  const reportSha256 = store.record(run);
  const current = { ...legacy, reportSha256 };
  assert.deepEqual(await store.resolve(current), run);
  const altered = { ...run, report: { ...run.report, summary: { ...run.report.summary, net: 1 } } };
  assert.throws(() => store.record(altered), /Refusing to replace/);
  await writeFile(join(directory, `run-${run.runId}.json`), JSON.stringify(altered));
  assert.equal(await store.resolve(current), null);
  assert.equal(replays, 2);
});
