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
  llmMode: "mock" | "openai" | "azure";
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
  azure: { endpoint: string; apiKey: string; deployment: string; apiVersion: string; wire: "auto" | "chat" | "responses"; reasoningEffort: string };
  llm: { timeoutMs: number; maxRetries: number; maxOutputTokens: number };
  port: number;
  demoPasscode: string;
  /** Optional text for the console's "AI:" badge (e.g. just the model name for a video without vendor names). */
  uiPlannerLabel: string;
  limits: DemoLimitsConfig;
  policy: PolicyConfig;
}

/** Hosted-demo protections. Every number can be tuned by env without code changes. */
export interface DemoLimitsConfig {
  rateLimitPerMin: number;      // POSTs per minute per client IP
  dailyRequestCap: number;      // POSTs to /api per UTC day, across all clients
  maxInputChars: number;        // max characters in one chat message
  maxBodyBytes: number;         // max JSON body size
  sessionTurnCap: number;       // chat turns per browser session
  maxSessions: number;          // sessions kept in memory (oldest evicted)
  llmDailyCallCap: number;      // LLM requests per UTC day; then the offline planner takes over
  llmDailyTokenCap: number;     // LLM tokens (input + output) per UTC day; then the offline planner takes over
  breakerFailures: number;      // consecutive LLM failures that open the circuit breaker
  breakerCooldownMs: number;    // how long the breaker stays open
  corsOrigin: string;           // exact allowed cross-origin, or "" for same-origin only
  clientIpHeader: string;       // header set by the trusted edge with the client IP (Render: true-client-ip); "" = socket address
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
    llmMode: env.LLM_MODE === "openai" ? "openai" : env.LLM_MODE === "azure" ? "azure" : "mock",
    llmBaseUrl: (env.LLM_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, ""),
    llmApiKey: env.LLM_API_KEY || "",
    llmModel: env.LLM_MODEL || "gpt-4o-mini",
    azure: {
      endpoint: (env.AZURE_OPENAI_ENDPOINT || "").replace(/\/$/, ""),
      apiKey: env.AZURE_OPENAI_API_KEY || "",
      deployment: env.AZURE_OPENAI_DEPLOYMENT || "",
      apiVersion: env.AZURE_OPENAI_API_VERSION || "2024-10-21",
      wire: env.AZURE_OPENAI_WIRE === "chat" ? "chat" : env.AZURE_OPENAI_WIRE === "responses" ? "responses" : "auto",
      reasoningEffort: env.AZURE_OPENAI_REASONING_EFFORT || "",
    },
    llm: { timeoutMs: num(env.LLM_TIMEOUT_MS, 30_000), maxRetries: num(env.LLM_MAX_RETRIES, 2), maxOutputTokens: num(env.LLM_MAX_OUTPUT_TOKENS, 1200) },
    port,
    demoPasscode: env.DEMO_PASSCODE || "",
    uiPlannerLabel: (env.UI_PLANNER_LABEL || "").slice(0, 60),
    limits: {
      rateLimitPerMin: num(env.RATE_LIMIT_PER_MIN, 30),
      dailyRequestCap: num(env.DAILY_REQUEST_CAP, 2000),
      maxInputChars: num(env.MAX_INPUT_CHARS, 600),
      maxBodyBytes: num(env.MAX_BODY_BYTES, 16_000),
      sessionTurnCap: num(env.SESSION_TURN_CAP, 40),
      maxSessions: num(env.MAX_SESSIONS, 500),
      llmDailyCallCap: num(env.LLM_DAILY_CALL_CAP, 400),
      llmDailyTokenCap: num(env.LLM_DAILY_TOKEN_CAP, 600_000),
      breakerFailures: num(env.LLM_BREAKER_FAILURES, 3),
      breakerCooldownMs: num(env.LLM_BREAKER_COOLDOWN_MS, 300_000),
      corsOrigin: (env.CORS_ORIGIN || "").replace(/\/$/, ""),
      clientIpHeader: (env.CLIENT_IP_HEADER || "").toLowerCase(),
    },
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
