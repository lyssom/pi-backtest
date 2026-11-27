"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import type { Approval } from "@/lib/backtest/approvals";
import type { ApprovalSummary } from "@/lib/backtest/research-bridge";

const button = "rounded-md border border-border bg-bg px-4 py-2 text-sm font-medium hover:bg-bg-selected disabled:opacity-50";
const link = "text-accent underline underline-offset-4";
const sessionUrl = "/api/backtest/research-session";
const approvalsUrl = "/api/backtest/approvals";
const statusText = { running: "执行中", completed: "已完成", failed: "解读未完成", interrupted: "已中断" };
const approvalPath = (id: string) => `/backtest?approval=${id}#trial-title`;

type ResearchView = {
  authenticated: boolean;
  approvalId?: string;
  current?: Approval;
  receipts?: ApprovalSummary[];
  unavailable?: boolean;
  hasReport: boolean;
};

export function TrialPanel({ baselineRunId, periods, initialFast, showReset, research }: {
  baselineRunId: string; periods: number[]; initialFast?: number; showReset: boolean; research: ResearchView | null;
}) {
  const router = useRouter();
  const [fast, setFast] = useState(String(initialFast ?? (periods.includes(4) ? 4 : periods[0])));
  const [showLogin, setShowLogin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const receipt = research?.current;
  const activeId = research?.approvalId;

  useEffect(() => {
    if (receipt?.status !== "running" || !activeId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await fetch(`${approvalsUrl}/${activeId}`, { signal: controller.signal, cache: "no-store" });
        if (response.status === 401) { router.refresh(); return; }
        if (response.ok) {
          const status: Approval = await response.json();
          if (!controller.signal.aborted && (status.status !== receipt.status || status.runId !== receipt.runId)) router.refresh();
        }
      } catch { /* Keep polling after reconnect; never submit again here. */ }
      if (!controller.signal.aborted) timer = setTimeout(poll, 2000);
    };
    timer = setTimeout(poll, 2000);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [activeId, receipt?.status, receipt?.runId, router]);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const password = new FormData(form).get("password");
    setBusy(true); setError("");
    try {
      const result = await fetch(sessionUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
      if (result.ok) { form.reset(); setShowLogin(false); router.refresh(); }
      else setError(result.status === 429 ? `请等待 ${result.headers.get("Retry-After") ?? "几"} 秒再试。` : result.status === 401 ? "研究密码不正确。" : "当前入口不支持研究登录。");
    } catch { setError("研究登录暂时不可用，请稍后重试。"); }
    finally { setBusy(false); }
  }

  async function approve() {
    setError("");
    if (!research?.authenticated) { setShowLogin(true); return; }
    setBusy(true);
    try {
      const response = await fetch(approvalsUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ baselineRunId, fast }) });
      const body = await response.json();
      if (response.ok) {
        if (activeId === body.approvalId) router.refresh();
        else router.push(approvalPath(body.approvalId));
      } else if (response.status === 401) { setShowLogin(true); router.refresh(); }
      else if (body.error === "busy") setError("已有一项 Pi 试跑在执行，请先查看其回执。");
      else if (body.error === "stale_baseline") setError("B0 已变更。请刷新页面并重新确认试跑参数。");
      else setError("未能取得回执。请刷新审批记录确认状态，不会自动重试。");
    } catch { setError("连接中断。请刷新审批记录确认是否已提交，不会自动重试。"); }
    finally { setBusy(false); }
  }

  return <section aria-labelledby="trial-title" className="rounded-xl border border-border bg-bg-panel p-4">
    <h2 id="trial-title" className="font-semibold">参数试跑</h2>
    <p className="mt-2 text-sm text-text-muted">只改 EMA 快线，沿用 B0 的行情、慢线、仓位和费用，不替换基线。</p>
    <form action="/backtest#baseline-comparison" method="get" className="mt-3 flex flex-wrap items-end gap-3">
      <label className="grid gap-1 text-sm">EMA 快线周期
        <select name="fast" value={fast} onChange={(event) => setFast(event.target.value)} className="rounded-md border border-border bg-bg px-3 py-2">
          {periods.map((period) => <option key={period} value={period}>{period}</option>)}
        </select>
      </label>
      <button type="submit" className={button}>同快照重跑</button>
      {research && <button type="button" className={button} disabled={busy} onClick={approve}>批准 Pi 试跑</button>}
      {showReset && <Link href="/backtest#baseline-comparison" className={`self-center text-sm ${link}`}>返回 A1 对照</Link>}
    </form>
    {research && <p className="mt-2 text-xs text-text-muted">Pi 只接收公开行情衍生的规则和成交证据。批准后自动试跑并解读，不替换 B0。</p>}
    {research && !research.authenticated && (showLogin || activeId) && <form method="post" action={sessionUrl} onSubmit={login} className="mt-3 flex flex-wrap items-end gap-3 border-t border-border pt-3">
      <label className="grid gap-1 text-sm">研究密码<input name="password" type="password" autoComplete="current-password" required maxLength={256} className="rounded-md border border-border bg-bg px-3 py-2" /></label>
      <button className={button} disabled={busy}>登录研究</button>
      <p className="basis-full text-xs text-text-muted">登录不会提交试跑。登录后请确认参数再批准。</p>
    </form>}
    {error && <p role="alert" className="mt-2 text-sm">{error}</p>}
    {research?.authenticated && <div className="mt-3 border-t border-border pt-3 text-sm">
      <h3 className="font-medium">Pi 审批记录</h3>
      {research.unavailable ? <p>暂时无法查询审批回执。刷新只查询，不会重跑。</p> : research.receipts?.length ?
        <ul className="mt-2 flex flex-wrap gap-3">{research.receipts.map((item) => {
          const id = `${item.baselineRunId}-${item.fast}`;
          return <li key={id}><Link href={approvalPath(id)} prefetch={false} aria-current={id === activeId ? "true" : undefined} className={link}>EMA {item.fast} · {statusText[item.status]}</Link></li>;
        })}</ul> : <p className="mt-2 text-text-muted">当前 B0 尚无 Pi 回执。</p>}
      {!receipt && activeId && !research.unavailable && <p className="mt-2">未找到该回执；未发起新试跑。</p>}
      {receipt && <div className="mt-3 grid gap-2" aria-live="polite">
        <h4 className="font-medium">Pi 试跑 · EMA {receipt.fast} · {receipt.status === "running" && receipt.runId ? "回测已完成，Pi 正在解读" : statusText[receipt.status]}</h4>
        {receipt.status === "running" && <p>可以离开页面，重新打开只查回执。</p>}
        {(receipt.status === "failed" || receipt.status === "interrupted") && <p>没有完整解读，不会自动重跑。B0 未变更。</p>}
        {receipt.runId && <p className="break-all">运行 ID：<code>{receipt.runId}</code></p>}
        {receipt.runId && (research.hasReport ? <a href="#baseline-comparison" className={link}>查看同数据对照</a> : <p>回执保留，原回测报告暂不可用。</p>)}
        {receipt.completedTools && <p>工具：{receipt.completedTools.join(" → ")}</p>}
        {receipt.answer && <><h4 className="font-medium">Pi 的说明</h4><pre className="whitespace-pre-wrap break-words text-sm">{receipt.answer}</pre></>}
      </div>}
    </div>}
  </section>;
}
