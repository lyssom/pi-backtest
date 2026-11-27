import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { validateReport, type SampleReport, type SampleTrade } from "./sample";

const ENGINE = "ema-cross-v1";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const hexId = (value: unknown) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

export type FrozenRun = {
  engine: string;
  dataSha256: string;
  runId: string;
  parentRunId: string | null;
  report: SampleReport;
};

type MarketBar = Pick<SampleReport["bars"][number], "time" | "open" | "high" | "low" | "close">;
function cents(price: number) {
  const value = Math.round(price * 100);
  if (!Number.isSafeInteger(value) || value / 100 !== price) throw new Error("Unexpected BTCUSDT price precision");
  return value;
}

export function marketHash(bars: MarketBar[]) {
  return hash(bars.map(({ time, open, high, low, close }) => [time, cents(open), cents(high), cents(low), cents(close)]));
}

type RunResult = { status: "ready"; run: FrozenRun } | { status: "missing" | "invalid" };

export async function loadRun(kind: "baseline" | "a1", directory = join(process.cwd(), ".pi-backtest")): Promise<RunResult> {
  try {
    const run = JSON.parse(await readFile(join(directory, `${kind}.json`), "utf8")) as FrozenRun | null;
    if (run?.engine !== ENGINE || !hexId(run.runId) || !hexId(run.dataSha256) || !validateReport(run.report)) return { status: "invalid" };
    if (kind === "baseline" ? run.parentRunId !== null : !hexId(run.parentRunId)) return { status: "invalid" };
    const { fast, slow, notional, feeBps } = run.report.strategy;
    if (run.dataSha256 !== marketHash(run.report.bars) || run.runId !== hash([run.engine, run.dataSha256, fast, slow, notional, feeBps])) {
      return { status: "invalid" };
    }
    return { status: "ready", run };
  } catch (error) {
    return { status: (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "missing" : "invalid" };
  }
}

type Difference = { entryBar: number; kind: "baseline-only" | "variant-only" | "changed"; baseline?: SampleTrade; variant?: SampleTrade };

export function compareRuns(baseline: FrozenRun, variant: FrozenRun) {
  const a = baseline.report.strategy;
  const b = variant.report.strategy;
  if (variant.parentRunId !== baseline.runId || baseline.engine !== variant.engine || baseline.dataSha256 !== variant.dataSha256 ||
    a.slow !== b.slow || a.notional !== b.notional || a.feeBps !== b.feeBps || a.fast === b.fast) return null;

  const left = new Map(baseline.report.trades.map((t) => [t.entry.bar, t]));
  const right = new Map(variant.report.trades.map((t) => [t.entry.bar, t]));
  const entries = [...new Set([...left.keys(), ...right.keys()])].sort((x, y) => x - y);
  const rows: Difference[] = [];
  let unchanged = 0;
  for (const entryBar of entries) {
    const a = left.get(entryBar), b = right.get(entryBar);
    if (!a) rows.push({ entryBar, kind: "variant-only", variant: b });
    else if (!b) rows.push({ entryBar, kind: "baseline-only", baseline: a });
    else if (a.exit.bar !== b.exit.bar || a.exit.price !== b.exit.price || a.exitReason !== b.exitReason || a.net !== b.net || a.fees !== b.fees) {
      rows.push({ entryBar, kind: "changed", baseline: a, variant: b });
    } else unchanged++;
  }
  return { rows, unchanged };
}
