import { test } from "node:test";
import assert from "node:assert/strict";
import { validateArgs, TOOL_SPECS } from "../src/tools.ts";

test("every tool has a JSON schema with type object", () => {
  for (const t of TOOL_SPECS) assert.equal(t.parameters.type, "object", t.name);
});
test("amounts: strings with $ are normalised, >2 decimals and negatives rejected", () => {
  assert.equal(validateArgs("create_order", { amount: "$1,250.50", description: "x y z" }).amount, 1250.5);
  assert.throws(() => validateArgs("create_order", { amount: 1.005, description: "abc" }), /2 decimals/);
  assert.throws(() => validateArgs("create_order", { amount: -5, description: "abc" }), /positive/);
  assert.throws(() => validateArgs("create_order", { amount: "lots", description: "abc" }), /positive/);
});
test("unexpected arguments are rejected (no smuggled fields)", () => {
  assert.throws(() => validateArgs("create_refund", { capture_id: "ABC123DEF4", bypass_policy: true }), /Unexpected argument "bypass_policy"/);
});
test("payout receivers must be emails and are lower-cased", () => {
  const v = validateArgs("create_payout", { items: [{ receiver: "Asha@Example.com", amount: 10 }] });
  assert.equal(v.items[0].receiver, "asha@example.com");
  assert.throws(() => validateArgs("create_payout", { items: [{ receiver: "asha", amount: 10 }] }), /not an email/);
  assert.throws(() => validateArgs("create_payout", { items: [] }), /1-20/);
});
test("ids are checked for shape", () => {
  assert.throws(() => validateArgs("get_order", { order_id: "../../v1/oauth2" }), /valid PayPal id/);
  assert.equal(validateArgs("get_order", { order_id: "5O190127TN364715T" }).order_id, "5O190127TN364715T");
});
test("unknown tool", () => assert.throws(() => validateArgs("delete_account", {}), /Unknown tool/));
