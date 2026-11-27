import type { SampleReport, SampleTrade } from "@/lib/backtest/sample";

const PRICE = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

export function SampleChart({ bars, selected }: { bars: SampleReport["bars"]; selected?: SampleTrade }) {
  const width = 940, height = 300, left = 56, right = 22, top = 18, bottom = 40;
  const low = Math.min(...bars.map((b) => Math.min(b.low, b.fastEma, b.slowEma)));
  const high = Math.max(...bars.map((b) => Math.max(b.high, b.fastEma, b.slowEma)));
  const margin = (high - low) * 0.035 || high * 0.01;
  const step = (width - left - right) / bars.length;
  const x = (i: number) => left + (i + 0.5) * step;
  const y = (v: number) => top + (height - top - bottom) * (high + margin - v) / (high - low + 2 * margin);
  const ema = (key: "fastEma" | "slowEma") => bars.map((b, i) => `${x(i)},${y(b[key])}`).join(" ");
  const ticks = Array.from({ length: 5 }, (_, i) => low + i * (high - low) / 4);
  const labels = [...new Set([0, Math.floor(bars.length / 2), bars.length - 1])];

  return <div className="overflow-x-auto">
    <svg role="img" aria-label={selected ? `K 线及第 ${selected.id} 笔模拟成交` : "K 线与快慢 EMA"}
      viewBox={`0 0 ${width} ${height}`} className="w-full min-w-[640px]">
      {selected && <rect data-testid="selected-trade" x={x(selected.entry.bar) - step / 2} y={top}
        width={(selected.exit.bar - selected.entry.bar + 1) * step} height={height - bottom - top}
        fill="var(--accent)" opacity="0.12" />}
      {ticks.map((price, i) => <g key={i}>
        <line x1={left} x2={width - right} y1={y(price)} y2={y(price)} stroke="var(--border)" />
        <text x={left - 7} y={y(price) + 4} textAnchor="end" fill="var(--text-muted)" fontSize="11">{PRICE.format(price)}</text>
      </g>)}
      {bars.map((bar, i) => {
        const color = bar.close >= bar.open ? "#0d9a70" : "#e46964";
        return <g key={bar.time}>
          <line x1={x(i)} x2={x(i)} y1={y(bar.high)} y2={y(bar.low)} stroke={color} />
          <rect x={x(i) - step * .28} y={Math.min(y(bar.open), y(bar.close))}
            width={step * .56} height={Math.max(1, Math.abs(y(bar.open) - y(bar.close)))} fill={color} />
        </g>;
      })}
      <polyline points={ema("fastEma")} fill="none" stroke="var(--accent)" strokeWidth="1.6" />
      <polyline points={ema("slowEma")} fill="none" stroke="#b98126" strokeWidth="1.6" />
      {selected && <g>
        <line x1={x(selected.entry.bar)} x2={x(selected.exit.bar)} y1={y(selected.entry.price)} y2={y(selected.exit.price)}
          stroke="var(--text)" strokeWidth="1.5" strokeDasharray="4 3" />
        <circle cx={x(selected.entry.bar)} cy={y(selected.entry.price)} r="5" fill="var(--accent)" stroke="var(--bg)" />
        <rect x={x(selected.exit.bar) - 5} y={y(selected.exit.price) - 5} width="10" height="10" fill="#b98126" stroke="var(--bg)" />
      </g>}
      {labels.map((i) => <text key={i} x={x(i)} y={height - 14} textAnchor={i === 0 ? "start" : i === bars.length - 1 ? "end" : "middle"}
        fill="var(--text-muted)" fontSize="11">{new Date(bars[i].time).toISOString().slice(5, 16).replace("T", " ")}</text>)}
    </svg>
  </div>;
}
