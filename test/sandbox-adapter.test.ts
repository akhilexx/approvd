// Contract tests for the real sandbox adapter using a recorded-shape fake fetch (no network, no keys).
import { test } from "node:test";
import assert from "node:assert/strict";
import { SandboxPayPal } from "../src/paypal/sandbox.ts";
import { readConfig } from "../src/config.ts";

function fakeFetch(routes: Record<string, (body: any, init: any) => [number, any]>) {
  const calls: { method: string; path: string; headers: any; body: any }[] = [];
  const f = async (url: any, init: any = {}) => {
    const u = new URL(String(url)); const key = `${init.method ?? "GET"} ${u.pathname}`;
    const body = init.body && typeof init.body === "string" && init.body.startsWith("{") ? JSON.parse(init.body) : init.body;
    calls.push({ method: init.method ?? "GET", path: u.pathname + u.search, headers: init.headers, body });
    const h = routes[key]; if (!h) return new Response(JSON.stringify({ name: "NOT_MOCKED" }), { status: 599 });
    const [s, j] = h(body, init); return new Response(JSON.stringify(j), { status: s });
  };
  return { f: f as unknown as typeof fetch, calls };
}
const TOKEN = { "POST /v1/oauth2/token": () => [200, { access_token: "A21AA-test", expires_in: 32400 }] as [number, any] };
const mk = (routes: any) => { const ff = fakeFetch({ ...TOKEN, ...routes }); return { pp: new SandboxPayPal({ base: "https://api-m.sandbox.paypal.com", clientId: "id", secret: "sec", fetchImpl: ff.f }), calls: ff.calls }; };

test("refuses to construct without keys or against a non-sandbox host", () => {
  assert.throws(() => new SandboxPayPal({ base: "https://api-m.sandbox.paypal.com", clientId: "", secret: "" }), /PAYPAL_CLIENT_ID/);
  assert.throws(() => new SandboxPayPal({ base: "https://api-m.paypal.com", clientId: "a", secret: "b" }), /sandbox/);
  assert.throws(() => readConfig({ PAYPAL_API_BASE: "https://api-m.paypal.com" } as any), /LIVE/);
});

test("Orders v2 create: OAuth basic auth, idempotency header, body shape, payer-action link", async () => {
  const { pp, calls } = mk({
    "POST /v2/checkout/orders": () => [201, { id: "5O190127TN364715T", status: "PAYER_ACTION_REQUIRED", purchase_units: [{ amount: { currency_code: "USD", value: "45.00" }, description: "2 soy candles" }], links: [{ rel: "self", href: "s" }, { rel: "payer-action", href: "https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T" }] }],
  });
  const o = await pp.createOrder({ amount: 45, currency: "USD", description: "2 soy candles", returnUrl: "https://x/return", cancelUrl: "https://x/cancel" });
  assert.equal(o.id, "5O190127TN364715T"); assert.match(o.approveUrl!, /sandbox\.paypal\.com\/checkoutnow/);
  assert.equal(calls[0].path, "/v1/oauth2/token"); assert.equal(calls[0].headers.Authorization, "Basic " + Buffer.from("id:sec").toString("base64"));
  const c = calls[1];
  assert.equal(c.headers.Authorization, "Bearer A21AA-test"); assert.ok(c.headers["PayPal-Request-Id"]);
  assert.equal(c.body.intent, "CAPTURE"); assert.equal(c.body.purchase_units[0].amount.value, "45.00");
  assert.equal(c.body.payment_source.paypal.experience_context.return_url, "https://x/return");
});

test("token is cached across calls", async () => {
  const { pp, calls } = mk({ "GET /v2/checkout/orders/ABC1234567": () => [200, { id: "ABC1234567", status: "APPROVED", purchase_units: [{ amount: { currency_code: "USD", value: "1.00" } }] }] });
  await pp.getOrder("ABC1234567"); await pp.getOrder("ABC1234567");
  assert.equal(calls.filter((c) => c.path === "/v1/oauth2/token").length, 1);
});

