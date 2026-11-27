import type { Metadata } from "next";
import Link from "next/link";
import { loadRun } from "@/lib/backtest/baseline";
import { HOUR_MS, loadSample, SAMPLE_SOURCE, type SampleReport, type SampleTrade } from "@/lib/backtest/sample";
import { runTrial, tradeHref, trialMax } from "@/lib/backtest/trial";
import { BaselineComparison } from "./baseline-comparison";
import { SampleChart } from "./sample-chart";

export const metadata: Metadata = { title: "回测样例 · Pi Backtest" };
export const dynamic = "force-dynamic";

const amount = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const utc = (time: number) => new Date(time).toISOString().slice(0, 16).replace("T", " ");
const closeUtc = (open: number) => new Date(open + HOUR_MS - 1).toISOString().slice(0, 19).replace("T", " ");
const panel = "rounded-xl border border-border bg-bg-panel p-4";
const linkStyle = "text-accent underline underline-offset-4";

function TradeEvidence({ report, trade }: { report: SampleReport; trade: SampleTrade }) {
  const entryBar = report.bars[trade.entry.bar];
  const exitBar = report.bars[trade.exit.bar];
  return <div className="mt-4 grid gap-2 rounded-lg border border-border p-3 text-sm" data-testid="trade-evidence">
    <p className="font-semibold">第 {trade.id} 笔 · 模拟开平仓依据</p>
    {trade.entry.signalBar !== null && <p>开仓信号：{closeUtc(report.bars[trade.entry.signalBar].time)} 收盘金叉；{utc(entryBar.time)} 开盘买入 @ {amount.format(trade.entry.price)}</p>}
    {trade.exit.signalBar !== null
      ? <p>平仓信号：{closeUtc(report.bars[trade.exit.signalBar].time)} 收盘死叉；{utc(exitBar.time)} 开盘卖出 @ {amount.format(trade.exit.price)}</p>
      : <p>窗口结束：{closeUtc(exitBar.time)} 按最后收盘价退出 @ {amount.format(trade.exit.price)}，不是死叉信号。</p>}
    <p className="text-text-muted">以上时间均为 UTC；图的横轴使用各 K 线的开盘时间。</p>
  </div>;
}

