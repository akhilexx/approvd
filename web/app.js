// Approvd console. Plain JS, no build step.
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const linkify = (s) => esc(s).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
const session = sessionStorage.getItem("sid") || (sessionStorage.setItem("sid", crypto.randomUUID()), sessionStorage.getItem("sid"));

async function api(path, body) {
  const headers = { "Content-Type": "application/json" };
  const pc = localStorage.getItem("passcode"); if (pc) headers["x-demo-passcode"] = pc;
  const r = await fetch(path, { method: body === undefined ? "GET" : "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (r.status === 401) { const v = prompt("Demo passcode (see README / Devpost testing instructions)"); if (v) { localStorage.setItem("passcode", v); return api(path, body); } }
  const j = await r.json(); if (!r.ok) throw new Error(j.error || r.statusText); return j;
}

function say(role, html, steps = []) {
  const d = document.createElement("div"); d.className = `m ${role}`; d.innerHTML = html;
  for (const s of steps) {
    const v = s.decision?.verdict ?? (s.status === "denied" ? "deny" : "allow");
    const st = document.createElement("div"); st.className = `step ${v}`;
    st.textContent = `${s.call.name}(${JSON.stringify(s.call.args)}) → policy: ${v} · ${s.status}${s.decision ? " · " + s.decision.reasons.join("; ") : ""}`;
    d.appendChild(st);
  }
  $("#log").appendChild(d); $("#log").scrollTop = 1e9;
}

function render(st) {
  $("#badges").innerHTML = `<span class="pill badge ${st.paypalMode}">PayPal: ${st.paypalMode}</span><span class="pill badge">AI: ${esc(st.planner)}</span>`;
  $("#policy").textContent = st.policy.text;
  const pct = Math.min(100, (100 * st.outflowLast24h) / st.policy.dailyOutflowCap);
  $("#bar").style.width = pct + "%"; $("#bar").style.background = pct > 80 ? "var(--bad)" : "var(--acc)";
  $("#outflow").textContent = `Outflow in last 24h: ${st.outflowLast24h} / ${st.policy.dailyOutflowCap} ${st.currency}`;
  $("#approveLast").hidden = !(st.paypalMode === "mock" && st.refs.lastOrderId);
  $("#apc").textContent = st.approvals.length;
  $("#approvals").innerHTML = st.approvals.length ? st.approvals.map((a) => `<div class="ap"><b>${esc(a.call.name)}</b> · ${esc(a.decision.amount)} ${esc(st.currency)}<div class="small muted">${esc(JSON.stringify(a.call.args))}</div><div class="why">${esc(a.decision.reasons.join("; "))}</div><button class="ok" data-a="${a.id}" data-k="approve">Approve</button> <button class="bad" data-a="${a.id}" data-k="reject">Reject</button></div>`).join("") : "Nothing waiting.";
  $("#ledger").innerHTML = st.ledger.map((l) => `<tr><td>${new Date(l.at).toLocaleTimeString()}</td><td>${esc(l.tool)}<div class="muted">${esc(l.source)}</div></td><td>${l.amount ? esc(l.amount) : ""}</td><td class="v-${l.verdict}">${esc(l.verdict)}</td><td>${esc(l.status)}</td><td><code>${esc(l.paypalRef ?? "")}</code></td><td class="muted">${esc(l.error ?? l.reasons.join("; "))}</td></tr>`).join("");
}

const CHIPS = [
  "Create a $45 checkout for 2 soy candles for priya@example.com",
  "Check the status of that order",
  "Capture it, then refund $12 for a cracked lid",
  "Pay asha@example.com $20 and ravi@example.com $25 for October deliveries",
  "Send $120 to newvendor@mail.test for packaging",
  "Refund the rest of it",
  "List open disputes",
  "Draft a reply to the first dispute",
  "Pay maya@example.com $900 for the photoshoot",
];
$("#chips").innerHTML = CHIPS.map((c) => `<button type="button">${esc(c)}</button>`).join("");
$("#chips").onclick = (e) => { if (e.target.tagName === "BUTTON") { $("#msg").value = e.target.textContent; $("#msg").focus(); } };

$("#f").onsubmit = async (e) => {
  e.preventDefault(); const m = $("#msg").value.trim(); if (!m) return; $("#msg").value = "";
  say("u", esc(m));
  try { const r = await api("/api/chat", { sessionId: session, message: m }); say("a", linkify(r.reply), r.steps); render(r.state); }
  catch (err) { say("a", "⚠️ " + esc(err.message)); }
};
$("#approvals").onclick = async (e) => {
  const b = e.target.closest("button[data-a]"); if (!b) return;
  try { const r = await api(`/api/approvals/${b.dataset.a}/${b.dataset.k}`, {}); render(r.state);
    const o = r.outcome; say("a", b.dataset.k === "approve" ? (o.status === "approved" ? `✅ Approved and executed ${esc(o.call.name)}. PayPal ref <code>${esc(o.result?.batchId ?? o.result?.refundId ?? o.result?.id ?? "")}</code>` : `⚠️ ${esc(o.error)}`) : `Rejected ${esc(o.call.name)}; nothing was sent.`);
  } catch (err) { say("a", "⚠️ " + esc(err.message)); }
};
$("#reset").onclick = async () => { render(await api("/api/reset", {})); $("#log").innerHTML = ""; sessionStorage.removeItem("sid"); };
$("#approveLast").onclick = async () => { const r = await api("/api/mock/approve-last", {}); render(r.state); say("a", "🧪 Simulated: buyer approved the last checkout. Now say “capture it”."); };

api("/api/state").then(render).then(() => say("a", "Hi! I run your PayPal back office: checkout links, captures, refunds, payouts and disputes. Small things I just do; bigger or unusual money moves wait for your click in Approvals."));
