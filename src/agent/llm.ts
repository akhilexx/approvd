// HTTP plumbing shared by the LLM providers: timeout, bounded retries with backoff, and typed errors.
// Errors never include request headers, keys or prompt text, only status, provider error code and message.

export type LlmErrorKind = "rate_limit" | "content_filter" | "timeout" | "auth" | "bad_request" | "server" | "network" | "unsupported";

export class LlmError extends Error {
  kind: LlmErrorKind; status: number; code: string; retryable: boolean;
  constructor(kind: LlmErrorKind, status: number, code: string, message: string) {
    super(message); this.name = "LlmError"; this.kind = kind; this.status = status; this.code = code;
    this.retryable = kind === "rate_limit" || kind === "server" || kind === "timeout" || kind === "network";
  }
}

export interface HttpOpts { timeoutMs: number; maxRetries: number; fetchImpl: typeof fetch; sleep?: (ms: number) => Promise<void> }
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Classify a non-2xx provider response (OpenAI and Azure OpenAI share the `{error:{code,message}}` shape). */
export function classify(status: number, body: any): LlmError {
  const err = body?.error ?? {};
  const code = String(err.code ?? err.type ?? "");
  const inner = String(err.innererror?.code ?? "");
  const msg = String(err.message ?? `LLM HTTP ${status}`).slice(0, 300);
  if (code === "content_filter" || inner === "ResponsibleAIPolicyViolation" || /content management policy|content_filter/i.test(msg))
    return new LlmError("content_filter", status, code || "content_filter", "The AI provider's content filter blocked this request.");
  if (status === 429) return new LlmError("rate_limit", status, code || "429", msg);
  if (status === 401 || status === 403) return new LlmError("auth", status, code || String(status), msg);
  if (status === 408) return new LlmError("timeout", status, code || "408", msg);
  if (status >= 500) return new LlmError("server", status, code || String(status), msg);
  return new LlmError("bad_request", status, code || String(status), msg);
}

const retryAfterMs = (res: Response) => {
  const ms = Number(res.headers.get("retry-after-ms")); if (Number.isFinite(ms) && ms > 0) return ms;
  const s = Number(res.headers.get("retry-after")); return Number.isFinite(s) && s > 0 ? s * 1000 : 0;
};

/** POST JSON with a per-attempt timeout; retries 429 / 5xx / timeouts / network errors up to maxRetries. */
export async function postJson(url: string, headers: Record<string, string>, body: unknown, o: HttpOpts): Promise<any> {
  const sleep = o.sleep ?? realSleep;
  let last: LlmError | undefined;
  for (let attempt = 0; attempt <= o.maxRetries; attempt++) {
    if (attempt > 0) await sleep(Math.min(8000, (last as any)?._wait || 500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250)));
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), o.timeoutMs);
    try {
      const res = await o.fetchImpl(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body), signal: ctl.signal });
      const j: any = await res.json().catch(() => ({}));
      if (res.ok) return j;
      last = classify(res.status, j);
      (last as any)._wait = retryAfterMs(res);
    } catch (e: any) {
      last = e?.name === "AbortError" || ctl.signal.aborted ? new LlmError("timeout", 0, "timeout", `LLM request timed out after ${o.timeoutMs} ms`)
        : e instanceof LlmError ? e : new LlmError("network", 0, "network", "Could not reach the LLM endpoint");
    } finally { clearTimeout(timer); }
    if (!last.retryable) break;
  }
  throw last!;
}