export default async function BacktestPage({ searchParams }: { searchParams: Promise<{ trade?: string | string[]; fast?: string | string[] }> }) {
  const [{ trade, fast }, b0] = await Promise.all([searchParams, loadRun("baseline")]);
  const baseline = b0.status === "ready" ? b0.run : undefined;
  const sample = b0.status === "missing" ? await loadSample() : undefined;
  const report = baseline?.report ?? (sample?.status === "ready" ? sample.report : undefined);
  const trial = baseline && fast !== undefined ? await runTrial(baseline, fast) : undefined;
  const a1 = baseline && !trial ? await loadRun("a1") : undefined;
  const variant = trial?.status === "ready" ? trial.run : a1?.status === "ready" ? a1.run : undefined;
  const variantLabel = trial ? "试跑" : "A1";
  const trialPeriod = trial?.status === "ready" ? trial.run.report.strategy.fast : undefined;
  const periods = baseline ? Array.from({ length: trialMax(baseline) }, (_, i) => i + 1).filter((p) => p !== baseline.report.strategy.fast) : [];
  const selected = report?.trades.find(({ id }) => String(id) === trade) ?? report?.trades[0];
  return <main lang="zh-CN" className="h-dvh overflow-y-auto bg-bg text-text">
    <div className="mx-auto grid max-w-[1120px] gap-4 px-4 py-6 sm:px-8 sm:py-8">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm font-medium text-text-muted">Pi Backtest / 研究工作台</p>
          <h1 className="mt-1 text-2xl font-semibold sm:text-3xl">{baseline ? "冻结基线 · B0" : "历史回测样例"}</h1>
        </div>
        <Link href="/" className={`text-sm ${linkStyle}`}>返回 Pi 对话</Link>
      </header>
      {!report ? <section className={panel}>
        <h2 className="font-semibold">{b0.status === "invalid" ? "B0 基线未通过校验" : "尚无可用的历史报告"}</h2>
        <p className="mt-2 text-sm text-text-muted">在项目根目录运行下方命令生成或核验。页面不会替换已冻结的基线或回退到合成数据。</p>
        <pre className="mt-3 overflow-x-auto text-sm"><code>python3 scripts/pi-backtest/baseline.py</code></pre>
      </section> : <>
        <section aria-labelledby="sample-rule" className={panel}>
          <h2 id="sample-rule" className="font-semibold">规则 · BTCUSDT · 1h</h2>
          <p className="mt-2 text-sm">EMA {report.strategy.fast} 上穿 EMA {report.strategy.slow} 做多，下穿平多。收盘确认、下一根开盘模拟成交；只持一笔，窗口结束按最后收盘价退出。</p>
          <p className="mt-2 text-sm text-text-muted">名义仓位 {amount.format(report.strategy.notional)} USDT；手续费每边 {report.strategy.feeBps} bps。使用永续行情，但这个样例不模拟资金费、滑点、保证金或强平。</p>
          <p className="mt-2 text-sm text-text-muted">{utc(report.bars[0].time)} 至 {utc(report.bars.at(-1)!.time + HOUR_MS)} UTC（右开） · {report.bars.length} 根 · <a href={SAMPLE_SOURCE} className={linkStyle}>Binance 公共行情归档</a></p>
          {baseline ? <a href="#baseline-comparison" className={`mt-2 inline-block text-sm ${linkStyle}`}>查看 B0 / {variantLabel} 同数据对照</a> : <p className="mt-2 text-sm text-text-muted">这份样例尚未冻结为基线。</p>}
        </section>
        {baseline && periods.length > 0 && <section aria-labelledby="trial-title" className={panel}>
          <h2 id="trial-title" className="font-semibold">参数试跑</h2>
          <p className="mt-2 text-sm text-text-muted">只允许更改 EMA 快线。使用 B0 的同一行情、慢线、仓位和费用，不保存为新基线。</p>
          <form action="/backtest#baseline-comparison" method="get" className="mt-3 flex flex-wrap items-end gap-3">
            <label className="grid gap-1 text-sm">EMA 快线周期
              <select name="fast" defaultValue={trialPeriod ?? (periods.includes(4) ? 4 : periods[0])} className="rounded-md border border-border bg-bg px-3 py-2">
                {periods.map((period) => <option key={period} value={period}>{period}</option>)}
              </select>
            </label>
            <button type="submit" className="rounded-md border border-border bg-bg px-4 py-2 text-sm font-medium hover:bg-bg-selected">同快照重跑</button>
            {trial && <Link href="/backtest#baseline-comparison" className={`self-center text-sm ${linkStyle}`}>返回 A1 对照</Link>}
          </form>
        </section>}
        <dl aria-label="样例绩效" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {([
            ["净盈亏 (USDT)", amount.format(report.summary.net)],
            ["手续费 (USDT)", amount.format(report.summary.fees)],
            ["已平笔数", report.summary.closed],
            ["净胜率", report.summary.closed ? `${(100 * report.summary.wins / report.summary.closed).toFixed(1)}%` : "—"],
          ] as const).map(([label, value]) => <div className={panel} key={label}>
            <dt className="text-sm text-text-muted">{label}</dt>
            <dd className="mt-1 font-mono text-lg tabular-nums">{value}</dd>
          </div>)}
        </dl>
        <section aria-labelledby="sample-chart" className={panel}>
          <h2 className="font-semibold" id="sample-chart">K 线与成交定位</h2>
          <p className="mt-1 text-sm text-text-muted">快 EMA / 慢 EMA；蓝圆为开仓，橙方为平仓。</p>
          <SampleChart bars={report.bars} selected={selected} />
          {selected && <TradeEvidence report={report} trade={selected} />}
        </section>
        <section aria-labelledby="sample-trades" className={panel}>
          <h2 id="sample-trades" className="font-semibold">逐笔成交</h2>
          {!report.trades.length ? <p className="mt-3 text-sm text-text-muted">这段历史没有已平交易。</p> :
            <div className="mt-3 overflow-x-auto">
              <table aria-label="报告逐笔成交" className="w-full min-w-[500px] text-left text-sm tabular-nums">
                <thead className="text-text-muted"><tr>{["交易", "开仓 UTC", "平仓 UTC", "退出", "净盈亏 (USDT)"].map((heading) => <th scope="col" key={heading} className="p-2">{heading}</th>)}</tr></thead>
                <tbody>{report.trades.map((item) => <tr key={item.id} className={item.id === selected?.id ? "bg-bg-selected" : ""}>
                  <td className="p-2"><Link href={tradeHref(item.id, trialPeriod)} aria-current={item.id === selected?.id ? "true" : undefined} className={linkStyle}>查看第 {item.id} 笔</Link></td>
                  <td className="whitespace-nowrap p-2">{utc(report.bars[item.entry.bar].time)}</td>
                  <td className="whitespace-nowrap p-2">{item.exitReason === "cross" ? utc(report.bars[item.exit.bar].time) : closeUtc(report.bars[item.exit.bar].time)}</td>
                  <td className="p-2">{item.exitReason === "cross" ? "死叉" : "窗口结束"}</td>
                  <td className="p-2">{amount.format(item.net)}</td>
                </tr>)}</tbody>
              </table>
            </div>}
        </section>
        {trial && trial.status !== "ready" && <p role="alert" className={panel}>{trial.status === "invalid" ? "快线周期必须是允许的整数，且不能与 B0 相同。" : "试跑未完成。B0 没有变更，请稍后重试。"}</p>}
        {baseline && <BaselineComparison baseline={baseline} variant={variant} variantLabel={variantLabel} trialPeriod={trialPeriod} formatTime={utc} formatClose={closeUtc} />}
      </>}
    </div>
  </main>;
}
