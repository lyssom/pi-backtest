import Link from "next/link";
import { compareRuns, type FrozenRun } from "@/lib/backtest/baseline";
import type { SampleTrade } from "@/lib/backtest/sample";
import { tradeHref } from "@/lib/backtest/trial";

const signed = new Intl.NumberFormat("en-US", { signDisplay: "exceptZero", minimumFractionDigits: 2, maximumFractionDigits: 4 });

export function BaselineComparison({ baseline, variant, variantLabel = "A1", trialPeriod, approvalId, formatTime, formatClose }: {
  baseline: FrozenRun;
  variant?: FrozenRun;
  variantLabel?: string;
  trialPeriod?: number;
  approvalId?: string;
  formatTime: (time: number) => string;
  formatClose: (time: number) => string;
}) {
  const comparison = variant && compareRuns(baseline, variant);
  const a = baseline.report.summary;
  const b = variant?.report.summary;
  const describe = (trade?: SampleTrade) => {
    if (!trade) return "—";
    const exitTime = baseline.report.bars[trade.exit.bar].time;
    const time = trade.exitReason === "window_end" ? formatClose(exitTime) : formatTime(exitTime);
    return `${time} 平仓 · ${signed.format(trade.net)}`;
  };
  const counts = comparison && {
    onlyB0: comparison.rows.filter((row) => row.kind === "baseline-only").length,
    onlyA1: comparison.rows.filter((row) => row.kind === "variant-only").length,
    changed: comparison.rows.filter((row) => row.kind === "changed").length,
  };

  return <section id="baseline-comparison" aria-labelledby="compare-title" className="rounded-xl border border-border bg-bg-panel p-4">
    <h2 id="compare-title" className="font-semibold">同数据对照 · B0 / {variantLabel}</h2>
    {!comparison || !counts || !variant || !b ? <p className="mt-2 text-sm text-text-muted">{variantLabel} 没有可比较的结果，B0 不受影响。</p> : <>
      <p className="mt-2 text-sm">只改 EMA 快线：{baseline.report.strategy.fast} → {variant.report.strategy.fast}。行情、慢线、仓位、手续费和成交规则不变。</p>
      <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm tabular-nums">
        <div><dt className="text-text-muted">B0 净额 (USDT)</dt><dd className="font-mono">{signed.format(a.net)}</dd></div>
        <div><dt className="text-text-muted">{variantLabel} 净额 (USDT)</dt><dd className="font-mono">{signed.format(b.net)}</dd></div>
        <div><dt className="text-text-muted">差异 {variantLabel} − B0 (USDT)</dt><dd className="font-mono">{signed.format(b.net - a.net)}</dd></div>
        <div><dt className="text-text-muted">已平笔数 B0 → {variantLabel}</dt><dd className="font-mono">{a.closed} → {b.closed}</dd></div>
      </dl>
      <p className="mt-3 text-sm text-text-muted">按入场 K 线配对：{comparison.unchanged} 笔未变、{counts.changed} 笔同入场但结果不同、B0 独有 {counts.onlyB0} 笔、{variantLabel} 独有 {counts.onlyA1} 笔。入场时点不同不强行配对。</p>
      {comparison.rows.length > 0 && <div className="mt-3 overflow-x-auto">
        <table aria-label="差异交易" className="w-full min-w-[560px] text-left text-sm tabular-nums">
          <thead className="text-text-muted"><tr>{["入场 UTC", "B0 平仓 UTC / 净额", `${variantLabel} 平仓 UTC / 净额`].map((heading) => <th scope="col" key={heading} className="p-2">{heading}</th>)}</tr></thead>
          <tbody>{comparison.rows.map(({ entryBar, baseline: left, variant: right }) => <tr key={entryBar} className="border-t border-border">
            <td className="p-2">{formatTime(baseline.report.bars[entryBar].time)}</td>
            <td className="p-2">{left ? <Link href={tradeHref(left.id, trialPeriod, approvalId)} className="text-accent underline underline-offset-4">{describe(left)}</Link> : "—"}</td>
            <td className="p-2">{describe(right)}</td>
          </tr>)}</tbody>
        </table>
      </div>}
      <p className="mt-3 text-xs text-text-muted">{variantLabel} 不会替换 B0。这是同一短历史窗口的探索性对照，不是样本外验证。</p>
    </>}
    <details className="mt-3 text-sm text-text-muted">
      <summary className="cursor-pointer">复现信息</summary>
      <dl className="mt-2 grid gap-1 break-all text-xs">
        <div><dt className="inline">行情 SHA-256：</dt><dd className="inline font-mono">{baseline.dataSha256}</dd></div>
        <div><dt className="inline">引擎：</dt><dd className="inline font-mono">{baseline.engine}</dd></div>
        <div><dt className="inline">B0 运行 ID：</dt><dd className="inline font-mono">{baseline.runId}</dd></div>
        {comparison && variant && <div><dt className="inline">{variantLabel} 运行 ID：</dt><dd className="inline font-mono">{variant.runId}</dd></div>}
      </dl>
    </details>
  </section>;
}
