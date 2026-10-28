// Deterministic offline planner so the demo and tests run with no LLM key.
// It understands the phrasings in the README demo script, splits multi-step requests
// ("capture it, then refund $5") and proposes ONE tool call per turn, resolving "it/that"
// from the results of earlier steps -- the same loop a real tool-calling model runs.
import type { ToolSpec } from "../tools.ts";
import type { SessionRefs } from "../engine.ts";
import type { ChatMsg, ChatToolCall, Planner, PlannerTurn } from "./types.ts";

const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const EMAIL_ONE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;
const AMOUNT_RE = /(?:\$|usd\s*|inr\s*|₹)\s*(\d+(?:[.,]\d{1,2})?)|(\d+(?:\.\d{1,2})?)\s*(?:dollars|usd|bucks)\b/gi;
const ID_RE = /\b(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{10,20}\b/;

export function splitClauses(text: string): string[] {
  return text
    .split(/\s*(?:;|\n|,?\s*\bthen\b|\bafter that\b|\.\s+(?=[A-Z]))\s*|\s+and\s+(?=(?:refund|capture|pay|send|create|make|check|list|show|look|charge)\b)/i)
    .map((s) => s?.trim())
    .filter((s): s is string => !!s && /[a-z]/i.test(s));
}

function amounts(s: string): { v: number; at: number }[] {
  const out: { v: number; at: number }[] = [];
  for (const m of s.matchAll(AMOUNT_RE)) out.push({ v: Number((m[1] ?? m[2]).replace(",", ".")), at: m.index! });
  return out;
}

function payoutItems(s: string): { receiver: string; amount: number }[] {
  const emails = [...s.matchAll(EMAIL_RE)].map((m) => ({ e: m[0].toLowerCase(), at: m.index!, end: m.index! + m[0].length }));
  const amts = amounts(s.replace(EMAIL_RE, (x) => " ".repeat(x.length)));
  if (!emails.length || !amts.length) return [];
  if (/\beach\b/i.test(s) && amts.length === 1) return emails.map((x) => ({ receiver: x.e, amount: amts[0].v }));
  return emails.map((x, i) => {
    const nextAt = emails[i + 1]?.at ?? Infinity; const prevEnd = emails[i - 1]?.end ?? -1;
    const after = amts.find((a) => a.at > x.end && a.at < nextAt);
    const before = [...amts].reverse().find((a) => a.at < x.at && a.at > prevEnd);
    return { receiver: x.e, amount: (after ?? before ?? amts[0]).v };
  });
}

export function clauseToCall(c: string, refs: SessionRefs): { name: string; args: Record<string, any> } | { help: string } {
  const lc = c.toLowerCase();
  const idm = c.replace(EMAIL_RE, "").match(ID_RE)?.[0];
  const amt = amounts(c.replace(EMAIL_RE, ""))[0]?.v;
  const dm = c.match(/\bPP-D-[A-Z0-9]+\b/)?.[0];
  if (/dispute/.test(lc) && (dm || /\b(first|draft|respond|reply|answer)\b/.test(lc))) {
    const d = dm ?? refs.lastDisputeId; return d ? { name: "get_dispute", args: { dispute_id: d } } : { help: "Which dispute? List disputes first." };
  }
  if (/dispute/.test(lc)) return { name: "list_disputes", args: {} };
  if (/\b(payout|batch)\b/.test(lc) && /\b(status|check|did|how)\b/.test(lc)) {
    const b = idm ?? refs.lastBatchId; return b ? { name: "get_payout", args: { batch_id: b } } : { help: "Which payout batch? I don't have one yet." };
  }
  if (/\brefund/.test(lc)) {
    const cap = idm ?? refs.lastCaptureId;
    if (!cap) return { help: "Which payment should I refund? Give me a capture id, or capture an order first." };
    const reason = c.match(/\b(?:for|because)\s+(.+)$/i)?.[1]?.replace(AMOUNT_RE, "").trim();
    return { name: "create_refund", args: { capture_id: cap, ...(amt !== undefined && !/\b(full|fully|entire|whole)\b/.test(lc) ? { amount: amt } : {}), ...(reason ? { reason } : {}) } };
  }
  if (/\b(pay|send|payout|tip|reimburse)\b/.test(lc) && EMAIL_ONE.test(c)) {
    const items = payoutItems(c);
    if (!items.length) return { help: "Who should I pay and how much? e.g. 'pay asha@example.com $40'." };
    const note = c.match(/\bfor\s+([^$@]+?)(?:$|\s+(?:to|and)\s)/i)?.[1]?.trim();
    return { name: "create_payout", args: { items: items.map((i) => ({ ...i, ...(note ? { note } : {}) })) } };
  }
  if (/\bcapture\b/.test(lc)) {
    const o = idm ?? refs.lastOrderId; return o ? { name: "capture_order", args: { order_id: o } } : { help: "Which order should I capture?" };
  }
  if (/\b(status|check|look up|lookup|where is|paid yet)\b/.test(lc) && /\border|it|payment|checkout\b/.test(lc)) {
    const o = idm ?? refs.lastOrderId; return o ? { name: "get_order", args: { order_id: o } } : { help: "Which order? Give me the order id." };
  }
  if (/\b(checkout|link|charge|invoice|bill|order|sell|request)\b/.test(lc) && amt !== undefined) {
    const customer = c.match(EMAIL_ONE)?.[0] ?? c.match(/\bfor\s+([A-Z][a-z]+)\b/)?.[1];
    let description = (c.match(/\bfor\s+(.+)$/i)?.[1] ?? c)
      .replace(EMAIL_RE, "").replace(AMOUNT_RE, "").replace(/\b(a|an|the|checkout|payment|link|create|make|send|please)\b/gi, " ")
      .replace(/\s+/g, " ").replace(/^[\s,:-]+|[\s,:-]+$/g, "");
    if (!description || description.length < 3) description = "Order";
    return { name: "create_order", args: { amount: amt, description: description.slice(0, 127), ...(customer ? { customer } : {}) } };
  }
  return { help: "I can create checkout links, capture approved orders, refund payments, send payouts, check payout status and list disputes. Try: 'Create a $45 checkout for 2 soy candles for priya@example.com'." };
}

export class MockPlanner implements Planner {
  readonly name = "mock (deterministic, offline)";
  private n = 0;
  async next(messages: ChatMsg[], _tools: ToolSpec[], refs: SessionRefs): Promise<PlannerTurn> {
    let lastUser = -1;
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user") { lastUser = i; break; }
    const user = messages[lastUser]?.content ?? "";
    const since = messages.slice(lastUser + 1);
    const step = since.filter((m) => m.role === "assistant" && m.tool_calls?.length).length;
    // Stop chaining if the previous step is waiting on a human or failed: don't act on a guess.
    const lastTool = [...since].reverse().find((m) => m.role === "tool");
    if (lastTool) {
      const st = JSON.parse(lastTool.content ?? "{}").status;
      if (st === "pending_approval" || st === "denied" || st === "failed") return { toolCalls: [] };
    }
    const clauses = splitClauses(user);
    if (step >= clauses.length) return { toolCalls: [] };
    const r = clauseToCall(clauses[step], refs);
    if ("help" in r) return { text: r.help, toolCalls: [] };
    const call: ChatToolCall = { id: `call_${++this.n}`, type: "function", function: { name: r.name, arguments: JSON.stringify(r.args) } };
    return { toolCalls: [call] };
  }
}
