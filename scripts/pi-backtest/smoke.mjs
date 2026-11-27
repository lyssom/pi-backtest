import assert from "node:assert/strict";
import { chromium } from "playwright";

const origin = process.argv[2] ?? "http://127.0.0.1:30141";
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1250, height: 820 } });
  await page.goto(origin);
  await page.getByRole("link", { name: "Pi Backtest", exact: true }).click();
  await page.waitForURL("**/backtest");
  await page.getByRole("heading", { name: "规则 · BTCUSDT · 1h" }).waitFor();
  assert.equal(await page.getByRole("table").getByRole("row").count(), 7);
  await page.getByRole("link", { name: "查看第 2 笔" }).click();
  await page.waitForURL("**/backtest?trade=2#sample-chart");
  await page.getByRole("img", { name: "K 线及第 2 笔模拟成交" }).waitFor();
  assert.match(await page.getByTestId("trade-evidence").textContent(), /第 2 笔.*开仓信号.*开盘买入/);
  assert.equal(await page.getByTestId("selected-trade").count(), 1);
  await page.reload();
  await page.getByRole("img", { name: "K 线及第 2 笔模拟成交" }).waitFor();
  await page.setViewportSize({ width: 390, height: 760 });
  assert.ok(await page.evaluate(() => document.body.scrollWidth === window.innerWidth));
  console.log("Backtest browser smoke passed: sidebar entry, six trades, selection, reload and mobile overflow");
} finally {
  await browser.close();
}
