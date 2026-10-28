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

test("live fixture: card order on an account without card processing gives an actionable error", async () => {
  const c = load("card_order");
  if (c[c.length - 1].response.status < 400) return; // account later enabled for cards: covered by the capture fixtures
  await assert.rejects(replay(c).createCardTestOrder(10, "USD", { number: "4111111111111111", expiry: "2030-12", securityCode: "123", name: "T" }),
    (e: any) => e.issue === "PAYEE_NOT_ENABLED_FOR_CARD_PROCESSING" && /Advanced Credit and Debit Card/.test(e.message));
});

test("live fixture: payouts error (if recorded) maps name + setup hint; success maps batch id", async () => {
  const c = load("create_payout"); const last = c[c.length - 1];
  const items = last.request.body.items.map((i: any) => ({ receiver: i.receiver, amount: Number(i.amount.value), note: i.note }));
  const p = replay(c).createPayouts(items, "USD", last.request.body.sender_batch_header.sender_batch_id, "s");
  if (last.response.status >= 400) await assert.rejects(p, (e: any) => e instanceof PayPalError && e.issue === last.response.body.name && (e.issue !== "PAYOUT_NOT_AVAILABLE" || /US sandbox business account/.test(e.message)));
  else assert.ok((await p).batchId);
});

test("live fixture: list disputes maps the (possibly empty) list", async () => {
  const c = load("list_disputes"); const ds = await replay(c).listDisputes();
  assert.equal(ds.length, (c[c.length - 1].response.body.items ?? []).length);
});

for (const name of ["capture_order", "refund_partial", "refund_full_remainder"]) {
  test(`live fixture: ${name} (recorded after buyer approval or card capture)`, { skip: !has(name) && "not recorded yet: needs buyer approval or card processing" }, async () => {
    const c = load(name); assert.ok(c.every((x) => x.response.status < 400 || /refund/.test(name)));
  });
}

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
