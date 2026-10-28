// Spend-policy engine. The model proposes; this decides. It runs on every tool call
// (from the chat agent, the HTTP tool API and the MCP server) and cannot be changed by prompts.
import type { PolicyConfig } from "./config.ts";
import { specOf, type ToolCall } from "./tools.ts";

export type Verdict = "allow" | "needs_approval" | "deny";
export interface Decision { verdict: Verdict; reasons: string[]; amount: number; direction: "inflow" | "outflow" | "none" }

export interface PolicyContext {
  outflowLast24h: number;
  /** For refunds: captured amount and how much this app already refunded on that capture. */
  capture?: { amount: number; refunded: number; currency: string };
}

const rank: Record<Verdict, number> = { allow: 0, needs_approval: 1, deny: 2 };

export function allowlisted(email: string, allow: string[]): boolean {
  const e = email.toLowerCase();
  return allow.some((a) => (a.startsWith("@") ? e.endsWith(a) : e === a));
}

export function evaluate(call: ToolCall, p: PolicyConfig, ctx: PolicyContext): Decision {
  const spec = specOf(call.name);
  const reasons: string[] = [];
  let verdict: Verdict = "allow";
  const bump = (v: Verdict, why: string) => { reasons.push(why); if (rank[v] > rank[verdict]) verdict = v; };
  const direction = spec?.moneyMoving ?? "none";
  let amount = 0;

  if (!spec) return { verdict: "deny", reasons: [`unknown tool ${call.name}`], amount, direction };
  if (p.blockedTools.includes(call.name)) bump("deny", `${call.name} is blocked by policy`);

  if (call.name === "create_order") {
    amount = call.args.amount;
    if (amount > p.maxPerAction) bump("needs_approval", `checkout of ${amount} is above the ${p.maxPerAction} per-action limit`);
  }

  if (call.name === "create_refund") {
    const c = ctx.capture;
    if (!c) bump("deny", "capture not found, so the refundable amount is unknown");
    else {
      const remaining = +(c.amount - c.refunded).toFixed(2);
      amount = call.args.amount ?? remaining;
      if (amount > remaining + 1e-9) bump("deny", `refund ${amount} exceeds refundable balance ${remaining}`);
      if (c.refunded > 0) bump("needs_approval", `capture already refunded ${c.refunded} before`);
    }
  }

  if (call.name === "create_payout") {
    const items: { receiver: string; amount: number }[] = call.args.items;
    amount = +items.reduce((s, i) => s + i.amount, 0).toFixed(2);
    const outside = items.filter((i) => !allowlisted(i.receiver, p.payeeAllowlist)).map((i) => i.receiver);
    if (outside.length) bump("needs_approval", `payee not on allowlist: ${outside.join(", ")}`);
    const seen = new Set<string>();
    for (const i of items) { if (seen.has(i.receiver)) bump("needs_approval", `duplicate payee ${i.receiver}`); seen.add(i.receiver); }
  }

  if (direction === "outflow" && amount > 0) {
    if (amount > p.maxPerAction) bump("deny", `${amount} is above the hard ${p.maxPerAction} per-action limit`);
    if (ctx.outflowLast24h + amount > p.dailyOutflowCap) bump("deny", `would exceed the 24h outflow cap (${ctx.outflowLast24h} already + ${amount} > ${p.dailyOutflowCap})`);
    if (amount > p.approvalThreshold) bump("needs_approval", `${amount} is above the ${p.approvalThreshold} auto-approve threshold`);
  }

  if (!reasons.length) reasons.push(direction === "none" ? "read-only" : "within policy");
  return { verdict, reasons, amount, direction };
}

export function describePolicy(p: PolicyConfig): string {
  return [
    `Currency ${p.currency}.`,
    `Refunds and payouts up to ${p.approvalThreshold} run automatically; above that a human must approve.`,
    `Hard limit ${p.maxPerAction} per action; 24h outflow cap ${p.dailyOutflowCap}.`,
    `Payout allowlist: ${p.payeeAllowlist.length ? p.payeeAllowlist.join(", ") : "(empty: every payout needs approval)"}.`,
    p.blockedTools.length ? `Blocked tools: ${p.blockedTools.join(", ")}.` : "",
  ].filter(Boolean).join(" ");
}
