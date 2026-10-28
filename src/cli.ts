// CLI: `demo` runs the full scripted story offline; `chat "..."` sends one message; `smoke` checks real sandbox keys.
import { createApp } from "./app.ts";
import { MockPayPal } from "./paypal/mock.ts";
import { SandboxPayPal } from "./paypal/sandbox.ts";
import { loadDotEnv, readConfig } from "./config.ts";

const [cmd, ...rest] = process.argv.slice(2);

async function demo() {
  const app = createApp();
  const say = async (m: string) => { const r = await app.agent.chat("cli", m); console.log(`\n> ${m}\n${r.reply}`); return r; };
  console.log(`PayPal: ${app.gw.mode} · planner: ${app.agent.planner.name}`);
  await say("Create a $45 checkout for 2 soy candles for priya@example.com");
  if (app.gw instanceof MockPayPal) { app.gw.approve(app.engine.refs.lastOrderId!); console.log("\n(simulated: buyer approves on the PayPal page)"); }
  else { console.log("\nOpen the approval link above as your sandbox buyer, then press Enter."); await new Promise((r) => process.stdin.once("data", r)); }
  await say("Capture it, then refund $12 for a cracked lid");
  await say("Pay asha@example.com $20 and ravi@example.com $25 for October deliveries");
  const r = await say("Send $120 to newvendor@mail.test for packaging");
  const apr = r.steps.find((s) => s.approvalId)?.approvalId;
  if (apr) { const o = await app.engine.approve(apr, "cli-demo"); console.log(`\n(human approves ${apr}) -> ${o.status} batch ${o.result?.batchId ?? ""}`); }
  await say("Pay maya@example.com $900 for the photo shoot");
  await say("Refund $100 on it");
  await say("List open disputes");
  await say("Draft a reply to the first dispute");
  if (process.env.DEBUG) console.log(app.engine.ledger.map((l) => `${l.tool} ${l.status} ${l.amount} ${l.direction}`));
  console.log(`\nLedger: ${app.engine.ledger.length} entries, outflow last 24h ${app.engine.outflowLast24h()} ${app.cfg.currency}`);
}

async function smoke() {
  loadDotEnv(); const cfg = readConfig();
  if (cfg.paypalMode !== "sandbox") { console.error("Set PAYPAL_MODE=sandbox plus PAYPAL_CLIENT_ID/PAYPAL_CLIENT_SECRET in .env first."); process.exit(2); }
  const gw = new SandboxPayPal({ base: cfg.paypalApiBase, clientId: cfg.paypalClientId, secret: cfg.paypalClientSecret });
  const o = await gw.createOrder({ amount: 1.23, currency: cfg.currency, description: "Approvd smoke test", returnUrl: `${cfg.publicBaseUrl}/return`, cancelUrl: `${cfg.publicBaseUrl}/cancel` });
  console.log("OAuth OK. Orders v2 OK:", o.id, o.status, o.approveUrl);
  console.log("Round-trip get_order:", (await gw.getOrder(o.id)).status);
  try { console.log("Disputes v1 OK:", (await gw.listDisputes()).length, "disputes"); } catch (e: any) { console.log("Disputes v1 not enabled on this app:", e.message); }
}

async function chat() {
  const app = createApp(); const r = await app.agent.chat("cli", rest.join(" ")); console.log(r.reply);
}

const run = { demo, smoke, chat }[cmd as "demo"];
if (!run) { console.log("usage: node src/cli.ts demo | smoke | chat \"message\""); process.exit(1); }
run().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
