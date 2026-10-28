import { loadDotEnv, readConfig, type AppConfig } from "./config.ts";
import { Engine } from "./engine.ts";
import { makeGateway, type PayPalGateway } from "./paypal/index.ts";
import { Agent, makePlanner } from "./agent/agent.ts";
import type { Planner } from "./agent/types.ts";

export interface App { cfg: AppConfig; gw: PayPalGateway; engine: Engine; agent: Agent }

export function createApp(opts: { env?: NodeJS.ProcessEnv; gateway?: PayPalGateway; planner?: Planner } = {}): App {
  if (!opts.env) loadDotEnv();
  const cfg = readConfig(opts.env ?? process.env);
  const gw = opts.gateway ?? makeGateway(cfg);
  const engine = new Engine(cfg, gw);
  const agent = new Agent(cfg, engine, opts.planner ?? makePlanner(cfg));
  return { cfg, gw, engine, agent };
}
