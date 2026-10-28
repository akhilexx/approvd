// Hosted-demo protections on the HTTP layer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { makeHandler, passcodeOk } from "../src/server.ts";
import { mockApp } from "./helpers.ts";

async function boot(over: Record<string, string> = {}) {
  const app = mockApp(over);
  const srv = createServer(makeHandler(app)); await new Promise<void>((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const req = async (p: string, init: { method?: string; body?: any; raw?: string; headers?: Record<string, string> } = {}) => {
    const r = await fetch(base + p, { method: init.method ?? (init.body !== undefined || init.raw ? "POST" : "GET"), headers: { "Content-Type": "application/json", ...(init.headers ?? {}) }, body: init.raw ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined) });
    const text = await r.text(); let body: any = text; try { body = JSON.parse(text); } catch {}
    return { status: r.status, body, headers: r.headers };
  };
  return { app, srv, base, req };
}

test("security headers on pages and API", async (t) => {
  const { srv, req } = await boot(); t.after(() => srv.close());
  for (const p of ["/", "/api/state", "/healthz", "/nope"]) {
    const h = (await req(p)).headers;
    assert.match(h.get("content-security-policy")!, /default-src 'self'.*frame-ancestors 'none'/);
    assert.equal(h.get("x-frame-options"), "DENY"); assert.equal(h.get("x-content-type-options"), "nosniff");
    assert.equal(h.get("referrer-policy"), "no-referrer"); assert.match(h.get("permissions-policy")!, /camera=\(\)/);
    assert.equal(h.get("cache-control"), "no-store"); assert.equal(h.get("access-control-allow-origin"), null);
  }
});

test("CORS is locked: foreign-origin POSTs refused, only CORS_ORIGIN gets CORS headers", async (t) => {
  const { srv, req } = await boot({ CORS_ORIGIN: "https://approvd.example.org" }); t.after(() => srv.close());
  const evil = await req("/api/chat", { body: { message: "Create a $45 checkout" }, headers: { Origin: "https://evil.test" } });
  assert.equal(evil.status, 403); assert.equal(evil.headers.get("access-control-allow-origin"), null);
  assert.equal((await req("/api/chat", { method: "OPTIONS", headers: { Origin: "https://evil.test" } })).status, 403);
  const pre = await req("/api/chat", { method: "OPTIONS", headers: { Origin: "https://approvd.example.org" } });
  assert.equal(pre.status, 204); assert.equal(pre.headers.get("access-control-allow-origin"), "https://approvd.example.org");
  const ok = await req("/api/chat", { body: { message: "Create a $45 checkout" }, headers: { Origin: "https://approvd.example.org" } });
  assert.equal(ok.status, 200); assert.equal(ok.headers.get("access-control-allow-origin"), "https://approvd.example.org");
  const same = await req("/api/chat", { body: { message: "hi" } }); assert.equal(same.status, 200, "same-origin / non-browser clients still work");
});

test("max input size and max body size", async (t) => {
  const { srv, req } = await boot({ MAX_INPUT_CHARS: "50", MAX_BODY_BYTES: "2000" }); t.after(() => srv.close());
  const long = await req("/api/chat", { body: { message: "x".repeat(51) } });
  assert.equal(long.status, 413); assert.match(long.body.error, /max 50 characters/);
  assert.equal((await req("/api/chat", { raw: JSON.stringify({ message: "hi", pad: "y".repeat(3000) }) })).status, 413);
  assert.equal((await req("/api/chat", { raw: "{not json" })).status, 400);
  assert.equal((await req("/api/chat", { body: { message: "x".repeat(50) } })).status, 200);
});

test("per-IP rate limit and global daily request cap", async (t) => {
  const a = await boot({ RATE_LIMIT_PER_MIN: "3" }); t.after(() => a.srv.close());
  const codes = []; for (let i = 0; i < 4; i++) codes.push((await a.req("/api/chat", { body: { message: "hi" } })).status);
  assert.deepEqual(codes, [200, 200, 200, 429]);
  const b = await boot({ DAILY_REQUEST_CAP: "2", RATE_LIMIT_PER_MIN: "100" }); t.after(() => b.srv.close());
  await b.req("/api/chat", { body: { message: "hi" } }); await b.req("/api/chat", { body: { message: "hi" } });
  const capped = await b.req("/api/chat", { body: { message: "hi" } });
  assert.equal(capped.status, 429); assert.match(capped.body.error, /daily request cap/);
  assert.equal((await b.req("/api/state")).status, 200, "reads still work");
});

test("demo passcode (constant-time compare)", async (t) => {
  const { srv, req } = await boot({ DEMO_PASSCODE: "open-sesame" }); t.after(() => srv.close());
  assert.equal((await req("/api/state")).status, 401);
  assert.equal((await req("/api/state", { headers: { "X-Demo-Passcode": "open-sesam" } })).status, 401);
  assert.equal((await req("/api/state", { headers: { "X-Demo-Passcode": "open-sesame" } })).status, 200);
  assert.equal((await req("/")).status, 200, "the page itself loads so it can ask for the passcode");
  assert.equal(passcodeOk(undefined, "x"), false); assert.equal(passcodeOk("anything", ""), true);
});

test("session turn cap over HTTP, and /api/reset does not clear the LLM spend counters", async (t) => {
  const { srv, req, app } = await boot({ SESSION_TURN_CAP: "1" }); t.after(() => srv.close());
  await req("/api/chat", { body: { sessionId: "a", message: "hi" } });
  const r = await req("/api/chat", { body: { sessionId: "a", message: "hi" } });
  assert.match(r.body.reply, /1-message limit/);
  const guard = app.guard; guard.recordCall(); guard.recordTokens(500);
  const st = await req("/api/reset", { body: {} });
  assert.equal(st.body.limits.llm.callsToday, 1); assert.equal(st.body.limits.llm.tokensToday, 500);
});

test("request logs carry no message text, prompts, passcodes or keys; 500s don't leak internals", async (t) => {
  const { srv, req, app } = await boot({ DEMO_PASSCODE: "pc-secret-123" }); t.after(() => srv.close());
  const lines: string[] = []; const orig = console.log; const origErr = console.error;
  console.log = (...a: any[]) => { lines.push(a.join(" ")); }; console.error = (...a: any[]) => { lines.push(a.join(" ")); };
  const prevEnv = process.env.NODE_ENV; process.env.NODE_ENV = "production";
  try {
    await req("/api/chat", { body: { message: "Create a $45 checkout for SECRET-CANARY-TEXT" }, headers: { "X-Demo-Passcode": "pc-secret-123" } });
    app.agent.chat = async () => { throw new Error("boom with internal detail /etc/secret"); };
    const r = await req("/api/chat", { body: { message: "SECRET-CANARY-2" }, headers: { "X-Demo-Passcode": "pc-secret-123" } });
    assert.equal(r.status, 500); assert.deepEqual(r.body, { error: "Internal error." });
  } finally { console.log = orig; console.error = origErr; process.env.NODE_ENV = prevEnv; }
  const all = lines.join("\n");
  assert.ok(lines.some((l) => /"path":"\/api\/chat","code":200/.test(l)), all);
  assert.doesNotMatch(all, /SECRET-CANARY|pc-secret-123|soy|checkout for/);
});

test("rate limit keys on the trusted edge header only; spoofed X-Forwarded-For is ignored", async (t) => {
  const a = await boot({ RATE_LIMIT_PER_MIN: "2" }); t.after(() => a.srv.close());
  const codes = []; for (let i = 0; i < 3; i++) codes.push((await a.req("/api/chat", { body: { message: "hi" }, headers: { "X-Forwarded-For": `10.0.0.${i}` } })).status);
  assert.deepEqual(codes, [200, 200, 429], "rotating X-Forwarded-For does not reset the limit");
  const b = await boot({ RATE_LIMIT_PER_MIN: "1", CLIENT_IP_HEADER: "True-Client-IP" }); t.after(() => b.srv.close());
  assert.equal((await b.req("/api/chat", { body: { message: "hi" }, headers: { "True-Client-IP": "203.0.113.1" } })).status, 200);
  assert.equal((await b.req("/api/chat", { body: { message: "hi" }, headers: { "True-Client-IP": "203.0.113.1" } })).status, 429);
  assert.equal((await b.req("/api/chat", { body: { message: "hi" }, headers: { "True-Client-IP": "203.0.113.2" } })).status, 200);
});

test("UI_PLANNER_LABEL overrides only the console badge text", async (t) => {
  const { srv, req, app } = await boot({ UI_PLANNER_LABEL: "gpt-6.1-sol" }); t.after(() => srv.close());
  assert.equal((await req("/api/state")).body.planner, "gpt-6.1-sol");
  assert.notEqual(app.agent.planner.name, "gpt-6.1-sol");
});
