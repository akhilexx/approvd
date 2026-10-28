// Offline PayPal simulator. Mirrors the sandbox state machine closely enough that the agent,
// policy engine and UI behave the same way they do against api-m.sandbox.paypal.com:
//  - orders start PAYER_ACTION_REQUIRED (as the live sandbox returns when payment_source.paypal is used) and cannot be captured until a buyer approves them (ORDER_NOT_APPROVED)
//  - captures can be refunded partially, never beyond the captured amount (REFUND_AMOUNT_EXCEEDED)
//  - payouts to receivers on @unclaimed.example come back UNCLAIMED, like a payee with no account
import { randomBytes } from "node:crypto";
import {
  PayPalError, toMoney, moneyNum,
  type CaptureInfo, type CaptureResult, type CreateOrderInput, type DisputeSummary, type OrderSummary,
  type PayoutBatchResult, type PayoutItemInput, type PayPalGateway, type RefundResult,
} from "./types.ts";

const id = (prefix: string, n = 17) => prefix + randomBytes(n).toString("hex").toUpperCase().slice(0, n);

interface MockOrder extends OrderSummary { returnUrl: string; cancelUrl: string }
interface MockCapture extends CaptureInfo { orderId: string; refunded: number }

export class MockPayPal implements PayPalGateway {
  readonly mode = "mock" as const;
  orders = new Map<string, MockOrder>();
  captures = new Map<string, MockCapture>();
  payouts = new Map<string, PayoutBatchResult>();
  disputes: DisputeSummary[];
  publicBaseUrl: string;

  constructor(publicBaseUrl = "http://localhost:8787") {
    this.publicBaseUrl = publicBaseUrl;
    this.disputes = [
      { id: "PP-D-" + id("", 5), reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", status: "OPEN", amount: toMoney(38, "USD"), createTime: new Date(Date.now() - 2 * 864e5).toISOString() },
      { id: "PP-D-" + id("", 5), reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED", status: "WAITING_FOR_SELLER_RESPONSE", amount: toMoney(112.5, "USD"), createTime: new Date(Date.now() - 5 * 864e5).toISOString() },
    ];
  }

  async createOrder(input: CreateOrderInput): Promise<OrderSummary> {
    if (!(input.amount > 0)) throw new PayPalError(422, "INVALID_PARAMETER_VALUE", "amount must be positive");
    const orderId = id("", 17);
    const order: MockOrder = {
      id: orderId, status: "PAYER_ACTION_REQUIRED", amount: toMoney(input.amount, input.currency), description: input.description,
      approveUrl: `${this.publicBaseUrl}/mock/checkout/${orderId}`, returnUrl: input.returnUrl, cancelUrl: input.cancelUrl,
    };
    this.orders.set(orderId, order);
    return this.view(order);
  }

  /** Simulates the buyer clicking "Pay" on the PayPal approval page. */
  approve(orderId: string, payerEmail = "sb-buyer@personal.example.com"): MockOrder {
    const o = this.mustOrder(orderId);
    if (o.status === "PAYER_ACTION_REQUIRED") { o.status = "APPROVED"; o.payerEmail = payerEmail; }
    return o;
  }

  async getOrder(orderId: string): Promise<OrderSummary> { return this.view(this.mustOrder(orderId)); }

  async captureOrder(orderId: string): Promise<CaptureResult> {
    const o = this.mustOrder(orderId);
    if (o.status === "COMPLETED") throw new PayPalError(422, "ORDER_ALREADY_CAPTURED", "Order already captured.");
    if (o.status !== "APPROVED") throw new PayPalError(422, "ORDER_NOT_APPROVED", "Payer has not yet approved the Order for payment.");
    const captureId = id("", 17);
    o.status = "COMPLETED"; o.captureId = captureId;
    this.captures.set(captureId, { captureId, orderId, status: "COMPLETED", amount: o.amount, refunded: 0 });
    return { orderId, status: "COMPLETED", captureId, amount: o.amount };
  }

  async getCapture(captureId: string): Promise<CaptureInfo> {
    const c = this.captures.get(captureId);
    if (!c) throw new PayPalError(404, "RESOURCE_NOT_FOUND", `Capture ${captureId} not found.`);
    return { captureId: c.captureId, status: c.status, amount: c.amount };
  }

  async refundCapture(captureId: string, amount: number | undefined, currency: string): Promise<RefundResult> {
    const c = this.captures.get(captureId);
    if (!c) throw new PayPalError(404, "RESOURCE_NOT_FOUND", `Capture ${captureId} not found.`);
    const remaining = +(moneyNum(c.amount) - c.refunded).toFixed(2);
    const amt = amount ?? remaining;
    if (amt <= 0 || amt > remaining + 1e-9) throw new PayPalError(422, "REFUND_AMOUNT_EXCEEDED", `Refund ${amt} exceeds refundable ${remaining}.`);
    c.refunded = +(c.refunded + amt).toFixed(2);
    c.status = c.refunded >= moneyNum(c.amount) ? "REFUNDED" : "PARTIALLY_REFUNDED";
    return { refundId: id("", 17), captureId, status: "COMPLETED", amount: toMoney(amt, currency) };
  }

  async createPayouts(items: PayoutItemInput[], currency: string, senderBatchId: string): Promise<PayoutBatchResult> {
    for (const p of this.payouts.values()) if ((p as any).senderBatchId === senderBatchId) throw new PayPalError(422, "DUPLICATE_REQUEST_ID", "sender_batch_id already used.");
    const batchId = id("", 13);
    const res: PayoutBatchResult & { senderBatchId: string } = {
      batchId, senderBatchId, status: "SUCCESS",
      total: toMoney(items.reduce((s, i) => s + i.amount, 0), currency),
      items: items.map((i) => ({
        receiver: i.receiver, amount: toMoney(i.amount, currency), itemId: id("", 13),
        status: /@unclaimed\.example$/i.test(i.receiver) ? "UNCLAIMED" : "SUCCESS",
      })),
    };
    this.payouts.set(batchId, res);
    return { batchId, status: "PENDING", total: res.total, items: res.items.map((i) => ({ ...i, status: "PENDING" })) };
  }

  async getPayoutBatch(batchId: string): Promise<PayoutBatchResult> {
    const p = this.payouts.get(batchId);
    if (!p) throw new PayPalError(404, "INVALID_RESOURCE_ID", `Payout batch ${batchId} not found.`);
    return { batchId: p.batchId, status: p.status, total: p.total, items: p.items };
  }

  async listDisputes(): Promise<DisputeSummary[]> { return this.disputes; }
  async getDispute(disputeId: string): Promise<DisputeSummary & { messages?: string[] }> {
    const d = this.disputes.find((x) => x.id === disputeId);
    if (!d) throw new PayPalError(404, "RESOURCE_NOT_FOUND", `Dispute ${disputeId} not found.`);
    return { ...d, messages: [d.reason.includes("NOT_RECEIVED") ? "It has been 12 days and nothing arrived." : "The colour is completely different from the photos."] };
  }

  private mustOrder(orderId: string): MockOrder {
    const o = this.orders.get(orderId);
    if (!o) throw new PayPalError(404, "RESOURCE_NOT_FOUND", `Order ${orderId} not found.`);
    return o;
  }
  private view(o: MockOrder): OrderSummary {
    const { returnUrl: _r, cancelUrl: _c, ...rest } = o;
    return { ...rest };
  }
}
