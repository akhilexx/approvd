// The PayPalGateway interface is the seam between the agent and PayPal.
// MockPayPal (offline simulator) and SandboxPayPal (real REST sandbox) both implement it,
// so dropping real sandbox keys into .env switches the whole app with no code changes.

export interface Money { currency: string; value: string }

export interface OrderSummary {
  id: string;
  status: string; // CREATED | APPROVED | COMPLETED | VOIDED ...
  amount: Money;
  description: string;
  approveUrl?: string;
  captureId?: string;
  payerEmail?: string;
}

export interface CaptureResult { orderId: string; status: string; captureId: string; amount: Money }
export interface CaptureInfo { captureId: string; status: string; amount: Money }
export interface RefundResult { refundId: string; captureId: string; status: string; amount: Money }

export interface PayoutItemInput { receiver: string; amount: number; note?: string }
export interface PayoutItemResult { receiver: string; amount: Money; status: string; itemId?: string }
export interface PayoutBatchResult { batchId: string; status: string; total: Money; items: PayoutItemResult[] }

export interface DisputeSummary { id: string; reason: string; status: string; amount: Money; createTime: string }

export interface CreateOrderInput {
  amount: number;
  currency: string;
  description: string;
  referenceId?: string;
  returnUrl: string;
  cancelUrl: string;
}

export interface PayPalGateway {
  readonly mode: "mock" | "sandbox";
  createOrder(input: CreateOrderInput): Promise<OrderSummary>;
  getOrder(orderId: string): Promise<OrderSummary>;
  captureOrder(orderId: string): Promise<CaptureResult>;
  getCapture(captureId: string): Promise<CaptureInfo>;
  refundCapture(captureId: string, amount: number | undefined, currency: string, note?: string): Promise<RefundResult>;
  createPayouts(items: PayoutItemInput[], currency: string, senderBatchId: string, subject: string): Promise<PayoutBatchResult>;
  getPayoutBatch(batchId: string): Promise<PayoutBatchResult>;
  listDisputes(): Promise<DisputeSummary[]>;
}

export class PayPalError extends Error {
  status: number;
  issue: string;
  debugId?: string;
  constructor(status: number, issue: string, message: string, debugId?: string) {
    super(message);
    this.name = "PayPalError";
    this.status = status;
    this.issue = issue;
    this.debugId = debugId;
  }
}

export const toMoney = (amount: number, currency: string): Money => ({ currency, value: amount.toFixed(2) });
export const moneyNum = (m: Money) => Number(m.value);
