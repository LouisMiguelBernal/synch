// Runs the labeled corpus through the live Core webhook, then grades what landed in Postgres.
//   node eval/run.mjs                 uses whatever TRIAGE_AI_MODE the stack runs (config/triage.env)
//   In mock mode (node eval/mock.mjs running) it also runs fault tests: AI 500s, malformed output,
//   sweeper replay, Slack outage + resend, stuck-ticket recovery.
//   options: --tag=<run tag>  --concurrency=4  --only=b1,b2
// Writes eval/results/<tag>.json and eval/report.md. The webhook token is read from the container, never printed.
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const opt = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? true]; }));
const TAG = String(opt.tag || "run" + new Date().toISOString().replace(/\D/g, "").slice(0, 12));
const URL = "http://localhost:5680/webhook/triage";
const SWEEP_URL = "http://localhost:5680/webhook/triage-sweep";
const CATS = ["Billing", "Access", "Scheduling", "Technical Support", "General Question", "Refund Request"];

const sh = (cmd, input) => execSync(cmd, { cwd: root, encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] });
const TOKEN = sh("docker compose exec -T n8n printenv TRIAGE_WEBHOOK_TOKEN").trim();
const MODE = sh("docker compose exec -T n8n printenv TRIAGE_AI_MODE").trim() || "ollama";
const MOCK = MODE === "mock";
const CONCURRENCY = Number(opt.concurrency || (MODE === "ollama" ? 2 : 4));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sql = (q) => JSON.parse(sh("docker compose exec -T db psql -U postgres -d triage -qAt -v ON_ERROR_STOP=1 -f -", q).trim() || "null");
const mid = (id) => `<${TAG}.${id}@eval.tidewell.example>`;

async function post(payload, token = TOKEN) {
  const t0 = Date.now();
  const res = await fetch(URL, { method: "POST", headers: { "content-type": "application/json", "x-triage-token": token }, body: JSON.stringify(payload) });
  let body = null;
  try { body = await res.json(); } catch {}
  return { status: res.status, body, ms: Date.now() - t0 };
}
async function pool(items, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}

const corpus = JSON.parse(fs.readFileSync(path.join(root, "eval/corpus.json"), "utf8")).items
  .filter((it) => !opt.only || String(opt.only).split(",").includes(it.id));
const payload = (it) => {
  const p = { ...it.msg, message_id: mid(it.id), received_at: new Date().toISOString(), source: "eval" };
  if (it.id === "b8") p.headers = { ...p.headers, References: mid("b1") }; // b8 replies in b1's thread
  return p;
};

console.log(`Run ${TAG}: ${corpus.length} messages, concurrency ${CONCURRENCY}${MOCK ? ", mock faults on" : ""}`);
// Earlier eval runs reuse the same bodies and would trip the possible-duplicate rule; remove only eval-sourced rows.
sql(`DELETE FROM ticket_events WHERE ticket_id IN (SELECT id FROM tickets WHERE source = 'eval');
     DELETE FROM tickets WHERE source = 'eval'; SELECT 'null';`);
if (MOCK) await fetch("http://localhost:8787/slack", { method: "DELETE" }).catch(() => {});
const ordered = [...corpus.filter((c) => c.id !== "b8"), ...corpus.filter((c) => c.id === "b8")];
const first = await pool(ordered.filter((c) => c.id !== "b8"), (it) => post(payload(it)));
const timing = Object.fromEntries(ordered.filter((c) => c.id !== "b8").map((c, k) => [c.id, first[k]]));
for (const it of ordered.filter((c) => c.id === "b8")) timing[it.id] = await post(payload(it));

/* Duplicate test: same Message-ID 3× sequential, then 3× concurrent → one ticket, one claim, one alert at most. */
const dupMsg = { ...corpus.find((c) => c.id === "r1")?.msg || { from: "x@example.com", subject: "dup", text: "refund please" }, message_id: mid("dup"), source: "eval" };
const dupSeq = [];
for (let k = 0; k < 3; k++) dupSeq.push(await post(dupMsg));
const dupPar = await Promise.all([0, 1, 2].map(() => post(dupMsg)));

/* Auth test */
const unauth = await post({ ...dupMsg, message_id: mid("unauth") }, "wrong-token");

/* Gmail reconciliation re-sends known mail: no new ticket, no duplicate event noise. */
const reconcile = await post({ ...dupMsg, source: "gmail_reconcile" });

