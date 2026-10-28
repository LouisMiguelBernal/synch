// Creates customer-triage/.env from env.template with fresh random secrets.
// Never overwrites an existing .env and never prints secret values.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const root = path.resolve(import.meta.dirname, "..");
const target = path.join(root, ".env");
if (fs.existsSync(target)) {
  console.log(".env already exists — left untouched.");
  process.exit(0);
}
const secret = () => crypto.randomBytes(32).toString("base64url");
const filled = fs
  .readFileSync(path.join(root, "env.template"), "utf8")
  .replace(/^(TRIAGE_DB_PASSWORD|N8N_ENCRYPTION_KEY|TRIAGE_WEBHOOK_TOKEN)=$/gm, (_, k) => `${k}=${secret()}`);
fs.writeFileSync(target, filled, { mode: 0o600 });
console.log("Wrote .env with 3 generated secrets. Add TRIAGE_SLACK_WEBHOOK_URL yourself if you want Slack alerts.");
