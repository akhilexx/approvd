// Replays redacted traffic recorded live from api-m.sandbox.paypal.com (scripts/sandbox-e2e.ts --record)
// through the real SandboxPayPal adapter, so the adapter is pinned to what PayPal actually returned.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { SandboxPayPal } from "../src/paypal/sandbox.ts";
import { PayPalError } from "../src/paypal/types.ts";
import { redactValue, assertClean } from "../scripts/redact.ts";

const DIR = new URL("./fixtures/sandbox/", import.meta.url);
const load = (name: string) => JSON.parse(readFileSync(new URL(`${name}.json`, DIR), "utf8")).calls as any[];
const has = (name: string) => existsSync(new URL(`${name}.json`, DIR));

/** fetch that answers OAuth from the recorded token call and everything else from `calls`, in order, checking method+path. */
function replay(calls: any[]) {
  const token = load("oauth-token")[0].response;
  const queue = calls.filter((c) => !c.request.path.endsWith("/oauth2/token"));
  const fetchImpl = (async (input: any, init: any) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/oauth2/token")) return new Response(JSON.stringify(token.body), { status: token.status });
    const next = queue.shift();
    assert.ok(next, `unexpected call ${init?.method} ${url.pathname}`);
    assert.equal(init?.method ?? "GET", next.request.method);
    assert.equal(url.pathname + url.search, next.request.path);
    if (init?.method && init.method !== "GET") assert.ok(init.headers["PayPal-Request-Id"], "writes must carry PayPal-Request-Id");
    return new Response(JSON.stringify(next.response.body), { status: next.response.status });
  }) as typeof fetch;
  return new SandboxPayPal({ base: "https://api-m.sandbox.paypal.com", clientId: "test-client", secret: "test-secret", fetchImpl });
}

test("live fixture: create order returns PAYER_ACTION_REQUIRED with a sandbox payer-action link", async () => {
  const c = load("create_order"); const gw = replay(c);
  const body = c[c.length - 1].request.body;
  const o = await gw.createOrder({ amount: Number(body.purchase_units[0].amount.value), currency: "USD", description: body.purchase_units[0].description, returnUrl: "x", cancelUrl: "y" });
  assert.equal(o.status, "PAYER_ACTION_REQUIRED");
  assert.match(o.approveUrl!, /^https:\/\/www\.sandbox\.paypal\.com\/checkoutnow\?token=/);
  assert.equal(o.amount.value, "45.00");
});

test("live fixture: get order maps status and amount", async () => {
  const c = load("get_order"); const id = c[c.length - 1].request.path.split("/").pop();
  const o = await replay(c).getOrder(id);
  assert.equal(o.id, id); assert.equal(o.status, "PAYER_ACTION_REQUIRED"); assert.equal(o.amount.value, "45.00");
});

test("live fixture: capturing an unapproved order raises 422 ORDER_NOT_APPROVED", async () => {
  const c = load("capture_unapproved_rejected"); const id = c[c.length - 1].request.path.split("/")[4];
  await assert.rejects(replay(c).captureOrder(id), (e: any) => e instanceof PayPalError && e.status === 422 && e.issue === "ORDER_NOT_APPROVED" && !!e.debugId);
});

test("live fixture: card order is paid and captured in one call (US sandbox, test card)", async () => {
  const c = load("card_order"); const last = c[c.length - 1];
  const p = replay(c).createCardTestOrder(10, "USD", { number: "4111111111111111", expiry: "2030-12", securityCode: "123", name: "T" });
  if (last.response.status >= 400) return void await assert.rejects(p, (e: any) => e.issue === "PAYEE_NOT_ENABLED_FOR_CARD_PROCESSING" && /Advanced Credit and Debit Card/.test(e.message));
  const o = await p; assert.equal(o.status, "COMPLETED"); assert.ok(o.captureId);
  assert.equal(last.request.body.payment_source.card.number, "[TEST CARD]", "card data is redacted in the fixture");
});

test("live fixture: partial refund, then capture is PARTIALLY_REFUNDED", async () => {
  const c = load("refund_partial"); const cap = c[0].request.path.split("/")[4];
  const r = await replay(c).refundCapture(cap, Number(c[0].request.body.amount.value), "USD", c[0].request.body.note_to_payer);
  assert.equal(r.status, "COMPLETED"); assert.equal(r.amount.value, c[0].request.body.amount.value);
  assert.equal((await replay(load("get_capture_after_partial")).getCapture(cap)).status, "PARTIALLY_REFUNDED");
});

