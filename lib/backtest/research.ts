import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore, type Api, type Model } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { compareRuns, type FrozenRun } from "./baseline";
import { HOUR_MS, type SampleTrade } from "./sample";
import { parseTrialPeriod, runTrial } from "./trial";

const TOOL = { read: "read_baseline", run: "run_approved_trial", inspect: "inspect_trial" } as const;
const TURN_LIMIT = 6;
const TIME_LIMIT_MS = 60_000;
const REPLY_TOKEN_LIMIT = 1536;
const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: undefined });

export function createResearchRuntime() {
  return ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
}

function researchTools(baseline: FrozenRun, fast: number, execute: typeof runTrial) {
  const completedTools: string[] = [];
  const mark = (name: string) => { if (!completedTools.includes(name)) completedTools.push(name); };
  const replayPath = `/backtest?fast=${fast}#baseline-comparison`;
  let submission: Promise<{ run: FrozenRun; comparison: NonNullable<ReturnType<typeof compareRuns>> }> | undefined;
  let inspectedRunId: string | undefined;
  const submitParams = Type.Object({ baselineRunId: Type.String(), fast: Type.Integer() }, { additionalProperties: false });
  const inspectParams = Type.Object({ runId: Type.String() }, { additionalProperties: false });
  const tools: ToolDefinition[] = [
    {
      name: TOOL.read, label: "Read B0",
      description: "Read B0's immutable run ID, market identity, strategy, totals and the exact approved fast period.",
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute() {
        mark(TOOL.read);
        return result({ name: "B0", runId: baseline.runId, dataSha256: baseline.dataSha256, engine: baseline.engine,
          market: "Binance USDⓈ-M BTCUSDT 1h", candles: baseline.report.bars.length, approvedFast: fast,
          strategy: baseline.report.strategy, summary: baseline.report.summary });
      },
    },
    {
      name: TOOL.run, label: "Run approved trial",
      description: "After reading B0, run exactly the approved fast EMA on B0's frozen candles. Waits for a run ID; no persistence or promotion.",
      parameters: submitParams,
      async execute(_id, params, signal) {
        signal?.throwIfAborted();
        if (!Value.Check(submitParams, params) || !completedTools.includes(TOOL.read) || params.baselineRunId !== baseline.runId || params.fast !== fast) {
          throw new Error("Read B0 first and use only its run ID and the approved fast period.");
        }
        submission ??= execute(baseline, String(fast)).then((trial) => {
          const run = trial.status === "ready" ? trial.run : undefined;
          const comparison = run && compareRuns(baseline, run);
          if (!run || run.report.strategy.fast !== fast || !comparison) {
            throw new Error("Approved trial unavailable; B0 was not changed.");
          }
          return { run, comparison };
        });
        const { run } = await submission;
        mark(TOOL.run);
        return result({ runId: run.runId });
      },
    },
    {
      name: TOOL.inspect, label: "Inspect trial evidence",
      description: "Read the completed trial and compare net P&L and trade evidence with B0. Use the run ID returned by run_approved_trial.",
      parameters: inspectParams,
      async execute(_id, params) {
        if (!submission || !completedTools.includes(TOOL.run)) throw new Error("Run the approved trial first.");
        const { run, comparison } = await submission;
        if (!Value.Check(inspectParams, params) || params.runId !== run.runId) throw new Error("Only the run from this approval can be inspected.");
        const bars = baseline.report.bars;
        const utc = (time: number) => new Date(time).toISOString();
        const tradeEvidence = (trade?: SampleTrade) => trade && ({
          exitTimeUtc: utc(bars[trade.exit.bar].time + (trade.exitReason === "window_end" ? HOUR_MS - 1 : 0)),
          exitReason: trade.exitReason, netUsdt: trade.net,
        });
        const b0 = baseline.report.summary;
        const trial = run.report.summary;
        inspectedRunId = run.runId;
        mark(TOOL.inspect);
        return result({ runId: run.runId, baselineRunId: baseline.runId, dataSha256: run.dataSha256,
          baselineFast: baseline.report.strategy.fast, trialFast: fast, baseline: b0, trial,
          netDeltaUsdt: Number((trial.net - b0.net).toFixed(6)),
          tradeCounts: {
            identicalTrades: comparison.unchanged,
            sameEntryDifferentExitOrPnL: comparison.rows.filter((row) => row.kind === "changed").length,
            baselineOnly: comparison.rows.filter((row) => row.kind === "baseline-only").length,
            trialOnly: comparison.rows.filter((row) => row.kind === "variant-only").length,
          },
          trades: comparison.rows.map((row) => ({
            entryTimeUtc: utc(bars[row.entryBar].time), kind: row.kind,
            baseline: tradeEvidence(row.baseline), trial: tradeEvidence(row.variant),
          })), replayPath });
      },
    },
  ];
  return { tools, completedTools, getInspectedRunId: () => inspectedRunId, replayPath };
}

