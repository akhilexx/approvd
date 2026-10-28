// Live end-to-end test against the PayPal REST *sandbox* (never live).
//   npm run e2e:sandbox                    full run: OAuth, orders, card capture+refunds (if enabled), payouts, disputes, agent
//   npm run e2e:sandbox -- capture <ID>    after a sandbox buyer approved order <ID> in the browser: capture, partial + full refund
//   npm run e2e:sandbox -- disputes        READ-ONLY: list disputes, show the first, run the agent's draft-only triage (GET calls only)
//   add --record to (re)write redacted fixtures into test/fixtures/sandbox/
// Credentials come only from the environment or the git-ignored .env. Every line printed and every fixture written is
// redacted and then checked for secrets; the run aborts if anything leaks.
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { loadDotEnv, readConfig } from "../src/config.ts";
import { SandboxPayPal } from "../src/paypal/sandbox.ts";
import { createApp } from "../src/app.ts";
import { PayPalError } from "../src/paypal/types.ts";
import { redactValue, assertClean } from "./redact.ts";

loadDotEnv();
const cfg = readConfig();
if (cfg.paypalMode !== "sandbox" || !/api-m\.sandbox\.paypal\.com/.test(cfg.paypalApiBase)) {
  console.error("Refusing to run: needs PAYPAL_MODE=sandbox and the sandbox API base (api-m.sandbox.paypal.com).");
  process.exit(2);
}
const args = process.argv.slice(2);
const RECORD = args.includes("--record");
const buyer = process.env.SANDBOX_BUYER_EMAIL ?? "";
const business = process.env.SANDBOX_BUSINESS_EMAIL ?? "";
const secrets: string[] = [cfg.paypalClientId, cfg.paypalClientSecret, Buffer.from(`${cfg.paypalClientId}:${cfg.paypalClientSecret}`).toString("base64"), buyer, business];

// ---- safe output ----
const clean = (v: unknown) => { const t = typeof v === "string" ? (redactValue(v, secrets) as string) : JSON.stringify(redactValue(v, secrets)); assertClean(t, secrets); return t; };
const log = (...parts: unknown[]) => console.log(parts.map(clean).join(" "));
const results: { step: string; ok: boolean | "blocked"; detail: string }[] = [];
const result = (step: string, ok: boolean | "blocked", detail: string) => { results.push({ step, ok, detail: clean(detail) }); log(`${ok === true ? "PASS" : ok === "blocked" ? "BLOCKED" : "FAIL"}  ${step}: ${detail}`); };

// ---- recording fetch (redacted) ----
let label = "unlabelled";
const READ_ONLY = args[0] === "disputes";
const fixtures: Record<string, any[]> = {};
const recFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  if (READ_ONLY && (init?.method ?? "GET") !== "GET" && !url.pathname.endsWith("/oauth2/token")) throw new Error(`read-only mode refused ${init?.method} ${url.pathname}`);
  const res = await fetch(input, init);
  const text = await res.clone().text();
  let body: unknown = text; try { body = text ? JSON.parse(text) : {}; } catch {}
  const reqHeaders = init?.headers as Record<string, string> | undefined;
  let reqBody: unknown = init?.body ? String(init.body) : undefined;
  try { if (typeof reqBody === "string" && reqBody.startsWith("{")) reqBody = JSON.parse(reqBody); } catch {}
  if (typeof reqBody === "object" && (reqBody as any)?.payment_source?.card) (reqBody as any).payment_source.card = { number: "[TEST CARD]", expiry: "[REDACTED]", security_code: "[REDACTED]", name: "Test Buyer" };
  const entry = redactValue({
    request: { method: init?.method ?? "GET", path: url.pathname + url.search, paypalRequestId: reqHeaders?.["PayPal-Request-Id"] ? "<set>" : undefined, prefer: reqHeaders?.Prefer, body: reqBody },
    response: { status: res.status, body },
  }, secrets);
  const key = url.pathname.endsWith("/oauth2/token") ? "oauth-token" : label;
  (fixtures[key] ??= []).push(entry);
  return res;
};

