import type { ToolSpec } from "../tools.ts";
import type { SessionRefs } from "../engine.ts";

export interface ChatToolCall { id: string; type: "function"; function: { name: string; arguments: string } }
export interface ChatMsg { role: "system" | "user" | "assistant" | "tool"; content: string | null; tool_calls?: ChatToolCall[]; tool_call_id?: string }
export interface PlannerTurn { text?: string; toolCalls: ChatToolCall[] }

/** A planner is the "brain": given the conversation and tools it proposes the next tool calls. */
export interface Planner {
  readonly name: string;
  next(messages: ChatMsg[], tools: ToolSpec[], refs: SessionRefs): Promise<PlannerTurn>;
}
