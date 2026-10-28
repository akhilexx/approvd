import { test } from "node:test";
import assert from "node:assert/strict";
import { splitClauses, clauseToCall } from "../src/agent/mockPlanner.ts";

test("splits multi-step requests but keeps multi-payee payouts together", () => {
  assert.deepEqual(splitClauses("Capture it, then refund $12 for a cracked lid"), ["Capture it", "refund $12 for a cracked lid"]);
  assert.equal(splitClauses("Pay a@example.com $20 and b@example.com $25").length, 1);
  assert.equal(splitClauses("Capture it and refund $5").length, 2);
});
test("checkout parsing", () => {
  const r: any = clauseToCall("Create a $45 checkout for 2 soy candles for priya@example.com", {});
  assert.equal(r.name, "create_order"); assert.equal(r.args.amount, 45); assert.equal(r.args.customer, "priya@example.com"); assert.match(r.args.description, /soy candles/);
});
test("payout parsing: per-payee amounts, 'each', amount-before-email", () => {
  const a: any = clauseToCall("Pay asha@example.com $20 and ravi@example.com $25 for October deliveries", {});
  assert.deepEqual(a.args.items.map((i: any) => [i.receiver, i.amount]), [["asha@example.com", 20], ["ravi@example.com", 25]]);
  const b: any = clauseToCall("Send $15 each to a@example.com, b@example.com and c@example.com", {});
  assert.deepEqual(b.args.items.map((i: any) => i.amount), [15, 15, 15]);
  const c: any = clauseToCall("Send $120 to newvendor@gmail.com for packaging", {});
  assert.equal(c.args.items[0].amount, 120); assert.equal(c.args.items[0].note, "packaging");
});
test("references resolve from session refs; explicit ids win", () => {
  assert.deepEqual(clauseToCall("capture it", { lastOrderId: "ORDERID123" }), { name: "capture_order", args: { order_id: "ORDERID123" } });
  assert.deepEqual(clauseToCall("capture 5O190127TN364715T", { lastOrderId: "ORDERID123" }), { name: "capture_order", args: { order_id: "5O190127TN364715T" } });
  const r: any = clauseToCall("Refund the rest of it", { lastCaptureId: "CAP1234567X" });
  assert.equal(r.name, "create_refund"); assert.equal(r.args.amount, undefined);
  assert.ok("help" in clauseToCall("refund $5", {}));
});
test("disputes and help", () => {
  assert.equal((clauseToCall("List open disputes", {}) as any).name, "list_disputes");
  assert.equal((clauseToCall("Draft a reply to the first dispute", { lastDisputeId: "PP-D-1" }) as any).name, "get_dispute");
  assert.ok("help" in clauseToCall("what's the weather", {}));
});