/* Fault injection (mock only). */
const faults = {};
if (MOCK) {
  // AI always 500 → failed; re-sends re-claim until 3 attempts, then the 4th is a duplicate.
  const f500 = { from: "Fault Test <fault@example.com>", subject: "fault 500", text: "Calendar sync broken [[mock:500]]", message_id: mid("f500"), source: "eval" };
  faults.f500 = [];
  for (let k = 0; k < 4; k++) faults.f500.push(await post(f500));
  faults.malformed = await post({ from: "Fault Test <fault@example.com>", subject: "fault malformed", text: "Invoice question [[mock:malformed]]", message_id: mid("malformed"), source: "eval" });
  // AI down for one whole execution (3 tries) → failed; the sweeper replays it and it succeeds.
  faults.transient = await post({ from: "Fault Test <fault@example.com>", subject: "fault transient", text: `My calendar sync stopped working [[mock:500x3:${TAG}]]`, message_id: mid("transient"), source: "eval" });
  // Slack down for the Core attempt (3 tries) → notified_at null; the sweeper resends it.
  await fetch("http://localhost:8787/slack/fail", { method: "POST", body: JSON.stringify({ n: 3 }) });
  faults.slackDown = await post({ from: "Fault Test <fault@example.com>", subject: "slack down", text: "Please refund my last charge, it was a duplicate.", message_id: mid("slackdown"), source: "eval" });
  // n8n crashed mid-run: a ticket left in 'received' for 20 min → the sweeper marks it stuck and replays it.
  const stuckRaw = { from: "Fault Test <fault@example.com>", subject: "stuck", text: "How do I add a team member?", message_id: mid("stuck"), source: "eval" };
  sql(`INSERT INTO tickets (message_id, source, sender, subject, status, raw, updated_at)
       VALUES ('${mid("stuck")}', 'eval', 'fault@example.com', 'stuck', 'received', '${JSON.stringify(stuckRaw).replace(/'/g, "''")}'::jsonb, now() - interval '20 minutes');
       SELECT 'null';`);
  faults.sweep = await fetch(SWEEP_URL, { method: "POST", headers: { "content-type": "application/json", "x-triage-token": TOKEN },
    body: JSON.stringify({ stuck_minutes: 10, retry_minutes: 0, alert_minutes: 0 }) }).then((r) => r.status).catch(() => null);
  faults.sweepUnauth = await fetch(SWEEP_URL, { method: "POST", headers: { "content-type": "application/json", "x-triage-token": "wrong" }, body: "{}" }).then((r) => r.status).catch(() => null);
  // The sweep answers 202 and keeps running; wait until all three tickets settle.
  for (let i = 0; i < 60; i++) {
    const s = sql(`SELECT json_agg(t) FROM (SELECT message_id, status, notified_at FROM tickets WHERE message_id IN ('${mid("transient")}', '${mid("slackdown")}', '${mid("stuck")}')) t`) || [];
    const by = Object.fromEntries(s.map((r) => [r.message_id, r]));
    if (["ready", "needs_review"].includes(by[mid("transient")]?.status) && by[mid("slackdown")]?.notified_at && ["ready", "needs_review"].includes(by[mid("stuck")]?.status)) break;
    await sleep(2000);
  }
}

/* Collect */
const rows = sql(`SELECT json_agg(t) FROM (SELECT id, message_id, status, skip_reason, category, secondary_category, confidence::float AS confidence,
  model_confidence::float AS model_confidence, rule_categories, alert_attempts,
  language, needs_review, review_reasons, draft, notified_at, attempts, error, model, prompt_version, prior_ticket_id, possible_dup_of,
  position('4242 4242' in coalesce(body_clean, '') || raw::text) = 0 AS no_card_stored
  FROM tickets WHERE message_id LIKE '<${TAG}.%') t`) || [];
const byMid = Object.fromEntries(rows.map((r) => [r.message_id, r]));
const events = sql(`SELECT json_agg(e) FROM (SELECT t.message_id, e.stage, e.detail FROM ticket_events e JOIN tickets t ON t.id = e.ticket_id WHERE t.message_id LIKE '<${TAG}.%') e`) || [];
const evCount = (m, stage) => events.filter((e) => e.message_id === m && e.stage === stage).length;
const slackLog = MOCK ? await fetch("http://localhost:8787/slack").then((r) => r.json()).catch(() => null) : null;

