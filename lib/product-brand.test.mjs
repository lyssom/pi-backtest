import assert from "node:assert/strict";
import test from "node:test";
import { formatProductWindowTitle } from "./product-brand.ts";

test("shows the product name with or without an active project", () => {
  assert.equal(formatProductWindowTitle(null), "Pi Backtest");
  assert.equal(formatProductWindowTitle("BTC research"), "BTC research - Pi Backtest");
});
