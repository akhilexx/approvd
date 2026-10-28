// MCP (Model Context Protocol) stdio bridge: lets any MCP client (Claude Desktop, Cursor, ...) use
// Approvd's PayPal tools. Calls are forwarded to a running Approvd server so the SAME policy engine,
// approval queue and audit ledger apply -- an outside agent can't bypass the guardrails.
// Usage: APPROVD_URL=http://localhost:8787 node src/mcp.ts
import { createInterface } from "node:readline";
import { TOOL_SPECS } from "./tools.ts";

const BASE = (process.env.APPROVD_URL || "http://localhost:8787").replace(/\/$/, "");
const write = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + "\n");

export async function handle(req: any, fetchImpl: typeof fetch = fetch): Promise<any> {
  const { id, method, params } = req;
  if (method === "initialize") return { jsonrpc: "2.0", id, result: { protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "approvd", version: "0.1.0" } } };
  if (method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: TOOL_SPECS.map((t) => ({ name: t.name, description: `${t.description} (policy-guarded by Approvd)`, inputSchema: t.parameters })) } };
  if (method === "tools/call") {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (process.env.DEMO_PASSCODE) headers["x-demo-passcode"] = process.env.DEMO_PASSCODE;
    const r = await fetchImpl(`${BASE}/api/tools/call`, { method: "POST", headers, body: JSON.stringify({ name: params?.name, args: params?.arguments ?? {}, source: "mcp" }) });
    const out: any = await r.json();
    const text = out.status === "pending_approval" ? `Queued for human approval (${out.approvalId}): ${out.decision?.reasons?.join("; ")}. Ask the user to approve it in the Approvd console.` : JSON.stringify(out.result ?? out.error ?? out);
    return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: out.status === "denied" || out.status === "failed" } };
  }
  if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
  if (id === undefined) return null; // notification
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createInterface({ input: process.stdin }).on("line", async (line) => {
    if (!line.trim()) return;
    let req: any; try { req = JSON.parse(line); } catch { return write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
    try { const res = await handle(req); if (res) write(res); }
    catch (e: any) { write({ jsonrpc: "2.0", id: req.id ?? null, error: { code: -32000, message: String(e?.message ?? e) } }); }
  });
}
