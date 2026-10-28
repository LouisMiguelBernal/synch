// Generates the importable n8n workflow JSON from readable source.
//   node build-workflows.mjs   → workflows/core.json, gmail.json, sweeper.json, errors.json + deliverables/PROMPTS.md
// Edit THIS file (and prompts/*.md), not the JSON. PROMPT_VERSION changes automatically when a prompt changes.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const here = import.meta.dirname;
const read = (f) => fs.readFileSync(path.join(here, f), "utf8").replace(/\r\n/g, "\n").trim();
const PROMPTS = { classify: read("prompts/classify.md"), draft: read("prompts/draft.md"), policy: read("prompts/policy.md") };
const PROMPT_VERSION = "p-" + crypto.createHash("sha256").update(JSON.stringify(PROMPTS)).digest("hex").slice(0, 8);

const uuid = (s) => crypto.createHash("md5").update(s).digest("hex").replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5");
const wfId = (name) => crypto.createHash("md5").update(name).digest("base64url").slice(0, 16);

// Credentials are created by scripts/setup.mjs with these fixed ids (Gmail is picked in the n8n UI).
const CRED = {
  postgres: { postgres: { id: "triagePostgres01", name: "Triage Postgres" } },
  anthropic: { httpHeaderAuth: { id: "triageAnthropic1", name: "Anthropic API key" } },
  gmail: { gmailOAuth2: { id: "triageGmail00001", name: "Triage Gmail" } },
};
const RETRY = { retryOnFail: true, maxTries: 3, waitBetweenTries: 5000 };
const CORE_URL = "http://localhost:5678/webhook/triage"; // n8n calling itself inside the container

export const CATEGORIES = ["Billing", "Access", "Scheduling", "Technical Support", "General Question", "Refund Request"];
const MODEL_REASONS = ["legal", "chargeback", "security", "angry", "multiple_requests", "unclear", "prompt_injection", "sensitive_data"];

// Runtime settings come from config/triage.env (non-secret) and .env (secrets). Mode picks AI endpoint, models and Slack target.
const MODE = "($env.TRIAGE_AI_MODE || 'ollama')";
const SLACK_URL = `(${MODE} === 'mock' ? 'http://host.docker.internal:8787/slack' : ($env.TRIAGE_SLACK_WEBHOOK_URL || ''))`;
const AI_URL = `($env.TRIAGE_AI_BASE_URL || (${MODE} === 'anthropic' ? 'https://api.anthropic.com' : ${MODE} === 'mock' ? 'http://host.docker.internal:8787' : 'http://host.docker.internal:11434'))`;
const MODEL = (v) => `($env.${v} || (${MODE} === 'anthropic' ? 'claude-opus-5-5' : ${MODE} === 'mock' ? 'mock' : 'gemma4:e4b'))`;
const EDITOR_URL = "($env.N8N_EDITOR_BASE_URL || 'http://localhost:5680/')";

