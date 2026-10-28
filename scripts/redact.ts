// Redaction for recorded PayPal sandbox traffic. Fixtures must never contain credentials, tokens,
// account identifiers or the sandbox account emails.
const SANDBOX_EMAIL = /sb-[a-z0-9]+@(business|personal)\.example\.com/gi;
const DROP_KEYS = new Set(["access_token", "app_id", "nonce", "scope", "id_token", "refresh_token"]);
const ID_KEYS = new Set(["payer_id", "merchant_id", "account_id", "payer_id_hash", "encrypted_id", "receiver_account_id"]);

export function redactValue(v: unknown, secrets: string[]): unknown {
  if (typeof v === "string") {
    let s = v;
    for (const sec of secrets) if (sec && sec.length >= 6) s = s.split(sec).join("[REDACTED]");
    return s.replace(SANDBOX_EMAIL, (_m, kind) => `sandbox-${kind.toLowerCase()}@example.com`);
  }
  if (Array.isArray(v)) return v.map((x) => redactValue(x, secrets));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      if (DROP_KEYS.has(k)) out[k] = "[REDACTED]";
      else if (ID_KEYS.has(k)) out[k] = "REDACTED_ID";
      // Disputes v1 returns buyer/seller names and emails: replace with neutral sandbox placeholders.
      else if ((k === "buyer" || k === "seller") && val && typeof val === "object" && !Array.isArray(val)) {
        const party = redactValue(val, secrets) as Record<string, unknown>;
        if ("name" in party) party.name = k === "buyer" ? "Sandbox Buyer" : "Sandbox Seller";
        if (typeof party.email === "string" && !/@(personal|business)?\.?example\.com$/.test(party.email)) party.email = `sandbox-${k === "buyer" ? "personal" : "business"}@example.com`;
        out[k] = party;
      }
      else out[k] = redactValue(val, secrets);
    }
    return out;
  }
  return v;
}

/** Throws if any secret (or any raw sandbox account email) survives in the serialized text. */
export function assertClean(text: string, secrets: string[]): void {
  for (const s of secrets) if (s && s.length >= 6 && text.includes(s)) throw new Error("Redaction failure: a secret value is present in output");
  if (SANDBOX_EMAIL.test(text)) { SANDBOX_EMAIL.lastIndex = 0; throw new Error("Redaction failure: a sandbox account email is present in output"); }
  SANDBOX_EMAIL.lastIndex = 0;
  if (/Bearer\s+A21/i.test(text) || /Basic\s+[A-Za-z0-9+/=]{20,}/.test(text)) throw new Error("Redaction failure: auth header present");
}
