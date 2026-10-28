// Demo helper for recording: send a sample email through the live workflow and show what landed in the database.
//   node scripts/demo.mjs send r1            send corpus email r1 (fresh Message-ID each time)
//   node scripts/demo.mjs send r1 --twice    send the same email twice → second one is ignored as a duplicate
//   node scripts/demo.mjs send "My calendar sync is broken"   send your own text
//   node scripts/demo.mjs tickets            last 10 tickets
//   node scripts/demo.mjs show <ticket id>   one ticket: draft + event log
//   node scripts/demo.mjs reset              delete demo tickets (source='demo') before a clean recording
//   node scripts/demo.mjs queue | stats      review queue / daily stats
//   node scripts/demo.mjs sweep              run the sweeper now (replay failed, resend alerts)
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const [cmd, arg, flag] = process.argv.slice(2);
const sh = (c, input) => execSync(c, { cwd: root, encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] });
const psql = (q) => sh("docker compose exec -T db psql -U postgres -d triage -P pager=off -f -", q);

async function send() {
  const items = JSON.parse(fs.readFileSync(path.join(root, "eval/corpus.json"), "utf8")).items;
  const item = items.find((i) => i.id === arg);
  const msg = item ? { ...item.msg } : { from: "Demo Customer <demo.customer@example.com>", subject: "Support request", text: arg };
  msg.message_id = `<demo.${Date.now()}@demo.tidewell.example>`;
  msg.received_at = new Date().toISOString();
  msg.source = "demo";
  const token = sh("docker compose exec -T n8n printenv TRIAGE_WEBHOOK_TOKEN").trim();
  console.log(`\nSending: "${msg.subject}" from ${msg.from}\n${(msg.text || "(html body)").slice(0, 200)}\n`);
  for (let k = 0; k < (flag === "--twice" ? 2 : 1); k++) {
    const t0 = Date.now();
    const res = await fetch("http://localhost:5680/webhook/triage", {
      method: "POST", headers: { "content-type": "application/json", "x-triage-token": token }, body: JSON.stringify(msg),
    });
    console.log(`Send ${k + 1}: HTTP ${res.status} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    console.log(JSON.stringify(await res.json(), null, 2), "\n");
  }
}

if (cmd === "send" && arg) await send();
else if (cmd === "tickets") console.log(psql(`SELECT id, to_char(created_at, 'HH24:MI:SS') AS at, status, category, confidence,
  array_to_string(review_reasons, ', ') AS review_reasons, left(subject, 40) AS subject
  FROM tickets ORDER BY id DESC LIMIT 10;`));
else if (cmd === "show" && arg) {
  const id = Number(arg);
  console.log(psql(`\\x on
SELECT id, status, sender, subject, category, secondary_category, confidence, language, summary,
  array_to_string(review_reasons, ', ') AS review_reasons, notified_at, model, prompt_version, attempts FROM tickets WHERE id = ${id};
\\x off
SELECT draft FROM tickets WHERE id = ${id};
SELECT to_char(at, 'HH24:MI:SS.MS') AS at, stage, left(detail::text, 90) AS detail FROM ticket_events WHERE ticket_id = ${id} ORDER BY id;`));
} else if (cmd === "reset") console.log(psql(`WITH demo AS (SELECT id FROM tickets WHERE source = 'demo')
  , a AS (UPDATE tickets SET prior_ticket_id = NULL WHERE prior_ticket_id IN (SELECT id FROM demo))
  , b AS (UPDATE tickets SET possible_dup_of = NULL WHERE possible_dup_of IN (SELECT id FROM demo))
  SELECT count(*) AS demo_tickets FROM demo;
DELETE FROM ticket_events WHERE ticket_id IN (SELECT id FROM tickets WHERE source = 'demo');
DELETE FROM tickets WHERE source = 'demo';`));
else if (cmd === "queue") console.log(psql(`SELECT id, to_char(received_at, 'MM-DD HH24:MI') AS received, category, confidence,
  array_to_string(review_reasons, ', ') AS reasons, notified_at IS NOT NULL AS slacked, left(subject, 40) AS subject FROM review_queue;`));
else if (cmd === "stats") console.log(psql("SELECT * FROM daily_stats LIMIT 14;"));
else if (cmd === "sweep") {
  const token = sh("docker compose exec -T n8n printenv TRIAGE_WEBHOOK_TOKEN").trim();
  const res = await fetch("http://localhost:5680/webhook/triage-sweep", { method: "POST", headers: { "content-type": "application/json", "x-triage-token": token }, body: "{}" });
  console.log(`Sweep: HTTP ${res.status}`, await res.text());
}
else console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 10).join("\n"));
