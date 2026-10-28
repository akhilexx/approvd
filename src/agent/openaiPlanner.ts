// LLM planners with tool calling.
//  - provider "openai": any OpenAI-compatible chat-completions endpoint (OpenAI, xAI, Groq, OpenRouter, Together,
//    Gemini's OpenAI-compatible endpoint, local Ollama). Bearer auth.
//  - provider "azure": Azure OpenAI. `api-key` header. Wire "chat" = {endpoint}/openai/deployments/{deployment}/chat/completions
//    ?api-version=...; wire "responses" = {endpoint}/openai/v1/responses (needed by reasoning deployments that refuse
//    function tools on chat completions). Wire "auto" starts with chat and switches to responses permanently if Azure
//    answers "Function tools ... use /v1/responses" (seen live with the gpt-6.1-sol deployment on 28 Oct 2026).
// Errors: 429/5xx/timeouts are retried with backoff; content-filter blocks are surfaced as LlmError("content_filter").
import type { ToolSpec } from "../tools.ts";
import type { SessionRefs } from "../engine.ts";
import type { ChatMsg, ChatToolCall, Planner, PlannerTurn } from "./types.ts";
import { LlmError, postJson } from "./llm.ts";

export interface PlannerOpts {
  provider?: "openai" | "azure";
  baseUrl?: string; apiKey: string; model: string;                         // openai
  endpoint?: string; deployment?: string; apiVersion?: string;              // azure
  wire?: "auto" | "chat" | "responses"; reasoningEffort?: string;
  maxOutputTokens?: number; timeoutMs?: number; maxRetries?: number;
  fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>;
  onUsage?: (tokens: number) => void;  // reports input+output tokens per call (for the daily token cap)
  onCall?: () => void;                 // called before every HTTP call (for the daily call cap)
}

export class OpenAIPlanner implements Planner {
  readonly name: string;
  readonly provider: "openai" | "azure";
  wire: "chat" | "responses";
  private auto: boolean;
  private tokenParam: "max_tokens" | "max_completion_tokens" = "max_tokens";
  private sendTemperature = true;
  lastModel = "";
  private o: PlannerOpts;

