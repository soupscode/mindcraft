-- Genesis: the goals of each agent and every change made to them (genesis/store/goal_store.js).

CREATE TABLE IF NOT EXISTS agent_goals (
    agent       text PRIMARY KEY,
    long_term   jsonb NOT NULL DEFAULT '[]'::jsonb,   -- 1 to 3 goals: [{id, title, option_id}]
    short_term  jsonb NOT NULL DEFAULT '[]'::jsonb,   -- queue of up to 3 goals
    updated_at  timestamptz NOT NULL,
    CHECK (jsonb_typeof(long_term) = 'array' AND jsonb_array_length(long_term) <= 3),
    CHECK (jsonb_typeof(short_term) = 'array' AND jsonb_array_length(short_term) <= 3)
);

CREATE TABLE IF NOT EXISTS goal_changes (
    id        text PRIMARY KEY,
    agent     text NOT NULL,
    scope     text NOT NULL CHECK (scope IN ('long_term', 'short_term')),
    before    jsonb NOT NULL,
    after     jsonb NOT NULL,
    reason    text NOT NULL CHECK (length(btrim(reason)) > 0),
    source    text NOT NULL CHECK (source IN ('planner', 'executor', 'routine', 'operator')),
    call_id   text,                                   -- the planner call behind the change, when there was one
    ts        timestamptz NOT NULL,
    CHECK (source <> 'planner' OR call_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS goal_changes_agent_ts_idx ON goal_changes (agent, ts DESC);
