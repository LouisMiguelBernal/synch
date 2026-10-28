// Offline stand-in for the Messages API and a Slack incoming webhook, for plumbing and fault-injection tests.
// It is NOT a classifier: its keyword answers say nothing about model quality. Real metrics need a real model.
//   node eval/mock.mjs            listens on :8787  (stack must run with TRIAGE_AI_MODE=mock)
// Markers in an email body force failures:
//   [[mock:500]]          every classify call → HTTP 500
//   [[mock:500x3:<key>]]  the first 3 classify calls for <key> → HTTP 500, then normal (exercises sweeper replay)
//   [[mock:malformed]]    non-JSON classification
// Slack control: POST /slack/fail {"n":3} makes the next 3 Slack calls return 500. GET /slack lists alerts, DELETE clears.
import http from "node:http";

const PORT = Number(process.env.MOCK_PORT || 8787);
const alerts = [];
const failCounts = new Map();
let slackFailures = 0;

const RULES = [
  ["Refund Request", 0.92, /refund|money back|reimburs|reembolso|chargeback/i],
  ["Access", 0.9, /log ?in|password|2fa|two-factor|locked|makapag-login|sso/i],
  ["Technical Support", 0.85, /sync|error|crash|not (working|sending)|blank|slow|down|empty/i],
  ["Billing", 0.88, /invoice|charge|card|payment|receipt|vat|annual/i],
  ["Scheduling", 0.86, /reschedul|appointment|cita|book|availability|demo|cancel/i],
];

function classify(text) {
  const hit = RULES.find(([, , rx]) => rx.test(text));
  const [category, confidence] = hit || ["General Question", 0.7];
  const language = /\b(quiero|cita|reembolso|hola)\b/i.test(text) ? "es" : /\b(hindi|ako|po)\b/i.test(text) ? "tl" : "en";
  return { category, secondary_category: null, confidence, needs_review: false, review_reasons: [], language, summary: "Mock summary." };
}

const send = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    if (req.url === "/slack/fail" && req.method === "POST") {
      slackFailures = Number(JSON.parse(raw || "{}").n || 0);
      return send(res, 200, { ok: true, failing_next: slackFailures });
    }
    if (req.url === "/slack" && req.method === "POST") {
      if (slackFailures > 0) { slackFailures--; return send(res, 500, { ok: false, error: "mock slack down" }); }
      const alert = { at: new Date().toISOString(), ...JSON.parse(raw || "{}") };
      alerts.push(alert);
      console.log(`\n[SLACK ALERT ${alert.at.slice(11, 19)}]\n${alert.text}\n`); // visible in the terminal for demos
      return send(res, 200, { ok: true });
    }
    if (req.url === "/slack" && req.method === "GET") return send(res, 200, alerts);
    if (req.url === "/slack" && req.method === "DELETE") { alerts.length = 0; failCounts.clear(); slackFailures = 0; return send(res, 200, { ok: true }); }
    if (req.url !== "/v1/messages" || req.method !== "POST") return send(res, 404, { error: "not found" });

    const body = JSON.parse(raw || "{}");
    const text = String(body.messages?.[0]?.content ?? "");
    const isClassify = !!body.output_config?.format;
    if (isClassify && text.includes("[[mock:500]]")) return send(res, 500, { type: "error", error: { type: "api_error", message: "mock 500" } });
    const once = isClassify && text.match(/\[\[mock:500x(\d+):([\w-]+)\]\]/);
    if (once) {
      const n = (failCounts.get(once[2]) || 0) + 1;
      failCounts.set(once[2], n);
      if (n <= Number(once[1])) return send(res, 500, { type: "error", error: { type: "api_error", message: `mock 500 (${n}/${once[1]})` } });
    }
    const out = isClassify
      ? (text.includes("[[mock:malformed]]") ? "Sorry, here is my answer: Billing" : JSON.stringify(classify(text)))
      : "Hi there,\n\nThanks for getting in touch. We've passed your message to the right team and will follow up shortly.\n\nBest regards,\nTidewell Support";
    send(res, 200, {
      id: "msg_mock", type: "message", role: "assistant", model: body.model,
      content: [{ type: "text", text: out }], stop_reason: "end_turn",
      usage: { input_tokens: Math.ceil(raw.length / 4), output_tokens: Math.ceil(out.length / 4) },
    });
  });
}).listen(PORT, () => console.log(`mock AI + Slack on :${PORT}`));