  constructor(o: PlannerOpts) {
    this.o = o; this.provider = o.provider ?? "openai";
    if (this.provider === "azure") {
      if (!o.endpoint || !o.apiKey || !o.deployment) throw new Error("LLM_MODE=azure needs AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY and AZURE_OPENAI_DEPLOYMENT.");
      if (!/^https:\/\//.test(o.endpoint)) throw new Error("AZURE_OPENAI_ENDPOINT must be an https URL.");
      this.name = `${o.deployment} (Azure OpenAI)`;
    } else {
      if (!o.baseUrl) throw new Error("LLM_BASE_URL is required");
      if (!o.apiKey && !/localhost|127\.0\.0\.1/.test(o.baseUrl)) throw new Error("LLM_MODE=openai needs LLM_API_KEY (or a local LLM_BASE_URL).");
      this.name = `${o.model} via ${new URL(o.baseUrl).host}`;
    }
    this.auto = (o.wire ?? "auto") === "auto";
    this.wire = o.wire === "responses" ? "responses" : "chat";
  }

  private http(url: string, body: unknown) {
    this.o.onCall?.();
    const headers: Record<string, string> = this.provider === "azure" ? { "api-key": this.o.apiKey } : this.o.apiKey ? { Authorization: `Bearer ${this.o.apiKey}` } : {};
    return postJson(url, headers, body, { timeoutMs: this.o.timeoutMs ?? 30_000, maxRetries: this.o.maxRetries ?? 2, fetchImpl: this.o.fetchImpl ?? fetch, sleep: this.o.sleep });
  }

  async next(messages: ChatMsg[], tools: ToolSpec[], refs: SessionRefs): Promise<PlannerTurn> {
    const ctx: ChatMsg = { role: "system", content: `Known ids from this session (use only these or ids the user typed; never invent ids): ${JSON.stringify(refs)}` };
    const all = [...messages, ctx];
    for (let adapt = 0; adapt < 3; adapt++) {
      try { return this.wire === "responses" ? await this.viaResponses(all, tools) : await this.viaChat(all, tools); }
      catch (e) {
        if (!(e instanceof LlmError) || e.kind !== "bad_request") throw e;
        // Parameter differences between model generations: adapt once and retry.
        if (this.auto && this.provider === "azure" && this.wire === "chat" && /responses/i.test(e.message)) { this.wire = "responses"; continue; }
        if (this.wire === "chat" && /max_tokens/.test(e.message) && this.tokenParam === "max_tokens") { this.tokenParam = "max_completion_tokens"; continue; }
        if (this.wire === "chat" && /temperature/.test(e.message) && this.sendTemperature) { this.sendTemperature = false; continue; }
        throw e;
      }
    }
    throw new LlmError("unsupported", 400, "unsupported", "The LLM endpoint rejected every request shape Approvd knows.");
  }

  private async viaChat(messages: ChatMsg[], tools: ToolSpec[]): Promise<PlannerTurn> {
    const azure = this.provider === "azure";
    const url = azure
      ? `${this.o.endpoint}/openai/deployments/${encodeURIComponent(this.o.deployment!)}/chat/completions?api-version=${encodeURIComponent(this.o.apiVersion ?? "2024-10-21")}`
      : `${this.o.baseUrl}/chat/completions`;
    const body: any = {
      messages, tool_choice: "auto", parallel_tool_calls: false,
      tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })),
      [this.tokenParam]: this.o.maxOutputTokens ?? 1200,
    };
    if (!tools.length) { delete body.tools; delete body.tool_choice; delete body.parallel_tool_calls; }
    if (!azure) body.model = this.o.model;
    if (this.sendTemperature) body.temperature = 0;
    const j = await this.http(url, body);
    this.lastModel = j.model ?? this.lastModel;
    this.o.onUsage?.(Number(j.usage?.total_tokens ?? 0));
    const choice = j.choices?.[0] ?? {};
    if (choice.finish_reason === "content_filter") throw new LlmError("content_filter", 200, "content_filter", "The AI provider's content filter blocked this response.");
    const msg = choice.message ?? {};
    return { text: msg.content ?? undefined, toolCalls: (msg.tool_calls ?? []).filter((c: any) => c.type === "function" || c.function) };
  }

  private async viaResponses(messages: ChatMsg[], tools: ToolSpec[]): Promise<PlannerTurn> {
    const url = this.provider === "azure" ? `${this.o.endpoint}/openai/v1/responses` : `${this.o.baseUrl}/responses`;
    const instructions = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const input: any[] = [];
    for (const m of messages) {
      if (m.role === "user") input.push({ role: "user", content: m.content ?? "" });
      else if (m.role === "assistant") {
        if (m.content) input.push({ role: "assistant", content: m.content });
        for (const c of m.tool_calls ?? []) input.push({ type: "function_call", call_id: c.id, name: c.function.name, arguments: c.function.arguments });
      } else if (m.role === "tool") input.push({ type: "function_call_output", call_id: m.tool_call_id, output: m.content ?? "" });
    }
    const body: any = {
      model: this.provider === "azure" ? this.o.deployment : this.o.model, instructions, input, store: false,
      tools: tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters })),
      tool_choice: "auto", parallel_tool_calls: false, max_output_tokens: this.o.maxOutputTokens ?? 1200,
    };
    if (!tools.length) { delete body.tools; delete body.tool_choice; delete body.parallel_tool_calls; }
    if (this.o.reasoningEffort) body.reasoning = { effort: this.o.reasoningEffort };
    const j = await this.http(url, body);
    this.lastModel = j.model ?? this.lastModel;
    this.o.onUsage?.(Number(j.usage?.total_tokens ?? (j.usage?.input_tokens ?? 0) + (j.usage?.output_tokens ?? 0)));
    if (j.incomplete_details?.reason === "content_filter") throw new LlmError("content_filter", 200, "content_filter", "The AI provider's content filter blocked this response.");
    const out: any[] = j.output ?? [];
    const toolCalls: ChatToolCall[] = out.filter((o) => o.type === "function_call").map((o) => ({ id: o.call_id, type: "function", function: { name: o.name, arguments: o.arguments ?? "{}" } }));
    const text = out.filter((o) => o.type === "message").flatMap((o) => (o.content ?? []).filter((c: any) => c.type === "output_text").map((c: any) => c.text)).join("\n").trim();
    return { text: text || undefined, toolCalls };
  }
}
