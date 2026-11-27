import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { chromium } from "playwright";

const { values } = parseArgs({ options: { origin: { type: "string" }, "password-file": { type: "string" },
  "approve-fast": { type: "string" }, "staging-cert": { type: "boolean" } } });
const origin = new URL(values.origin);
const fast = values["approve-fast"];
if (origin.protocol !== "https:" || !values["password-file"] || !/^[124567]$/.test(fast ?? "")) {
  throw new Error("Requires --origin=https://... --password-file=... --approve-fast=7. This can approve one real trial.");
}
if (values["staging-cert"] && origin.hostname !== "127.0.0.1") throw new Error("The staging certificate exception is loopback only.");
const password = (await readFile(values["password-file"], "utf8")).trim();
const browser = await chromium.launch({ headless: true });
const chatPath = "/api/backtest/research-chat";
try {
  const context = await browser.newContext({ locale: "en-US", ignoreHTTPSErrors: values["staging-cert"] });
  let page = await context.newPage();
  let prompts = 0;
  let approvals = 0;
  context.on("request", (req) => {
    const url = new URL(req.url());
    if (req.method() !== "POST") return;
    if (url.pathname === `${chatPath}/message`) prompts++;
    if (url.pathname === `${chatPath}/decision`) approvals++;
  });
  const state = async () => (await (await context.request.get(new URL(chatPath, origin).href)).json()).chat;
  const send = async (text) => {
    await page.getByLabel("研究消息输入").fill(text);
    await page.getByRole("button", { name: /^(Send|发送)$/ }).click();
  };

  assert.equal((await context.request.get(new URL(chatPath, origin).href)).status(), 401);
  await page.goto(origin.href);
  await page.waitForURL((url) => url.pathname === "/research");
  await page.getByRole("heading", { name: "研究对话", exact: true }).waitFor();
  await page.getByLabel("研究密码").fill(password);
  await page.getByRole("button", { name: "登录研究" }).click();
  await page.getByLabel("研究消息输入").waitFor();
  const prior = await state();
  if (prior) {
    if (prior.phase !== "idle") throw new Error("Wait for the existing research session to settle before running this smoke test.");
    await page.getByRole("button", { name: "新研究对话" }).click();
    await page.getByRole("button", { name: "新研究对话" }).waitFor({ state: "hidden" });
  }
  await send(`以 B0 为基线，把 EMA 快线改成 ${fast}，看看少了哪几笔。`);
  await page.getByRole("button", { name: "批准这次试跑" }).waitFor({ timeout: 45_000 });
  const before = await state();
  assert.equal(before.phase, "approval");
  const card = before.entries.find((entry) => entry.kind === "approval");
  assert.equal(card.fast, Number(fast));
  assert.equal(before.entries.some((entry) => entry.kind === "result"), false);
  assert.equal(prompts, 1);
  await page.reload();
  await page.getByRole("button", { name: "批准这次试跑" }).click();
  await page.getByRole("heading", { name: "B0 审批 · 已批准" }).waitFor();
  await page.close();
  page = await context.newPage();
  await page.goto(new URL("/research", origin).href);
  const evidence = page.getByRole("link", { name: "查看回测对照和逐笔证据" });
  await evidence.waitFor({ timeout: 75_000 });
  const after = await state();
  assert.equal(after.sessionId, before.sessionId);
  assert.equal(after.phase, "idle");
  assert.equal(after.entries.filter((entry) => entry.kind === "message" && entry.message.role === "user").length, 1);
  assert.ok(after.entries.some((entry) => entry.kind === "message" && entry.message.role === "assistant"));
  const result = after.entries.find((entry) => entry.kind === "result");
  assert.ok(result?.runId);
  assert.equal(prompts, 1);
  assert.equal(approvals, 1);
  const detail = await context.request.get(new URL(`/api/backtest/approvals/${result.approvalId}`, origin).href);
  assert.equal((await detail.json()).status, "completed");
  await evidence.click();
  await page.getByRole("region", { name: "同数据对照 · B0 / Pi 试跑" }).getByText(`只改 EMA 快线：3 → ${fast}。`, { exact: false }).waitFor();
  await page.getByRole("link", { name: "返回研究对话" }).click();
  await evidence.waitFor();
  await send("沿用刚才的结果。只告诉我本次试跑的快线周期数字，不要再跑。");
  await page.waitForFunction(async ({ chatPath, old, fast }) => {
    const reply = (await (await fetch(chatPath, { cache: "no-store" })).json()).chat;
    const rows = reply?.entries.slice(old) ?? [];
    return reply?.phase === "idle" && rows.some((row) => row.kind === "message" && row.message.role === "assistant" && JSON.stringify(row.message.content).includes(fast));
  }, { chatPath, old: after.entries.length, fast }, { timeout: 45_000 });
  assert.equal((await state()).sessionId, before.sessionId);
  assert.equal(prompts, 2);
  assert.equal(approvals, 1);
  console.log(`Pi Web chat: one prompt and one approval, same session across reconnect, result and follow-up; report ${result.runId}.`);
} finally { await browser.close(); }
