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

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..", "web");
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function send(res: ServerResponse, code: number, body: unknown, type = "application/json") {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}
async function readJson(req: IncomingMessage): Promise<any> {
  let raw = ""; for await (const ch of req) { raw += ch; if (raw.length > 64_000) throw new Error("body too large"); }
  return raw ? JSON.parse(raw) : {};
}
const page = (title: string, inner: string) => `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>${esc(title)}</title><link rel=stylesheet href=/style.css><main class="narrow card">${inner}</main>`;

// Tiny fixed-window rate limit for the hosted demo so a public URL can't burn the LLM key.
export function rateLimiter(limit = Number(process.env.RATE_LIMIT_PER_MIN ?? 30)) {
  const hits = new Map<string, { n: number; t: number }>();
  return (key: string, now = Date.now()) => {
    const h = hits.get(key);
    if (!h || now - h.t > 60_000) { hits.set(key, { n: 1, t: now }); return true; }
    h.n++; return h.n <= limit;
  };
}

export function makeHandler(app: App) {
  const allow = rateLimiter();
  let { engine, agent } = app;
  const state = () => ({
    paypalMode: app.gw.mode, planner: agent.planner.name, currency: app.cfg.currency,
    policy: { ...app.cfg.policy, text: describePolicy(app.cfg.policy) },
    outflowLast24h: engine.outflowLast24h(), refs: engine.refs,
    approvals: [...engine.approvals.values()].filter((a) => a.status === "pending").reverse(),
    ledger: engine.ledger.slice(0, 100),
  });

  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://x");
    const p = url.pathname;
    try {
      if (req.method === "GET" && (p === "/" || /^\/[\w-]+\.(js|css|svg)$/.test(p))) {
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
        if (app.cfg.demoPasscode && req.headers["x-demo-passcode"] !== app.cfg.demoPasscode) return send(res, 401, { error: "passcode required" });
        if (req.method === "GET" && p === "/api/state") return send(res, 200, state());
        if (req.method === "GET" && p === "/api/tools") return send(res, 200, TOOL_SPECS);
        if (req.method === "POST" && !allow(String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "?").split(",")[0])) return send(res, 429, { error: "Too many requests, wait a minute." });
        if (req.method === "POST" && p === "/api/chat") {
          const b = await readJson(req);
          if (typeof b.message !== "string" || !b.message.trim()) return send(res, 400, { error: "message required" });
          const out = await agent.chat(String(b.sessionId ?? "default").slice(0, 64), b.message);
          return send(res, 200, { ...out, state: state() });
        }
        if (req.method === "POST" && p === "/api/tools/call") {
          const b = await readJson(req);
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
          const fresh = createApp({ env: process.env });
          (app as any).gw = fresh.gw; (app as any).engine = fresh.engine; (app as any).agent = fresh.agent;
          engine = fresh.engine; agent = fresh.agent;
          return send(res, 200, state());
        }
        return send(res, 404, { error: "not found" });
      }
      send(res, 404, "Not found", "text/plain");
    } catch (e: any) {
      send(res, 500, { error: String(e?.message ?? e) });
    }
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = createApp();
  createServer(makeHandler(app)).listen(app.cfg.port, () => {
    console.log(`Approvd console on http://localhost:${app.cfg.port}  ·  PayPal: ${app.gw.mode}  ·  planner: ${app.agent.planner.name}`);
  });
}
