import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { compareRuns, decodeRun, type FrozenRun } from "./baseline";

const execute = promisify(execFile);
const MAX_PERIOD = 7;
const MAX_TRIALS = 6; // After excluding B0, only six period values exist for this fixture.
type TrialResult = { status: "ready"; run: FrozenRun } | { status: "invalid" | "failed" };
type Engine = (baseline: FrozenRun, fast: number) => Promise<FrozenRun>;

export function trialMax(baseline: FrozenRun) {
  return Math.min(MAX_PERIOD, baseline.report.strategy.slow - 1);
}

export function parseTrialPeriod(raw: unknown, baseline: FrozenRun) {
  if (typeof raw !== "string" || !/^[1-7]$/.test(raw)) return null;
  const fast = Number(raw);
  return fast <= trialMax(baseline) && fast !== baseline.report.strategy.fast ? fast : null;
}

export function tradeHref(trade: number, trial?: number) {
  return `/backtest?${trial === undefined ? "" : `fast=${trial}&`}trade=${trade}#sample-chart`;
}

export function createTrialRunner(engine: Engine) {
  const runs = new Map<string, Promise<FrozenRun>>();
  return async (baseline: FrozenRun, raw: unknown): Promise<TrialResult> => {
    const fast = parseTrialPeriod(raw, baseline);
    if (fast === null) return { status: "invalid" };
    const key = `${baseline.runId}:${fast}`;
    let pending = runs.get(key);
    if (!pending) {
      if (runs.size >= MAX_TRIALS) return { status: "failed" };
      pending = Promise.resolve().then(() => engine(baseline, fast));
      runs.set(key, pending);
    }
    try {
      return { status: "ready", run: await pending };
    } catch {
      if (runs.get(key) === pending) runs.delete(key);
      return { status: "failed" };
    }
  };
}

export const runTrial = createTrialRunner(async (baseline, fast) => {
  const script = join(process.cwd(), "scripts", "pi-backtest", "baseline.py");
  // Fixed executable and script; only the validated period reaches argv. No shell, user code, or credentials.
  const { stdout } = await execute("python3", ["-B", "-E", "-S", script, "--fast", String(fast)], {
    timeout: 5000,
    maxBuffer: 128 * 1024,
    env: { PATH: process.env.PATH, NODE_ENV: process.env.NODE_ENV },
  });
  const run = decodeRun(stdout, "variant");
  if (!run || run.report.strategy.fast !== fast || !compareRuns(baseline, run)) {
    throw new Error("Trial did not match the requested frozen baseline and period");
  }
  return run;
});
