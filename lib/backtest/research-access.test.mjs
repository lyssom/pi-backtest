import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { createWebSessionToken, isValidWebSessionToken } from "../web-auth.ts";

const { getResearchAccess, isResearchRequest, issueResearchSession, hasResearchSession, parseApprovalId, readSmallJson } = await createJiti(import.meta.url).import("./research-access.ts");
const password = "a-long-password-for-tests-only";
const origin = "https://research.example:3443";
const env = { PI_BACKTEST_RESEARCH_ORIGIN: origin, PI_BACKTEST_RESEARCH_PASSWORD: password, PI_BACKTEST_WORKER_TOKEN: "a-separate-token-for-tests-only" };
const access = getResearchAccess(env);
const headers = new Headers({ host: "research.example:3443", "x-forwarded-proto": "https", origin });

test("research stays disabled without exact HTTPS and distinct credentials", () => {
  assert.ok(access);
  assert.equal(getResearchAccess({ ...env, PI_BACKTEST_RESEARCH_ORIGIN: "http://research.example:3443" }), null);
  assert.equal(getResearchAccess({ ...env, PI_BACKTEST_WORKER_TOKEN: password }), null);
  assert.equal(getResearchAccess({ ...env, PI_WEB_PASSWORD: password }), null);
  assert.equal(isResearchRequest(headers, access, true), true);
  for (const [name, value] of [["origin", "null"], ["origin", "https://other.example"], ["host", "other.example"], ["x-forwarded-proto", "http"], ["x-forwarded-proto", "https,http"]]) {
    const changed = new Headers(headers);
    changed.set(name, value);
    assert.equal(isResearchRequest(changed, access, true), false, name);
  }
  headers.delete("origin");
  assert.equal(isResearchRequest(headers, access, true), false);
  assert.equal(isResearchRequest(headers, access), true);
});

test("research cookies cannot be used as regular Pi Web cookies", () => {
  const cookie = issueResearchSession(access);
  assert.equal(hasResearchSession(cookie, access), true);
  assert.equal(isValidWebSessionToken(cookie, password), false);
  assert.equal(hasResearchSession(createWebSessionToken(password), access), false);
  assert.equal(hasResearchSession(`${cookie}x`, access), false);
  assert.equal(hasResearchSession(issueResearchSession(access, 0), access, 8 * 3600 * 1000), false);
});

test("limits approval IDs and request bytes, including request streams without a declared size", async () => {
  const id = "a".repeat(64) + "-5";
  assert.deepEqual(parseApprovalId(id), { baselineRunId: "a".repeat(64), fast: "5" });
  assert.equal(parseApprovalId("../baseline.json"), null);
  assert.equal(parseApprovalId(`${id}\n`), null);
  const request = (body) => new Request(origin, { method: "POST", body, headers: { "content-type": "application/json" } });
  assert.deepEqual(await readSmallJson(request('{"fast":"5"}')), { fast: "5" });
  assert.equal(await readSmallJson(request(JSON.stringify({ extra: "x".repeat(1024) }))), null);
});
