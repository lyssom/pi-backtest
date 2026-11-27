import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createJiti } from "jiti";
import { createApprovalServer } from "./approval-web.mjs";

const usage = "node scripts/pi-backtest/approval-server.mjs --password-file=/path/to/private/password --model=deepseek/deepseek-flash [--report-origin=http://127.0.0.1:30141]";

async function main() {
  const { values } = parseArgs({ options: { "password-file": { type: "string" }, model: { type: "string" },
    "report-origin": { type: "string", default: "http://127.0.0.1:30141" }, help: { type: "boolean" } } });
  if (values.help) return console.log(usage);
  const modelRef = /^([^/]+)\/(.+)$/.exec(values.model ?? "");
  if (!values["password-file"] || !modelRef) throw new Error(usage);
  const permissions = await stat(values["password-file"]);
  if (!permissions.isFile() || (permissions.mode & 0o077)) throw new Error("Password file must be private (mode 0600).");
  const password = (await readFile(values["password-file"], "utf8")).trim();
  const jiti = createJiti(import.meta.url);
  const { loadRun } = await jiti.import("../../lib/backtest/baseline.ts");
  const { createResearchRuntime, runResearch } = await jiti.import("../../lib/backtest/research.ts");
  const { runTrial } = await jiti.import("../../lib/backtest/trial.ts");
  const { createApprovalStore } = await jiti.import("../../lib/backtest/approvals.ts");
  const { createApprovalReports } = await jiti.import("../../lib/backtest/approval-reports.ts");
  const { createResearchChat } = await jiti.import("../../lib/backtest/research-chat.ts");
  const baseline = await loadRun("baseline");
  if (baseline.status !== "ready") throw new Error("B0 is not available.");
  const [, provider, modelId] = modelRef;
  const runtime = await createResearchRuntime();
  const model = runtime.getModel(provider, modelId);
  if (!model || !await runtime.getAuth(model)) throw new Error("The selected Pi model needs a credential in this process environment.");
  const directory = join(process.cwd(), ".pi-backtest", "approvals");
  const modelLabel = `${provider}/${modelId}`;
  const reports = createApprovalReports(directory, baseline.run);
  const store = createApprovalStore({
    directory, baseline: baseline.run, model: modelLabel,
    executor: (fast, recordRun) => runResearch({ runtime, model, baseline: baseline.run, fast,
      execute: async (b0, value) => {
        const trial = await runTrial(b0, value);
        if (trial.status === "ready") recordRun(trial.run.runId, reports.record(trial.run));
        return trial;
      },
    }),
  });
  const currentBaseline = async () => {
    const current = await loadRun("baseline");
    return current.status === "ready" ? current.run.runId : null;
  };
  const workerToken = process.env.PI_BACKTEST_WORKER_TOKEN;
  const chat = workerToken ? createResearchChat({ store, reports, baseline: baseline.run, runtime, model, currentBaseline }) : undefined;
  const server = createApprovalServer({ store, password, modelLabel, reportOrigin: values["report-origin"],
    workerToken, reportFor: reports.resolve, currentBaseline, chat,
  });
  server.on("error", (error) => { console.error(`Approval listener failed (${error.code ?? "unknown"}).`); process.exitCode = 1; });
  server.listen(30143, "127.0.0.1", () => {
    try {
      store.recoverInterrupted();
      console.log("Pi Backtest approval page: http://127.0.0.1:30143 (loopback only)");
    } catch {
      console.error("Cannot recover approval receipts; refusing new approvals.");
      server.close();
      process.exitCode = 1;
    }
  });
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });