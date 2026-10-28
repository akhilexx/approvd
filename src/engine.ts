// Guarded executor: validate -> policy -> (execute | queue for approval | deny) -> audit ledger.
// Shared by the chat agent, the HTTP tool API and the MCP server.
import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config.ts";
import { evaluate, type Decision } from "./policy.ts";
import { PayPalError, moneyNum, type PayPalGateway } from "./paypal/types.ts";
import { validateArgs, type ToolCall, type ToolName } from "./tools.ts";

export interface LedgerEntry {
  id: string; at: string; tool: ToolName; args: Record<string, any>;
  verdict: Decision["verdict"] | "invalid"; reasons: string[]; amount: number; direction: string;
  status: "executed" | "pending_approval" | "approved" | "rejected" | "denied" | "failed";
  source: string; approvalId?: string; result?: any; error?: string; paypalRef?: string;
}

export interface Approval { id: string; createdAt: string; call: ToolCall; decision: Decision; status: "pending" | "approved" | "rejected"; source: string; ledgerId: string }

export interface StepOutcome { call: ToolCall; status: LedgerEntry["status"]; decision?: Decision; result?: any; error?: string; approvalId?: string }

export interface SessionRefs { lastOrderId?: string; lastCaptureId?: string; lastBatchId?: string; lastApproveUrl?: string }

export class Engine {
  cfg: AppConfig; gw: PayPalGateway;
  ledger: LedgerEntry[] = [];
  approvals = new Map<string, Approval>();
  refunded = new Map<string, number>(); // captureId -> amount refunded through this app
  refs: SessionRefs = {};

  constructor(cfg: AppConfig, gw: PayPalGateway) { this.cfg = cfg; this.gw = gw; }

  outflowLast24h(now = Date.now()): number {
    return +this.ledger
      .filter((l) => l.direction === "outflow" && (l.status === "executed" || l.status === "approved") && now - Date.parse(l.at) < 864e5)
      .reduce((s, l) => s + l.amount, 0).toFixed(2);
  }

  async run(name: string, rawArgs: Record<string, any>, source = "agent"): Promise<StepOutcome> {
    const call: ToolCall = { id: randomUUID(), name: name as ToolName, args: rawArgs };
    let args: Record<string, any>;
    try { args = validateArgs(name, rawArgs); } catch (e: any) {
      this.log({ tool: call.name, args: rawArgs, verdict: "invalid", reasons: [e.message], amount: 0, direction: "none", status: "denied", source });
      return { call, status: "denied", error: `Invalid arguments: ${e.message}` };
    }
    call.args = args;
    const decision = await this.decide(call);
    if (decision.verdict === "deny") {
      this.log({ tool: call.name, args, ...this.d(decision), status: "denied", source });
      return { call, status: "denied", decision, error: `Blocked by policy: ${decision.reasons.join("; ")}` };
    }
    if (decision.verdict === "needs_approval") {
      const approvalId = "apr_" + randomUUID().slice(0, 8);
      const entry = this.log({ tool: call.name, args, ...this.d(decision), status: "pending_approval", source, approvalId });
      this.approvals.set(approvalId, { id: approvalId, createdAt: entry.at, call, decision, status: "pending", source, ledgerId: entry.id });
      return { call, status: "pending_approval", decision, approvalId };
    }
    return this.execute(call, decision, source);
  }

  async approve(approvalId: string, approver = "human"): Promise<StepOutcome> {
    const a = this.approvals.get(approvalId);
    if (!a || a.status !== "pending") throw new Error(`No pending approval ${approvalId}`);
    // Re-check hard limits at approval time: caps may have been consumed meanwhile.
    const decision = await this.decide(a.call);
    a.status = "approved";
    const entry = this.ledger.find((l) => l.id === a.ledgerId);
    if (decision.verdict === "deny") {
      if (entry) { entry.status = "denied"; entry.reasons = decision.reasons; }
      return { call: a.call, status: "denied", decision, error: `Still blocked: ${decision.reasons.join("; ")}` };
    }
    const out = await this.execute(a.call, decision, `${a.source} (approved by ${approver})`, entry);
    return out;
  }

  reject(approvalId: string): Approval {
    const a = this.approvals.get(approvalId);
    if (!a || a.status !== "pending") throw new Error(`No pending approval ${approvalId}`);
    a.status = "rejected";
    const entry = this.ledger.find((l) => l.id === a.ledgerId);
    if (entry) entry.status = "rejected";
    return a;
  }

  private d(x: Decision) { return { verdict: x.verdict, reasons: x.reasons, amount: x.amount, direction: x.direction }; }

  private async decide(call: ToolCall): Promise<Decision> {
    let capture;
    if (call.name === "create_refund") {
      try {
        const c = await this.gw.getCapture(call.args.capture_id);
        capture = { amount: moneyNum(c.amount), refunded: this.refunded.get(c.captureId) ?? 0, currency: c.amount.currency };
      } catch { capture = undefined; }
    }
    return evaluate(call, this.cfg.policy, { outflowLast24h: this.outflowLast24h(), capture });
  }

  private log(e: Omit<LedgerEntry, "id" | "at">): LedgerEntry {
    const entry: LedgerEntry = { id: "led_" + randomUUID().slice(0, 8), at: new Date().toISOString(), ...e };
    this.ledger.unshift(entry);
    if (this.ledger.length > 500) this.ledger.pop();
    return entry;
  }

  private async execute(call: ToolCall, decision: Decision, source: string, existing?: LedgerEntry): Promise<StepOutcome> {
    const status = existing ? "approved" : "executed";
    try {
      const result = await this.dispatch(call);
      const paypalRef = result?.id ?? result?.captureId ?? result?.refundId ?? result?.batchId;
      if (existing) Object.assign(existing, { status, result, paypalRef, source, reasons: decision.reasons, amount: decision.amount });
      else this.log({ tool: call.name, args: call.args, ...this.d(decision), status, source, result, paypalRef });
      return { call, status, decision, result };
    } catch (e: any) {
      const msg = e instanceof PayPalError ? `PayPal ${e.status} ${e.issue}: ${e.message}${e.debugId ? ` (debug_id ${e.debugId})` : ""}` : String(e?.message ?? e);
      if (existing) Object.assign(existing, { status: "failed", error: msg });
      else this.log({ tool: call.name, args: call.args, ...this.d(decision), status: "failed", source, error: msg });
      return { call, status: "failed", decision, error: msg };
    }
  }

  private async dispatch(call: ToolCall): Promise<any> {
    const a = call.args; const cur = this.cfg.currency; const base = this.cfg.publicBaseUrl;
    switch (call.name) {
      case "create_order": {
        const o = await this.gw.createOrder({ amount: a.amount, currency: cur, description: a.description, referenceId: a.customer?.replace(/[^A-Za-z0-9-]/g, "-").slice(0, 60), returnUrl: `${base}/return`, cancelUrl: `${base}/cancel` });
        this.refs.lastOrderId = o.id; this.refs.lastApproveUrl = o.approveUrl;
        return o;
      }
      case "get_order": { const o = await this.gw.getOrder(a.order_id); this.refs.lastOrderId = o.id; if (o.captureId) this.refs.lastCaptureId = o.captureId; return o; }
      case "capture_order": { const c = await this.gw.captureOrder(a.order_id); this.refs.lastOrderId = c.orderId; this.refs.lastCaptureId = c.captureId; return c; }
      case "create_refund": {
        const r = await this.gw.refundCapture(a.capture_id, a.amount, cur, a.reason);
        this.refunded.set(a.capture_id, +((this.refunded.get(a.capture_id) ?? 0) + moneyNum(r.amount)).toFixed(2));
        return r;
      }
      case "create_payout": {
        const b = await this.gw.createPayouts(a.items, cur, `approvd-${Date.now()}`, a.memo ?? "You have a payout");
        this.refs.lastBatchId = b.batchId; return b;
      }
      case "get_payout": { const b = await this.gw.getPayoutBatch(a.batch_id); this.refs.lastBatchId = b.batchId; return b; }
      case "list_disputes": return this.gw.listDisputes();
    }
  }
}
