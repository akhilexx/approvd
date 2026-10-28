// Any OpenAI-compatible chat-completions endpoint with function calling
// (OpenAI, xAI, Groq, OpenRouter, Together, Gemini's OpenAI-compatible endpoint, local Ollama).
import type { ToolSpec } from "../tools.ts";
import type { SessionRefs } from "../engine.ts";
import type { ChatMsg, Planner, PlannerTurn } from "./types.ts";

export class OpenAIPlanner implements Planner {
  readonly name: string;
  private base: string; private key: string; private model: string; private fetchImpl: typeof fetch;
  constructor(opts: { baseUrl: string; apiKey: string; model: string; fetchImpl?: typeof fetch }) {
    if (!opts.apiKey && !/localhost|127\.0\.0\.1/.test(opts.baseUrl)) throw new Error("LLM_MODE=openai needs LLM_API_KEY (or a local LLM_BASE_URL).");
    this.base = opts.baseUrl; this.key = opts.apiKey; this.model = opts.model; this.fetchImpl = opts.fetchImpl ?? fetch;
    this.name = `${opts.model} via ${new URL(opts.baseUrl).host}`;
  }
  async next(messages: ChatMsg[], tools: ToolSpec[], refs: SessionRefs): Promise<PlannerTurn> {
    const ctx: ChatMsg = { role: "system", content: `Known ids from this session (use only these or ids the user typed; never invent ids): ${JSON.stringify(refs)}` };
    const res = await this.fetchImpl(`${this.base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(this.key ? { Authorization: `Bearer ${this.key}` } : {}) },
      body: JSON.stringify({
        model: this.model, temperature: 0, messages: [...messages, ctx], tool_choice: "auto", parallel_tool_calls: false,
        tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })),
      }),
    });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`LLM error ${res.status}: ${j.error?.message ?? JSON.stringify(j).slice(0, 200)}`);
    const msg = j.choices?.[0]?.message ?? {};
    return { text: msg.content ?? undefined, toolCalls: (msg.tool_calls ?? []).filter((c: any) => c.type === "function" || c.function) };
  }
}
