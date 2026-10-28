// Tool catalogue the agent can call. Names follow PayPal's agent toolkit / MCP server naming
// (create_order, get_order, capture_order, create_refund, list_disputes ...) plus payouts.
// Every argument is validated here before the policy engine sees it, so a model can't smuggle
// in malformed amounts or extra fields.

export type ToolName = "create_order" | "get_order" | "capture_order" | "create_refund" | "create_payout" | "get_payout" | "list_disputes";

export interface ToolCall { id: string; name: ToolName; args: Record<string, any> }

export interface ToolSpec { name: ToolName; description: string; parameters: Record<string, any>; moneyMoving: "inflow" | "outflow" | "none" }

const amount = { type: "number", description: "Amount in the store currency, max 2 decimals", exclusiveMinimum: 0 };

export const TOOL_SPECS: ToolSpec[] = [
  { name: "create_order", moneyMoving: "inflow", description: "Create a PayPal checkout (Orders v2, intent CAPTURE) and return a buyer approval link.",
    parameters: { type: "object", additionalProperties: false, required: ["amount", "description"], properties: { amount, description: { type: "string", maxLength: 127 }, customer: { type: "string", description: "Optional customer name or email for the reference" } } } },
  { name: "get_order", moneyMoving: "none", description: "Look up a PayPal order's status.",
    parameters: { type: "object", additionalProperties: false, required: ["order_id"], properties: { order_id: { type: "string" } } } },
  { name: "capture_order", moneyMoving: "inflow", description: "Capture payment for an order the buyer has approved.",
    parameters: { type: "object", additionalProperties: false, required: ["order_id"], properties: { order_id: { type: "string" } } } },
  { name: "create_refund", moneyMoving: "outflow", description: "Refund a captured payment, fully (omit amount) or partially.",
    parameters: { type: "object", additionalProperties: false, required: ["capture_id"], properties: { capture_id: { type: "string" }, amount, reason: { type: "string", maxLength: 255 } } } },
  { name: "create_payout", moneyMoving: "outflow", description: "Send money to one or more people by email (Payouts v1).",
    parameters: { type: "object", additionalProperties: false, required: ["items"], properties: { items: { type: "array", minItems: 1, maxItems: 20, items: { type: "object", additionalProperties: false, required: ["receiver", "amount"], properties: { receiver: { type: "string", format: "email" }, amount, note: { type: "string", maxLength: 100 } } } }, memo: { type: "string" } } } },
  { name: "get_payout", moneyMoving: "none", description: "Check status of a payout batch.",
    parameters: { type: "object", additionalProperties: false, required: ["batch_id"], properties: { batch_id: { type: "string" } } } },
  { name: "list_disputes", moneyMoving: "none", description: "List open PayPal disputes for the merchant.",
    parameters: { type: "object", additionalProperties: false, properties: {} } },
];

export const specOf = (name: string) => TOOL_SPECS.find((t) => t.name === name);

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ID = /^[A-Za-z0-9-]{3,64}$/;

function money(v: unknown, field: string): number {
  const n = typeof v === "string" ? Number(v.replace(/[$,\s]/g, "")) : v;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) throw new Error(`${field} must be a positive number`);
  if (Math.round(n * 100) !== +(n * 100).toFixed(6)) throw new Error(`${field} has more than 2 decimals`);
  return Math.round(n * 100) / 100;
}
function id(v: unknown, field: string): string {
  if (typeof v !== "string" || !ID.test(v)) throw new Error(`${field} is not a valid PayPal id`);
  return v;
}
function str(v: unknown, max: number): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  return String(v).slice(0, max);
}

/** Returns normalised args or throws with a human-readable reason. */
export function validateArgs(name: string, args: Record<string, any> = {}): Record<string, any> {
  const spec = specOf(name);
  if (!spec) throw new Error(`Unknown tool ${name}`);
  const allowed = Object.keys(spec.parameters.properties ?? {});
  for (const k of Object.keys(args)) if (!allowed.includes(k)) throw new Error(`Unexpected argument "${k}" for ${name}`);
  switch (spec.name) {
    case "create_order": {
      const description = str(args.description, 127);
      if (!description) throw new Error("description is required");
      return { amount: money(args.amount, "amount"), description, customer: str(args.customer, 80) };
    }
    case "get_order": case "capture_order": return { order_id: id(args.order_id, "order_id") };
    case "create_refund": return { capture_id: id(args.capture_id, "capture_id"), amount: args.amount === undefined ? undefined : money(args.amount, "amount"), reason: str(args.reason, 255) };
    case "create_payout": {
      if (!Array.isArray(args.items) || args.items.length === 0 || args.items.length > 20) throw new Error("items must list 1-20 payees");
      const items = args.items.map((it: any, i: number) => {
        const receiver = String(it?.receiver ?? "").trim().toLowerCase();
        if (!EMAIL.test(receiver)) throw new Error(`items[${i}].receiver is not an email`);
        return { receiver, amount: money(it.amount, `items[${i}].amount`), note: str(it.note, 100) };
      });
      return { items, memo: str(args.memo, 120) };
    }
    case "get_payout": return { batch_id: id(args.batch_id, "batch_id") };
    case "list_disputes": return {};
  }
}