function workflow(name) {
  const nodes = [];
  const connections = {};
  const node = (n) => {
    nodes.push({ id: uuid(name + n.name), typeVersion: 1, parameters: {}, ...n });
    return n.name;
  };
  const link = (from, to, output = 0) => {
    connections[from] ??= { main: [] };
    while (connections[from].main.length <= output) connections[from].main.push([]);
    connections[from].main[output].push({ node: to, type: "main", index: 0 });
  };
  const note = (content, position, width, height, color = 7) =>
    nodes.push({ id: uuid(name + content), name: content.split("\n")[0].replace(/^#+\s*/, ""), type: "n8n-nodes-base.stickyNote", typeVersion: 1, position, parameters: { content, width, height, color } });
  return { node, link, note, build: (settings = {}) => ({ id: wfId(name), name, nodes, connections, active: false, settings: { executionOrder: "v1", ...settings }, pinData: {} }) };
}

const code = (name, position, jsCode, extra = {}) => ({
  name, type: "n8n-nodes-base.code", typeVersion: 2, position,
  parameters: { mode: "runOnceForEachItem", jsCode: jsCode.trim() }, ...extra,
});
const pg = (name, position, query, params, extra = {}) => ({
  name, type: "n8n-nodes-base.postgres", typeVersion: 2.6, position, credentials: CRED.postgres, ...RETRY,
  parameters: { operation: "executeQuery", query: query.trim(), options: params ? { queryReplacement: `={{ [ ${params} ] }}` } : {} }, ...extra,
});
const ifNode = (name, position, expr) => ({
  name, type: "n8n-nodes-base.if", typeVersion: 2.2, position,
  parameters: { conditions: { options: { caseSensitive: true, typeValidation: "loose", version: 2 }, combinator: "and",
    conditions: [{ id: uuid(name), leftValue: `={{ ${expr} }}`, rightValue: true, operator: { type: "boolean", operation: "true", singleValue: true } }] }, options: {} },
});
const respond = (name, position, bodyExpr, status = 200) => ({
  name, type: "n8n-nodes-base.respondToWebhook", typeVersion: 1.1, position,
  parameters: { respondWith: "json", responseBody: `={{ JSON.stringify(${bodyExpr}) }}`, options: { responseCode: status } },
});
const slack = (name, position, textExpr, extra = {}) => ({
  name, type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, position, ...RETRY,
  parameters: { method: "POST", url: `={{ ${SLACK_URL} }}`, sendBody: true, specifyBody: "json",
    jsonBody: `={{ JSON.stringify({ text: ${textExpr} }) }}`, options: { timeout: 15000 } }, ...extra,
});
const postCore = (name, position, bodyExpr, extra = {}) => ({
  name, type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, position,
  parameters: { method: "POST", url: CORE_URL, sendHeaders: true,
    headerParameters: { parameters: [{ name: "x-triage-token", value: "={{ $env.TRIAGE_WEBHOOK_TOKEN }}" }] },
    sendBody: true, specifyBody: "json", jsonBody: `={{ JSON.stringify(${bodyExpr}) }}`,
    options: { timeout: 300000, batching: { batch: { batchSize: 1, batchInterval: 0 } } } },
  ...extra,
});
// Shared-token check for webhook entry points (timing-safe). Returns { authorized } merged into the item.
const TOKEN_CHECK = `
const crypto = require('crypto');
const given = Buffer.from(String(($json.headers || {})['x-triage-token'] || ''));
const expected = Buffer.from(String($env.TRIAGE_WEBHOOK_TOKEN || ''));
const authorized = expected.length > 0 && given.length === expected.length && crypto.timingSafeEqual(given, expected);`;
// n8n ends an expression at the first "}}", so nested object literals must never close back to back.
const noDoubleBrace = (s) => { while (s.includes("}}")) s = s.replaceAll("}}", "} }"); return s; };
// Messages API call (Claude, or Ollama's compatible endpoint). Body is built in an expression so the request is visible in the node.
const ai = (name, position, bodyExpr, extra = {}) => ({
  name, type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, position, ...RETRY,
  credentials: CRED.anthropic,
  parameters: {
    method: "POST", url: "={{ $('Config & Prompts').item.json.AI_BASE_URL }}/v1/messages",
    authentication: "genericCredentialType", genericAuthType: "httpHeaderAuth",
    sendHeaders: true,
    headerParameters: { parameters: [
      { name: "anthropic-version", value: "2026-10-21" },
      { name: "anthropic-beta", value: "server-side-fallback-2026-07-01" },
    ] },
    sendBody: true, specifyBody: "json", jsonBody: `={{ JSON.stringify(${noDoubleBrace(bodyExpr)}) }}`,
    options: { timeout: 180000 },
  },
  ...extra,
});

const CLASSIFY_SCHEMA = {
  type: "object",
  properties: {
    category: { type: "string", enum: CATEGORIES },
    secondary_category: { anyOf: [{ type: "string", enum: CATEGORIES }, { type: "null" }] },
    confidence: { type: "number" },
    needs_review: { type: "boolean" },
    review_reasons: { type: "array", items: { type: "string", enum: MODEL_REASONS } },
    language: { type: "string" },
    summary: { type: "string" },
  },
  required: ["category", "secondary_category", "confidence", "needs_review", "review_reasons", "language", "summary"],
  additionalProperties: false,
};
// Server-side refusal fallback is only accepted on these models; other models get no `fallbacks` field.
const FALLBACK_MODELS = ["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5", "claude-fable-5-1"];

// Keyword second opinion on the category. Self-reported model confidence is uncalibrated (local model: ≥ 0.9 on 95% of mail),
// so when strong keywords point only to other categories the confidence is capped and the ticket goes to review.
const RULE_CATEGORIES = {
  "Refund Request": /\b(refund|reimburs|money back|charge ?back|reembolso)/i,
  "Access": /\b(can'?t|cannot|unable to|not able to) (log ?in|sign ?in|access)|\blocked out\b|\b(reset|forgot) (my )?password|\bpassword reset\b|\b2fa\b|two[- ]factor|verification code|\bsso\b/i,
  "Technical Support": /\b(error|crash(es|ed|ing)?|bug|not working|isn'?t working|stopped (working|syncing|sending)|won'?t (load|sync)|blank (page|screen)|outage)\b/i,
  "Billing": /\b(invoice|receipt|charged|payment (method|failed)|failed payment|vat|billing)\b/i,
  "Scheduling": /\b(reschedul\w*|appointment|availability|book (a|the) (demo|call))\b/i,
};
const RULE_CONFIDENCE_CAP = 0.6;

/* ───────────────────────────── Core: webhook → classify → draft → store → alert ───────────────────────────── */
const CORE = "Triage — Core";
const ERRORS = "Triage — Errors";
const w = workflow(CORE);

w.note("## 1. Intake\nOne entry point for Gmail, the sweeper and the eval harness. Token-checked, normalized, then **claimed atomically** in Postgres (unique Message-ID) before any AI call — duplicates and retries stop here.", [-40, 80], 1340, 420, 7);
w.note("## 2. AI\nClassify (JSON schema) → validate + keyword cross-check (bad output or disagreement → review) → draft reply grounded in the policy. Prompts and models live in **Config & Prompts**.", [1320, 80], 1100, 420, 4);
w.note("## 3. Route & alert\nRules + model flags decide review. Slack alert (when a webhook URL is configured) on low confidence, any refund signal, or a review rule. Every stage writes `ticket_events`.", [2440, 80], 1100, 420, 6);
w.note("## Errors\nClassification failure → ticket `failed` (re-claimable, max 3 attempts; the sweeper replays it). Final failure alerts Slack. Anything unexpected → **Triage — Errors** workflow.", [1500, 560], 1160, 340, 5);

const hook = w.node({
  name: "Webhook", type: "n8n-nodes-base.webhook", typeVersion: 2.1, position: [0, 300], webhookId: uuid("triage-webhook"),
  parameters: { httpMethod: "POST", path: "triage", responseMode: "responseNode", options: {} },
});

const cfgFields = [
  ["PROMPT_VERSION", PROMPT_VERSION],
  ["AI_MODE", `={{ ${MODE} }}`],
  ["AI_BASE_URL", `={{ ${AI_URL} }}`],
  ["CLASSIFY_MODEL", `={{ ${MODEL("TRIAGE_CLASSIFY_MODEL")} }}`],
  ["CLASSIFY_EFFORT", "low"],
  ["DRAFT_MODEL", `={{ ${MODEL("TRIAGE_DRAFT_MODEL")} }}`],
  ["DRAFT_EFFORT", "medium"],
  ["CONFIDENCE_THRESHOLD", "={{ Number($env.TRIAGE_CONFIDENCE_THRESHOLD || 0.8) }}", "number"],
  ["SLACK_URL", `={{ ${SLACK_URL} }}`],
  ["MAX_BODY_CHARS", 8000],
  ["CLASSIFY_PROMPT", PROMPTS.classify],
  ["DRAFT_PROMPT", PROMPTS.draft],
  ["POLICY", PROMPTS.policy],
];
const cfg = w.node({
  name: "Config & Prompts", type: "n8n-nodes-base.set", typeVersion: 3.4, position: [220, 300],
  parameters: { assignments: { assignments: cfgFields.map(([k, v, t]) => ({ id: uuid(k), name: k, value: v, type: t || (typeof v === "number" ? "number" : "string") })) }, options: {} },
});
w.link(hook, cfg);

const normalize = w.node(code("Normalize", [440, 300], `
// Checks the shared token, then turns any inbound payload (Gmail, sweeper, eval) into one shape.
// Payload: { message_id, thread_id?, from, from_name?, subject, text?, html?, received_at?, headers?, has_attachments?, source? }
const req = $('Webhook').item.json;
const cfg = $('Config & Prompts').item.json;
${TOKEN_CHECK.replaceAll("$json.headers", "req.headers")}
if (!authorized) return { json: { authorized: false } };

// Card numbers (Luhn-valid) are masked before anything is stored or sent to the model.
const luhn = (s) => { let sum = 0, alt = false; for (let i = s.length - 1; i >= 0; i--) { let x = +s[i]; if (alt) { x *= 2; if (x > 9) x -= 9; } sum += x; alt = !alt; } return sum % 10 === 0; };
let masked = 0;
const maskCards = (s) => s == null ? s : String(s).replace(/\\b(?:\\d[ -]?){13,19}\\b/g, (x) => luhn(x.replace(/\\D/g, '')) ? (masked++, '[card number removed]') : x);
const m = { ...(req.body || {}) };
m.text = maskCards(m.text);
m.html = maskCards(m.html);
m.subject = maskCards(m.subject);
const h = Object.fromEntries(Object.entries(m.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

const htmlToText = (html) => String(html || '')
  .replace(/<(script|style)[\\s\\S]*?<\\/\\1>/gi, '')
  .replace(/<br\\s*\\/?>|<\\/(p|div|li|tr)>/gi, '\\n')
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

// Keep only the new text: drop quoted lines, everything after a reply header, and the signature.
function clean(text) {
  const out = [];
  for (const line of String(text).replace(/\\r\\n?/g, '\\n').split('\\n')) {
    const t = line.trim();
    if (/^>/.test(t)) continue;
    if (/^On .{4,200}wrote:$/i.test(t) || /^-{2,}\\s*(Original|Forwarded) Message/i.test(t)) break;
    if (out.some((l) => l.trim()) && /^From:\\s.+/i.test(t)) break;
    if (/^--\\s*$/.test(line) || /^Sent from my /i.test(t)) break;
    out.push(line);
  }
  return out.join('\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
}

const fromRaw = String(m.from || '');
const addr = (fromRaw.match(/<([^>]+)>/) || [, fromRaw])[1].trim().toLowerCase();
const name = m.from_name || (fromRaw.includes('<') ? fromRaw.split('<')[0].replace(/"/g, '').trim() : '');
const subject = String(m.subject || '').trim();
const body = clean(m.text || htmlToText(m.html)).slice(0, cfg.MAX_BODY_CHARS);
const messageId = String(m.message_id || h['message-id'] || '').trim() || 'generated:' + sha([addr, subject, m.received_at || '', body].join('|'));
const refs = (h['references'] || '').split(/\\s+/).filter(Boolean);

let skip = null;
if (/^(mailer-daemon|postmaster)@/.test(addr) || /^(undeliverable|delivery status notification|mail delivery (failed|subsystem))/i.test(subject)) skip = 'bounce';
else if ((h['auto-submitted'] && h['auto-submitted'] !== 'no') || h['x-autoreply'] || /^(auto_reply|bulk|junk|list)$/i.test(h['precedence'] || '') || /^(automatic reply|auto[- ]?reply|out of (the )?office)/i.test(subject)) skip = 'auto_reply';
else if (addr && addr === String($env.TRIAGE_SUPPORT_ADDRESS || '').toLowerCase()) skip = 'self_loop';

return { json: {
  authorized: true,
  message_id: messageId,
  thread_id: m.thread_id || refs[0] || h['in-reply-to'] || messageId,
  source: m.source || 'webhook',
  sender: addr || null,
  sender_name: name || null,
  subject,
  body_clean: body,
  body_sha256: sha(body.toLowerCase().replace(/\\s+/g, ' ')),
  received_at: m.received_at || new Date().toISOString(),
  has_attachments: !!m.has_attachments,
  skip_reason: skip,
  cards_masked: masked,
  raw: m,
} };
`));
w.link(cfg, normalize);

const authorized = w.node(ifNode("Authorized?", [660, 300], "$json.authorized"));
w.link(normalize, authorized);
const r401 = w.node(respond("Respond: 401", [880, 460], "{ ok: false, error: 'unauthorized' }", 401));
w.link(authorized, r401, 1);

const claim = w.node(pg("Claim ticket", [880, 300], `
-- Atomic duplicate prevention: a Message-ID is processed once. A failed ticket can be re-claimed (max 3 attempts).
WITH input AS (SELECT $1::jsonb AS j),
claimed AS (
  INSERT INTO tickets (message_id, thread_id, source, sender, subject, body_clean, body_sha256, received_at,
                       status, skip_reason, raw, prior_ticket_id, possible_dup_of)
  SELECT j->>'message_id', j->>'thread_id', j->>'source', j->>'sender', j->>'subject', j->>'body_clean', j->>'body_sha256',
         (j->>'received_at')::timestamptz,
         (CASE WHEN j->>'skip_reason' IS NULL THEN 'received' ELSE 'skipped' END)::ticket_status,
         j->>'skip_reason', j->'raw',
         (SELECT t.id FROM tickets t WHERE t.thread_id = j->>'thread_id' ORDER BY t.id DESC LIMIT 1),
         (SELECT t.id FROM tickets t WHERE t.sender = j->>'sender' AND t.body_sha256 = j->>'body_sha256'
            AND t.created_at > now() - interval '24 hours' ORDER BY t.id DESC LIMIT 1)
  FROM input
  ON CONFLICT (message_id) DO UPDATE
    SET attempts = tickets.attempts + 1, status = 'received', error = NULL, updated_at = now()
    WHERE tickets.status = 'failed' AND tickets.attempts < 3
  RETURNING id, status::text AS status, attempts, prior_ticket_id, possible_dup_of
),
ev AS (
  INSERT INTO ticket_events (ticket_id, stage, detail)
  SELECT id, CASE WHEN status = 'skipped' THEN 'skipped' ELSE 'claimed' END,
         jsonb_build_object('attempt', attempts, 'source', (SELECT j->>'source' FROM input), 'skip_reason', (SELECT j->>'skip_reason' FROM input))
  FROM claimed
),
dup AS (
  -- Gmail reconciliation re-sends known mail on purpose; only log duplicates from other sources.
  INSERT INTO ticket_events (ticket_id, stage, detail)
  SELECT t.id, 'duplicate_ignored', jsonb_build_object('source', i.j->>'source', 'status', t.status)
  FROM tickets t, input i
  WHERE t.message_id = i.j->>'message_id' AND NOT EXISTS (SELECT 1 FROM claimed) AND i.j->>'source' <> 'gmail_reconcile'
)
SELECT c.*, NULL AS existing_id FROM claimed c
UNION ALL
SELECT NULL, t.status::text, t.attempts, NULL, NULL, t.id FROM tickets t, input i
WHERE t.message_id = i.j->>'message_id' AND NOT EXISTS (SELECT 1 FROM claimed);
`, "$json", { alwaysOutputData: true }));
w.link(authorized, claim, 0);

const isNew = w.node(ifNode("New ticket?", [1100, 300], "!!$json.id && $json.status === 'received'"));
w.link(claim, isNew);
const rSkip = w.node(respond("Respond: not processed", [1320, 460],
  "{ ok: true, processed: false, reason: $json.status === 'skipped' && $json.id ? 'skipped: ' + $('Normalize').item.json.skip_reason : 'duplicate', ticket_id: $json.id || $json.existing_id || null, status: $json.status || null }"));
w.link(isNew, rSkip, 1);

const classify = w.node(ai("AI: classify", [1400, 300], `(() => {
  const c = $('Config & Prompts').item.json, n = $('Normalize').item.json;
  const body = {
    model: c.CLASSIFY_MODEL,
    max_tokens: 4000,
    output_config: { effort: c.CLASSIFY_EFFORT, format: { type: 'json_schema', schema: ${JSON.stringify(CLASSIFY_SCHEMA)} } },
    system: c.CLASSIFY_PROMPT,
    messages: [{ role: 'user', content: '<email>\\nFrom: ' + (n.sender_name || '') + ' <' + (n.sender || 'unknown') + '>\\nSubject: ' + n.subject + '\\nAttachments: ' + (n.has_attachments ? 'yes' : 'no') + '\\n\\n' + n.body_clean + '\\n</email>' }],
  };
  if (${JSON.stringify(FALLBACK_MODELS)}.includes(c.CLASSIFY_MODEL)) body.fallbacks = 'default';
  return body;
})()`, { onError: "continueErrorOutput" }));
w.link(isNew, classify, 0);

const validate = w.node(code("Validate classification", [1620, 300], `
// Never trust model output blindly: enum + type checks; anything off becomes a safe fallback that forces review.
// Then a keyword second opinion: if strong keywords point only to other categories, confidence is capped.
const CATS = ${JSON.stringify(CATEGORIES)};
const REASONS = ${JSON.stringify(MODEL_REASONS)};
const RULES = { ${Object.entries(RULE_CATEGORIES).map(([k, rx]) => `${JSON.stringify(k)}: ${rx}`).join(", ")} };
const n = $('Normalize').item.json;
const res = $json;
let p = null, problem = null;
try {
  if (res.stop_reason === 'refusal') throw new Error('model_refusal');
  if (res.stop_reason === 'max_tokens') throw new Error('max_tokens');
  // Claude returns bare JSON (schema-enforced). Local models may wrap it in prose or a code fence: take the outer {...}.
  const text = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  p = JSON.parse(start >= 0 && end > start ? text.slice(start, end + 1) : text);
} catch (e) { problem = e.message; }

let out;
if (p && CATS.includes(p.category) && typeof p.confidence === 'number' && Number.isFinite(p.confidence)) {
  const conf = p.confidence > 1 && p.confidence <= 100 ? p.confidence / 100 : p.confidence;
  out = {
    category: p.category,
    secondary_category: CATS.includes(p.secondary_category) && p.secondary_category !== p.category ? p.secondary_category : null,
    model_confidence: Math.round(Math.min(1, Math.max(0, conf)) * 1000) / 1000,
    needs_review: p.needs_review === true,
    review_reasons: (Array.isArray(p.review_reasons) ? p.review_reasons : []).filter((r) => REASONS.includes(r)),
    language: String(p.language || '').toLowerCase().slice(0, 8) || null,
    summary: String(p.summary || '').slice(0, 500) || null,
    valid: true,
  };
} else {
  out = { category: 'General Question', secondary_category: null, model_confidence: 0, needs_review: true,
          review_reasons: ['invalid_model_output'], language: null, summary: null, valid: false, problem: problem || 'schema_mismatch' };
}

const text = n.subject + '\\n' + n.body_clean;
const hits = Object.keys(RULES).filter((c) => RULES[c].test(text));
out.rule_categories = hits;
out.rule_disagreement = out.valid && hits.length > 0 && !hits.includes(out.category) && !hits.includes(out.secondary_category);
out.confidence = out.rule_disagreement ? Math.min(out.model_confidence, ${RULE_CONFIDENCE_CAP}) : out.model_confidence;
if (out.rule_disagreement) out.review_reasons.push('rule_disagreement');
out.model = res.model || $('Config & Prompts').item.json.CLASSIFY_MODEL;
out.usage = res.usage ? { input: res.usage.input_tokens, output: res.usage.output_tokens } : null;
return { json: out };
`));
w.link(classify, validate, 0);

const saveClass = w.node(pg("Save classification", [1840, 300], `
WITH input AS (SELECT $1::jsonb AS j),
upd AS (
  UPDATE tickets t SET status = 'classified', category = j->>'category', secondary_category = j->>'secondary_category',
    confidence = (j->>'confidence')::numeric, model_confidence = (j->>'model_confidence')::numeric,
    rule_categories = ARRAY(SELECT jsonb_array_elements_text(j->'rule_categories')),
    language = j->>'language', summary = j->>'summary',
    model = j->>'model', prompt_version = j->>'prompt_version', updated_at = now()
  FROM input WHERE t.id = (j->>'id')::bigint
  RETURNING t.id
)
INSERT INTO ticket_events (ticket_id, stage, detail)
SELECT id, 'classified', (SELECT j - 'id' - 'summary' FROM input) FROM upd
RETURNING ticket_id;
`, "{ ...$json, id: $('Claim ticket').item.json.id, prompt_version: $('Config & Prompts').item.json.PROMPT_VERSION }"));
w.link(validate, saveClass);

const draft = w.node(ai("AI: draft reply", [2060, 300], `(() => {
  const c = $('Config & Prompts').item.json, n = $('Normalize').item.json, v = $('Validate classification').item.json;
  const body = {
    model: c.DRAFT_MODEL,
    max_tokens: 4000,
    output_config: { effort: c.DRAFT_EFFORT },
    system: c.DRAFT_PROMPT + '\\n\\n## Policy\\n' + c.POLICY,
    messages: [{ role: 'user', content: 'Triage: category=' + v.category + '; secondary=' + (v.secondary_category || 'none') + '; language=' + (v.language || 'unknown') + '; summary=' + (v.summary || 'n/a') + '\\nCustomer first name: ' + ((n.sender_name || '').split(' ')[0] || 'unknown') + '\\n\\n<email>\\nSubject: ' + n.subject + '\\n\\n' + n.body_clean + '\\n</email>' }],
  };
  if (${JSON.stringify(FALLBACK_MODELS)}.includes(c.DRAFT_MODEL)) body.fallbacks = 'default';
  return body;
})()`, { onError: "continueRegularOutput" }));
w.link(saveClass, draft);

const decide = w.node(code("Decide review", [2280, 300], `
// Deterministic rules OR model flags. Refund signals always alert, whatever the model said.
const cfg = $('Config & Prompts').item.json;
const n = $('Normalize').item.json;
const v = $('Validate classification').item.json;
const claim = $('Claim ticket').item.json;
const d = $json;
const draft = d.error || d.stop_reason === 'refusal' ? null
  : ((d.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim() || null);

const text = n.subject + '\\n' + n.body_clean;
const hasCard = n.cards_masked > 0; // masked in Normalize
const letters = n.body_clean.replace(/[^A-Za-z]/g, '');
const RX = {
  refund: /\\b(refund|reimburs|money back|charge ?back|reembolso|devoluci[oó]n|ibalik ang (pera|bayad))|\\b(unused|remaining|rest of (it|that|the \\w+)|that|it) back\\b|\\bpro[- ]?rat(a|ed)\\b/i,
  legal: /\\b(lawyer|attorney|legal action|lawsuit|sue|small claims|court|regulator|consumer protection|abogado)\\b/i,
  chargeback: /\\b(charge ?back|dispute (the |this )?charge|contact(ing)? my bank|report(ing)? (this|you) to my bank)\\b/i,
  security: /\\b(hacked|unauthori[sz]ed (access|login|charge|use)|someone (else )?(logged|log) ?in|account takeover|phishing|breach|suspicious (login|activity))\\b/i,
  injection: /(ignore (all |any |the )?(previous|prior|above|your) (instructions|rules)|system prompt|you are now|disregard (the|your|all) (instructions|rules)|classify (this|me|it) as|set (the )?(confidence|priority|category) to)/i,
  password: /\\bpassword\\s*(is|:)\\s*\\S+/i,
  commit: /(we('ll| will| have)? (issue|process|approve)d? (a |your )?(full )?refund|refund (has been|will be|is) (issued|processed|approved)|you will (receive|get) (a |your )?(full )?refund|\\$\\s?\\d|guarantee)/i,
};

const reasons = new Set(v.review_reasons);
if (v.needs_review && reasons.size === 0) reasons.add('model_flagged');
if (v.confidence < cfg.CONFIDENCE_THRESHOLD) reasons.add('low_confidence');
if (v.category === 'Refund Request' || v.secondary_category === 'Refund Request' || RX.refund.test(text)) reasons.add('refund');
for (const k of ['legal', 'chargeback', 'security']) if (RX[k].test(text)) reasons.add(k);
if (RX.injection.test(text)) reasons.add('prompt_injection');
if (hasCard || RX.password.test(text)) reasons.add('sensitive_data');
if (letters.length > 20 && letters.replace(/[^A-Z]/g, '').length / letters.length > 0.6 || /!{3,}/.test(text)) reasons.add('angry');
if (v.language && v.language !== 'en') reasons.add('non_english');
if (v.secondary_category) reasons.add('multiple_requests');
if (!n.body_clean) reasons.add('empty_message');
if (claim.possible_dup_of) reasons.add('possible_duplicate');
if (!draft) reasons.add('no_draft');
else if (RX.commit.test(draft)) reasons.add('draft_commits');

const list = [...reasons];
const review = list.length > 0;
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const link = ${EDITOR_URL} + 'workflow/' + $workflow.id + '/executions/' + $execution.id;
const alert = review ? [
  ':rotating_light: *Ticket #' + claim.id + ' needs review* — ' + list.join(', '),
  '*' + v.category + '* (' + Math.round(v.confidence * 100) + '% confidence)' + (v.secondary_category ? ' + ' + v.secondary_category : '') + ' · from ' + esc(n.sender),
  '*Subject:* ' + esc(n.subject),
  '*Summary:* ' + esc(v.summary || 'n/a'),
  claim.prior_ticket_id ? 'Follow-up in thread of ticket #' + claim.prior_ticket_id : null,
  '<' + link + '|Open execution> · draft saved in tickets.draft',
].filter(Boolean).join('\\n') : null;

return { json: { id: claim.id, status: review ? 'needs_review' : 'ready', needs_review: review, review_reasons: list,
  send_slack: review && !!cfg.SLACK_URL,
  draft, draft_error: d.error ? String(d.error.message || d.error).slice(0, 300) : null, alert_text: alert,
  category: v.category, confidence: v.confidence,
  draft_usage: d.usage ? { input: d.usage.input_tokens, output: d.usage.output_tokens } : null } };
`));
w.link(draft, decide);

const saveResult = w.node(pg("Save result", [2500, 300], `
WITH input AS (SELECT $1::jsonb AS j),
upd AS (
  UPDATE tickets t SET status = (j->>'status')::ticket_status, needs_review = (j->>'needs_review')::boolean,
    review_reasons = ARRAY(SELECT jsonb_array_elements_text(j->'review_reasons')),
    draft = j->>'draft', alert_text = j->>'alert_text', error = j->>'draft_error', updated_at = now()
  FROM input WHERE t.id = (j->>'id')::bigint
  RETURNING t.id
)
INSERT INTO ticket_events (ticket_id, stage, detail)
SELECT id, 'routed', (SELECT jsonb_build_object('status', j->>'status', 'review_reasons', j->'review_reasons', 'has_draft', j->>'draft' IS NOT NULL, 'draft_usage', j->'draft_usage', 'slack', (j->>'send_slack')::boolean) FROM input) FROM upd
RETURNING ticket_id;
`, "$json"));
w.link(decide, saveResult);

const needAlert = w.node(ifNode("Slack alert?", [2720, 300], "$('Decide review').item.json.send_slack"));
w.link(saveResult, needAlert);
const alertSlack = w.node(slack("Slack: review alert", [2940, 200], "$('Decide review').item.json.alert_text", { onError: "continueErrorOutput" }));
w.link(needAlert, alertSlack, 0);
const markNotified = w.node(pg("Mark notified", [3160, 200], `
WITH upd AS (UPDATE tickets SET notified_at = now() WHERE id = $1::bigint RETURNING id)
INSERT INTO ticket_events (ticket_id, stage) SELECT id, 'notified' FROM upd RETURNING ticket_id;
`, "$('Decide review').item.json.id"));
w.link(alertSlack, markNotified, 0);
const doneBody = "{ ok: true, processed: true, ticket_id: $('Decide review').item.json.id, status: $('Decide review').item.json.status, category: $('Decide review').item.json.category, confidence: $('Decide review').item.json.confidence, review_reasons: $('Decide review').item.json.review_reasons }";
const rDone = w.node(respond("Respond: done", [3380, 300], doneBody));
w.link(markNotified, rDone);
w.link(alertSlack, rDone, 1); // Slack failed: notified_at stays null and the sweeper resends the alert (max 5 tries)
w.link(needAlert, rDone, 1);

const markFailed = w.node(pg("Mark failed", [1620, 640], `
WITH input AS (SELECT $1::jsonb AS j),
upd AS (
  UPDATE tickets t SET status = 'failed', error = j->>'error', updated_at = now()
  FROM input WHERE t.id = (j->>'id')::bigint
  RETURNING t.id, t.attempts, t.error
),
ev AS (INSERT INTO ticket_events (ticket_id, stage, detail) SELECT id, 'failed', (SELECT jsonb_build_object('stage', 'classify', 'error', j->>'error') FROM input) FROM upd)
SELECT id, attempts, error FROM upd;
`, "{ id: $('Claim ticket').item.json.id, error: String($json.error?.message || $json.error?.description || JSON.stringify($json.error || $json)).slice(0, 500) }"));
w.link(classify, markFailed, 1);
const gaveUp = w.node(ifNode("Gave up + Slack?", [1840, 640], "$json.attempts >= 3 && !!$('Config & Prompts').item.json.SLACK_URL"));
w.link(markFailed, gaveUp);
const failSlack = w.node(slack("Slack: failure alert", [2060, 760],
  "':x: *Ticket #' + $json.id + ' failed classification 3 times* — handle it manually. Error: ' + String($json.error || 'unknown').slice(0, 300)",
  { onError: "continueRegularOutput" }));
w.link(gaveUp, failSlack, 0);
const rFail = w.node(respond("Respond: failed", [2280, 640], "{ ok: false, ticket_id: $('Mark failed').item.json.id, attempts: $('Mark failed').item.json.attempts, retry: $('Mark failed').item.json.attempts < 3 }", 502));
w.link(failSlack, rFail);
w.link(gaveUp, rFail, 1);

/* ───────────────────────────── Gmail intake: live trigger + reconciliation sweep ───────────────────────────── */
const g = workflow("Triage — Gmail intake");
g.note("## Gmail intake\nGmail search query from `TRIAGE_GMAIL_QUERY` (default: all incoming inbox mail).Live: Gmail Trigger polls every minute. **Reconcile** every 15 min lists the last 3 days of inbox mail and sends only messages that have no ticket yet, so mail is not lost while Core, Postgres or the AI is down.", [-40, 60], 1160, 200, 7);
// Which mail becomes a ticket. Default: everything in the inbox not sent by the mailbox itself.
// For a demo, e.g. TRIAGE_GMAIL_QUERY="in:inbox from:you@example.com to:you@example.com" (only self-sent test mail).
const GMAIL_Q = process.env.TRIAGE_GMAIL_QUERY || "in:inbox -from:me";
const gTrigger = g.node({
  name: "Gmail Trigger", type: "n8n-nodes-base.gmailTrigger", typeVersion: 1.2, position: [0, 300], credentials: CRED.gmail,
  parameters: { pollTimes: { item: [{ mode: "everyMinute" }] }, simple: false, filters: { q: GMAIL_Q, readStatus: "both" }, options: {} },
});
const gEvery = g.node({ name: "Every 15 minutes", type: "n8n-nodes-base.scheduleTrigger", typeVersion: 1.2, position: [0, 520],
  parameters: { rule: { interval: [{ field: "minutes", minutesInterval: 15 }] } } });
const gList = g.node({
  name: "List recent inbox mail", type: "n8n-nodes-base.gmail", typeVersion: 2.1, position: [220, 520], credentials: CRED.gmail, ...RETRY,
  parameters: { resource: "message", operation: "getAll", returnAll: false, limit: 100, simple: false,
    filters: { q: GMAIL_Q + " newer_than:3d", readStatus: "both" }, options: { downloadAttachments: false } },
});
g.link(gEvery, gList);
const gMapCode = (source) => `
// Gmail (raw format) → the Core webhook payload. Header values arrive as full lines ("Message-ID: <...>").
const m = $json;
const headers = {};
for (const [k, v] of Object.entries(m.headers || {})) {
  const line = String(v);
  headers[k.toLowerCase()] = line.toLowerCase().startsWith(k.toLowerCase() + ':') ? line.slice(k.length + 1).trim() : line;
}
const from = m.from?.value?.[0] || {};
return { json: {
  message_id: m.messageId || headers['message-id'] || null,
  thread_id: m.threadId || null,
  from: from.address || m.from?.text || '',
  from_name: from.name || null,
  subject: m.subject || '',
  text: m.text || null,
  html: m.html || null,
  received_at: m.date || null,
  has_attachments: Object.keys($input.item.binary || {}).length > 0 || (m.attachments || []).length > 0,
  headers: Object.fromEntries(['message-id', 'in-reply-to', 'references', 'auto-submitted', 'precedence', 'x-autoreply', 'list-id'].filter((k) => headers[k]).map((k) => [k, headers[k]])),
  source: '${source}',
  gmail_id: m.id,
} };
`;
const gMap = g.node(code("Map to triage payload", [220, 300], gMapCode("gmail")));
g.link(gTrigger, gMap);
const gMapR = g.node(code("Map (reconcile)", [440, 520], gMapCode("gmail_reconcile")));
g.link(gList, gMapR);
const gKnown = g.node(pg("Has ticket?", [660, 520], `
SELECT EXISTS (SELECT 1 FROM tickets WHERE message_id = $1) AS known;
`, "$json.message_id || ''"));
g.link(gMapR, gKnown);
const gMissing = g.node(ifNode("Missing?", [880, 520], "$json.known === false && !!$('Map (reconcile)').item.json.message_id"));
g.link(gKnown, gMissing);
const gSend = g.node(postCore("Send to Core", [440, 300], "$json", { retryOnFail: true, maxTries: 3, waitBetweenTries: 10000 }));
g.link(gMap, gSend);
const gSendR = g.node(postCore("Send missing to Core", [1100, 500], "$('Map (reconcile)').item.json", { onError: "continueRegularOutput" }));
g.link(gMissing, gSendR, 0);

/* ───────────────────────────── Sweeper: replay failed/stuck, resend alerts, purge old PII ───────────────────────────── */
const s = workflow("Triage — Sweeper");
s.note("## Sweeper\nEvery 10 min, or on demand via `POST /webhook/triage-sweep` (same token; body may set `stuck_minutes`, `retry_minutes`, `alert_minutes` for tests). Replays failed and stuck tickets, resends missed Slack alerts (max 5 tries), and purges message content older than `TRIAGE_RETENTION_DAYS`.", [-40, 40], 1300, 200, 7);
const sTrigger = s.node({ name: "Every 10 minutes", type: "n8n-nodes-base.scheduleTrigger", typeVersion: 1.2, position: [0, 300],
  parameters: { rule: { interval: [{ field: "minutes", minutesInterval: 10 }] } } });
const sHook = s.node({
  name: "Sweep webhook", type: "n8n-nodes-base.webhook", typeVersion: 2.1, position: [0, 520], webhookId: uuid("triage-sweep-webhook"),
  parameters: { httpMethod: "POST", path: "triage-sweep", responseMode: "responseNode", options: {} },
});
const sAuth = s.node(code("Check token", [220, 520], `${TOKEN_CHECK}\nreturn { json: { authorized, body: $json.body || {} } };`));
s.link(sHook, sAuth);
const sAuthOk = s.node(ifNode("Authorized?", [440, 520], "$json.authorized"));
s.link(sAuth, sAuthOk);
s.link(sAuthOk, s.node(respond("Respond: 401", [660, 680], "{ ok: false, error: 'unauthorized' }", 401)), 1);
const sAck = s.node(respond("Respond: sweep started", [660, 520], "{ ok: true, sweep: 'started' }", 202));
s.link(sAuthOk, sAck, 0);
const sSettings = s.node(code("Sweep settings", [880, 300], `
// Schedule run: defaults. Webhook run: the request body may shorten the age limits (used by eval/run.mjs).
const b = $json.body || {};
const num = (v, d) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : d);
return { json: {
  stuck_minutes: num(b.stuck_minutes, 15),
  retry_minutes: num(b.retry_minutes, 5),
  alert_minutes: num(b.alert_minutes, 5),
  retention_days: num($env.TRIAGE_RETENTION_DAYS, 30),
  slack: !!${SLACK_URL},
} };
`));
s.link(sTrigger, sSettings);
s.link(sAck, sSettings);
const sStale = s.node(pg("Find tickets to replay", [1100, 200], `
-- Stuck = crashed mid-run (no stage update for N min). Mark them failed, then replay every failed ticket with attempts left.
WITH stuck AS (
  UPDATE tickets SET status = 'failed', error = coalesce(error, 'stuck in ' || status::text), updated_at = now()
  WHERE status IN ('received', 'classified') AND updated_at < now() - make_interval(mins => $1::int)
  RETURNING id, raw, attempts
),
ev AS (INSERT INTO ticket_events (ticket_id, stage) SELECT id, 'marked_stuck' FROM stuck)
SELECT id, raw FROM tickets WHERE status = 'failed' AND attempts < 3 AND updated_at <= now() - make_interval(mins => $2::int)
UNION
SELECT id, raw FROM stuck WHERE attempts < 3;
`, "$json.stuck_minutes, $json.retry_minutes"));
s.link(sSettings, sStale);
const sReplay = s.node(postCore("Replay to Core", [1320, 200], "{ ...$json.raw, source: 'sweeper' }", { onError: "continueRegularOutput" }));
s.link(sStale, sReplay);
const sAlerts = s.node(pg("Find unsent alerts", [1100, 420], `
-- Counts every resend so a dead Slack webhook is not retried forever.
UPDATE tickets SET alert_attempts = alert_attempts + 1
WHERE id IN (
  SELECT id FROM tickets
  WHERE $1::boolean AND status = 'needs_review' AND notified_at IS NULL AND alert_text IS NOT NULL AND alert_attempts < 5
    AND updated_at <= now() - make_interval(mins => $2::int) AND created_at > now() - interval '3 days'
)
RETURNING id, alert_text;
`, "$json.slack, $json.alert_minutes"));
s.link(sSettings, sAlerts);
const sSlack = s.node(slack("Slack: resend alert", [1320, 420], "$json.alert_text", { onError: "continueErrorOutput" }));
s.link(sAlerts, sSlack);
const sMark = s.node(pg("Mark notified", [1540, 420], `
WITH upd AS (UPDATE tickets SET notified_at = now() WHERE id = $1::bigint RETURNING id)
INSERT INTO ticket_events (ticket_id, stage, detail) SELECT id, 'notified', '{"by":"sweeper"}' FROM upd RETURNING ticket_id;
`, "$('Find unsent alerts').item.json.id"));
s.link(sSlack, sMark, 0);
const sPurge = s.node(pg("Purge old content", [1100, 640], `
-- Retention: after N days keep only the triage outcome (category, confidence, reasons, timestamps); drop message content.
WITH purged AS (
  UPDATE tickets SET sender = NULL, subject = NULL, body_clean = NULL, summary = NULL, draft = NULL, alert_text = NULL,
    raw = '{"purged": true}'::jsonb, purged_at = now()
  WHERE purged_at IS NULL AND created_at < now() - make_interval(days => $1::int) AND status IN ('ready', 'needs_review', 'skipped', 'failed')
  RETURNING id
)
INSERT INTO ticket_events (ticket_id, stage, detail) SELECT NULL, 'purged', jsonb_build_object('count', count(*)) FROM purged HAVING count(*) > 0
RETURNING id;
`, "$json.retention_days"));
s.link(sSettings, sPurge);

/* ───────────────────────────── Errors: any unexpected workflow failure ───────────────────────────── */
const e = workflow(ERRORS);
const eTrigger = e.node({ name: "Error Trigger", type: "n8n-nodes-base.errorTrigger", typeVersion: 1, position: [0, 300] });
const eLog = e.node(pg("Log workflow error", [220, 300], `
INSERT INTO ticket_events (ticket_id, stage, detail) VALUES (NULL, 'workflow_error', $1::jsonb) RETURNING id;
`, "{ workflow: $json.workflow?.name, node: $json.execution?.lastNodeExecuted, message: String($json.execution?.error?.message || '').slice(0, 500), execution_id: $json.execution?.id, url: $json.execution?.url }",
  { onError: "continueRegularOutput" }));
e.link(eTrigger, eLog);
const eHasSlack = e.node(ifNode("Slack configured?", [440, 300], `!!${SLACK_URL}`));
e.link(eLog, eHasSlack);
const eSlack = e.node(slack("Slack: workflow error", [660, 300],
  "':warning: *' + $('Error Trigger').item.json.workflow?.name + '* failed at *' + $('Error Trigger').item.json.execution?.lastNodeExecuted + '*: ' + String($('Error Trigger').item.json.execution?.error?.message || '').slice(0, 300) + ($('Error Trigger').item.json.execution?.url ? '\\n<' + $('Error Trigger').item.json.execution.url + '|Open execution>' : '')",
  { onError: "continueRegularOutput" }));
e.link(eHasSlack, eSlack, 0);

/* ───────────────────────────── write ───────────────────────────── */
const ERROR_ID = wfId(ERRORS);
fs.mkdirSync(path.join(here, "workflows"), { recursive: true });
const out = {
  "core.json": w.build({ errorWorkflow: ERROR_ID }),
  "gmail.json": g.build({ errorWorkflow: ERROR_ID }),
  "sweeper.json": s.build({ errorWorkflow: ERROR_ID }),
  "errors.json": e.build(),
};
for (const [file, wf] of Object.entries(out)) fs.writeFileSync(path.join(here, "workflows", file), JSON.stringify(wf, null, 2) + "\n");
fs.writeFileSync(path.join(here, "workflows", "ids.json"), JSON.stringify(Object.fromEntries(Object.values(out).map((wf) => [wf.name, wf.id])), null, 2) + "\n");

// deliverables/PROMPTS.md is generated from the same sources, so the document never drifts from the workflow.
const decideCode = w.build().nodes.find((n) => n.name === "Decide review").parameters.jsCode;
const rules = decideCode.slice(decideCode.indexOf("const RX = {"), decideCode.indexOf("const list = [...reasons];")).trim();
fs.mkdirSync(path.join(here, "deliverables"), { recursive: true });
fs.writeFileSync(path.join(here, "deliverables", "PROMPTS.md"), [
  "# AI prompts", "",
  `Prompt version \`${PROMPT_VERSION}\` (hash of the three prompt files; stored on every ticket). The AI endpoint and models follow \`TRIAGE_AI_MODE\` in \`config/triage.env\`: \`ollama\` → local \`gemma4:e4b\` (default, free), \`anthropic\` → \`claude-opus-5-5\` for both calls (classify at effort \`low\`, draft at \`medium\`), \`mock\` → offline stub. Override models with \`TRIAGE_CLASSIFY_MODEL\` / \`TRIAGE_DRAFT_MODEL\`.`, "",
  "Source files: `prompts/classify.md`, `prompts/draft.md`, `prompts/policy.md`. Edit those and run `node scripts/setup.mjs`, or edit the Config & Prompts node in n8n for a quick test.", "",
  "## 1. Classification — system prompt", "", "```text", PROMPTS.classify, "```", "",
  "User message sent with it (the email is wrapped as untrusted data):", "", "```text", "<email>\nFrom: {name} <{address}>\nSubject: {subject}\nAttachments: yes|no\n\n{body with quoted replies and signature removed, max 8000 chars}\n</email>", "```", "",
  "Structured output schema (`output_config.format`; the Claude API enforces it, the local model is parsed and validated):", "", "```json", JSON.stringify(CLASSIFY_SCHEMA, null, 2), "```", "",
  "## 2. Draft reply — system prompt", "", "```text", PROMPTS.draft, "\n## Policy\n{policy below}", "```", "",
  "User message: `Triage: category=…; secondary=…; language=…; summary=…` + customer first name + the email in `<email>` tags.", "",
  "## 3. Policy given to the draft model", "", "```text", PROMPTS.policy, "```", "",
  "## 4. Keyword cross-check (not AI — applied right after classification)", "",
  `If strong keywords match one or more categories and none of them is the model's primary or secondary category, confidence is capped at ${RULE_CONFIDENCE_CAP} and \`rule_disagreement\` is added. The raw model score is kept in \`model_confidence\`.`, "",
  "```js", ...Object.entries(RULE_CATEGORIES).map(([k, rx]) => `${JSON.stringify(k)}: ${rx}`), "```", "",
  "## 5. Deterministic review rules (not AI — applied after both calls)", "",
  "A ticket goes to review (and Slack, when configured) if **any** reason is present: model flags, confidence below `TRIAGE_CONFIDENCE_THRESHOLD` (0.8), keyword disagreement, refund category or refund wording, legal/chargeback/security wording, prompt-injection wording, card number (Luhn-checked; masked in Normalize before storage and before the AI sees it) or password in the text, shouting or `!!!`, non-English, a second request, empty body, possible duplicate, no draft, or a draft that promises a refund/amount.", "",
  "```js", rules, "```", "",
].join("\n"));
console.log(`Wrote ${Object.keys(out).length} workflows + deliverables/PROMPTS.md (prompt version ${PROMPT_VERSION}).`);
