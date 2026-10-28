import type { AppConfig } from "../config.ts";
import { MockPayPal } from "./mock.ts";
import { SandboxPayPal } from "./sandbox.ts";
import type { PayPalGateway } from "./types.ts";

export function makeGateway(cfg: AppConfig): PayPalGateway {
  if (cfg.paypalMode === "sandbox") return new SandboxPayPal({ base: cfg.paypalApiBase, clientId: cfg.paypalClientId, secret: cfg.paypalClientSecret });
  return new MockPayPal(cfg.publicBaseUrl);
}
export * from "./types.ts";
export { MockPayPal, SandboxPayPal };
