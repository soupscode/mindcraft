-- Genesis dashboard: every event of the stream "genesis:events", kept 7 days and searchable.
-- Applied in file-name order by the dashboard at start (src/server/migrate.ts); each file runs
-- once, inside one transaction, and is noted in dashboard_migrations.

CREATE TABLE IF NOT EXISTS dashboard_events (
    id          text PRIMARY KEY,                 -- the event's ULID: the same event twice is one row
    stream_ms   bigint NOT NULL,                  -- the Redis stream id "<ms>-<n>": the order of delivery
    stream_n    bigint NOT NULL,
    ts          timestamptz NOT NULL,             -- when the agent emitted it
    agent       text NOT NULL,
    seq         bigint NOT NULL,
    type        text NOT NULL,
    corr        text,
    severity    text NOT NULL CHECK (severity IN ('info', 'warn', 'error')),
    data        jsonb NOT NULL,
    search_text text NOT NULL DEFAULT ''          -- agent, type and the text values of data
);

CREATE INDEX IF NOT EXISTS dashboard_events_stream_idx ON dashboard_events (stream_ms, stream_n);
CREATE INDEX IF NOT EXISTS dashboard_events_ts_idx ON dashboard_events (ts);
CREATE INDEX IF NOT EXISTS dashboard_events_agent_idx ON dashboard_events (agent, stream_ms DESC);
CREATE INDEX IF NOT EXISTS dashboard_events_type_idx ON dashboard_events (type, stream_ms DESC);
CREATE INDEX IF NOT EXISTS dashboard_events_search_idx ON dashboard_events USING gin (to_tsvector('simple', search_text));