/* Grade */
const results = corpus.map((it) => {
  const r = byMid[mid(it.id)] || null;
  const L = it.label;
  const alerted = !!r && r.status === "needs_review";
  const accepted = L.category ? [L.category, ...(L.accept || [])] : [];
  return {
    id: it.id, tags: it.tags, label: L, row: r, ms: timing[it.id]?.ms, http: timing[it.id]?.status, alerted,
    skipOk: L.skip ? r?.status === "skipped" && r?.skip_reason === L.skip : r?.status !== "skipped",
    strict: L.category ? r?.category === L.category : null,
    lenient: L.category ? accepted.includes(r?.category) : null,
  };
});
const graded = results.filter((x) => x.label.category);
const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) + "%" : "n/a");

const confusion = Object.fromEntries(CATS.map((c) => [c, Object.fromEntries(CATS.map((p) => [p, 0]))]));
for (const x of graded) if (x.row?.category) confusion[x.label.category][x.row.category]++;
const f1s = CATS.map((c) => {
  const tp = confusion[c][c];
  const fp = CATS.reduce((s, o) => s + (o !== c ? confusion[o][c] : 0), 0);
  const fn = CATS.reduce((s, o) => s + (o !== c ? confusion[c][o] : 0), 0);
  const p = tp + fp ? tp / (tp + fp) : 0, r = tp + fn ? tp / (tp + fn) : 0;
  return { c, p, r, f1: p + r ? (2 * p * r) / (p + r) : 0, n: tp + fn };
});
const macroF1 = f1s.reduce((s, x) => s + x.f1, 0) / CATS.length;

const binsFor = (key) => [[0, 0.6], [0.6, 0.8], [0.8, 0.9], [0.9, 1.0001]].map(([lo, hi]) => {
  const inBin = graded.filter((x) => x.row && x.row[key] >= lo && x.row[key] < hi);
  return { range: `${lo.toFixed(1)}–${Math.min(hi, 1).toFixed(1)}`, n: inBin.length, acc: pct(inBin.filter((x) => x.strict).length, inBin.length), lenient: pct(inBin.filter((x) => x.lenient).length, inBin.length) };
});
const bins = binsFor("confidence");
const modelBins = binsFor("model_confidence");
const disagree = graded.filter((x) => (x.row?.review_reasons || []).includes("rule_disagreement"));
const wrong = graded.filter((x) => x.row && !x.strict);

