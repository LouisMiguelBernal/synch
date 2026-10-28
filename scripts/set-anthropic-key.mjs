// Stores your Anthropic API key in the n8n credential "Anthropic API key" (id triageAnthropic1).
//   node scripts/set-anthropic-key.mjs
// The key is typed with echo off and passed to the container over stdin (not argv, not a file on the host).
// It prints only whether the update worked, never the key.
import { execSync } from "node:child_process";
import path from "node:path";
import readline from "node:readline";

const root = path.resolve(import.meta.dirname, "..");

function askHidden(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(prompt)) process.stdout.write(prompt); };
    rl.question(prompt, (answer) => { rl.close(); process.stdout.write("\n"); resolve(answer.trim()); });
  });
}

const key = await askHidden("Anthropic API key (input hidden): ");
if (!/^sk-ant-api/.test(key)) {
  console.error("That does not look like an API key from console.anthropic.com (expected it to start with sk-ant-api). Nothing changed.");
  process.exit(1);
}

// Inside the container: read the key from stdin, write the import file, import, delete the file.
const inner = `read -r K; K="$K" node -e 'require("fs").writeFileSync("/tmp/c.json", JSON.stringify([{id:"triageAnthropic1",name:"Anthropic API key",type:"httpHeaderAuth",data:{name:"x-api-key",value:process.env.K}}]))' && n8n import:credentials --input=/tmp/c.json; rm -f /tmp/c.json`;
execSync(`docker compose exec -T n8n sh -c ${JSON.stringify(inner)}`, { cwd: root, input: key + "\n", stdio: ["pipe", "inherit", "inherit"] });

// Verify without revealing: compare inside the container, print only a status word.
const check = `n8n export:credentials --id=triageAnthropic1 --decrypted --output=/tmp/k.json >/dev/null 2>&1; node -e 'const c=require("/tmp/k.json");const x=Array.isArray(c)?c[0]:c;console.log(/^sk-ant-api/.test(x.data.value)?"OK: credential updated":"FAILED: credential not updated")'; rm -f /tmp/k.json`;
execSync(`docker compose exec -T n8n sh -c ${JSON.stringify(check)}`, { cwd: root, stdio: ["ignore", "inherit", "inherit"] });
console.log("Switch to the Claude API with `node scripts/setup.mjs --mode=anthropic`.");
