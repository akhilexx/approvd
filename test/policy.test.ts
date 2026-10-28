import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, allowlisted, describePolicy } from "../src/policy.ts";
import type { PolicyConfig } from "../src/config.ts";

const P: PolicyConfig = { approvalThreshold: 50, maxPerAction: 500, dailyOutflowCap: 1000, payeeAllowlist: ["@example.com", "boss@gmail.com"], blockedTools: [], currency: "USD" };
const call = (name: any, args: any) => ({ id: "t", name, args });

test("allowlist supports exact emails and @domain suffixes", () => {
  assert.ok(allowlisted("a@example.com", P.payeeAllowlist));
  assert.ok(allowlisted("BOSS@gmail.com", P.payeeAllowlist));
  assert.ok(!allowlisted("a@example.com.evil.io", P.payeeAllowlist));
  assert.ok(!allowlisted("x@gmail.com", P.payeeAllowlist));
});
test("small allowlisted payout runs automatically", () => {
  const d = evaluate(call("create_payout", { items: [{ receiver: "a@example.com", amount: 20 }, { receiver: "b@example.com", amount: 25 }] }), P, { outflowLast24h: 0 });
  assert.equal(d.verdict, "allow"); assert.equal(d.amount, 45);
});
test("payout above threshold or to a new payee needs approval", () => {
  assert.equal(evaluate(call("create_payout", { items: [{ receiver: "a@example.com", amount: 51 }] }), P, { outflowLast24h: 0 }).verdict, "needs_approval");
  const d = evaluate(call("create_payout", { items: [{ receiver: "new@gmail.com", amount: 5 }] }), P, { outflowLast24h: 0 });
  assert.equal(d.verdict, "needs_approval"); assert.match(d.reasons[0], /not on allowlist/);
});
test("duplicate payee in one batch needs approval", () => {
  const d = evaluate(call("create_payout", { items: [{ receiver: "a@example.com", amount: 5 }, { receiver: "a@example.com", amount: 5 }] }), P, { outflowLast24h: 0 });
  assert.equal(d.verdict, "needs_approval"); assert.match(d.reasons.join(), /duplicate/);
});
test("hard per-action limit and 24h cap deny, and only deny reasons are reported", () => {
  const d = evaluate(call("create_payout", { items: [{ receiver: "a@example.com", amount: 900 }] }), P, { outflowLast24h: 0 });
  assert.equal(d.verdict, "deny"); assert.deepEqual(d.reasons, ["900 is above the hard 500 per-action limit"]);
  const c = evaluate(call("create_payout", { items: [{ receiver: "a@example.com", amount: 30 }] }), P, { outflowLast24h: 980 });
  assert.equal(c.verdict, "deny"); assert.match(c.reasons[0], /24h outflow cap/);
});
test("refund: full refund defaults to remaining balance; over-refund denied; repeat refund needs approval", () => {
  const full = evaluate(call("create_refund", { capture_id: "X" }), P, { outflowLast24h: 0, capture: { amount: 45, refunded: 0, currency: "USD" } });
  assert.equal(full.verdict, "allow"); assert.equal(full.amount, 45);
  assert.equal(evaluate(call("create_refund", { capture_id: "X", amount: 40 }), P, { outflowLast24h: 0, capture: { amount: 45, refunded: 12, currency: "USD" } }).verdict, "deny");
  assert.equal(evaluate(call("create_refund", { capture_id: "X", amount: 10 }), P, { outflowLast24h: 0, capture: { amount: 45, refunded: 12, currency: "USD" } }).verdict, "needs_approval");
  assert.equal(evaluate(call("create_refund", { capture_id: "X", amount: 10 }), P, { outflowLast24h: 0 }).verdict, "deny");
});
test("inflow: checkout above per-action limit needs approval, reads always allowed", () => {
  assert.equal(evaluate(call("create_order", { amount: 600, description: "x" }), P, { outflowLast24h: 999 }).verdict, "needs_approval");
  assert.equal(evaluate(call("create_order", { amount: 60, description: "x" }), P, { outflowLast24h: 999 }).verdict, "allow");
  assert.equal(evaluate(call("list_disputes", {}), P, { outflowLast24h: 1e9 }).verdict, "allow");
});
test("blocked tools are denied", () => {
  assert.equal(evaluate(call("create_refund", { capture_id: "X", amount: 1 }), { ...P, blockedTools: ["create_refund"] }, { outflowLast24h: 0, capture: { amount: 5, refunded: 0, currency: "USD" } }).verdict, "deny");
});
test("policy description is human readable", () => assert.match(describePolicy(P), /above that a human must approve/));
