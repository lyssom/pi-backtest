import { randomUUID } from "node:crypto";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { AssistantMessage, UserMessage } from "../types";
import type { createApprovalReports } from "./approval-reports";
import type { Approval, ApprovalTicket, createApprovalStore } from "./approvals";
import { compareRuns, type FrozenRun } from "./baseline";
import { openResearchSession, researchBaselineFacts, researchPrompt, researchToolResult, trialEvidence, type ResearchModel } from "./research";
import { parseTrialPeriod, runTrial } from "./trial";

const APPROVAL_MS = 90_000;
const RUN_MS = 60_000;
const MAX_PROMPTS = 10;
const IDLE_TTL_MS = 30 * 60_000;
const fastSchema = Type.Object({ fast: Type.Integer() }, { additionalProperties: false });
const runSchema = Type.Object({ runId: Type.String() }, { additionalProperties: false });
const prompt = "你是 Pi Web 的 Pi Backtest 研究助手。用中文回答，只能研究当前冻结的 B0；支持调整 EMA 快线，保留慢线、仓位、费用、数据和其他规则。不支持任意策略、联网搜索、执行代码、交易或晋升基线。用户提出试跑时，先用 read_baseline 读真实 B0；只在明确一个允许的 EMA 快线时调用 propose_trial 生成审批卡（工具会等待用户按钮，不要以聊天文本或用户说批准代替）。只有工具明确返回 approved=true 才在本轮按相同参数调用 run_approved_trial，再用返回的 runId 调用 inspect_trial，然后解释真实净额、笔数和一项逐笔差异。未批准或拒绝时不能运行。后续追问可以用已有回执的证据回答；需要新参数时要新的卡。成交按入场 K 线配对，不强配单侧交易；注明样本内和 B0 不变。";

type ChatPhase = "idle" | "thinking" | "approval" | "running";
type Card = { kind: "approval"; id: string; baselineRunId: string; dataSha256: string; baselineFast: number; slow: number; fast: number;
  alreadyRecorded: boolean; state: "pending" | "approved" | "declined" | "expired" };
export type ResearchChatEntry = Card | { kind: "message"; id: string; message: UserMessage | AssistantMessage }
  | { kind: "result"; id: string; approvalId: string; runId: string; reused: boolean }
  | { kind: "notice"; id: string; text: string };
export type ResearchChatView = { sessionId: string; phase: ChatPhase; entries: ResearchChatEntry[] };

type Turn = { read: boolean; proposed: boolean; ticket?: ApprovalTicket; existing?: Approval; approvedFast?: number;
  submission?: Promise<FrozenRun>; inspected?: string; timer?: ReturnType<typeof setTimeout>; cancelled?: boolean };

