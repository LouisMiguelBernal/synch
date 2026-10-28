// One-shot setup: build workflows, start the stack, apply the schema, create credentials, import + publish workflows.
//   node scripts/setup.mjs                    use the mode in config/triage.env
//   node scripts/setup.mjs --mode=ollama      switch mode (ollama | anthropic | mock) and persist it in config/triage.env
// Safe to re-run. Secrets stay inside the containers: this script never reads .env or prints a secret.
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const CONFIG = path.join(root, "config", "triage.env");
const MODES = ["ollama", "anthropic", "mock"];
const modeArg = process.argv.slice(2).find((a) => a.startsWith("--mode="))?.split("=")[1];

const run = (cmd, opts = {}) => execSync(cmd, { cwd: root, stdio: opts.capture ? "pipe" : "inherit", encoding: "utf8" });
const n8n = (cmd, opts) => run(`docker compose exec -T n8n ${cmd}`, opts);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const inner = (js) => `sh -c ${JSON.stringify(js)}`;

if (!fs.existsSync(path.join(root, ".env"))) {
  console.error("No .env — run `node scripts/make-env.mjs` first.");
  process.exit(1);
}
if (modeArg) {
  if (!MODES.includes(modeArg)) { console.error(`--mode must be one of ${MODES.join(", ")}`); process.exit(1); }
  fs.writeFileSync(CONFIG, fs.readFileSync(CONFIG, "utf8").replace(/^TRIAGE_AI_MODE=.*$/m, `TRIAGE_AI_MODE=${modeArg}`));
}
const mode = (fs.readFileSync(CONFIG, "utf8").match(/^TRIAGE_AI_MODE=(\w*)/m) || [])[1] || "ollama";

async function waitFor(url, ok, label) {
  for (let i = 0; i < 90; i++) {
    const r = await fetch(url, { method: ok === 401 ? "POST" : "GET", body: ok === 401 ? "{}" : undefined, headers: { "content-type": "application/json" } }).catch(() => null);
    if (r && (ok === 401 ? r.status === 401 : r.ok)) return;
    await sleep(2000);
  }
  throw new Error(`${label} did not come up (${url})`);
}

run("node build-workflows.mjs");
run("docker compose up -d --wait db");
run("docker compose exec -T db psql -q -U postgres -d triage -v ON_ERROR_STOP=1 -f /schema/schema.sql");
run("docker compose up -d n8n");
await waitFor("http://localhost:5680/healthz", true, "n8n");

// Postgres credential: built inside the container from its own env, imported, then the temp file is removed.
n8n(inner(`node -e "require('fs').writeFileSync('/tmp/c.json', JSON.stringify([{id:'triagePostgres01',name:'Triage Postgres',type:'postgres',data:{host:'db',port:5432,database:'triage',user:'postgres',password:process.env.TRIAGE_DB_PASSWORD,ssl:'disable'}}]))" && n8n import:credentials --input=/tmp/c.json; rm -f /tmp/c.json`));

// Anthropic credential: created once with a placeholder, never overwritten here (scripts/set-anthropic-key.mjs stores the real key).
let hasCred = true;
try { n8n("n8n export:credentials --id=triageAnthropic1 --output=/tmp/k.json", { capture: true }); } catch { hasCred = false; }
n8n("rm -f /tmp/k.json", { capture: true });
if (!hasCred) {
  n8n(inner(`node -e "require('fs').writeFileSync('/tmp/c.json', JSON.stringify([{id:'triageAnthropic1',name:'Anthropic API key',type:'httpHeaderAuth',data:{name:'x-api-key',value:'replace-with-your-anthropic-api-key'}}]))" && n8n import:credentials --input=/tmp/c.json; rm -f /tmp/c.json`));
}

n8n("n8n import:workflow --separate --input=/workflows/");
const ids = JSON.parse(fs.readFileSync(path.join(root, "workflows/ids.json"), "utf8"));
for (const name of ["Triage — Errors", "Triage — Core", "Triage — Sweeper"]) n8n(`n8n publish:workflow --id=${ids[name]}`);
run("docker compose restart n8n");
await waitFor("http://localhost:5680/healthz", true, "n8n");
// /healthz answers before workflows are activated; wait until the Core webhook is registered (401 = live, token missing).
await waitFor("http://localhost:5680/webhook/triage", 401, "Core webhook");

// Mode checks: warn loudly instead of failing every ticket later.
const warn = [];
if (mode === "anthropic") {
  const check = `n8n export:credentials --id=triageAnthropic1 --decrypted --output=/tmp/k.json >/dev/null 2>&1; node -e 'const c=require("/tmp/k.json");const x=Array.isArray(c)?c[0]:c;console.log(/^sk-ant-/.test(x.data.value)?"ok":"placeholder")'; rm -f /tmp/k.json`;
  if (n8n(inner(check), { capture: true }).trim() !== "ok") warn.push("Mode anthropic but the API key is still the placeholder → run `node scripts/set-anthropic-key.mjs`.");
}
if (mode === "ollama") {
  const tags = await fetch("http://localhost:11434/api/tags").then((r) => r.json()).catch(() => null);
  if (!tags) warn.push("Ollama is not reachable on :11434 → start it, or tickets will fail and be retried by the sweeper.");
  else if (!tags.models?.some((m) => m.name === "gemma4:e4b")) warn.push("Ollama is running but gemma4:e4b is missing → `ollama pull gemma4:e4b`.");
}
if (mode === "mock") warn.push("Mode mock: start `node eval/mock.mjs` (AI + Slack stub on :8787).");
let slack = "none (review_queue only)";
try { if (n8n("printenv TRIAGE_SLACK_WEBHOOK_URL", { capture: true }).trim()) slack = "Slack webhook"; } catch {}

console.log(`\nReady: http://localhost:5680  · AI mode: ${mode} · alerts: ${mode === "mock" ? "mock Slack" : slack}`);
for (const w of warn) console.log("WARNING: " + w);
console.log("Gmail intake: run `node scripts/set-gmail-oauth.mjs` then `node scripts/gmail-connect.mjs` once, then publish it (see README).");
