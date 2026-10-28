-- Customer-request triage schema. Idempotent: scripts/setup.mjs applies it on every run, so schema changes
-- reach an existing database without manual psql. Add new columns with ALTER TABLE ... ADD COLUMN IF NOT EXISTS.
-- Status flow:  received -> classified -> ready | needs_review      (terminal: ready, needs_review, skipped)
--               any stage -> failed  (re-claimable until attempts = 3)

DO $$ BEGIN
  CREATE TYPE ticket_status AS ENUM ('received', 'classified', 'ready', 'needs_review', 'failed', 'skipped');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS tickets (
  id                 bigserial PRIMARY KEY,
  message_id         text NOT NULL UNIQUE,            -- RFC 5322 Message-ID; the duplicate-prevention key
  thread_id          text,
  source             text NOT NULL,                   -- gmail | gmail_reconcile | webhook | sweeper | eval | demo
  sender             text,
  subject            text,
  body_clean         text,                            -- quoted replies and signatures removed, card numbers masked
  body_sha256        text,
  received_at        timestamptz,
  status             ticket_status NOT NULL DEFAULT 'received',
  skip_reason        text,                            -- auto_reply | bounce | self_loop
  prior_ticket_id    bigint REFERENCES tickets(id),   -- earlier ticket in the same thread
  possible_dup_of    bigint REFERENCES tickets(id),   -- same sender + same body within 24 h
  category           text,
  secondary_category text,
  confidence         numeric(4,3),                    -- after the keyword cross-check
  model_confidence   numeric(4,3),                    -- as reported by the model
  rule_categories    text[] NOT NULL DEFAULT '{}',    -- categories the keyword rules matched
  language           text,
  summary            text,
  needs_review       boolean,
  review_reasons     text[] NOT NULL DEFAULT '{}',
  draft              text,
  alert_text         text,                            -- kept so the sweeper can resend a failed alert
  alert_attempts     int NOT NULL DEFAULT 0,          -- sweeper resends; capped at 5
  notified_at        timestamptz,
  model              text,
  prompt_version     text,
  attempts           int NOT NULL DEFAULT 1,
  error              text,
  raw                jsonb NOT NULL,                  -- normalized input, used for replay
  purged_at          timestamptz,                     -- content removed by the retention sweep
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tickets_status_idx ON tickets (status, updated_at);
CREATE INDEX IF NOT EXISTS tickets_thread_idx ON tickets (thread_id);
CREATE INDEX IF NOT EXISTS tickets_dup_idx ON tickets (sender, body_sha256, created_at);

CREATE TABLE IF NOT EXISTS ticket_events (
  id         bigserial PRIMARY KEY,
  ticket_id  bigint REFERENCES tickets(id),           -- null for workflow-level events (errors, purge)
  stage      text NOT NULL,                           -- claimed | classified | routed | notified | failed | marked_stuck | ...
  detail     jsonb NOT NULL DEFAULT '{}',
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ticket_events_ticket_idx ON ticket_events (ticket_id, at);

-- Human review queue, oldest first. notified_at null = Slack not configured or still failing.
CREATE OR REPLACE VIEW review_queue AS
SELECT id, received_at, sender, subject, category, confidence, review_reasons, notified_at, draft
FROM tickets
WHERE status IN ('needs_review', 'failed')
ORDER BY received_at;

-- Daily volume and health, newest first.
CREATE OR REPLACE VIEW daily_stats AS
SELECT created_at::date AS day,
       count(*)                                             AS tickets,
       count(*) FILTER (WHERE status = 'ready')             AS ready,
       count(*) FILTER (WHERE status = 'needs_review')      AS needs_review,
       count(*) FILTER (WHERE status = 'failed')            AS failed,
       count(*) FILTER (WHERE status = 'skipped')           AS skipped,
       count(*) FILTER (WHERE 'refund' = ANY(review_reasons)) AS refunds,
       round(avg(confidence), 3)                            AS avg_confidence
FROM tickets
GROUP BY 1
ORDER BY 1 DESC;
