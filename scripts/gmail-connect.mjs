// Connects a Google account to the n8n credential "Triage Gmail" without the n8n editor login.
//   node scripts/gmail-connect.mjs [account@gmail.com]
// Needs: credential imported by set-gmail-oauth.mjs, and http://localhost:8790/oauth/callback on the OAuth client.
// Opens a one-shot server on :8790, prints the Google sign-in URL, exchanges the code, stores the token in n8n.
// Client secret and tokens move only between this process, Google and the container (stdin); nothing is printed.
import { execSync } from "node:child_process";
import http from "node:http";
import crypto from "node:crypto";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const REDIRECT = "http://localhost:8790/oauth/callback";
// Same scopes as n8n's Gmail OAuth2 credential type.
const SCOPES = ["https://www.googleapis.com/auth/gmail.labels", "https://www.googleapis.com/auth/gmail.addons.current.action.compose",
  "https://www.googleapis.com/auth/gmail.addons.current.message.action", "https://mail.google.com/",
  "https://www.googleapis.com/auth/gmail.modify", "https://www.googleapis.com/auth/gmail.compose"];
const sh = (inner, opts = {}) => execSync(`docker compose exec -T n8n sh -c ${JSON.stringify(inner)}`, { cwd: root, encoding: "utf8", ...opts });

const cred = JSON.parse(sh(`n8n export:credentials --id=triageGmail00001 --decrypted --output=/tmp/k.json >/dev/null 2>&1; cat /tmp/k.json; rm -f /tmp/k.json`, { stdio: ["ignore", "pipe", "ignore"] }));
const { clientId, clientSecret } = [].concat(cred)[0].data;
if (!clientId || !clientSecret) { console.error("Triage Gmail has no client id/secret: run scripts/set-gmail-oauth.mjs first."); process.exit(1); }

const state = crypto.randomBytes(16).toString("hex");
const url = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
  client_id: clientId, redirect_uri: REDIRECT, response_type: "code", scope: SCOPES.join(" "),
  access_type: "offline", prompt: "consent", state, ...(process.argv[2] ? { login_hint: process.argv[2] } : {}),
});

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, REDIRECT);
  if (u.pathname !== "/oauth/callback") { res.writeHead(404).end(); return; }
  const done = (code, msg) => { res.writeHead(code, { "content-type": "text/plain" }).end(msg); console.log(msg); server.close(); process.exitCode = code === 200 ? 0 : 1; };
  if (u.searchParams.get("state") !== state) return done(400, "FAILED: state mismatch");
  if (u.searchParams.get("error")) return done(400, "FAILED: Google returned " + u.searchParams.get("error"));
  const tok = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code: u.searchParams.get("code"), client_id: clientId, client_secret: clientSecret, redirect_uri: REDIRECT, grant_type: "authorization_code" }) }).then((r) => r.json());
  if (!tok.access_token || !tok.refresh_token) return done(400, "FAILED: token exchange (" + (tok.error || "no refresh token") + ")");
  const who = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", { headers: { authorization: "Bearer " + tok.access_token } }).then((r) => r.json());
  const payload = JSON.stringify([{ id: "triageGmail00001", name: "Triage Gmail", type: "gmailOAuth2", data: { clientId, clientSecret, oauthTokenData: tok } }]);
  sh(`cat > /tmp/c.json && n8n import:credentials --input=/tmp/c.json >/dev/null; rm -f /tmp/c.json`, { input: payload, stdio: ["pipe", "ignore", "inherit"] });
  done(200, `OK: Triage Gmail connected to ${who.emailAddress || "(unknown account)"}. You can close this tab.`);
});
server.listen(8790, () => console.log("Open this URL and allow access:\n" + url));
