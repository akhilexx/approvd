// Minimal .env loader + typed config. Zero dependencies on purpose so judges can run it with just Node.
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

export function loadDotEnv(path = resolve(process.cwd(), ".env")): void {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val; // real env wins over .env
  }
}

export interface PolicyConfig {
  approvalThreshold: number;
  maxPerAction: number;
  dailyOutflowCap: number;
  payeeAllowlist: string[];
  blockedTools: string[];
  currency: string;
}

export interface AppConfig {
  paypalMode: "mock" | "sandbox";
  paypalClientId: string;
  paypalClientSecret: string;
  paypalApiBase: string;
  currency: string;
  publicBaseUrl: string;
  llmMode: "mock" | "openai";
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
  port: number;
  demoPasscode: string;
  policy: PolicyConfig;
}

const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) ? n : d;
};

export function readConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const paypalMode = env.PAYPAL_MODE === "sandbox" ? "sandbox" : "mock";
  const apiBase = env.PAYPAL_API_BASE || "https://api-m.sandbox.paypal.com";
  if (/api-m\.paypal\.com|api\.paypal\.com/.test(apiBase) && !/sandbox/.test(apiBase)) {
    throw new Error("Refusing to start: PAYPAL_API_BASE points at PayPal LIVE. This project is sandbox-only.");
  }
  const currency = (env.PAYPAL_CURRENCY || "USD").toUpperCase();
  const port = num(env.PORT, 8787);
  return {
    paypalMode,
    paypalClientId: env.PAYPAL_CLIENT_ID || "",
    paypalClientSecret: env.PAYPAL_CLIENT_SECRET || "",
    paypalApiBase: apiBase.replace(/\/$/, ""),
    currency,
    publicBaseUrl: (env.PUBLIC_BASE_URL || `http://localhost:${port}`).replace(/\/$/, ""),
    llmMode: env.LLM_MODE === "openai" ? "openai" : "mock",
    llmBaseUrl: (env.LLM_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, ""),
    llmApiKey: env.LLM_API_KEY || "",
    llmModel: env.LLM_MODEL || "gpt-4o-mini",
    port,
    demoPasscode: env.DEMO_PASSCODE || "",
    policy: {
      approvalThreshold: num(env.POLICY_APPROVAL_THRESHOLD, 50),
      maxPerAction: num(env.POLICY_MAX_PER_ACTION, 500),
      dailyOutflowCap: num(env.POLICY_DAILY_OUTFLOW_CAP, 1000),
      payeeAllowlist: env.POLICY_PAYEE_ALLOWLIST === undefined ? ["@example.com"] : list(env.POLICY_PAYEE_ALLOWLIST),
      blockedTools: list(env.POLICY_BLOCKED_TOOLS),
      currency,
    },
  };
}