// One live session for this single-operator worker. Only receipts/reports are written to disk.
export function createResearchChat({ runtime, model, baseline, store, reports, currentBaseline, execute = runTrial }: ResearchModel & {
  baseline: FrozenRun; store: ReturnType<typeof createApprovalStore>; reports: ReturnType<typeof createApprovalReports>;
  currentBaseline: () => Promise<string | null>; execute?: typeof runTrial;
}) {
  let agent: Awaited<ReturnType<typeof openResearchSession>> | undefined;
  let phase: ChatPhase = "idle";
  let entries: ResearchChatEntry[] = [];
  let turn: Turn | undefined;
  let pending: { card: Card; settle: (state: Card["state"]) => void } | undefined;
  let lastRun: FrozenRun | undefined;
  let touchedAt = 0;
  let messagesSent = 0;
  let running: Promise<void> | undefined;
  const notice = (text: string) => entries.push({ kind: "notice", id: randomUUID(), text });
  const currentId = () => agent?.session.sessionId;

  const tools: ToolDefinition[] = [
    {
      name: "read_baseline", label: "Read B0", description: "Read B0's market snapshot, rules, summary and allowed fast periods.",
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute() {
        if (!turn) throw new Error("No research turn.");
        turn.read = true;
        return researchToolResult({ ...researchBaselineFacts(baseline), allowedFast: store.periods.map(Number) });
      },
    },
    {
      name: "propose_trial", label: "Request approval", description: "After reading B0, show a server-generated approval card and wait for the operator's decision on this exact fast period.",
      parameters: fastSchema,
      async execute(_id, args, signal) {
        const scope = turn;
        signal?.throwIfAborted();
        if (!scope?.read || scope.proposed || !Value.Check(fastSchema, args) || parseTrialPeriod(String(args.fast), baseline) === null) {
          throw new Error("Read B0 first. At most one valid fast period may be proposed per user message.");
        }
        scope.proposed = true;
        const card: Card = { kind: "approval", id: randomUUID(), baselineRunId: baseline.runId, dataSha256: baseline.dataSha256,
          baselineFast: baseline.report.strategy.fast, slow: baseline.report.strategy.slow, fast: args.fast,
          alreadyRecorded: Boolean(store.get(String(args.fast))), state: "pending" };
        entries.push(card);
        phase = "approval";
        const result = await new Promise<Card["state"]>((resolve) => {
          const abort = () => settle("declined");
          const timer = setTimeout(() => settle("expired"), APPROVAL_MS);
          const settle = (state: Card["state"]) => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
            pending = undefined;
            card.state = state;
            phase = state === "approved" ? "running" : "thinking";
            resolve(state);
          };
          pending = { card, settle };
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted) abort();
        });
        return researchToolResult({ approved: result === "approved", fast: args.fast, reason: result,
          reuseReceipt: Boolean(scope.existing) });
      },
    },
    {
      name: "run_approved_trial", label: "Run approved trial", description: "Only after propose_trial returns approved=true; use the same fast period. If recorded, reuse the saved result instead of rerunning.",
      parameters: fastSchema,
      async execute(_id, args, signal) {
        const scope = turn;
        signal?.throwIfAborted();
        if (!scope || !Value.Check(fastSchema, args) || scope.approvedFast !== args.fast) throw new Error("No matching browser approval.");
        scope.submission ??= (async () => {
          const trial = scope.existing ? await reports.resolve(scope.existing) : await execute(baseline, String(args.fast)).then((result) => result.status === "ready" ? result.run : null);
          signal?.throwIfAborted();
          if (!trial || !compareRuns(baseline, trial) || trial.report.strategy.fast !== args.fast) throw new Error("Saved or new report does not match B0.");
          if (scope.ticket) scope.ticket.recordRun(trial.runId, reports.record(trial));
          return trial;
        })();
        const trial = await scope.submission;
        return researchToolResult({ runId: trial.runId, reused: Boolean(scope.existing) });
      },
    },
    {
      name: "inspect_trial", label: "Read trade evidence", description: "Inspect by runId returned in this conversation. Can read the last finished result again for a follow-up.",
      parameters: runSchema,
      async execute(_id, args) {
        const scope = turn;
        if (!scope || !Value.Check(runSchema, args)) throw new Error("Use the returned run ID.");
        const candidate = scope.submission ? await scope.submission : lastRun;
        if (!candidate || candidate.runId !== args.runId) throw new Error("That run was not returned in this conversation.");
        const evidence = trialEvidence(baseline, candidate);
        if (scope.submission) scope.inspected = candidate.runId;
        return researchToolResult(evidence);
      },
    },
  ];

  async function unload() {
    const previous = agent;
    agent = undefined;
    entries = [];
    lastRun = undefined;
    messagesSent = 0;
    await previous?.close();
  }

  function view(): ResearchChatView | null {
    if (phase === "idle" && agent && Date.now() - touchedAt > IDLE_TTL_MS) void unload().catch(() => {});
    const sessionId = currentId();
    return sessionId ? { sessionId, phase, entries } : null;
  }

  async function send(sessionId: string | null, text: string) {
    if (!text.trim() || text.length > 2000) return "invalid" as const;
    const existing = view();
    if ((existing?.sessionId ?? null) !== sessionId) return "stale" as const;
    if (phase !== "idle") return "busy" as const;
    if (messagesSent >= MAX_PROMPTS) return "limit" as const;
    phase = "thinking";
    try {
      if (!agent) {
        agent = await openResearchSession({ runtime, model }, tools, prompt);
        agent.session.subscribe((event) => {
          if (event.type !== "message_end" || event.message.role !== "assistant" || event.message.stopReason === "error") return;
          const content = event.message.content.flatMap((block) => block.type === "text" ? [{ type: "text" as const, text: block.text }] : []);
          if (content.length) entries.push({ kind: "message", id: randomUUID(), message: { role: "assistant", content,
            timestamp: event.message.timestamp, model: model.id, provider: model.provider } });
        });
      }
    } catch { phase = "idle"; return "unavailable" as const; }
    const scope: Turn = { read: false, proposed: false };
    const session = agent.session;
    turn = scope;
    messagesSent++;
    entries.push({ kind: "message", id: randomUUID(), message: { role: "user", content: text, timestamp: Date.now() } });
    running = (async () => {
      try {
        const { answer } = await researchPrompt(session, text, APPROVAL_MS + RUN_MS);
        const done = scope.inspected && answer && !scope.cancelled && scope.submission ? await scope.submission : null;
        if (done && answer) {
          const completedTools = ["read_baseline", "propose_trial", "run_approved_trial", "inspect_trial"];
          scope.ticket?.complete({ runId: done.runId, answer, completedTools });
          lastRun = done;
          entries.push({ kind: "result", id: randomUUID(), approvalId: `${baseline.runId}-${done.report.strategy.fast}`,
            runId: done.runId, reused: Boolean(scope.existing) });
        } else {
          scope.ticket?.fail();
          const partial = scope.approvedFast === undefined ? undefined : store.get(String(scope.approvedFast));
          if (partial?.runId) entries.push({ kind: "result", id: randomUUID(), approvalId: `${baseline.runId}-${partial.fast}`, runId: partial.runId,
            reused: Boolean(scope.existing) });
          if (!answer || scope.approvedFast !== undefined) notice(scope.cancelled ? "已停止，不会自动重跑。" : "Pi 没有完成本轮研究，不会自动重跑。若已有运行回执，可打开对照核验。");
        }
      } catch {
        try { scope.ticket?.fail(); } catch { /* keep last durable receipt */ }
        notice("本轮研究没有完成。B0 未修改，也不会自动重新提交。");
      } finally {
        clearTimeout(scope.timer);
        pending?.settle("declined");
        turn = undefined;
        running = undefined;
        phase = "idle";
        touchedAt = Date.now();
      }
    })();
    return "accepted" as const;
  }

  async function decide(sessionId: string, cardId: string, allow: boolean) {
    const wait = pending;
    const scope = turn;
    if (sessionId !== currentId() || !scope || wait?.card.id !== cardId) return "stale" as const;
    if (allow) {
      if (await currentBaseline() !== baseline.runId) return "stale_baseline" as const;
      if (pending !== wait || turn !== scope) return "stale" as const;
      const fast = String(wait.card.fast);
      const ticket = store.reserve(fast);
      if (ticket.status === "accepted") scope.ticket = ticket;
      else if (ticket.status === "exists") {
        const stored = store.get(fast);
        if (stored?.status === "running") return "busy" as const;
        if (!stored?.runId) return "unavailable" as const;
        scope.existing = stored;
      } else return ticket.status;
      scope.approvedFast = wait.card.fast;
      scope.timer = setTimeout(() => { scope.cancelled = true; agent?.session.agent.abort(); }, RUN_MS);
    }
    wait.settle(allow ? "approved" : "declined");
    return "accepted" as const;
  }

  function stop(sessionId: string) {
    if (sessionId !== currentId() || !turn) return "stale" as const;
    turn.cancelled = true;
    agent?.session.agent.abort();
    return "accepted" as const;
  }

  async function reset(sessionId: string) {
    if (sessionId !== currentId()) return "stale" as const;
    if (phase !== "idle") return "busy" as const;
    await unload();
    return "accepted" as const;
  }

  return { view, send, decide, stop, reset, async close() {
    const sessionId = currentId();
    if (sessionId) stop(sessionId);
    await running;
    await unload();
  } };
}
