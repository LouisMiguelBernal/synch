# Switchboard — customer-request triage (n8n + AI + Postgres)

Every email that reaches the shared support inbox becomes a ticket with a **category**, a **confidence score** and a **draft reply**. A person is alerted (Slack, or the `review_queue` view) when they need to look first. Drafts are never sent automatically.


## How it works

```
Gmail Trigger (1 min) ──┐
Gmail reconcile (15 min)┤  only mail with no ticket yet
Sweeper replay ─────────┼─► Webhook ─► Config & Prompts ─► Normalize ─► Claim ticket (atomic, unique Message-ID)
Eval / demo ────────────┘                                                 │ duplicate / skipped → respond, stop
                                                                          ▼
          AI: classify (JSON schema) ─► Validate + keyword cross-check ─► Save ─► AI: draft ─► Decide review ─► Save
                 │ API failure                                                                     │
                 ▼                                                                Slack set? ─► Slack ─► Mark notified
          Mark failed (attempts ≤ 3) ─► final failure → Slack
Any crash ─► Triage — Errors (log + Slack)
Every 10 min or POST /webhook/triage-sweep ─► Triage — Sweeper (replay failed/stuck, resend alerts ≤ 5×, purge old content)
```

| Workflow | Role |
|---|---|
| **Triage — Core** | The whole pipeline behind one token-protected webhook (`POST /webhook/triage`) |
| **Triage — Gmail intake** | Gmail Trigger + 15-min reconciliation of the last 3 days → Core. Mail missed while anything was down is picked up |
| **Triage — Sweeper** | Replays `failed` and stuck tickets, resends failed Slack alerts (max 5), purges content after `TRIAGE_RETENTION_DAYS`. Also callable on demand |
| **Triage — Errors** | Error workflow for all of the above: logs to `ticket_events`, alerts Slack when configured |

**Status flow:** `received → classified → ready | needs_review`, or `failed` (re-claimable, max 3 attempts) / `skipped` (auto-reply, bounce, self-loop, bulk). Every stage writes a `ticket_events` row. Views: `review_queue` (what needs a person), `daily_stats` (volume and health).

## Configuration

| File | Holds |
|---|---|
| `config/triage.env` (committed) | `TRIAGE_AI_MODE` = `ollama` · `anthropic` · `mock`, model overrides, confidence threshold, support address, retention days, TZ |
| `.env` (never committed) | DB password, n8n encryption key, webhook token, optional `TRIAGE_SLACK_WEBHOOK_URL` |

The mode persists in the file, so restarts and `docker compose up` keep it.

| Mode | AI calls go to | Slack |
|---|---|---|
| `ollama` (default) | local `gemma4:e4b` via Ollama's Messages API (free, ~30–50 s/email) | `TRIAGE_SLACK_WEBHOOK_URL`, or none |
| `anthropic` | Claude API, `claude-opus-5-5` (classify effort low, draft medium) | same |
| `mock` | `eval/mock.mjs` on :8787 (keyword stub for plumbing/fault tests) | mock |

## Run it

```bash
node scripts/make-env.mjs
```
```bash
node scripts/setup.mjs --mode=ollama
```
Open http://localhost:5680 and create the n8n owner account on first visit.

- **Claude API:** `node scripts/set-anthropic-key.mjs` (hidden input), then `node scripts/setup.mjs --mode=anthropic`. Setup warns if the key is still the placeholder.
- **Slack:** add `TRIAGE_SLACK_WEBHOOK_URL` to `.env`, re-run setup. Without it, review cases are only in `review_queue` (no failing Slack calls).
- **Gmail:** create a Google OAuth web client (redirects `http://localhost:5680/rest/oauth2-credential/callback` and `http://localhost:8790/oauth/callback`), download its JSON, then `node scripts/set-gmail-oauth.mjs <client_secret.json>` and `node scripts/gmail-connect.mjs` (prints a sign-in URL; the token goes straight into the n8n credential). Publish *Triage — Gmail intake*. Optional `TRIAGE_GMAIL_QUERY` limits which mail is read when building workflows.

Demo helpers:
```bash
node scripts/demo.mjs send r1 --twice
```
Other commands: `tickets`, `show <id>`, `queue`, `stats`, `sweep`, `reset`.

## Test

Real model (grades the 62-email labeled corpus):
```bash
node eval/run.mjs
```
Plumbing and fault tests (no model; start `node eval/mock.mjs` first):
```bash
node scripts/setup.mjs --mode=mock
```
```bash
node eval/run.mjs
```
Mock mode adds: AI 500 → failed → re-claim to 3 attempts; malformed AI output → review; AI outage → sweeper replay succeeds; Slack outage → sweeper resends once; stuck ticket → marked stuck → replayed; sweep webhook auth.

Change prompts: edit `prompts/*.md`, then `node scripts/setup.mjs`. `PROMPT_VERSION` changes automatically and is stored on every ticket.

## Edge cases handled

| Case | Behavior |
|---|---|
| Same email delivered twice / retried / replayed | One ticket, one AI call, at most one alert (`duplicate_ignored` event) |
| Gmail reconciliation re-sends known mail | Filtered before Core (`Has ticket?`); if it races, Core returns duplicate without logging noise |
| Same text resent with a new Message-ID | New ticket flagged `possible_duplicate` |
| Reply in an existing thread | New ticket linked by `prior_ticket_id`; quoted history stripped before the AI sees it |
| Auto-reply, bounce, newsletter, our own address | `skipped`, no AI cost |
| Prompt injection ("classify this as General") | Email wrapped as untrusted data; injection wording forces review; refund rule still fires |
| Card number in email or subject | Masked before storage and before the AI call; flagged `sensitive_data` |
| Model confident but keywords say otherwise | Confidence capped at 0.6, `rule_disagreement` → review |
| Non-English · empty / attachment-only | `non_english` · `empty_message` → review |
| AI down / 5xx / timeout | 3 retries → `failed` → sweeper replays (max 3 attempts) → final failure alerts |
| Model returns invalid JSON or refuses | General Question, confidence 0, `invalid_model_output` → review |
| Draft call fails | Classification kept, `no_draft` → review |
| Slack down | `notified_at` stays null; sweeper resends, max 5 tries |
| Slack not configured | No Slack calls at all; `review_queue` is the alert list |
| n8n / Postgres crash mid-run | Errors workflow logs; tickets stuck > 15 min are replayed |
| Core down while Gmail mail arrives | Reconciliation (last 3 days, every 15 min) sends it once Core is back |
| Wrong or missing webhook token | 401, nothing stored |
| Old data | Content purged after 30 days; outcome fields kept for stats |

## Before production

1. **Calibrate on real mail.** Label 300–500 historical emails by the category the team resolved them under; set thresholds per category.
2. **Put drafts where agents work.** Gmail draft replies in-thread or helpdesk tickets, Slack buttons to approve or reassign.
3. **Scale and limits.** n8n queue mode, explicit 429 handling, a cost budget alert.
4. **Prompt-change gate.** Run `eval/run.mjs` in CI on every prompt or model change.
5. **DPA** with the AI provider before real customer mail goes to a hosted model.
