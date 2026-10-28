// Real PayPal REST sandbox adapter (https://api-m.sandbox.paypal.com).
// APIs used: OAuth2 client credentials, Orders v2, Payments v2 (captures/refunds), Payouts v1, Disputes v1.
// Every write sends a PayPal-Request-Id so retries are idempotent.
import { randomUUID } from "node:crypto";
import {
  PayPalError, toMoney,
  type CaptureInfo, type CaptureResult, type CreateOrderInput, type DisputeSummary, type Money, type OrderSummary,
  type PayoutBatchResult, type PayoutItemInput, type PayPalGateway, type RefundResult,
} from "./types.ts";

type Fetch = typeof fetch;
// Account-setup errors seen live on the sandbox, with what to change. Appended to the PayPal message so the agent
// and the console tell the merchant how to fix it instead of only echoing the code.
export const SETUP_HINTS: Record<string, string> = {
  PAYOUT_NOT_AVAILABLE: "Hint: PayPal Payouts is not available for this business account's country. Use a US sandbox business account for the app (developer.paypal.com > Sandbox > Accounts).",
  PAYEE_NOT_ENABLED_FOR_CARD_PROCESSING: "Hint: enable Advanced Credit and Debit Card Payments for the sandbox app, or use a US sandbox business account.",
  AUTHORIZATION_ERROR: "Hint: this sandbox app is missing the permission for this API. Enable the feature under Apps & Credentials > your app > Features.",
  NOT_AUTHORIZED: "Hint: this sandbox app is missing the permission for this API. Enable the feature under Apps & Credentials > your app > Features.",
};
const m = (a: any): Money => ({ currency: a?.currency_code ?? a?.currency ?? "USD", value: String(a?.value ?? "0") });

export class SandboxPayPal implements PayPalGateway {
  readonly mode = "sandbox" as const;
  private token?: { value: string; expiresAt: number };
  private base: string; private clientId: string; private secret: string; private fetchImpl: Fetch;

  constructor(opts: { base: string; clientId: string; secret: string; fetchImpl?: Fetch }) {
    if (!opts.clientId || !opts.secret) throw new Error("PAYPAL_MODE=sandbox needs PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (sandbox app credentials).");
    if (!/sandbox/.test(opts.base)) throw new Error("SandboxPayPal only talks to the PayPal sandbox.");
    this.base = opts.base; this.clientId = opts.clientId; this.secret = opts.secret; this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt - 60_000) return this.token.value;
    const res = await this.fetchImpl(`${this.base}/v1/oauth2/token`, {
      method: "POST",
      headers: { Authorization: "Basic " + Buffer.from(`${this.clientId}:${this.secret}`).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new PayPalError(res.status, body.error ?? "AUTH_FAILED", body.error_description ?? "PayPal OAuth failed");
    this.token = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 300) * 1000 };
    return this.token.value;
  }

