import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { loadSample } = await jiti.import("./sample.ts");

test("distinguishes a missing snapshot from an invalid report; accepts well-formed data", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-backtest-test-"));
  const file = join(dir, "sample.json");
  const bar = { open: 100, high: 110, low: 90, close: 100, fastEma: 100, slowEma: 100 };
  const report = {
    version: 1,
    bars: [{ ...bar, time: 0 }, { ...bar, time: 3_600_000 }],
    trades: [],
    strategy: { fast: 3, slow: 8, notional: 1000, feeBps: 5 },
    summary: { closed: 0, wins: 0, net: 0, fees: 0 },
  };
  try {
    assert.equal((await loadSample(file)).status, "missing");
    await writeFile(file, "not-json");
    assert.equal((await loadSample(file)).status, "invalid");
    await writeFile(file, JSON.stringify(report));
    assert.deepEqual(await loadSample(file), { status: "ready", report });
    report.trades.push({ id: 1, entry: { bar: 1, price: 100, signalBar: 0 }, exit: { bar: 2, price: 100, signalBar: 1 }, exitReason: "cross", fees: 1, net: -1 });
    report.summary.closed = 1;
    await writeFile(file, JSON.stringify(report));
    assert.equal((await loadSample(file)).status, "invalid");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
