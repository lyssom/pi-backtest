"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ChatInput, type ChatInputHandle } from "@/components/ChatInput";
import { MessageView } from "@/components/MessageView";
import type { ResearchChatView } from "@/lib/backtest/research-chat";
import type { ChatAction } from "@/lib/backtest/research-bridge";

const endpoint = "/api/backtest/research-chat";
const sessionEndpoint = "/api/backtest/research-session";
const button = "rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-bg-selected disabled:opacity-50";
const link = "text-accent underline underline-offset-4";
const phases = { idle: "Pi 已就绪", thinking: "Pi 正在研究", approval: "等待你的批准", running: "Pi 正在试跑或检查证据" };
const cardStates = { pending: "待批准", approved: "已批准", declined: "已拒绝", expired: "已过期" };

export function ResearchChat({ initiallyAuthenticated }: { initiallyAuthenticated: boolean }) {
  const [authenticated, setAuthenticated] = useState(initiallyAuthenticated);
  const [chat, setChat] = useState<ResearchChatView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const model = useRef<ChatInputHandle>(null);
  const tail = useRef<HTMLDivElement>(null);
  const revision = useRef(0);
  const ready = chat?.phase === "idle" || !chat;
  const count = chat?.entries.length ?? 0;

  useEffect(() => {
    if (!authenticated) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const version = revision.current;
      try {
        const response = await fetch(endpoint, { signal: controller.signal, cache: "no-store" });
        if (!controller.signal.aborted && version === revision.current) {
          if (response.status === 401) { setAuthenticated(false); setChat(null); return; }
          if (response.ok) {
            const body = await response.json();
            if (version === revision.current && !controller.signal.aborted) setChat(body.chat);
          }
        }
      } catch { /* A reconnect only resumes reads. No message or approval is resubmitted. */ }
      if (!controller.signal.aborted) timer = setTimeout(poll, 1500);
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [authenticated]);

  useEffect(() => { tail.current?.scrollIntoView({ block: "nearest" }); }, [count]);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const password = new FormData(form).get("password");
    setBusy(true); setError("");
    try {
      const result = await fetch(sessionEndpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
      if (result.ok) { form.reset(); setAuthenticated(true); }
      else setError(result.status === 429 ? "登录暂时受限，请稍后再试。" : "研究登录失败，请确认密码。");
    } catch { setError("研究入口暂时不可用。"); }
    finally { setBusy(false); }
  }

  async function command(action: ChatAction, input: object) {
    if (busy) return false;
    revision.current++;
    setBusy(true); setError("");
    try {
      const response = await fetch(`${endpoint}/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
      if (response.status === 401) { setAuthenticated(false); setChat(null); return false; }
      const body = await response.json();
      if (response.ok) { setChat(body.chat); return true; }
      setError(body.error === "limit" ? "本会话已达到消息上限。请开启新研究对话。" : body.error === "stale_baseline" ? "B0 已变更，未批准这次试跑。" :
        body.error === "stale" ? "会话或审批卡已更新，请查看最新状态。" : body.error === "busy" ? "已有研究任务正在执行。" :
          "本次操作未完成。请看当前会话状态；页面不会自动重试。");
    } catch { setError("连接中断。请查看会话是否已收到消息；页面不会自动重发。"); }
    finally { revision.current++; setBusy(false); }
    return false;
  }

  return <main lang="zh-CN" className="h-dvh bg-bg text-text">
    <div className="mx-auto flex h-full min-w-0 max-w-[880px] flex-col px-4 sm:px-8">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border py-4">
        <div><p className="text-xs text-text-muted">Pi Web / Pi Backtest</p><h1 className="text-xl font-semibold">研究对话</h1></div>
        <nav className="flex flex-wrap items-center gap-4 text-sm">
          <Link href="/backtest" className={link}>回测工作台</Link>
          {chat && ready && <button className={button} disabled={busy} onClick={() => void command("reset", { sessionId: chat.sessionId })}>新研究对话</button>}
        </nav>
      </header>
      {!authenticated ? <section className="mt-6 rounded-xl border border-border bg-bg-panel p-4">
        <h2 className="font-semibold">登录研究</h2>
        <p className="my-2 text-sm text-text-muted">登录后可发起研究对话；试跑仍需在聊天中单独批准。</p>
        <form method="post" action={sessionEndpoint} onSubmit={login} className="flex flex-wrap items-end gap-3">
          <label className="grid gap-1 text-sm">研究密码<input type="password" name="password" autoComplete="current-password" required maxLength={256} className="rounded-md border border-border bg-bg px-3 py-2" /></label>
          <button type="submit" className={button} disabled={busy}>登录研究</button>
        </form>
      </section> : <>
        <div aria-label="研究消息" data-session-id={chat?.sessionId} className="min-h-0 flex-1 overflow-y-auto py-4" role="log">
          {!chat?.entries.length && <section className="rounded-xl border border-border bg-bg-panel p-4 text-sm">
            <p>可以从 B0 开始：以 B0 为基线，把 EMA 快线改成 7，看看少了哪几笔。</p>
            <p className="mt-2 text-text-muted">当前仅支持冻结 B0 的 EMA 快线试跑。没有文件、终端或交易工具；对话文本和公开行情衍生的成交证据会发给所配置的模型提供商。</p>
          </section>}
          {chat?.entries.map((entry) => {
            if (entry.kind === "message") return <MessageView key={entry.id} message={entry.message} />;
            if (entry.kind === "notice") return <p key={entry.id} className="my-3 text-sm text-text-muted">{entry.text}</p>;
            if (entry.kind === "result") return <aside key={entry.id} className="my-4 rounded-xl border border-border bg-bg-panel p-4 text-sm">
              <p>{entry.reused ? "复用已有回执" : "回测回执"} · <code className="break-all">{entry.runId}</code></p>
              <Link href={`/backtest?approval=${entry.approvalId}#baseline-comparison`} className={link}>查看回测对照和逐笔证据</Link>
            </aside>;
            return <section key={entry.id} aria-label="试跑审批卡" className="my-4 rounded-xl border border-border bg-bg-panel p-4">
              <h2 className="font-semibold">B0 审批 · {cardStates[entry.state]}</h2>
              <p className="mt-2 text-sm">EMA 快线 {entry.baselineFast} → {entry.fast}，慢线 {entry.slow} 不变；沿用同一快照及费用，不替换基线。</p>
              {entry.alreadyRecorded && <p className="mt-2 text-sm">已有回执，批准后只检查原结果，不另跑。</p>}
              <details className="mt-2 text-xs text-text-muted"><summary>B0 与数据快照</summary><p className="break-all">{entry.baselineRunId}</p><p className="break-all">{entry.dataSha256}</p></details>
              {entry.state === "pending" && chat && <div className="mt-3 flex gap-2">
                <button className={button} disabled={busy} onClick={() => void command("decision", { sessionId: chat.sessionId, cardId: entry.id, approved: true })}>批准这次试跑</button>
                <button className={button} disabled={busy} onClick={() => void command("decision", { sessionId: chat.sessionId, cardId: entry.id, approved: false })}>拒绝</button>
              </div>}
            </section>;
          })}
          <div ref={tail} />
        </div>
        <section className="shrink-0 border-t border-border pb-3 pt-2">
          <p role="status" className="mb-2 text-xs text-text-muted">{phases[chat?.phase ?? "idle"]}</p>
          <ChatInput ref={model} compact allowSessionReferences={false} inputLabel="研究消息输入" isStreaming={!ready || busy}
            onAbort={() => { if (chat) void command("stop", { sessionId: chat.sessionId }); }}
            onSend={(message) => { if (!ready || busy) return; void command("message", { sessionId: chat?.sessionId ?? null, message }).then((accepted) => { if (!accepted) model.current?.insertIfEmpty(message); }); }} />
        </section>
      </>}
      {error && <p role="alert" className="mb-3 text-sm">{error}</p>}
    </div>
  </main>;
}
