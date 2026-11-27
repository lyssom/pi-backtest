import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const statuses = { running: "执行中", completed: "已完成", failed: "未完成", interrupted: "已中断" };
const escape = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const digest = (value) => createHash("sha256").update(value).digest();

function page({ store, selected, modelLabel, reportOrigin }) {
  const recent = store.list();
  const receipt = store.get(selected);
  const options = store.periods.map((fast) => `<option${fast === selected ? " selected" : ""}>${fast}</option>`).join("");
  const entries = recent.map(({ fast, status }) => `<li><a href="/?fast=${fast}">EMA ${fast} · ${statuses[status]}</a></li>`).join("");
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${receipt?.status === "running" ? '<meta http-equiv="refresh" content="2">' : ""}<title>Pi Backtest · 研究审批</title>
<style>html{font:1rem/1.55 system-ui,sans-serif;color-scheme:light dark}body{max-width:48rem;margin:2rem auto;padding:0 1rem}section{border:1px solid #8888;border-radius:.75rem;padding:1rem;margin:1rem 0}h2{margin-top:0}code{overflow-wrap:anywhere}select,button{font:inherit;padding:.45rem .65rem}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style></head>
<body><main><h1>Pi Backtest · 研究审批</h1><p>B0 <code>${escape(store.baselineRunId)}</code></p>
<section><h2>批准一次试跑</h2><p>模型 ${escape(modelLabel)} 将读取 B0、试跑并解释差异。只改 EMA 快线，不替换 B0；公开行情衍生的成交证据会发给该模型提供商。</p>
<form method="post" action="/approve"><label>EMA 快线周期 <select name="fast">${options}</select></label> <button type="submit">批准并运行</button></form></section>
<section><h2>本基线的审批记录</h2>${entries ? `<ul>${entries}</ul>` : "<p>尚无回执。</p>"}</section>
${receipt ? `<section><h2>EMA ${receipt.fast} · ${statuses[receipt.status]}</h2>
<p>批准时间：${escape(receipt.approvedAt)}</p>
${receipt.status === "running" ? "<p>页面每两秒查询一次；关闭页面不会取消任务。</p>" : ""}
${receipt.status === "failed" || receipt.status === "interrupted" ? "<p>Pi 未生成完整说明。不会自动重跑，B0 没有变更。</p>" : ""}
${receipt.runId ? `<p>试跑运行 ID：<code>${escape(receipt.runId)}</code></p><p><a rel="noreferrer" href="${escape(reportOrigin)}/backtest?fast=${receipt.fast}#baseline-comparison">查看回测对照</a></p>` : ""}
${receipt.completedTools ? `<p>工具：${escape(receipt.completedTools.join(" → "))}</p>` : ""}
${receipt.answer ? `<h3>Pi 的说明</h3><pre>${escape(receipt.answer)}</pre>` : ""}</section>` : ""}
</main></body></html>`;
}

export function createApprovalServer({ store, password, reportOrigin, modelLabel }) {
  const report = new URL(reportOrigin);
  if (report.origin !== reportOrigin || !["http:", "https:"].includes(report.protocol)) throw new Error("Use a report origin without a path.");
  if (typeof password !== "string" || password.length < 24) throw new Error("A dedicated random research password is required.");
  const credentialHash = digest(`Basic ${Buffer.from(`research:${password}`).toString("base64")}`);
  const server = createServer({ requestTimeout: 5000, headersTimeout: 3000, maxHeaderSize: 4096 }, async (req, res) => {
    const send = (status, body = "", headers = {}) => {
      res.writeHead(status, {
        // Chromium sends Origin: null for form POSTs under no-referrer. Same-origin still hides external referrers.
        "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
        "Content-Type": "text/plain; charset=utf-8", ...headers,
      });
      res.end(body);
    };
    try {
      const host = `127.0.0.1:${server.address().port}`;
      const origin = `http://${host}`;
      if (req.headers.host !== host) return send(403, "Use the loopback address.");
      if (!timingSafeEqual(digest(req.headers.authorization ?? ""), credentialHash)) {
        return send(401, "Research login required.", { "WWW-Authenticate": 'Basic realm="Pi Backtest Research", charset="UTF-8"' });
      }
      if (!req.url?.startsWith("/") || req.url.startsWith("//")) return send(400);
      const url = new URL(req.url, origin);
      if (url.origin !== origin) return send(400);
      if (req.method === "GET" && url.pathname === "/") {
        const values = url.searchParams.getAll("fast");
        if (values.length > 1 || (values.length === 1 && !store.periods.includes(values[0]))) return send(400, "请选择允许的快线周期。");
        const selected = values[0] ?? (store.periods.includes("5") ? "5" : store.periods[0]);
        return send(200, page({ store, selected, modelLabel, reportOrigin }), { "Content-Type": "text/html; charset=utf-8" });
      }
      if (req.method !== "POST" || req.url !== "/approve") return send(404);
      if (req.headers.origin !== origin) return send(403, "Approval requires a same-origin form.");
      const size = Number(req.headers["content-length"]);
      if (req.headers["content-type"] !== "application/x-www-form-urlencoded" || !Number.isSafeInteger(size) || size < 1 || size > 64) return send(400);
      req.setTimeout(5000, () => req.destroy());
      let body = "";
      for await (const chunk of req) body += chunk;
      const fast = /^fast=([1-7])$/.exec(body)?.[1];
      const approval = fast ? store.approve(fast) : "invalid";
      if (approval === "invalid") return send(400, "请选择允许且不同于 B0 的快线周期。");
      if (approval === "busy") return send(409, "已有一项试跑在执行。请返回审批页查看回执。");
      return send(303, "", { Location: `/?fast=${fast}` });
    } catch {
      if (!res.headersSent && !res.destroyed) send(503, "暂时无法读取或保存审批回执。请稍后查看审批页。");
    }
  });
  return server;
}