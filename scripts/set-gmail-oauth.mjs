// Stores the Google OAuth client in the n8n credential "Triage Gmail" (id triageGmail00001).
//   node scripts/set-gmail-oauth.mjs [path/to/client_secret_*.json]
// Default: the newest client_secret_*.json in ~/Downloads (from Google Cloud → Clients → Download JSON).
// The file goes to the container over stdin; this script never prints the client id or secret.
// Afterwards: n8n → Credentials → Triage Gmail → "Sign in with Google", then publish "Triage — Gmail intake".
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
let file = process.argv[2];
if (!file) {
  const dir = path.join(os.homedir(), "Downloads");
  const found = fs.readdirSync(dir).filter((f) => /^client_secret_.*\.json$/.test(f))
    .map((f) => path.join(dir, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  file = found[0];
}
if (!file || !fs.existsSync(file)) {
  console.error("No client_secret_*.json found. Download it from Google Cloud (Clients → your client → Download JSON) or pass its path.");
  process.exit(1);
}
const raw = fs.readFileSync(file, "utf8");
const web = (() => { try { return JSON.parse(raw).web; } catch { return null; } })();
if (!web?.client_id || !web?.client_secret) {
  console.error("That file is not a Web-application OAuth client JSON. Nothing changed.");
  process.exit(1);
}
if (!(web.redirect_uris || []).includes("http://localhost:5680/rest/oauth2-credential/callback")) {
  console.log("WARNING: redirect URI http://localhost:5680/rest/oauth2-credential/callback is not on this client; Google sign-in will fail.");
}

// Inside the container: read the JSON from stdin, write the import file, import, delete the file.
const inner = `node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const w=JSON.parse(s).web;require("fs").writeFileSync("/tmp/c.json",JSON.stringify([{id:"triageGmail00001",name:"Triage Gmail",type:"gmailOAuth2",data:{clientId:w.client_id,clientSecret:w.client_secret}}]))})' && n8n import:credentials --input=/tmp/c.json; rm -f /tmp/c.json`;
execSync(`docker compose exec -T n8n sh -c ${JSON.stringify(inner)}`, { cwd: root, input: raw, stdio: ["pipe", "inherit", "inherit"] });

const check = `n8n export:credentials --id=triageGmail00001 --decrypted --output=/tmp/k.json >/dev/null 2>&1; node -e 'const c=require("/tmp/k.json");const x=Array.isArray(c)?c[0]:c;console.log(x.data.clientId&&x.data.clientSecret?"OK: Triage Gmail credential stored":"FAILED: credential not stored")'; rm -f /tmp/k.json`;
execSync(`docker compose exec -T n8n sh -c ${JSON.stringify(check)}`, { cwd: root, stdio: ["ignore", "inherit", "inherit"] });
console.log(`Next: http://localhost:5680/home/credentials → Triage Gmail → Sign in with Google.
Keep ${path.basename(file)} in your password manager, then delete it from Downloads (Google shows the secret only once).`);
