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

// Policy verdict badge (allow / needs_approval / deny / invalid); text stays the raw verdict.
const vb = (v) => `<span class="vb ${esc(v)}">${esc(v)}</span>`;

function say(role, html, steps = [], extra = "") {
  const d = document.createElement("div"); d.className = `m ${role}${extra}`; d.innerHTML = html;
  for (const s of steps) {
    const v = s.decision?.verdict ?? (s.status === "denied" ? "deny" : "allow");
    const st = document.createElement("div"); st.className = `step ${v}`;
    const txt = document.createElement("span");
    txt.textContent = `${s.call.name}(${JSON.stringify(s.call.args)}) → policy: ${v} · ${s.status}${s.decision ? " · " + s.decision.reasons.join("; ") : ""}`;
    st.innerHTML = vb(v); st.appendChild(txt);
    d.appendChild(st);
  }
  $("#log").appendChild(d); $("#log").scrollTop = 1e9;
}

function render(st) {
  // Header badges: neutral AI label from the server (never a vendor or model name).
  const ai = st.aiBadge || "live LLM";
  $("#badges").innerHTML = `<span class="pill badge ${esc(st.paypalMode)}">PayPal: ${esc(st.paypalMode)}</span><span class="pill badge ai${/offline/.test(ai) ? " offline" : ""}">AI: ${esc(ai)}</span>`;
  $("#policy").textContent = st.policy.text;
  if (st.limits?.maxInputChars) $("#msg").maxLength = st.limits.maxInputChars;
  const pct = Math.min(100, (100 * st.outflowLast24h) / st.policy.dailyOutflowCap);
  $("#bar").style.width = pct + "%"; $("#bar").classList.toggle("hot", pct > 80);
  $("#outflow").textContent = `Outflow in last 24h: ${st.outflowLast24h} / ${st.policy.dailyOutflowCap} ${st.currency}`;
  $("#approveLast").hidden = !(st.paypalMode === "mock" && st.refs.lastOrderId);
  $("#apc").textContent = st.approvals.length; $("#apc").classList.toggle("has", st.approvals.length > 0);
  $("#approvals").classList.toggle("empty", !st.approvals.length);
  $("#approvals").innerHTML = st.approvals.length ? st.approvals.map((a) => `<div class="ap"><div class="head"><b>${esc(a.call.name)}</b>${vb(a.decision.verdict)}</div><div class="amt">${esc(a.decision.amount)} ${esc(st.currency)}</div><div class="args">${esc(JSON.stringify(a.call.args))}</div><div class="why">${esc(a.decision.reasons.join("; "))}</div><button class="ok small" data-a="${esc(a.id)}" data-k="approve">Approve</button> <button class="bad small" data-a="${esc(a.id)}" data-k="reject">Reject</button></div>`).join("") : "Nothing waiting.";
  // Ledger "Tool" column shows the tool name only (no planner, vendor or model line).
  $("#ledger").innerHTML = st.ledger.map((l) => `<tr><td class="time">${new Date(l.at).toLocaleTimeString()}</td><td class="tool">${esc(l.tool)}</td><td class="amt">${l.amount ? esc(l.amount) : ""}</td><td>${vb(l.verdict)}</td><td>${esc(l.status)}</td><td>${l.paypalRef ? `<code>${esc(l.paypalRef)}</code>` : ""}</td><td class="muted">${esc(l.error ?? l.reasons.join("; "))}</td></tr>`).join("");
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
  "Pay maya@example.com $900 for the photo shoot",
];
$("#chips").innerHTML = CHIPS.map((c) => `<button type="button">${esc(c)}</button>`).join("");
$("#chips").onclick = (e) => { if (e.target.tagName === "BUTTON") { $("#msg").value = e.target.textContent; $("#msg").focus(); } };

$("#f").onsubmit = async (e) => {
  e.preventDefault(); const m = $("#msg").value.trim(); if (!m) return; $("#msg").value = "";
  say("u", esc(m));
  try { const r = await api("/api/chat", { sessionId: session, message: m }); say("a", linkify(r.reply), r.steps); render(r.state); }
  catch (err) { say("a err", "⚠️ " + esc(err.message)); }
};
$("#approvals").onclick = async (e) => {
  const b = e.target.closest("button[data-a]"); if (!b) return;
  try { const r = await api(`/api/approvals/${b.dataset.a}/${b.dataset.k}`, {}); render(r.state);
    const o = r.outcome; const failed = b.dataset.k === "approve" && o.status !== "approved";
    say("a", b.dataset.k === "approve" ? (o.status === "approved" ? `✅ Approved and executed ${esc(o.call.name)}. PayPal ref <code>${esc(o.result?.batchId ?? o.result?.refundId ?? o.result?.id ?? "")}</code>` : `⚠️ ${esc(o.error)}`) : `Rejected ${esc(o.call.name)}; nothing was sent.`, [], failed ? " err" : "");
  } catch (err) { say("a err", "⚠️ " + esc(err.message)); }
};
$("#reset").onclick = async () => { render(await api("/api/reset", {})); $("#log").innerHTML = ""; sessionStorage.removeItem("sid"); };
$("#approveLast").onclick = async () => { const r = await api("/api/mock/approve-last", {}); render(r.state); say("a", "🧪 Simulated: buyer approved the last checkout. Now say “capture it”."); };

api("/api/state").then(render).then(() => say("a", "Hi! I run your PayPal back office: checkout links, captures, refunds, payouts and disputes. Small things I just do; bigger or unusual money moves wait for your click in Approvals."));
