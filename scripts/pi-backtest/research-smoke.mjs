import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { chromium } from "playwright";

const { values } = parseArgs({ options: { origin: { type: "string" }, "password-file": { type: "string" },
  "approve-fast": { type: "string" }, "staging-cert": { type: "boolean" } } });
const origin = new URL(values.origin);
const fast = values["approve-fast"];
if (origin.protocol !== "https:" || !values["password-file"] || !/^[124567]$/.test(fast ?? "")) {
  throw new Error("Requires --origin=https://... --password-file=... --approve-fast=6. This submits one real approval if the receipt is new.");
}
if (values["staging-cert"] && origin.hostname !== "127.0.0.1") throw new Error("The staging certificate exception is loopback only.");
const password = (await readFile(values["password-file"], "utf8")).trim();
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ ignoreHTTPSErrors: values["staging-cert"] });
  let page = await context.newPage();
  const approvals = new URL("/api/backtest/approvals", origin).href;
  let sends = 0;
  context.on("request", (request) => { if (request.url() === approvals && request.method() === "POST") sends++; });
  const status = await context.request.get(approvals);
  assert.equal(status.status(), 401);
  await page.goto(new URL("/backtest", origin).href);
  await page.getByLabel("EMA 快线周期").selectOption(fast);
  await page.getByRole("button", { name: "批准 Pi 试跑" }).click();
  await page.getByLabel("研究密码").fill(password);
  await page.getByRole("button", { name: "登录研究" }).click();
  await page.getByRole("heading", { name: "Pi 审批记录" }).waitFor();
  assert.equal(await page.getByLabel("EMA 快线周期").inputValue(), fast);
  assert.equal(sends, 0, "Login must not approve a trial");
  const session = (await context.cookies()).find((cookie) => cookie.name === "__Host-pi_backtest_research");
  assert.ok(session?.secure && session.httpOnly && session.sameSite === "Lax");
  assert.equal((await context.request.post(approvals, { headers: { origin: "null" }, data: { fast } })).status(), 403);
  await page.getByRole("button", { name: "批准 Pi 试跑" }).click();
  await page.waitForURL((url) => url.searchParams.has("approval") && url.pathname === "/backtest");
  const receiptUrl = page.url();
  await page.close();
  page = await context.newPage();
  await page.goto(receiptUrl);
  await page.getByRole("heading", { name: `Pi 试跑 · EMA ${fast} · 已完成` }).waitFor({ timeout: 75_000 });
  await page.getByRole("heading", { name: "Pi 的说明" }).waitFor();
  await page.getByText("工具：read_baseline → run_approved_trial → inspect_trial").waitFor();
  await page.getByRole("link", { name: "查看同数据对照" }).click();
  await page.getByRole("region", { name: "同数据对照 · B0 / Pi 试跑" }).getByText(`只改 EMA 快线：3 → ${fast}。`, { exact: false }).waitFor();
  const approvalId = new URL(receiptUrl).searchParams.get("approval");
  await page.getByRole("link", { name: "查看第 2 笔" }).click();
  await page.waitForURL((url) => url.searchParams.get("approval") === approvalId && url.searchParams.get("trade") === "2");
  await page.reload();
  await page.getByRole("heading", { name: "Pi 的说明" }).waitFor();
  await page.getByRole("img", { name: "K 线及第 2 笔模拟成交" }).waitFor();
  await page.setViewportSize({ width: 390, height: 760 });
  assert.ok(await page.evaluate(() => document.body.scrollWidth === window.innerWidth));
  assert.equal(sends, 1, "Reopen, poll and trade links must not resubmit");
  console.log(`Same-page research: one approval, close/reopen, explanation, comparison and deep link for ${approvalId}`);
} finally { await browser.close(); }
