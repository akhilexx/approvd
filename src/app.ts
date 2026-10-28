import { loadDotEnv, readConfig, type AppConfig } from "./config.ts";
import { Engine } from "./engine.ts";
import { makeGateway, type PayPalGateway } from "./paypal/index.ts";
import { Agent, makePlanner } from "./agent/agent.ts";
import type { Planner } from "./agent/types.ts";
import { LlmGuard } from "./guard.ts";

export interface App { cfg: AppConfig; gw: PayPalGateway; engine: Engine; agent: Agent; guard: LlmGuard }

export function createApp(opts: { env?: NodeJS.ProcessEnv; gateway?: PayPalGateway; planner?: Planner; guard?: LlmGuard } = {}): App {
  if (!opts.env) loadDotEnv();
  const cfg = readConfig(opts.env ?? process.env);
  const gw = opts.gateway ?? makeGateway(cfg);
  const engine = new Engine(cfg, gw);
  // The guard outlives /api/reset (the server passes the old one back in) so resetting can't clear the spend caps.
  const guard = opts.guard ?? new LlmGuard(cfg.limits);
  const agent = new Agent(cfg, engine, opts.planner ?? makePlanner(cfg, guard), guard);
  return { cfg, gw, engine, agent, guard };
}
