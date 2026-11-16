-- Genesis dashboard: the events that have the incident shape (genesis/recovery/incidents.js),
-- kept 90 days. An incident is the fold of its events, done when it is read.

CREATE TABLE IF NOT EXISTS dashboard_incident_events (
    id           text PRIMARY KEY,                -- the event's ULID
    incident_id  text NOT NULL,
    ts           timestamptz NOT NULL,
    event        jsonb NOT NULL                   -- the whole event envelope
);

CREATE INDEX IF NOT EXISTS dashboard_incident_events_ts_idx ON dashboard_incident_events (ts);
CREATE INDEX IF NOT EXISTS dashboard_incident_events_incident_idx ON dashboard_incident_events (incident_id);

-- What the operator did on the Controls view, kept 90 days.
CREATE TABLE IF NOT EXISTS dashboard_controls (
    id      text PRIMARY KEY,
    at      timestamptz NOT NULL,
    actor   text NOT NULL,
    origin  text NOT NULL,
    action  text NOT NULL,
    target  text,
    ok      boolean NOT NULL,
    detail  text
);

CREATE INDEX IF NOT EXISTS dashboard_controls_at_idx ON dashboard_controls (at DESC);
