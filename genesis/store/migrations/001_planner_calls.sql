-- Genesis: one row per planning call (genesis/broker/call_record.js).
-- Not run by the code: apply the files in this folder in order, once, with psql or a migration tool.

CREATE TABLE IF NOT EXISTS planner_calls (
    call_id            text PRIMARY KEY,
    request_id         text,
    agent              text NOT NULL,
    call_trigger       text,                              -- the record's "trigger"
    context            text,                              -- the context text built at dispatch
    options_offered    jsonb NOT NULL DEFAULT '[]'::jsonb, -- [{id, description}]
    raw_output         text,                              -- exactly what the model returned
    chosen_ids         jsonb NOT NULL DEFAULT '[]'::jsonb,
    valid              boolean NOT NULL,
    attempt            integer NOT NULL,                  -- 1, or 2 for the repair retry
    queue_wait_ms      integer,
    latency_ms         integer,
    prompt_tokens      integer,
    completion_tokens  integer,
    model              text,
    outcome            text NOT NULL
        CHECK (outcome IN ('ok', 'invalid', 'refused_budget', 'cancelled', 'timeout', 'error')),
    errors             jsonb NOT NULL DEFAULT '[]'::jsonb,
    started_at         timestamptz,
    recorded_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS planner_calls_agent_started_idx ON planner_calls (agent, started_at DESC);
CREATE INDEX IF NOT EXISTS planner_calls_request_idx ON planner_calls (request_id);
