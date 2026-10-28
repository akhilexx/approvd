// Spend guard and circuit breaker for the hosted demo's LLM key.
// - daily LLM call cap and daily token cap (UTC day): when hit, the agent switches to the offline planner
// - circuit breaker: after N consecutive LLM failures, stop calling the LLM for a cooldown period
// Counters are in memory (one Render instance); a restart resets them, which is acceptable for a demo.
import type { DemoLimitsConfig } from "./config.ts";

const day = (now: number) => new Date(now).toISOString().slice(0, 10);

export class LlmGuard {
  private l: Pick<DemoLimitsConfig, "llmDailyCallCap" | "llmDailyTokenCap" | "breakerFailures" | "breakerCooldownMs">;
  private now: () => number;
  calls = 0; tokens = 0; private dayKey: string;
  consecutiveFailures = 0; openUntil = 0;

  constructor(limits: LlmGuard["l"], now: () => number = Date.now) { this.l = limits; this.now = now; this.dayKey = day(now()); }

  private roll() { const d = day(this.now()); if (d !== this.dayKey) { this.dayKey = d; this.calls = 0; this.tokens = 0; } }

  /** null when the LLM may be called, else a short user-facing reason. */
  blockedReason(): string | null {
    this.roll();
    if (this.now() < this.openUntil) return "the AI planner is paused for a few minutes after repeated provider errors";
    if (this.calls >= this.l.llmDailyCallCap) return "the hosted demo reached its daily AI request cap";
    if (this.tokens >= this.l.llmDailyTokenCap) return "the hosted demo reached its daily AI token budget";
    return null;
  }
  recordCall() { this.roll(); this.calls++; }
  recordTokens(n: number) { this.roll(); if (Number.isFinite(n) && n > 0) this.tokens += n; }
  success() { this.consecutiveFailures = 0; }
  failure() {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.l.breakerFailures) { this.openUntil = this.now() + this.l.breakerCooldownMs; this.consecutiveFailures = 0; }
  }
  status() {
    this.roll();
    return { callsToday: this.calls, callCap: this.l.llmDailyCallCap, tokensToday: this.tokens, tokenCap: this.l.llmDailyTokenCap, breakerOpen: this.now() < this.openUntil };
  }
}

/** Global per-UTC-day request counter for the whole server. */
export class DailyCounter {
  private n = 0; private dayKey: string; private cap: number; private now: () => number;
  constructor(cap: number, now: () => number = Date.now) { this.cap = cap; this.now = now; this.dayKey = day(now()); }
  hit(): boolean { const d = day(this.now()); if (d !== this.dayKey) { this.dayKey = d; this.n = 0; } this.n++; return this.n <= this.cap; }
  get count() { return this.n; }
}
