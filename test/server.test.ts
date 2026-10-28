import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { makeHandler, rateLimiter } from "../src/server.ts";
import { mockApp } from "./helpers.ts";
import { handle as mcpHandle } from "../src/mcp.ts";

async function boot(over: Record<string, string> = {}) {
  const app = mockApp(over);
  const srv = createServer(makeHandler(app)); await new Promise<void>((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const j = async (p: string, body?: any, headers: any = {}) => { const r = await fetch(base + p, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined, redirect: "manual" }); return { status: r.status, body: r.headers.get("content-type")?.includes("json") ? await r.json() : await r.text(), headers: r.headers }; };
  return { app, srv, base, j };
}

test("console, static assets and health", async (t) => {
  const { srv, j } = await boot(); t.after(() => srv.close());
  assert.match((await j("/")).body, /Approvd/);
  assert.match((await j("/app.js")).body, /api\/chat/);
  assert.deepEqual((await j("/healthz")).body, { ok: true, paypalMode: "mock" });
  assert.equal((await j("/../package.json")).status, 404);
});

test("bundled fonts are served locally as woff2 (byte-exact) and the CSP allows only self", async (t) => {
  const { srv, base, j } = await boot(); t.after(() => srv.close());
  const { readFileSync } = await import("node:fs");
  for (const f of ["fraunces-latin-var.woff2", "manrope-latin-var.woff2"]) {
    const r = await fetch(`${base}/fonts/${f}`);
    assert.equal(r.status, 200); assert.equal(r.headers.get("content-type"), "font/woff2");
    const buf = Buffer.from(await r.arrayBuffer());
    assert.equal(buf.subarray(0, 4).toString("latin1"), "wOF2");
    assert.ok(buf.equals(readFileSync(new URL(`../web/fonts/${f}`, import.meta.url))));
    assert.match(r.headers.get("content-security-policy")!, /font-src 'self'/);
  }
  assert.equal((await j("/fonts/OFL-Fraunces.txt")).status, 404);
  assert.equal((await j("/fonts/../package.json")).status, 404);
  const css = (await j("/style.css")).body as string;
  assert.doesNotMatch(css, /https?:\/\//, "no external font or asset URLs");
  assert.match(css, /url\("\/fonts\/fraunces-latin-var\.woff2"\)/);
});

test("chat -> simulated buyer approval page -> capture -> approvals API", async (t) => {
  const { srv, j } = await boot(); t.after(() => srv.close());
  const a = await j("/api/chat", { sessionId: "x", message: "Create a $45 checkout for 2 soy candles" });
  const orderId = a.body.state.refs.lastOrderId;
  assert.match((await j(`/mock/checkout/${orderId}`)).body, /SIMULATED BUYER APPROVAL/);
  const ap = await j(`/mock/checkout/${orderId}/approve`, {});
  assert.equal(ap.status, 303); assert.equal(ap.headers.get("location"), `/return?token=${orderId}`);
  assert.match((await j(`/return?token=${orderId}`)).body, /capture it/);
  const c = await j("/api/chat", { sessionId: "x", message: "capture it" });
  assert.equal(c.body.steps[0].status, "executed");
  const p = await j("/api/chat", { sessionId: "x", message: "Send $70 to a@example.com" });
  const id = p.body.steps[0].approvalId;
  assert.equal(p.body.state.approvals[0].id, id);
  const ok = await j(`/api/approvals/${id}/approve`, {});
  assert.equal(ok.body.outcome.status, "approved"); assert.equal(ok.body.state.approvals.length, 0);
  assert.equal((await j("/api/chat", { sessionId: "x", message: "" })).status, 400);
  const reset = await j("/api/reset", {});
  assert.equal(reset.body.ledger.length, 0);
});

test("demo passcode protects the API but not the page", async (t) => {
  const { srv, j } = await boot({ DEMO_PASSCODE: "judge-2026" }); t.after(() => srv.close());
  assert.equal((await j("/api/state")).status, 401);
  assert.equal((await j("/api/state", undefined, { "x-demo-passcode": "judge-2026" })).status, 200);
  assert.equal((await j("/")).status, 200);
});

test("MCP bridge: initialize, tools/list and guarded tools/call through the server", async (t) => {
  const { srv, base } = await boot(); t.after(() => srv.close());
  process.env.APPROVD_URL = base;
  const init = await mcpHandle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  assert.equal(init.result.serverInfo.name, "approvd");
  const list = await mcpHandle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.ok(list.result.tools.some((x: any) => x.name === "create_payout" && x.inputSchema.type === "object"));
  const f = fetch;
  const big = await mcpHandle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "create_payout", arguments: { items: [{ receiver: "x@gmail.com", amount: 10 }] } } }, f);
  assert.match(big.result.content[0].text, /Queued for human approval/);
  const denied = await mcpHandle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "create_payout", arguments: { items: [{ receiver: "x@example.com", amount: 5000 }] } } }, f);
  assert.equal(denied.result.isError, true);
  assert.equal((await mcpHandle({ jsonrpc: "2.0", id: 5, method: "nope" })).error.code, -32601);
});

test("rate limiter allows N per minute per key", () => {
  const ok = rateLimiter(2);
  assert.deepEqual([ok("a", 0), ok("a", 1), ok("a", 2), ok("b", 2), ok("a", 61_000)], [true, true, false, true, true]);
});