test("live fixture: full refund of the remainder (no amount), then capture is REFUNDED", async () => {
  const c = load("refund_full_remainder"); const cap = c[0].request.path.split("/")[4];
  assert.equal(c[0].request.body.amount, undefined, "a full refund sends no amount");
  const r = await replay(c).refundCapture(cap, undefined, "USD", c[0].request.body.note_to_payer);
  assert.equal(r.status, "COMPLETED"); assert.ok(Number(r.amount.value) > 0);
  assert.equal((await replay(load("get_capture_after_full")).getCapture(cap)).status, "REFUNDED");
});

test("live fixture: refunding a fully refunded capture is rejected (422 CAPTURE_FULLY_REFUNDED)", async () => {
  const c = load("refund_over_limit_rejected"); const cap = c[0].request.path.split("/")[4];
  await assert.rejects(replay(c).refundCapture(cap, 0.5, "USD"), (e: any) => e instanceof PayPalError && e.status === 422 && e.issue === "CAPTURE_FULLY_REFUNDED");
});

test("live fixture: payouts batch is created, then reaches SUCCESS (claimed) / UNCLAIMED per item", async () => {
  const c = load("create_payout"); const last = c[c.length - 1];
  const items = last.request.body.items.map((i: any) => ({ receiver: i.receiver, amount: Number(i.amount.value), note: i.note }));
  const p = replay(c).createPayouts(items, "USD", last.request.body.sender_batch_header.sender_batch_id, "s");
  if (last.response.status >= 400) return void await assert.rejects(p, (e: any) => e.issue === last.response.body.name);
  const b = await p; assert.ok(b.batchId); assert.equal(b.total.value, "3.75");
  const g = load("get_payout"); const fin = await replay([g[g.length - 1]]).getPayoutBatch(b.batchId);
  assert.equal(fin.status, "SUCCESS");
  assert.deepEqual(fin.items.map((i) => i.status).sort(), ["SUCCESS", "UNCLAIMED"]);
});

test("live fixture: duplicate sender_batch_id is rejected; Payouts' error shape maps to the code in `name`", async () => {
  const c = load("payout_duplicate_sender_batch_rejected"); const b = c[c.length - 1].request.body;
  await assert.rejects(replay(c).createPayouts(b.items.map((i: any) => ({ receiver: i.receiver, amount: Number(i.amount.value) })), "USD", b.sender_batch_header.sender_batch_id, "dup"),
    (e: any) => e instanceof PayPalError && e.status === 400 && e.issue === "USER_BUSINESS_ERROR" && /already exists/.test(e.message));
});

test("live fixture: list disputes maps the (possibly empty) list", async () => {
  const c = load("list_disputes"); const ds = await replay(c).listDisputes();
  assert.equal(ds.length, (c[c.length - 1].response.body.items ?? []).length);
});

test("live fixture: wallet order capture after buyer approval", { skip: !has("capture_order") && "not recorded yet: needs one sandbox buyer approval in a browser" }, async () => {
  const c = load("capture_order"); const id = c[0].request.path.split("/")[4];
  const r = await replay(c).captureOrder(id); assert.equal(r.status, "COMPLETED"); assert.ok(r.captureId);
});

test("fixtures are redacted: no tokens, long credential-like strings, auth headers or sandbox account emails", () => {
  for (const f of readdirSync(DIR).filter((f) => f.endsWith(".json"))) {
    const text = readFileSync(new URL(f, DIR), "utf8");
    assert.doesNotMatch(text, /A21AA[A-Za-z0-9_-]{20,}/, `${f}: access token`);
    assert.doesNotMatch(text, /"[A-Za-z0-9_-]{60,}"/, `${f}: credential-like string`);
    assert.doesNotMatch(text, /(Bearer|Basic) [A-Za-z0-9+/=_-]{16,}/, `${f}: auth header`);
    assert.doesNotMatch(text, /sb-[a-z0-9]+@(business|personal)\.example\.com/i, `${f}: sandbox account email`);
    assert.doesNotThrow(() => assertClean(text, ["test-secret-value"]));
  }
});

test("redactValue scrubs secrets, tokens, ids and sandbox account emails", () => {
  const out = JSON.stringify(redactValue({ access_token: "A21AAabc", nested: { payer_id: "XYZ", note: "key s3cretVALUE here", email_address: "sb-abc123@personal.example.com" } }, ["s3cretVALUE"]));
  assert.doesNotMatch(out, /A21AAabc|XYZ|s3cretVALUE|sb-abc123/);
  assert.throws(() => assertClean("contains s3cretVALUE", ["s3cretVALUE"]), /Redaction failure/);
});
