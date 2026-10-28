// HTTP server: web console, JSON API, guarded tool endpoint (used by the MCP bridge) and,
// in mock mode, a simulated PayPal buyer-approval page.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createApp, type App } from "./app.ts";
import { MockPayPal } from "./paypal/mock.ts";
import { describePolicy } from "./policy.ts";
import { TOOL_SPECS } from "./tools.ts";
import { DailyCounter } from "./guard.ts";
import { timingSafeEqual, createHash } from "node:crypto";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..", "web");
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
};
function sendRaw(res: ServerResponse, code: number, body: unknown, type = "application/json", extra: Record<string, string> = {}) {
  res.writeHead(code, { ...SECURITY_HEADERS, ...extra, "Content-Type": type, "Cache-Control": "no-store" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}
class HttpError extends Error { code: number; constructor(code: number, msg: string) { super(msg); this.code = code; } }
async function readJson(req: IncomingMessage, maxBytes: number): Promise<any> {
  if (Number(req.headers["content-length"] ?? 0) > maxBytes) throw new HttpError(413, "Request body too large.");
  let raw = ""; for await (const ch of req) { raw += ch; if (Buffer.byteLength(raw) > maxBytes) throw new HttpError(413, "Request body too large."); }
  try { return raw ? JSON.parse(raw) : {}; } catch { throw new HttpError(400, "Invalid JSON."); }
}
/** Constant-time passcode check (hash first so lengths always match). */
export function passcodeOk(given: unknown, expected: string): boolean {
  if (!expected) return true;
  if (typeof given !== "string") return false;
  const h = (v: string) => createHash("sha256").update(v).digest();
  return timingSafeEqual(h(given), h(expected));
}
/** Log line for an API request: method, path, status, duration, IP hash. Never message text, prompts, headers or secrets. */
function logLine(method: string, path: string, code: number, ms: number, ip: string) {
  if (process.env.NODE_ENV === "test" || process.env.LOG_REQUESTS === "0") return;
  console.log(JSON.stringify({ t: new Date().toISOString(), method, path: path.replace(/(apr_|ord_)[\w-]+/g, "$1…"), code, ms, ip: createHash("sha256").update(ip).digest("hex").slice(0, 10) }));
}
const page = (title: string, inner: string) => `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>${esc(title)}</title><link rel=stylesheet href=/style.css><main class="narrow card">${inner}</main>`;

// Tiny fixed-window rate limit for the hosted demo so a public URL can't burn the LLM key.
export function rateLimiter(limit = Number(process.env.RATE_LIMIT_PER_MIN ?? 30)) {
  const hits = new Map<string, { n: number; t: number }>();
  return (key: string, now = Date.now()) => {
    if (hits.size > 10_000) for (const [k, v] of hits) if (now - v.t > 60_000) hits.delete(k); // bound memory
    const h = hits.get(key);
    if (!h || now - h.t > 60_000) { hits.set(key, { n: 1, t: now }); return true; }
    h.n++; return h.n <= limit;
  };
}

export function makeHandler(app: App) {
  const lim = app.cfg.limits;
  const allow = rateLimiter(lim.rateLimitPerMin);
  const daily = new DailyCounter(lim.dailyRequestCap);
  const corsOrigin = lim.corsOrigin;
  let { engine, agent } = app;
  const state = () => ({
    paypalMode: app.gw.mode, planner: app.cfg.uiPlannerLabel || agent.planner.name, currency: app.cfg.currency,
    limits: { maxInputChars: lim.maxInputChars, sessionTurnCap: lim.sessionTurnCap, rateLimitPerMin: lim.rateLimitPerMin, llm: app.guard.status() },
    policy: { ...app.cfg.policy, text: describePolicy(app.cfg.policy) },
    outflowLast24h: engine.outflowLast24h(), refs: engine.refs,
    approvals: [...engine.approvals.values()].filter((a) => a.status === "pending").reverse(),
    ledger: engine.ledger.slice(0, 100),
  });

  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://x");
    const p = url.pathname;
    const t0 = Date.now();
    // Client IP for rate limiting: only a header the trusted edge overwrites (Render/Cloudflare: true-client-ip).
    // X-Forwarded-For is never trusted because Render appends to it and clients can spoof the first entry.
    const hdr = lim.clientIpHeader ? req.headers[lim.clientIpHeader] : undefined;
    const ip = String((Array.isArray(hdr) ? hdr[0] : hdr) || req.socket.remoteAddress || "?").trim().slice(0, 64);
    const origin = req.headers.origin;
    // CORS: same-origin by default. Only CORS_ORIGIN (exact match) gets CORS headers; other cross-site browsers are refused.
    const cors: Record<string, string> = corsOrigin && origin === corsOrigin ? { "Access-Control-Allow-Origin": corsOrigin, "Vary": "Origin", "Access-Control-Allow-Headers": "Content-Type, X-Demo-Passcode", "Access-Control-Allow-Methods": "GET, POST", "Access-Control-Max-Age": "600" } : { "Vary": "Origin" };
    const send = (r: ServerResponse, code: number, body: unknown, type?: string) => sendRaw(r, code, body, type, cors);
    const host = String(req.headers.host ?? "");
    const sameOrigin = !origin || origin === `https://${host}` || origin === `http://${host}`;
    const reply = (code: number, body: unknown, type?: string) => { if (p.startsWith("/api/")) logLine(req.method ?? "?", p, code, Date.now() - t0, ip); return send(res, code, body, type); };
    try {
      if (req.method === "OPTIONS") return corsOrigin && origin === corsOrigin ? reply(204, "", "text/plain") : reply(403, { error: "CORS origin not allowed" });
      if (req.method === "POST" && !sameOrigin && origin !== corsOrigin) return reply(403, { error: "Cross-origin request refused." });
      if ((req.method === "GET" || req.method === "HEAD") && (p === "/" || /^\/[\w-]+\.(js|css|svg)$/.test(p))) {
        const file = p === "/" ? "index.html" : p.slice(1);
        return send(res, 200, readFileSync(join(WEB, file), "utf8"), TYPES[file.slice(file.lastIndexOf("."))]);
      }
      if (p === "/healthz") return send(res, 200, { ok: true, paypalMode: app.gw.mode });

      // Simulated PayPal approval page (mock mode only). In sandbox mode the buyer goes to sandbox.paypal.com instead.
      const mc = p.match(/^\/mock\/checkout\/([A-Z0-9]+)(\/approve)?$/);
      if (mc && app.gw instanceof MockPayPal) {
        const order = app.gw.orders.get(mc[1]);
        if (!order) return send(res, 404, page("Not found", "<h2>Order not found</h2>"), TYPES[".html"]);
        if (mc[2] && req.method === "POST") { app.gw.approve(order.id); res.writeHead(303, { Location: `/return?token=${order.id}` }); return res.end(); }
        return send(res, 200, page("Simulated checkout", `<p class=tag>SIMULATED BUYER APPROVAL · mock mode, no real money</p><h2>Pay ${esc(order.amount.value)} ${esc(order.amount.currency)}</h2><p>${esc(order.description)}</p><p class=muted>Order ${esc(order.id)} · status ${esc(order.status)}</p><form method=post action="/mock/checkout/${order.id}/approve"><button class=primary>Approve payment as sandbox buyer</button></form><p><a href="/cancel?token=${order.id}">Cancel</a></p>`), TYPES[".html"]);
      }
      if (p === "/return") return send(res, 200, page("Approved", `<h2>Payment approved ✅</h2><p>Order <code>${esc(url.searchParams.get("token") ?? "")}</code> is approved by the buyer.</p><p>Go back to the Approvd console and say <b>“capture it”</b>.</p><p><a href="/">Open console</a></p>`), TYPES[".html"]);
      if (p === "/cancel") return send(res, 200, page("Cancelled", `<h2>Checkout cancelled</h2><p><a href="/">Back to console</a></p>`), TYPES[".html"]);

      if (p.startsWith("/api/")) {
        if (!passcodeOk(req.headers["x-demo-passcode"], app.cfg.demoPasscode)) return reply(401, { error: "passcode required" });
        if (req.method === "GET" && p === "/api/state") return send(res, 200, state());
        if (req.method === "GET" && p === "/api/tools") return send(res, 200, TOOL_SPECS);
        if (req.method === "POST" && !allow(ip)) { res.setHeader("Retry-After", "60"); return reply(429, { error: "Too many requests, wait a minute." }); }
        if (req.method === "POST" && !daily.hit()) return reply(429, { error: "The hosted demo reached its daily request cap. Please try again tomorrow, or run it locally (npm start)." });
        if (req.method === "POST" && p === "/api/chat") {
          const b = await readJson(req, lim.maxBodyBytes);
          if (typeof b.message !== "string" || !b.message.trim()) return reply(400, { error: "message required" });
          if (b.message.length > lim.maxInputChars) return reply(413, { error: `Message too long (max ${lim.maxInputChars} characters).` });
          const out = await agent.chat(String(b.sessionId ?? "default").slice(0, 64), b.message);
          return reply(200, { ...out, state: state() });
        }
        if (req.method === "POST" && p === "/api/tools/call") {
          const b = await readJson(req, lim.maxBodyBytes);
          const out = await engine.run(String(b.name), b.args ?? {}, String(b.source ?? "api").slice(0, 40));
          return send(res, 200, out);
        }
        const ap = p.match(/^\/api\/approvals\/(apr_[\w-]+)\/(approve|reject)$/);
        if (req.method === "POST" && ap) {
          const out = ap[2] === "approve" ? await engine.approve(ap[1]) : engine.reject(ap[1]);
          return send(res, 200, { outcome: out, state: state() });
        }
        if (req.method === "POST" && p === "/api/mock/approve-last" && app.gw instanceof MockPayPal && engine.refs.lastOrderId) {
          app.gw.approve(engine.refs.lastOrderId); return send(res, 200, { ok: true, state: state() });
        }
        if (req.method === "POST" && p === "/api/reset") {
          const fresh = createApp({ env: process.env, guard: app.guard });
          (app as any).gw = fresh.gw; (app as any).engine = fresh.engine; (app as any).agent = fresh.agent;
          engine = fresh.engine; agent = fresh.agent;
          return send(res, 200, state());
        }
        return send(res, 404, { error: "not found" });
      }
      send(res, 404, "Not found", "text/plain");
    } catch (e: any) {
      if (e instanceof HttpError) return reply(e.code, { error: e.message });
      reply(500, { error: "Internal error." });
      if (process.env.NODE_ENV !== "test") console.error("handler error:", String(e?.name ?? "Error"), String(e?.message ?? "").slice(0, 200));
    }
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = createApp();
  createServer(makeHandler(app)).listen(app.cfg.port, () => {
    console.log(`Approvd console on http://localhost:${app.cfg.port}  ·  PayPal: ${app.gw.mode}  ·  planner: ${app.agent.planner.name}`);
  });
}
