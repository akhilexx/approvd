import { test } from "node:test";
import assert from "node:assert/strict";
import { MockPayPal } from "../src/paypal/mock.ts";

const base = { currency: "USD", description: "candles", returnUrl: "r", cancelUrl: "c" };
test("order state machine mirrors PayPal: PAYER_ACTION_REQUIRED -> APPROVED -> COMPLETED (as seen live in sandbox)", async () => {
  const pp = new MockPayPal("http://h");
  const o = await pp.createOrder({ ...base, amount: 45 });
  assert.equal(o.status, "PAYER_ACTION_REQUIRED"); assert.equal(o.approveUrl, `http://h/mock/checkout/${o.id}`);
  await assert.rejects(pp.captureOrder(o.id), /not yet approved/);
  pp.approve(o.id);
  const c = await pp.captureOrder(o.id);
  assert.equal(c.status, "COMPLETED"); assert.equal(c.amount.value, "45.00");
  await assert.rejects(pp.captureOrder(o.id), (e: any) => e.issue === "ORDER_ALREADY_CAPTURED");
  assert.equal((await pp.getOrder(o.id)).captureId, c.captureId);
});
test("refunds are capped at the captured amount", async () => {
  const pp = new MockPayPal(); const o = await pp.createOrder({ ...base, amount: 30 }); pp.approve(o.id);
  const c = await pp.captureOrder(o.id);
  assert.equal((await pp.refundCapture(c.captureId, 10, "USD")).amount.value, "10.00");
  await assert.rejects(pp.refundCapture(c.captureId, 25, "USD"), (e: any) => e.issue === "REFUND_AMOUNT_EXCEEDED");
  assert.equal((await pp.refundCapture(c.captureId, undefined, "USD")).amount.value, "20.00");
  assert.equal((await pp.getCapture(c.captureId)).status, "REFUNDED");
});
test("payouts: PENDING on create, item statuses on lookup, duplicate sender_batch_id rejected", async () => {
  const pp = new MockPayPal();
  const b = await pp.createPayouts([{ receiver: "a@example.com", amount: 5 }, { receiver: "z@unclaimed.example", amount: 6 }], "USD", "batch-1", "s");
  assert.equal(b.status, "PENDING"); assert.equal(b.total.value, "11.00");
  const g = await pp.getPayoutBatch(b.batchId);
  assert.deepEqual(g.items.map((i) => i.status), ["SUCCESS", "UNCLAIMED"]);
  await assert.rejects(pp.createPayouts([{ receiver: "a@example.com", amount: 5 }], "USD", "batch-1", "s"), (e: any) => e.issue === "DUPLICATE_REQUEST_ID");
});
test("disputes are seeded and retrievable", async () => {
  const pp = new MockPayPal(); const ds = await pp.listDisputes();
  assert.equal(ds.length, 2); assert.equal((await pp.getDispute(ds[0].id)).id, ds[0].id);
  await assert.rejects(pp.getDispute("PP-D-NOPE"), /not found/);
});
