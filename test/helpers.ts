import { createApp } from "../src/app.ts";
export const ENV = { PAYPAL_MODE: "mock", LLM_MODE: "mock", POLICY_APPROVAL_THRESHOLD: "50", POLICY_MAX_PER_ACTION: "500", POLICY_DAILY_OUTFLOW_CAP: "1000", POLICY_PAYEE_ALLOWLIST: "@example.com", PUBLIC_BASE_URL: "http://localhost:8787" };
export const mockApp = (over: Record<string, string> = {}, extra: any = {}) => createApp({ env: { ...ENV, ...over } as any, ...extra });
