import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";

const jiti = createJiti(import.meta.url);
const { createResearchChat } = await jiti.import("./research-chat.ts");
const { createResearchRuntime } = await jiti.import("./research.ts");
const { createApprovalStore } = await jiti.import("./approvals.ts");
const baseline = { runId: "a".repeat(64), engine: "ema-cross-v1", dataSha256: "shared", report: {
  strategy: { fast: 3, slow: 8, notional: 1000, feeBps: 5 }, bars: [{ time: 0 }], trades: [], summary: { closed: 0, wins: 0, net: 0, fees: 0 },
} };
const runId = "b".repeat(64);
const candidate = { ...baseline, runId, parentRunId: baseline.runId, report: { ...baseline.report, strategy: { ...baseline.report.strategy, fast: 7 } } };
const call = (tool, args) => fauxAssistantMessage(fauxToolCall(tool, args), { stopReason: "toolUse" });
async function waitFor(reader) {
  for (let tries = 0; tries < 200; tries++) { const result = reader(); if (result) return result; await new Promise((resolve) => setTimeout(resolve, 5)); }
  assert.fail("condition not reached");
}

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), "pi-backtest-chat-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const faux = fauxProvider();
  const runtime = await createResearchRuntime();
  runtime.registerNativeProvider(faux.provider);
  const store = createApprovalStore({ directory: dir, baseline, async executor() { assert.fail("no separate Pi executor"); } });
  let engineCalls = 0;
  const chat = createResearchChat({ runtime, model: faux.getModel(), baseline, store, currentBaseline: async () => baseline.runId,
    async execute(_b0, fast) { engineCalls++; assert.equal(fast, "7"); return { status: "ready", run: candidate }; },
    reports: { record: () => "c".repeat(64), async resolve() { return candidate; } },
  });
  t.after(() => chat.close());
  return { faux, chat, store, engineCalls: () => engineCalls };
}

test("one message and one approval resume the same real Pi session, including a follow-up", async (t) => {
  const { faux, chat, store, engineCalls } = await setup(t);
  const prompt = "以 B0 为基线，把 EMA 快线改成 7，看看逐笔差异。";
  faux.setResponses([
    (context) => {
      assert.deepEqual(getCurrentTools(context.messages).map(({ name }) => name).sort(), ["inspect_trial", "propose_trial", "read_baseline", "run_approved_trial"]);
      return call("read_baseline", {});
    },
    call("propose_trial", { fast: 7 }),
    (context) => {
      assert.equal(context.messages.filter(({ role }) => role === "user").length, 1);
      const entry = context.messages.findLast(({ role }) => role === "toolResult");
      assert.equal(JSON.parse(entry.content[0].text).approved, true);
      return call("run_approved_trial", { fast: 7 });
    },
    call("inspect_trial", { runId }),
    fauxAssistantMessage("试跑的净额差为零。"),
    (context) => {
      const userMessages = context.messages.filter(({ role }) => role === "user");
      assert.equal(userMessages.length, 2);
      assert.match(JSON.stringify(userMessages[0]), /快线改成 7/);
      return fauxAssistantMessage("这是同一快照的逐笔对照。");
    },
  ]);
  assert.equal(await chat.send(null, prompt), "accepted");
  const card = await waitFor(() => chat.view()?.entries.find((entry) => entry.kind === "approval"));
  const sessionId = chat.view().sessionId;
  assert.equal(card.fast, 7);
  assert.equal(store.get("7"), undefined);
  assert.equal(engineCalls(), 0);
  assert.equal(await chat.decide(sessionId, "wrong-id", true), "stale");
  assert.equal(await chat.decide(sessionId, card.id, true), "accepted");
  assert.equal(await chat.decide(sessionId, card.id, true), "stale");
  await waitFor(() => chat.view()?.phase === "idle");
  assert.equal(chat.view().sessionId, sessionId);
  assert.equal(store.get("7").status, "completed");
  assert.equal(engineCalls(), 1);
  assert.ok(chat.view().entries.some((entry) => entry.kind === "result" && entry.runId === runId));
  assert.equal(await chat.send(sessionId, "那如何理解这次对照？"), "accepted");
  await waitFor(() => chat.view()?.phase === "idle");
  assert.equal(chat.view().sessionId, sessionId);
  assert.equal(chat.view().entries.filter((entry) => entry.kind === "message" && entry.message.role === "user").length, 2);
  assert.equal(engineCalls(), 1);

  faux.setResponses([call("read_baseline", {}), call("propose_trial", { fast: 7 }), call("run_approved_trial", { fast: 7 }),
    call("inspect_trial", { runId }), fauxAssistantMessage("读取了已有结果。")]);
  const prior = store.get("7");
  assert.equal(await chat.send(sessionId, "再检查一下刚才的快线 7。"), "accepted");
  const second = await waitFor(() => chat.view()?.entries.find((entry) => entry.kind === "approval" && entry.state === "pending"));
  assert.equal(second.alreadyRecorded, true);
  assert.equal(await chat.decide(sessionId, second.id, true), "accepted");
  await waitFor(() => chat.view()?.phase === "idle");
  assert.equal(chat.view().entries.at(-1).reused, true);
  assert.deepEqual(store.get("7"), prior);
  assert.equal(engineCalls(), 1);
});

test("model cannot run before explicit approval, and a declined card never writes a receipt", async (t) => {
  const { faux, chat, store, engineCalls } = await setup(t);
  faux.setResponses([
    call("run_approved_trial", { fast: 7 }),
    (context) => { assert.equal(context.messages.findLast(({ role }) => role === "toolResult").isError, true); return call("read_baseline", {}); },
    call("propose_trial", { fast: 7 }),
    fauxAssistantMessage("未执行试跑。"),
  ]);
  assert.equal(await chat.send(null, "试一下快线七"), "accepted");
  const card = await waitFor(() => chat.view()?.entries.find((entry) => entry.kind === "approval"));
  assert.equal(await chat.decide(chat.view().sessionId, card.id, false), "accepted");
  await waitFor(() => chat.view()?.phase === "idle");
  assert.equal(engineCalls(), 0);
  assert.equal(store.get("7"), undefined);
});