const gw = new SandboxPayPal({ base: cfg.paypalApiBase, clientId: cfg.paypalClientId, secret: cfg.paypalClientSecret, fetchImpl: recFetch });
const step = async <T>(name: string, fn: () => Promise<T>): Promise<T | undefined> => {
  label = name;
  try { return await fn(); } catch (e: any) { result(name, false, e instanceof PayPalError ? `${e.status} ${e.issue}: ${e.message}` : String(e?.message ?? e)); return undefined; }
};
const expectError = async (name: string, fn: () => Promise<unknown>, issueRe: RegExp) => {
  label = name;
  try { await fn(); result(name, false, "expected PayPal to reject this call, but it succeeded"); }
  catch (e: any) { const ok = e instanceof PayPalError && issueRe.test(e.issue); result(name, ok, `${e.status ?? ""} ${e.issue ?? ""}: ${e.message}`); return e; }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ret = { returnUrl: `${cfg.publicBaseUrl}/return`, cancelUrl: `${cfg.publicBaseUrl}/cancel` };

async function captureAndRefund(orderId: string) {
  const cap = await step("capture_order", () => gw.captureOrder(orderId));
  if (!cap) return;
  result("capture_order", cap.status === "COMPLETED", `order ${orderId} -> capture ${cap.captureId} ${cap.status} ${cap.amount.value} ${cap.amount.currency}`);
  const again = await step("capture_order_idempotent_retry", () => gw.captureOrder(orderId));
  if (again) result("capture_order_idempotent_retry", again.captureId === cap.captureId, `same PayPal-Request-Id returned capture ${again.captureId}`);
  await refunds(cap.captureId, Number(cap.amount.value));
}

async function refunds(captureId: string, total: number) {
  const part = Math.min(1, Math.round(total * 30) / 100);
  const r1 = await step("refund_partial", () => gw.refundCapture(captureId, part, cfg.currency, "Approvd sandbox e2e: partial refund"));
  if (r1) result("refund_partial", r1.status === "COMPLETED" || r1.status === "PENDING", `${r1.refundId} ${r1.status} ${r1.amount.value}`);
  const c1 = await step("get_capture_after_partial", () => gw.getCapture(captureId));
  if (c1) result("get_capture_after_partial", c1.status === "PARTIALLY_REFUNDED", `capture status ${c1.status}`);
  const r2 = await step("refund_full_remainder", () => gw.refundCapture(captureId, undefined, cfg.currency, "Approvd sandbox e2e: refund the rest"));
  if (r2) result("refund_full_remainder", r2.status === "COMPLETED" || r2.status === "PENDING", `${r2.refundId} ${r2.status} ${r2.amount.value}`);
  const c2 = await step("get_capture_after_full", () => gw.getCapture(captureId));
  if (c2) result("get_capture_after_full", c2.status === "REFUNDED", `capture status ${c2.status}`);
  await expectError("refund_over_limit_rejected", () => gw.refundCapture(captureId, 0.5, cfg.currency), /CAPTURE_FULLY_REFUNDED|REFUND_AMOUNT_EXCEEDED|REFUND_NOT_ALLOWED/);
}

async function full() {
  // 1. OAuth + Orders v2 (PayPal wallet checkout)
  const o = await step("create_order", () => gw.createOrder({ amount: 45, currency: cfg.currency, description: "2 soy candles (Approvd sandbox e2e)", ...ret }));
  if (o) result("oauth+create_order", o.status === "PAYER_ACTION_REQUIRED" && !!o.approveUrl?.startsWith("https://www.sandbox.paypal.com/"), `${o.id} ${o.status} approve: ${o.approveUrl}`);
  if (o) {
    const g = await step("get_order", () => gw.getOrder(o.id));
    if (g) result("get_order", g.id === o.id && g.amount.value === "45.00", `${g.id} ${g.status} ${g.amount.value}`);
    await expectError("capture_unapproved_rejected", () => gw.captureOrder(o.id), /ORDER_NOT_APPROVED|PAYER_ACTION_REQUIRED/);
    result("buyer_approval_wallet", "blocked", `needs a sandbox buyer to log in at the approve link in a browser, then run: npm run e2e:sandbox -- capture ${o.id}`);
  }
  // 2. Card path (no buyer login): PayPal sandbox test card
  label = "card_order";
  try {
    const co = await gw.createCardTestOrder(10, cfg.currency, { number: process.env.SANDBOX_TEST_CARD ?? "4111111111111111", expiry: "2030-12", securityCode: "123", name: "Test Buyer" });
    result("card_order_capture", co.status === "COMPLETED" && !!co.captureId, `${co.id} ${co.status} capture ${co.captureId}`);
    if (co.captureId) await refunds(co.captureId, 10);
  } catch (e: any) {
    if (e?.issue === "PAYEE_NOT_ENABLED_FOR_CARD_PROCESSING") result("card_order_capture", "blocked", "422 PAYEE_NOT_ENABLED_FOR_CARD_PROCESSING: enable Advanced Credit and Debit Card Payments on the sandbox app to test capture/refund headlessly");
    else result("card_order_capture", false, `${e?.status ?? ""} ${e?.issue ?? ""} ${e?.message}`);
  }
  // 3. Payouts v1
  const batchId = `approvd-e2e-${Date.now()}`;
  const items = [{ receiver: buyer || "sandbox-buyer@example.com", amount: 2.5, note: "Approvd e2e courier payout" }, { receiver: "unclaimed-courier@example.com", amount: 1.25, note: "Approvd e2e unclaimed payout" }];
  const p = await step("create_payout", () => gw.createPayouts(items, cfg.currency, batchId, "Approvd sandbox e2e payout"));
  if (p) {
    result("create_payout", !!p.batchId, `${p.batchId} ${p.status} total ${p.total.value}`);
    await expectError("payout_duplicate_sender_batch_rejected", () => gw.createPayouts(items, cfg.currency, batchId, "dup"), /DUPLICATE|SENDER_BATCH_ID|USER_BUSINESS_ERROR/i);
    let b = await step("get_payout", () => gw.getPayoutBatch(p.batchId));
    for (let i = 0; i < 8 && b && /PENDING|PROCESSING/.test(b.status); i++) { await sleep(4000); b = await step("get_payout", () => gw.getPayoutBatch(p.batchId)); }
    if (b) result("get_payout", /SUCCESS|PROCESSING|PENDING/.test(b.status), `${b.status}; items: ${b.items.map((x) => `${x.receiver}=${x.status}`).join(", ")}`);
  }
  // 4. Disputes v1 (read)
  const ds = await step("list_disputes", () => gw.listDisputes());
  if (ds) result("list_disputes", true, `${ds.length} dispute(s)`);
  if (ds?.length) { const d = await step("get_dispute", () => gw.getDispute(ds[0].id)); if (d) result("get_dispute", d.id === ds[0].id, `${d.id} ${d.reason} ${d.status}`); }
  else result("get_dispute", "blocked", "no disputes exist on this sandbox account yet (open one as the sandbox buyer in the Resolution Center)");
  // 5. Whole agent (mock planner, real sandbox gateway, real policy engine)
  label = "agent";
  const app = createApp({ env: { ...process.env, LLM_MODE: "mock" }, gateway: gw });
  const r1 = await app.agent.chat("e2e", "Create a $45 checkout for 2 soy candles for priya@example.com");
  result("agent:create_order", r1.steps[0]?.status === "executed", r1.reply.split("\n")[0]);
  const r2 = await app.agent.chat("e2e", "Check the status of that order");
  result("agent:get_order", r2.steps[0]?.status === "executed", r2.reply.split("\n")[0]);
  const r3 = await app.agent.chat("e2e", "Capture it");
  result("agent:capture_unapproved_reports_error", r3.steps[0]?.status === "failed", r3.reply.split("\n")[0]);
  const r4 = await app.agent.chat("e2e", "Pay asha@example.com $2 for October deliveries");
  result("agent:payout_auto_allowed", r4.steps[0]?.status === "executed", r4.reply.split("\n")[0]);
  const r5 = await app.agent.chat("e2e", "Send $60 to newvendor@mail.test for packaging");
  const apr = r5.steps.find((s) => s.approvalId)?.approvalId;
  result("agent:payout_needs_approval", !!apr, r5.reply.split("\n")[0]);
  if (apr) { const a = await app.engine.approve(apr, "e2e"); result("agent:approved_payout_executes", a.status === "approved" || a.status === "executed", `${a.status} ${a.result?.batchId ?? a.error ?? ""}`); }
  const r6 = await app.agent.chat("e2e", "Pay maya@example.com $900 for the photo shoot");
  result("agent:hard_limit_denied", r6.steps[0]?.status === "denied", r6.reply.split("\n")[0]);
  const r7 = await app.agent.chat("e2e", "List open disputes");
  result("agent:list_disputes", r7.steps[0]?.status === "executed", r7.reply.split("\n")[0]);
}

// Disputes v1, read-only: never accepts, offers, escalates, messages or refunds.
async function disputes() {
  const ds = await step("list_disputes", () => gw.listDisputes());
  if (ds) result("list_disputes", ds.length > 0, `${ds.length} dispute(s)${ds[0] ? `; first ${ds[0].id} ${ds[0].reason} ${ds[0].status} stage ${ds[0].stage}` : ""}`);
  if (!ds?.length) return void result("get_dispute", "blocked", "no disputes exist on this sandbox account yet");
  const d = await step("get_dispute", () => gw.getDispute(ds[0].id));
  if (d) result("get_dispute", d.id === ds[0].id && !!d.reason && !!d.stage, `${d.id} ${d.reason} ${d.status} stage ${d.stage}; capture ${d.captureId} ${d.transactionStatus}; buyer asks ${d.buyerRequested?.value ?? "-"}; allowed: ${(d.allowedResponses ?? []).join(", ")}`);
  label = "agent_dispute_triage";
  const app = createApp({ env: { ...process.env, LLM_MODE: "mock" }, gateway: gw });
  const r1 = await app.agent.chat("e2e", "List open disputes");
  result("agent:list_disputes", r1.steps[0]?.status === "executed", r1.reply.split("\n")[0]);
  const r2 = await app.agent.chat("e2e", "Draft a reply to the first dispute");
  result("agent:draft_dispute_reply", r2.steps[0]?.call.name === "get_dispute" && r2.steps[0]?.status === "executed" && /Not submitted/.test(r2.reply), r2.reply.replace(/\n/g, " | "));
  result("agent:dispute_triage_moved_no_money", app.engine.ledger.every((e: any) => !/refund|payout|capture/.test(e.call?.name ?? e.tool ?? "")), `${app.engine.ledger.length} ledger row(s), read-only tools only`);
}

async function main() {
  log(`Approvd sandbox e2e against ${cfg.paypalApiBase} (${new Date().toISOString()})`);
  if (args[0] === "disputes") await disputes();
  else if (args[0] === "capture") { if (!args[1]) throw new Error("usage: npm run e2e:sandbox -- capture <ORDER_ID>"); await captureAndRefund(args[1]); }
  else await full();
  const pass = results.filter((r) => r.ok === true).length, fail = results.filter((r) => r.ok === false).length, blocked = results.filter((r) => r.ok === "blocked").length;
  log(`\nSummary: ${pass} passed, ${fail} failed, ${blocked} blocked`);
  if (RECORD) {
    const dir = resolve("test/fixtures/sandbox"); mkdirSync(dir, { recursive: true });
    for (const [k, v] of Object.entries(fixtures)) {
      if (READ_ONLY && k === "oauth-token") continue; // keep the existing token fixture
      const text = JSON.stringify({ recordedAt: new Date().toISOString(), note: "Recorded from api-m.sandbox.paypal.com; redacted (tokens, ids, account emails).", calls: v }, null, 2) + "\n";
      assertClean(text, secrets); writeFileSync(resolve(dir, `${k}.json`), text);
    }
    const mode = args[0] === "capture" || args[0] === "disputes" ? args[0] : "full";
    const summary = JSON.stringify({ ranAt: new Date().toISOString(), mode, results }, null, 2) + "\n";
    assertClean(summary, secrets); writeFileSync(resolve(dir, mode === "full" ? "_results.json" : `_results-${mode}.json`), summary);
    log(`Recorded ${Object.keys(fixtures).length} redacted fixture files to test/fixtures/sandbox/`);
  }
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error("e2e aborted:", e instanceof Error && /Redaction failure/.test(e.message) ? e.message : clean(String(e?.message ?? e))); process.exit(1); });
