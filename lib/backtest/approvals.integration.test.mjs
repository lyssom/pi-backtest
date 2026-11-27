import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { createApprovalServer } from "../../scripts/pi-backtest/approval-web.mjs";

const { createApprovalStore } = await createJiti(import.meta.url).import("./approvals.ts");
const baseline = { runId: "a".repeat(64), report: { strategy: { fast: 3, slow: 8 } } };
const runId = "b".repeat(64);
const answer = '<script>alert("model output is plain text")</script>';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "pi-backtest-approvals-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let calls = 0;
  let finish;
  const executor = async (fast, recordRun) => {
    calls++;
    recordRun(runId);
    await new Promise((resolve) => { finish = resolve; });
    return { runId, answer, completedTools: ["read_baseline", "run_approved_trial", "inspect_trial"] };
  };
  return { directory, makeStore: () => createApprovalStore({ directory, baseline, executor }), calls: () => calls, finish: () => finish() };
}

async function waitFor(check) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("condition not reached");
}

test("persists approval before invoking Pi, reuses its receipt and restores completed results", async (t) => {
  const f = await fixture(t);
  const store = f.makeStore();
  assert.equal(store.approve("3"), "invalid");
  assert.equal(store.approve("5"), "accepted");
  assert.equal(store.get("5").status, "running");
  assert.equal(f.calls(), 0);
  assert.equal(store.approve("5"), "exists");
  assert.equal(store.approve("7"), "busy");
  await waitFor(() => store.get("5").runId === runId);
  f.finish();
  await waitFor(() => store.get("5").status === "completed");
  const reopened = f.makeStore();
  reopened.recoverInterrupted();
  assert.equal(reopened.get("5").answer, answer);
  assert.equal(reopened.get("5").runId, runId);
  assert.equal(reopened.approve("5"), "exists");
  assert.equal(f.calls(), 1);
});

test("recovery preserves a receipt and does not reissue an interrupted approval", async (t) => {
  const f = await fixture(t);
  const store = f.makeStore();
  assert.equal(store.approve("5"), "accepted");
  await waitFor(() => store.get("5").runId === runId);
  assert.equal((await stat(join(f.directory, `${baseline.runId}-5.json`))).mode & 0o777, 0o600);
  const reopened = f.makeStore();
  reopened.recoverInterrupted();
  assert.equal(reopened.get("5").status, "interrupted");
  assert.equal(reopened.get("5").runId, runId);
  assert.equal(reopened.approve("5"), "exists");
  assert.equal(f.calls(), 1);
  f.finish();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reopened.get("5").status, "interrupted");
});

test("a provider failure keeps the recorded trial ID and does not reissue the approval", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const store = createApprovalStore({ directory: f.directory, baseline, async executor(_fast, recordRun) {
    calls++;
    recordRun(runId);
    throw new Error("Provider failed after the engine returned");
  } });
  assert.equal(store.approve("5"), "accepted");
  await waitFor(() => store.get("5").status === "failed");
  assert.equal(store.get("5").runId, runId);
  assert.equal(store.approve("5"), "exists");
  assert.equal(calls, 1);
});

test("private JSON bridge requires a separate credential, pins B0, and returns an existing receipt", async (t) => {
  const f = await fixture(t);
  const store = f.makeStore();
  const token = "private-worker-token-for-test-only";
  const server = createApprovalServer({ store, password: "operator-password-for-tests-only", workerToken: token,
    modelLabel: "faux", reportOrigin: "http://127.0.0.1:30141" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/internal/approvals`;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const post = (body) => fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await post({ baselineRunId: "f".repeat(64), fast: "5" })).status, 409);
  assert.equal((await post({ baselineRunId: baseline.runId, fast: "5", model: "other" })).status, 400);
  assert.equal(f.calls(), 0);
  const approved = await post({ baselineRunId: baseline.runId, fast: "5" });
  assert.equal(approved.status, 202);
  const { approvalId } = await approved.json();
  assert.equal(approvalId, `${baseline.runId}-5`);
  const duplicate = await post({ baselineRunId: baseline.runId, fast: "5" });
  assert.equal(duplicate.status, 200);
  assert.deepEqual(await duplicate.json(), { approvalId });
  const detail = await (await fetch(`${url}/${approvalId}`, { headers })).json();
  assert.equal(detail.runId, runId);
  assert.equal(f.calls(), 1);
  f.finish();
  await waitFor(() => store.get("5").status === "completed");
});

test("web approval requires credentials and same origin; refresh and duplicate POST do not submit again", async (t) => {
  const f = await fixture(t);
  const password = "a-secret-used-only-in-a-test";
  const store = f.makeStore();
  const server = createApprovalServer({ store, password, modelLabel: "faux", reportOrigin: "http://127.0.0.1:30141" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const authorization = `Basic ${Buffer.from(`research:${password}`).toString("base64")}`;
  const get = (path) => fetch(origin + path, { headers: { authorization }, redirect: "manual" });
  const post = (body = "fast=5", headers = {}) => fetch(origin + "/approve", {
    method: "POST", headers: { authorization, origin, "content-type": "application/x-www-form-urlencoded", ...headers }, body, redirect: "manual",
  });
  assert.equal((await fetch(origin)).status, 401);
  assert.equal((await post("fast=5", { origin: "https://other.example" })).status, 403);
  assert.equal((await post("fast=5", { origin: "null" })).status, 403);
  assert.equal((await post("fast=5&fast=7")).status, 400);
  assert.equal((await post("fast=3")).status, 400);
  assert.equal(f.calls(), 0);
  const accepted = await post();
  assert.equal(accepted.status, 303);
  assert.equal(accepted.headers.get("location"), "/?fast=5");
  const pending = await get("/?fast=5");
  assert.equal(pending.headers.get("cache-control"), "no-store");
  assert.equal(pending.headers.get("referrer-policy"), "same-origin");
  assert.match(await pending.text(), /执行中/);
  assert.equal((await post()).status, 303);
  assert.equal((await get("/api/sessions")).status, 404);
  assert.equal((await get("/api/terminal")).status, 404);
  await waitFor(() => f.calls() === 1);
  f.finish();
  await waitFor(() => store.get("5").status === "completed");
  const completed = await (await get("/?fast=5")).text();
  assert.match(completed, /已完成/);
  assert.match(completed, /&lt;script&gt;alert/);
  assert.doesNotMatch(completed, /<script>/);
  assert.match(completed, new RegExp(runId));
  assert.equal(f.calls(), 1);
});