export async function runResearch({ runtime, model, baseline, fast, execute = runTrial }: {
  runtime: ModelRuntime; model: Model<Api>; baseline: FrozenRun; fast: string; execute?: typeof runTrial;
}) {
  const approved = parseTrialPeriod(fast, baseline);
  if (approved === null) throw new Error("Invalid approved fast period for B0.");
  const scope = researchTools(baseline, approved, execute);
  const dir = await mkdtemp(join(tmpdir(), "pi-backtest-research-"));
  try {
    const settingsManager = SettingsManager.inMemory({ retry: { enabled: false, provider: { maxRetries: 0 } },
      compaction: { enabled: false }, cacheWarming: "off" });
    const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPrompt: "你是 Pi Backtest 的研究助手。只能使用提供的三项研究工具。严格按顺序读取 B0、提交已批准试跑、检查回执中的运行 ID。收到工具结果就自行继续，不要再请求批准。用中文依据工具结果报告净盈亏、笔数和一项逐笔差异（如有）。成交按入场 K 线配对；区分完全相同、同入场但有变化和单侧独有，不推断未配对交易的对应关系。注明这不是样本外验证且 B0 不变。",
    });
    await resourceLoader.reload();
    const names = scope.tools.map((tool) => tool.name);
    const { session } = await createAgentSession({ cwd: dir, agentDir: dir, settingsManager, resourceLoader,
      modelRuntime: runtime, model, thinkingLevel: "off", sessionManager: SessionManager.inMemory(dir),
      tools: names, customTools: scope.tools });
    const timeout = setTimeout(() => session.agent.abort(), TIME_LIMIT_MS);
    try {
      if (session.model?.provider !== model.provider || session.model.id !== model.id ||
        JSON.stringify(session.getActiveToolNames().sort()) !== JSON.stringify([...names].sort())) {
        throw new Error("Research model or tool allowlist did not match the requested scope.");
      }
      session.agent.toolExecution = "sequential";
      const stream = session.agent.streamFunction;
      session.agent.streamFunction = (model, context, options) => stream(model, context,
        { ...options, maxTokens: Math.min(options?.maxTokens ?? model.maxTokens, REPLY_TOKEN_LIMIT) });
      const finish = session.agent.finishTurn;
      let turns = 0;
      let limited = false;
      session.agent.finishTurn = async (turn, signal) => {
        if (++turns >= TURN_LIMIT && turn.toolResults.length) {
          limited = true;
          return { action: "end" };
        }
        return (await finish?.(turn, signal)) ?? undefined;
      };
      await session.prompt(`已批准一次试跑：以 B0 为基线，只把 EMA 快线改成 ${approved}。请执行并比较结果。`, { expandPromptTemplates: false });
      const runId = scope.getInspectedRunId();
      const last = session.messages.at(-1);
      const answer = last?.role === "assistant" && last.stopReason === "stop" ? session.getLastAssistantText() : undefined;
      if (!runId || !answer) {
        const progress = scope.completedTools.join(" → ") || "none";
        throw new Error(`Research incomplete (${limited ? "turn limit" : last?.role === "assistant" ? last.stopReason : "no final answer"}); completed tools: ${progress}.`);
      }
      return { baselineRunId: baseline.runId, runId, replayPath: scope.replayPath, completedTools: scope.completedTools, answer };
    } finally {
      clearTimeout(timeout);
      session.dispose();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