const must = results.filter((x) => x.label.alert === true);
const mustNot = results.filter((x) => x.label.alert === false && !x.label.skip);
const refunds = results.filter((x) => x.label.category === "Refund Request");
const RX_COMMIT = /(we('ll| will| have)? (issue|process|approve)d? (a |your )?(full )?refund|refund (has been|will be|is) (issued|processed|approved)|you will (receive|get) (a |your )?(full )?refund|\$\s?\d|guarantee)/i;
const drafts = results.filter((x) => x.row?.draft);
const draftChecks = drafts.map((x) => ({ id: x.id, signoff: /Tidewell Support\s*$/.test(x.row.draft), noCommit: !RX_COMMIT.test(x.row.draft), short: x.row.draft.split(/\s+/).length <= 200, noCard: !/\b(?:\d[ -]?){13,19}\b/.test(x.row.draft) }));
const allPass = draftChecks.filter((d) => d.signoff && d.noCommit && d.short && d.noCard).length;

const usage = events.reduce((a, e) => {
  const u = e.stage === "classified" ? e.detail?.usage : e.stage === "routed" ? e.detail?.draft_usage : null;
  if (u) { a.input += u.input || 0; a.output += u.output || 0; }
  return a;
}, { input: 0, output: 0 });
const lat = results.map((x) => x.ms).filter(Boolean).sort((a, b) => a - b);
const q = (p) => lat.length ? lat[Math.min(lat.length - 1, Math.floor(p * lat.length))] : 0;
const models = [...new Set(rows.map((r) => r.model).filter(Boolean))];
const promptVersions = [...new Set(rows.map((r) => r.prompt_version).filter(Boolean))];

const dupRow = byMid[mid("dup")];
const dupAlerts = slackLog ? slackLog.filter((a) => dupRow && String(a.text).includes(`#${dupRow.id} `)).length : null;
const checks = [
  ["Duplicate: one ticket for 6 sends", rows.filter((r) => r.message_id === mid("dup")).length === 1],
  ["Duplicate: claimed once, 5 ignored", evCount(mid("dup"), "claimed") === 1 && evCount(mid("dup"), "duplicate_ignored") >= 4],
  ["Duplicate: AI called once", evCount(mid("dup"), "classified") === 1],
  ["Duplicate: at most one alert", (dupAlerts ?? evCount(mid("dup"), "notified")) <= 1],
  ["Wrong token → 401, nothing stored", unauth.status === 401 && !byMid[mid("unauth")]],
  ["Refund alert recall = 100%", refunds.every((x) => x.alerted)],
  ["Card number masked before storage and AI (e11)", !corpus.some((c) => c.id === "e11") || byMid[mid("e11")]?.no_card_stored === true],
  ["Thread follow-up linked (b8 → b1)", !corpus.some((c) => c.id === "b8") || byMid[mid("b8")]?.prior_ticket_id === byMid[mid("b1")]?.id],
  ["Gmail reconcile resend → duplicate, no event noise", reconcile.body?.reason === "duplicate" && !events.some((e) => e.stage === "duplicate_ignored" && e.detail?.source === "gmail_reconcile")],
];
if (MOCK) {
  const f = byMid[mid("f500")], tr = byMid[mid("transient")], sd = byMid[mid("slackdown")], st = byMid[mid("stuck")];
  const sdNotified = events.filter((e) => e.message_id === mid("slackdown") && e.stage === "notified");
  checks.push(["AI 500 → HTTP 502 + ticket failed", faults.f500[0].status === 502 && f?.status === "failed"]);
  checks.push(["Retries re-claim until 3 attempts, then stop", f?.attempts === 3 && faults.f500[3].body?.reason === "duplicate"]);
  checks.push(["Malformed AI output → review with invalid_model_output", (byMid[mid("malformed")]?.review_reasons || []).includes("invalid_model_output")]);
  checks.push(["Sweep webhook: token → 202, wrong token → 401", faults.sweep === 202 && faults.sweepUnauth === 401]);
  checks.push(["AI outage → failed → sweeper replay succeeds (attempt 2)", faults.transient.status === 502 && ["ready", "needs_review"].includes(tr?.status) && tr?.attempts === 2]);
  checks.push(["Slack outage → sweeper resends alert once", !!sd?.notified_at && sd?.alert_attempts === 1 && sdNotified.length === 1 && sdNotified[0].detail?.by === "sweeper"]);
  checks.push(["Stuck ticket → marked stuck → replayed", ["ready", "needs_review"].includes(st?.status) && evCount(mid("stuck"), "marked_stuck") === 1]);
}

/* Report */
const md = [];
md.push(`# Eval report — ${TAG}`, "");
md.push(`- Date: ${new Date().toISOString()}`, `- AI mode: ${MOCK ? "**MOCK** (keyword stub — classification numbers below say nothing about model quality)" : MODE} · models: ${models.join(", ") || "n/a"} · prompt version: ${promptVersions.join(", ") || "n/a"}`);
md.push(`- Messages: ${corpus.length} (${graded.length} graded for category, ${results.filter((x) => x.label.skip).length} expected skips)`, "");
md.push("## Checks", "", "| Check | Result |", "|---|---|", ...checks.map(([n, ok]) => `| ${n} | ${ok ? "PASS" : "**FAIL**"} |`), "");
md.push("## Classification", "");
md.push(`| Metric | Value |`, `|---|---|`);
md.push(`| Accuracy (exact label) | ${pct(graded.filter((x) => x.strict).length, graded.length)} |`);
md.push(`| Accuracy (label or listed alternative) | ${pct(graded.filter((x) => x.lenient).length, graded.length)} |`);
md.push(`| Macro F1 (exact) | ${macroF1.toFixed(3)} |`);
md.push(`| Skips correct | ${pct(results.filter((x) => x.skipOk).length, results.length)} |`, "");
md.push("Per class:", "", "| Category | n | Precision | Recall | F1 |", "|---|---|---|---|---|", ...f1s.map((x) => `| ${x.c} | ${x.n} | ${x.p.toFixed(2)} | ${x.r.toFixed(2)} | ${x.f1.toFixed(2)} |`), "");
md.push("Confusion (rows = label, columns = predicted):", "", `| | ${CATS.map((c) => c.split(" ")[0]).join(" | ")} |`, `|---|${CATS.map(() => "---").join("|")}|`,
  ...CATS.map((c) => `| ${c} | ${CATS.map((p) => confusion[c][p] || "·").join(" | ")} |`), "");
md.push("## Calibration — does the 80% threshold mean anything?", "", "| Confidence | n (final) | Accuracy exact | Accuracy lenient | n (model raw) | Accuracy exact (raw) |", "|---|---|---|---|---|---|",
  ...bins.map((b, k) => `| ${b.range} | ${b.n} | ${b.acc} | ${b.lenient} | ${modelBins[k].n} | ${modelBins[k].acc} |`), "");
md.push("Final = after the keyword cross-check (`confidence`); raw = the model's own score (`model_confidence`). Target: messages at ≥ 0.8 should be ≥ 90% correct.", "");
md.push(`Keyword disagreement: ${disagree.length} of ${graded.length} graded tickets capped; ${disagree.filter((x) => !x.strict).length} of them were wrong (exact). Wrong predictions caught by the cap: ${wrong.filter((x) => (x.row.review_reasons || []).includes("rule_disagreement")).length} of ${wrong.length}.`, "");
md.push("## Alerts", "", "| Metric | Value |", "|---|---|");
md.push(`| Must-alert recall (label alert = true) | ${pct(must.filter((x) => x.alerted).length, must.length)} |`);
md.push(`| Refund alert recall | ${pct(refunds.filter((x) => x.alerted).length, refunds.length)} |`);
md.push(`| Alerts on mail that did not need one | ${pct(mustNot.filter((x) => x.alerted).length, mustNot.length)} |`);
md.push(`| Alert rate overall (non-skipped) | ${pct(results.filter((x) => x.alerted).length, results.filter((x) => !x.label.skip).length)} |`, "");
const missed = must.filter((x) => !x.alerted);
if (missed.length) md.push("Missed must-alerts: " + missed.map((x) => `${x.id} (${x.row?.status})`).join(", "), "");
md.push("## Drafts (automatic checks; read the appendix for the manual rubric)", "", `- ${allPass}/${drafts.length} pass all checks (sign-off, no refund/amount promise, ≤ 200 words, no card number)`);
for (const d of draftChecks.filter((d) => !(d.signoff && d.noCommit && d.short && d.noCard))) md.push(`- ${d.id}: ${Object.entries(d).filter(([k, v]) => k !== "id" && !v).map(([k]) => k).join(", ")}`);
md.push("", "## Cost and latency", "", `- Tokens: ${usage.input} in / ${usage.output} out (output includes thinking)`, `- Latency per message (webhook round trip, concurrency ${CONCURRENCY}): p50 ${q(0.5)} ms · p95 ${q(0.95)} ms`, "");
md.push("## Per message", "", "| id | tags | label | predicted | conf | status | reasons |", "|---|---|---|---|---|---|---|",
  ...results.map((x) => `| ${x.id} | ${x.tags.join(" ")} | ${x.label.category || "skip:" + x.label.skip}${x.label.alert ? " ⚑" : ""} | ${x.row?.category || x.row?.skip_reason || "—"}${x.strict === false ? (x.lenient ? " ~" : " ✗") : ""} | ${x.row?.confidence ?? ""} | ${x.row?.status || "missing"} | ${(x.row?.review_reasons || []).join(", ")} |`), "");
md.push("✗ wrong · ~ acceptable alternative · ⚑ must alert", "");
md.push("## Appendix — drafts for manual review", "");
for (const x of drafts.slice(0, 20)) md.push(`### ${x.id} — ${x.row.category}`, "", "```", x.row.draft, "```", "");

fs.mkdirSync(path.join(root, "eval/results"), { recursive: true });
fs.writeFileSync(path.join(root, `eval/results/${TAG}.json`), JSON.stringify({ tag: TAG, mock: MOCK, results, checks, faults, usage }, null, 2));
fs.writeFileSync(path.join(root, "eval/report.md"), md.join("\n"));
console.log(md.slice(0, md.indexOf("## Classification")).join("\n"));
console.log(`Report: eval/report.md · raw: eval/results/${TAG}.json`);
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
