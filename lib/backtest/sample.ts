import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export const HOUR_MS = 3_600_000;
export const SAMPLE_SOURCE = "https://data.binance.vision/data/futures/um/monthly/klines/BTCUSDT/1h/BTCUSDT-1h-2025-05.zip";
const barIndex = Type.Integer({ minimum: 0, maximum: 95 });
const price = Type.Number({ exclusiveMinimum: 0 });
const count = Type.Integer({ minimum: 0, maximum: 96 });
const fill = Type.Object({ bar: barIndex, price, signalBar: Type.Union([barIndex, Type.Null()]) });
const reportSchema = Type.Object({
  version: Type.Literal(1),
  bars: Type.Array(Type.Object({
    time: Type.Integer({ minimum: 0, maximum: 8_640_000_000_000_000 - HOUR_MS }),
    open: price, high: price, low: price, close: price, fastEma: price, slowEma: price,
  }), { minItems: 2, maxItems: 96 }),
  trades: Type.Array(Type.Object({
    id: Type.Integer({ minimum: 1, maximum: 96 }),
    entry: fill, exit: fill,
    exitReason: Type.Union([Type.Literal("cross"), Type.Literal("window_end")]),
    fees: Type.Number({ minimum: 0 }), net: Type.Number(),
  }), { maxItems: 96 }),
  strategy: Type.Object({ fast: Type.Integer({ minimum: 1 }), slow: Type.Integer({ minimum: 2 }), notional: price, feeBps: Type.Number({ minimum: 0 }) }),
  summary: Type.Object({ closed: count, wins: count, net: Type.Number(), fees: Type.Number({ minimum: 0 }) }),
});

export type SampleReport = Static<typeof reportSchema>;
export type SampleTrade = SampleReport["trades"][number];

type SampleResult = { status: "ready"; report: SampleReport } | { status: "missing" | "invalid" };

export function validateReport(report: unknown): report is SampleReport {
  if (!Value.Check(reportSchema, report)) return false;
  const { bars, trades, strategy, summary } = report;
  const validBar = (bar: SampleReport["bars"][number], i: number) =>
    bar.time === bars[0].time + i * HOUR_MS && bar.low <= Math.min(bar.open, bar.close) && bar.high >= Math.max(bar.open, bar.close);
  const validTrades = trades.every(({ id, entry, exit, exitReason }, i) => {
    if (id !== i + 1 || entry.bar > exit.bar || exit.bar >= bars.length || (i > 0 && entry.bar <= trades[i - 1].exit.bar)) return false;
    if (entry.signalBar !== entry.bar - 1 || entry.price !== bars[entry.bar].open) return false;
    return exitReason === "cross"
      ? exit.signalBar === exit.bar - 1 && exit.bar > entry.bar && exit.price === bars[exit.bar].open
      : exit.signalBar === null && exit.bar === bars.length - 1 && exit.price === bars[exit.bar].close;
  });
  return strategy.fast < strategy.slow && bars.every(validBar) && validTrades && summary.closed === trades.length && summary.wins === trades.filter(({ net }) => net > 0).length;
}

export async function loadSample(file = join(process.cwd(), ".pi-backtest", "sample.json")): Promise<SampleResult> {
  try {
    const report: unknown = JSON.parse(await readFile(file, "utf8"));
    return validateReport(report) ? { status: "ready", report } : { status: "invalid" };
  } catch (error) {
    return { status: (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "missing" : "invalid" };
  }
}
