import { compareRuns, loadRun } from "@/lib/backtest/baseline";
import { runTrial } from "@/lib/backtest/trial";

const headers = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  const baseline = await loadRun("baseline");
  if (baseline.status !== "ready") {
    return Response.json({ error: "Baseline unavailable" }, { status: 409, headers });
  }
  const fast = new URL(request.url).searchParams.getAll("fast");
  const trial = await runTrial(baseline.run, fast.length === 1 ? fast[0] : null);
  if (trial.status === "invalid") {
    return Response.json({ error: "Choose a fast period from 1 to 7 different from B0" }, { status: 400, headers });
  }
  if (trial.status !== "ready") {
    return Response.json({ error: "Trial unavailable; B0 is unchanged" }, { status: 503, headers });
  }
  return Response.json({ baselineRunId: baseline.run.runId, trial: trial.run, comparison: compareRuns(baseline.run, trial.run) }, { headers });
}