  private async call(method: string, path: string, body?: unknown, requestId?: string): Promise<any> {
    const headers: Record<string, string> = { Authorization: `Bearer ${await this.accessToken()}`, "Content-Type": "application/json", Prefer: "return=representation" };
    if (method !== "GET") headers["PayPal-Request-Id"] = requestId ?? randomUUID();
    const res = await this.fetchImpl(`${this.base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    const json: any = text ? JSON.parse(text) : {};
    if (!res.ok) {
      // Orders/Payments put a code in details[0].issue; Payouts puts a sentence there and the code in `name`.
      const d0 = json.details?.[0];
      const codeLike = typeof d0?.issue === "string" && /^[A-Z0-9_]+$/.test(d0.issue);
      const issue = (codeLike ? d0.issue : json.name) ?? "PAYPAL_ERROR";
      const msg = (codeLike ? d0?.description ?? json.message : [d0?.issue, json.message].filter(Boolean).join(". ")) || `PayPal ${res.status}`;
      throw new PayPalError(res.status, issue, SETUP_HINTS[issue] ? `${msg} ${SETUP_HINTS[issue]}` : msg, json.debug_id);
    }
    return json;
  }

  private order(j: any): OrderSummary {
    const pu = j.purchase_units?.[0] ?? {};
    const cap = pu.payments?.captures?.[0];
    const link = (j.links ?? []).find((l: any) => l.rel === "payer-action" || l.rel === "approve");
    return { id: j.id, status: j.status, amount: m(pu.amount), description: pu.description ?? "", approveUrl: link?.href, captureId: cap?.id, payerEmail: j.payer?.email_address };
  }

  async createOrder(i: CreateOrderInput): Promise<OrderSummary> {
    const j = await this.call("POST", "/v2/checkout/orders", {
      intent: "CAPTURE",
      purchase_units: [{ reference_id: i.referenceId ?? "default", description: i.description.slice(0, 127), amount: { currency_code: i.currency, value: i.amount.toFixed(2) } }],
      payment_source: { paypal: { experience_context: { return_url: i.returnUrl, cancel_url: i.cancelUrl, user_action: "PAY_NOW", shipping_preference: "NO_SHIPPING", brand_name: "Approvd demo store" } } },
    });
    return this.order(j);
  }
  /**
   * Sandbox-only test helper (not part of PayPalGateway, never exposed to the agent): pay an order directly with
   * one of PayPal's documented sandbox test cards, so capture and refund can be exercised with no buyer login.
   * Requires "Advanced Credit and Debit Card Payments" to be enabled for the sandbox app; otherwise PayPal answers
   * 422 PAYEE_NOT_ENABLED_FOR_CARD_PROCESSING.
   */
  async createCardTestOrder(amount: number, currency: string, card: { number: string; expiry: string; securityCode: string; name: string }, description = "Approvd sandbox card test"): Promise<OrderSummary> {
    const j = await this.call("POST", "/v2/checkout/orders", {
      intent: "CAPTURE",
      purchase_units: [{ reference_id: "card-test", description, amount: { currency_code: currency, value: amount.toFixed(2) } }],
      payment_source: { card: { number: card.number, expiry: card.expiry, security_code: card.securityCode, name: card.name } },
    });
    return this.order(j);
  }
  async getOrder(orderId: string) { return this.order(await this.call("GET", `/v2/checkout/orders/${encodeURIComponent(orderId)}`)); }

  async captureOrder(orderId: string): Promise<CaptureResult> {
    const j = await this.call("POST", `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {}, `capture-${orderId}`);
    const cap = j.purchase_units?.[0]?.payments?.captures?.[0];
    return { orderId: j.id, status: cap?.status ?? j.status, captureId: cap?.id, amount: m(cap?.amount) };
  }
  async getCapture(captureId: string): Promise<CaptureInfo> {
    const j = await this.call("GET", `/v2/payments/captures/${encodeURIComponent(captureId)}`);
    return { captureId: j.id, status: j.status, amount: m(j.amount) };
  }
  async refundCapture(captureId: string, amount: number | undefined, currency: string, note?: string): Promise<RefundResult> {
    const body: any = {};
    if (amount !== undefined) body.amount = { value: amount.toFixed(2), currency_code: currency };
    if (note) body.note_to_payer = note.slice(0, 255);
    const j = await this.call("POST", `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, body);
    return { refundId: j.id, captureId, status: j.status, amount: m(j.amount ?? body.amount) };
  }
  async createPayouts(items: PayoutItemInput[], currency: string, senderBatchId: string, subject: string): Promise<PayoutBatchResult> {
    const j = await this.call("POST", "/v1/payments/payouts", {
      sender_batch_header: { sender_batch_id: senderBatchId, email_subject: subject, email_message: "Sent by Approvd (sandbox demo)." },
      items: items.map((i, n) => ({ recipient_type: "EMAIL", receiver: i.receiver, note: i.note ?? "Payout", sender_item_id: `${senderBatchId}-${n}`, amount: { value: i.amount.toFixed(2), currency } })),
    }, senderBatchId);
    const total = items.reduce((s, i) => s + i.amount, 0);
    return { batchId: j.batch_header.payout_batch_id, status: j.batch_header.batch_status, total: toMoney(total, currency), items: items.map((i) => ({ receiver: i.receiver, amount: toMoney(i.amount, currency), status: "PENDING" })) };
  }
  async getPayoutBatch(batchId: string): Promise<PayoutBatchResult> {
    const j = await this.call("GET", `/v1/payments/payouts/${encodeURIComponent(batchId)}`);
    return {
      batchId: j.batch_header.payout_batch_id, status: j.batch_header.batch_status, total: m(j.batch_header.amount),
      items: (j.items ?? []).map((it: any) => ({ receiver: it.payout_item?.receiver, amount: m(it.payout_item?.amount), status: it.transaction_status, itemId: it.payout_item_id })),
    };
  }
  async listDisputes(): Promise<DisputeSummary[]> {
    const j = await this.call("GET", "/v1/customer/disputes?page_size=10");
    return (j.items ?? []).map((d: any) => ({ id: d.dispute_id, reason: d.reason, status: d.status, amount: m(d.dispute_amount), createTime: d.create_time }));
  }
  async getDispute(disputeId: string) {
    const d = await this.call("GET", `/v1/customer/disputes/${encodeURIComponent(disputeId)}`);
    return { id: d.dispute_id, reason: d.reason, status: d.status, amount: m(d.dispute_amount), createTime: d.create_time, messages: (d.messages ?? []).map((x: any) => `${x.posted_by}: ${x.content}`) };
  }
}
