import { parseArgs } from "node:util";
import { createJiti } from "jiti";

const usage = "node scripts/pi-backtest/research.mjs --approve-fast=5 --model=deepseek/deepseek-flash";

try {
  const { values } = parseArgs({ options: { "approve-fast": { type: "string" }, model: { type: "string" }, help: { type: "boolean" } } });
  if (values.help) {
    console.log(usage);
  } else {
    const fast = values["approve-fast"];
    const modelRef = /^([^/]+)\/(.+)$/.exec(values.model ?? "");
    if (!fast || !modelRef) throw new Error(`Explicit approval and provider/model are required.\n${usage}`);
    const jiti = createJiti(import.meta.url);
    const { loadRun } = await jiti.import("../../lib/backtest/baseline.ts");
    const { parseTrialPeriod } = await jiti.import("../../lib/backtest/trial.ts");
    const baseline = await loadRun("baseline");
    if (baseline.status !== "ready") throw new Error("B0 is unavailable; run python3 scripts/pi-backtest/baseline.py first.");
    if (parseTrialPeriod(fast, baseline.run) === null) throw new Error("Approve one fast period from 1, 2, 4, 5, 6, 7.");
    const { createResearchRuntime, runResearch } = await jiti.import("../../lib/backtest/research.ts");
    const [, provider, id] = modelRef;
    const runtime = await createResearchRuntime();
    const model = runtime.getModel(provider, id);
    if (!model) throw new Error("Unknown built-in model; use a provider/model from Pi's catalog.");
    if (!await runtime.getAuth(model)) throw new Error("No model credential is available in this process environment.");
    const output = await runResearch({ runtime, model, baseline: baseline.run, fast });
    console.log(`Pi 工具：${output.completedTools.join(" → ")}\nB0: ${output.baselineRunId}\n试跑: ${output.runId}\n复现: ${output.replayPath}\n\n${output.answer}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Research failed.");
  process.exitCode = 1;
}
