import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { runResearch, createResearchRuntime } = await jiti.import("./research.ts");
const baseline = {
  engine: "ema-cross-v1", runId: "b0", parentRunId: null, dataSha256: "shared",
  report: { strategy: { fast: 3, slow: 8, notional: 1000, feeBps: 5 }, summary: { closed: 0, wins: 0, net: 0, fees: 0 }, bars: [{ time: 0 }], trades: [] },
};
const candidate = {
  ...baseline, runId: "candidate", parentRunId: baseline.runId,
  report: { ...baseline.report, strategy: { ...baseline.report.strategy, fast: 5 } },
};
const toolNames = ["read_baseline", "run_approved_trial", "inspect_trial"];
const call = (index, args) => fauxAssistantMessage(fauxToolCall(toolNames[index], args, { id: `call_${index}` }), { stopReason: "toolUse" });

async function setup() {
  const faux = fauxProvider();
  const runtime = await createResearchRuntime();
  runtime.registerNativeProvider(faux.provider);
  const inputs = [];
  const run = (fast = "5") => runResearch({ runtime, model: faux.getModel(), baseline, fast,
    async execute(b0, value) {
      inputs.push([b0.runId, value]);
      return { status: "ready", run: candidate };
    },
  });
  return { faux, inputs, run };
}

const resultOf = (context, name) => context.messages.findLast((message) => message.role === "toolResult" && message.toolName === name);

test("one Pi prompt drives all three tools with the next calls based on actual tool results", async () => {
  const { faux, inputs, run } = await setup();
  faux.setResponses([
    (context) => {
      assert.deepEqual(getCurrentTools(context.messages).map(({ name }) => name).sort(), [...toolNames].sort());
      assert.equal(context.messages.filter((message) => message.role === "user").length, 1);
      return call(0, {});
    },
    (context) => {
      const fact = JSON.parse(resultOf(context, toolNames[0]).content[0].text);
      return call(1, { baselineRunId: fact.runId, fast: 5 });
    },
    (context) => {
      const receipt = JSON.parse(resultOf(context, toolNames[1]).content[0].text);
      return call(2, { runId: receipt.runId });
    },
    (context) => {
      const evidence = JSON.parse(resultOf(context, toolNames[2]).content[0].text);
      assert.equal(evidence.dataSha256, "shared");
      return fauxAssistantMessage(`Trial net delta: ${evidence.netDeltaUsdt}`);
    },
  ]);
  const result = await run();
  assert.deepEqual(inputs, [["b0", "5"]]);
  assert.deepEqual(result.completedTools, toolNames);
  assert.equal(result.runId, "candidate");
  assert.equal(result.replayPath, "/backtest?fast=5#baseline-comparison");
  assert.equal(result.answer, "Trial net delta: 0");
});

test("rejects out-of-order and unapproved execution", async () => {
  const { faux, inputs, run } = await setup();
  faux.setResponses([
    call(1, { baselineRunId: "b0", fast: 5 }),
    (context) => {
      assert.equal(resultOf(context, toolNames[1]).isError, true);
      return call(0, {});
    },
    call(1, { baselineRunId: "b0", fast: 6 }),
    (context) => {
      assert.equal(resultOf(context, toolNames[1]).isError, true);
      return fauxAssistantMessage("I did not run a trial");
    },
  ]);
  await assert.rejects(run(), /incomplete/);
  assert.deepEqual(inputs, []);
  await assert.rejects(run("3"), /approved fast period/);
  assert.equal(faux.state.callCount, 4);
});

test("a completed run without inspection does not count as a complete research loop", async () => {
  const { faux, inputs, run } = await setup();
  faux.setResponses([call(0, {}), call(1, { baselineRunId: "b0", fast: 5 }), fauxAssistantMessage("Done")]);
  await assert.rejects(run(), /incomplete.*completed tools: read_baseline → run_approved_trial/);
  assert.deepEqual(inputs, [["b0", "5"]]);
});

test("repeated submit returns the original receipt once and rejects inspection of other runs", async () => {
  const { faux, inputs, run } = await setup();
  faux.setResponses([
    call(0, {}), call(1, { baselineRunId: "b0", fast: 5 }),
    call(1, { baselineRunId: "b0", fast: 5 }),
    call(2, { runId: "another-run" }),
    (context) => {
      const receipts = context.messages.filter((message) => message.role === "toolResult" && message.toolName === toolNames[1]);
      assert.equal(receipts.length, 2);
      assert.deepEqual(receipts[0].content, receipts[1].content);
      assert.equal(resultOf(context, toolNames[2]).isError, true);
      return call(2, { runId: "candidate" });
    },
    fauxAssistantMessage("Done"),
  ]);
  const result = await run();
  assert.deepEqual(inputs, [["b0", "5"]]);
  assert.deepEqual(result.completedTools, toolNames);
});

test("stops repeated provider turns at the budget without calling the engine", async () => {
  const { faux, inputs, run } = await setup();
  faux.setResponses(Array.from({ length: 9 }, () => call(0, {})));
  await assert.rejects(run(), /turn limit/);
  assert.equal(faux.state.callCount, 6);
  assert.deepEqual(inputs, []);
});
