import assert from "node:assert/strict";
import { chromium } from "playwright";

const origin = process.argv[2] ?? "http://127.0.0.1:30141";
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1250, height: 820 } });
  if (process.argv.includes("--direct")) {
    await page.goto(new URL("/backtest", origin).href);
  } else {
    await page.goto(origin);
    await page.getByRole("link", { name: "Pi Backtest", exact: true }).click();
    await page.waitForURL("**/backtest");
  }
  await page.getByRole("heading", { name: "规则 · BTCUSDT · 1h" }).waitFor();
  assert.equal(await page.getByRole("table", { name: "报告逐笔成交" }).getByRole("row").count(), 7);
  if (process.argv.includes("--baseline")) {
    await page.getByRole("heading", { name: "冻结基线 · B0" }).waitFor();
    await page.getByRole("link", { name: "查看 B0 / A1 同数据对照" }).click();
    assert.equal(await page.getByRole("table", { name: "差异交易" }).getByRole("row").count(), 5);
    const comparison = page.getByRole("region", { name: "同数据对照 · B0 / A1" });
    assert.match(await comparison.textContent(), /4 笔未变.*B0 独有 2 笔、A1 独有 2 笔/);
    await page.getByText("复现信息", { exact: true }).click();
    await page.getByText("95a8a3832195", { exact: false }).waitFor();
  }
  await page.getByRole("link", { name: "查看第 2 笔" }).click();
  await page.waitForURL("**/backtest?trade=2#sample-chart");
  await page.getByRole("img", { name: "K 线及第 2 笔模拟成交" }).waitFor();
  assert.match(await page.getByTestId("trade-evidence").textContent(), /第 2 笔.*开仓信号.*开盘买入/);
  assert.equal(await page.getByTestId("selected-trade").count(), 1);
  await page.reload();
  await page.getByRole("img", { name: "K 线及第 2 笔模拟成交" }).waitFor();
  await page.setViewportSize({ width: 390, height: 760 });
  assert.ok(await page.evaluate(() => document.body.scrollWidth === window.innerWidth));
  console.log("Backtest browser smoke passed: report, six trades, selection, reload and mobile overflow");
} finally {
  await browser.close();
}