test("capture uses deterministic PayPal-Request-Id; refund body; PayPal errors parsed with debug_id", async () => {
  const { pp, calls } = mk({
    "POST /v2/checkout/orders/ORD1234567/capture": () => [201, { id: "ORD1234567", status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: "CAP1234567", status: "COMPLETED", amount: { currency_code: "USD", value: "45.00" } }] } }] }],
    "POST /v2/payments/captures/CAP1234567/refund": (b) => [201, { id: "REF1234567", status: "COMPLETED", amount: b.amount }],
    "POST /v2/payments/captures/CAPBAD0000/refund": () => [422, { name: "UNPROCESSABLE_ENTITY", debug_id: "dbg42", details: [{ issue: "REFUND_AMOUNT_EXCEEDED", description: "The refund amount must be less than or equal to the capture amount." }] }],
  });
  const cap = await pp.captureOrder("ORD1234567");
  assert.equal(cap.captureId, "CAP1234567");
  assert.equal(calls.find((c) => c.path.endsWith("/capture"))!.headers["PayPal-Request-Id"], "capture-ORD1234567");
  const r = await pp.refundCapture("CAP1234567", 12, "USD", "cracked lid");
  assert.equal(r.amount.value, "12.00");
  assert.deepEqual(calls.at(-1)!.body, { amount: { value: "12.00", currency_code: "USD" }, note_to_payer: "cracked lid" });
  await assert.rejects(pp.refundCapture("CAPBAD0000", 99, "USD"), (e: any) => e.status === 422 && e.issue === "REFUND_AMOUNT_EXCEEDED" && e.debugId === "dbg42");
});

test("Payouts v1 create + get map batch and item statuses", async () => {
  const { pp, calls } = mk({
    "POST /v1/payments/payouts": () => [201, { batch_header: { payout_batch_id: "BATCH12345", batch_status: "PENDING" } }],
    "GET /v1/payments/payouts/BATCH12345": () => [200, { batch_header: { payout_batch_id: "BATCH12345", batch_status: "SUCCESS", amount: { currency: "USD", value: "45.00" } }, items: [{ payout_item_id: "IT1", transaction_status: "SUCCESS", payout_item: { receiver: "a@example.com", amount: { currency: "USD", value: "20.00" } } }] }],
  });
  const b = await pp.createPayouts([{ receiver: "a@example.com", amount: 20 }, { receiver: "b@example.com", amount: 25 }], "USD", "sb-1", "Payout");
  assert.equal(b.batchId, "BATCH12345"); assert.equal(b.total.value, "45.00");
  const req = calls.find((c) => c.path === "/v1/payments/payouts")!;
  assert.equal(req.headers["PayPal-Request-Id"], "sb-1");
  assert.equal(req.body.items[1].amount.value, "25.00"); assert.equal(req.body.items[0].recipient_type, "EMAIL");
  const g = await pp.getPayoutBatch("BATCH12345");
  assert.equal(g.status, "SUCCESS"); assert.equal(g.items[0].receiver, "a@example.com");
});

test("Disputes v1 list + get", async () => {
  const { pp } = mk({
    "GET /v1/customer/disputes": () => [200, { items: [{ dispute_id: "PP-D-27803", reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", status: "OPEN", dispute_amount: { currency_code: "USD", value: "38.00" }, create_time: "2026-10-26T10:00:00Z" }] }],
    "GET /v1/customer/disputes/PP-D-27803": () => [200, { dispute_id: "PP-D-27803", reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", status: "OPEN", dispute_amount: { currency_code: "USD", value: "38.00" }, messages: [{ posted_by: "BUYER", content: "Where is it?" }] }],
  });
  assert.equal((await pp.listDisputes())[0].id, "PP-D-27803");
  assert.deepEqual((await pp.getDispute("PP-D-27803")).messages, ["BUYER: Where is it?"]);
});

test("OAuth failure surfaces PayPal's error", async () => {
  const ff = fakeFetch({ "POST /v1/oauth2/token": () => [401, { error: "invalid_client", error_description: "Client Authentication failed" }] });
  const pp = new SandboxPayPal({ base: "https://api-m.sandbox.paypal.com", clientId: "id", secret: "bad", fetchImpl: ff.f });
  await assert.rejects(pp.listDisputes(), /Client Authentication failed/);
});
