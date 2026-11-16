-- Genesis alerter: alerts (kept 90 days), the hourly warning pushes, the daily digests (kept
-- a year), the facts a digest is made from (kept 8 days) and the little state the rules need.
-- Applied in file-name order by the alerter at start; each file runs once, inside one
-- transaction, and is noted in alerter_migrations.

CREATE TABLE IF NOT EXISTS alerter_alerts (
    id           text PRIMARY KEY,
    problem_key  text NOT NULL,                    -- one open alert per problem
    severity     text NOT NULL CHECK (severity IN ('critical', 'warning')),
    title        text NOT NULL,                    -- fixed words, an agent's name, an incident's kind: no secrets
    subject      text NOT NULL,
    kind         text NOT NULL,
    opened_at    timestamptz NOT NULL,
    updated_at   timestamptz NOT NULL,
    closed_at    timestamptz,
    occurrences  integer NOT NULL DEFAULT 1,
    push_state   text NOT NULL CHECK (push_state IN ('queued', 'sending', 'sent', 'unconfirmed', 'failed', 'batched', 'off')),
    pushed_at    timestamptz
);

-- at most one open alert per problem, also when two alerter processes run by mistake
CREATE UNIQUE INDEX IF NOT EXISTS alerter_alerts_open_idx ON alerter_alerts (problem_key) WHERE closed_at IS NULL;
CREATE INDEX IF NOT EXISTS alerter_alerts_opened_idx ON alerter_alerts (opened_at DESC);

CREATE TABLE IF NOT EXISTS alerter_batches (
    pushed_at  timestamptz PRIMARY KEY,            -- one row per hourly warning push
    warnings   integer NOT NULL
);

CREATE TABLE IF NOT EXISTS alerter_digests (
    period_end    timestamptz PRIMARY KEY,         -- 18:00 local time, as an instant: one digest per day
    period_start  timestamptz NOT NULL,            -- exactly 24 hours earlier
    tz            text NOT NULL,
    local_date    text NOT NULL,
    body          jsonb NOT NULL,
    created_at    timestamptz NOT NULL,
    pushed_at     timestamptz
);

CREATE TABLE IF NOT EXISTS alerter_facts (
    id     text PRIMARY KEY,                       -- the event's ULID
    ts     timestamptz NOT NULL,
    event  jsonb NOT NULL                          -- the event, cut down to what a digest counts
);

CREATE INDEX IF NOT EXISTS alerter_facts_ts_idx ON alerter_facts (ts);

CREATE TABLE IF NOT EXISTS alerter_state (
    id          integer PRIMARY KEY CHECK (id = 1),
    state       jsonb NOT NULL,                    -- { gate, held }
    updated_at  timestamptz NOT NULL DEFAULT now()
);
