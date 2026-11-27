import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writePrivateFileAtomicSync } from "../atomic-file";
import { compareRuns, decodeRun, type FrozenRun } from "./baseline";
import type { Approval } from "./approvals";
import { runTrial } from "./trial";

const hex = /^[a-f0-9]{64}$/;
const sha256 = (json: string) => createHash("sha256").update(json).digest("hex");

// Only the approval worker writes this directory. The digest pins the report bytes, not just its execution inputs.
export function createApprovalReports(directory: string, baseline: FrozenRun, replay = runTrial) {
  const path = (runId: string) => join(directory, `run-${runId}.json`);
  const read = (runId: string) => {
    try { return readFileSync(path(runId), "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return undefined;
    }
  };

  function record(run: FrozenRun) {
    if (!hex.test(run.runId) || !compareRuns(baseline, run)) throw new Error("Candidate does not match B0.");
    const json = JSON.stringify(run);
    const existing = read(run.runId);
    if (existing === undefined) writePrivateFileAtomicSync(path(run.runId), json);
    else if (existing !== json) throw new Error("Refusing to replace a candidate report.");
    return sha256(json);
  }

  async function resolve(receipt: Approval): Promise<FrozenRun | null> {
    if (receipt.baselineRunId !== baseline.runId || !receipt.runId || !hex.test(receipt.runId)) return null;
    const matches = (run: FrozenRun) => run.runId === receipt.runId && String(run.report.strategy.fast) === receipt.fast && compareRuns(baseline, run);
    if (!receipt.reportSha256) {
      // Pre-migration receipt: verify a deterministic replay without involving Pi or changing the receipt.
      const result = await replay(baseline, receipt.fast);
      return result.status === "ready" && matches(result.run) ? result.run : null;
    }
    const json = read(receipt.runId);
    if (json === undefined || sha256(json) !== receipt.reportSha256) return null;
    const run = decodeRun(json, "variant");
    return run && matches(run) ? run : null;
  }

  return { record, resolve };
}
