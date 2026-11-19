-- Genesis learning: the experience of the agents and everything computed from it
-- (genesis/learning/store.js; the plan's section 2.1).
--
-- Applied like the other files of this folder: in order, at the start of the MindServer process
-- (genesis/adapters/pg_stores.js, runStoreMigrations). Every statement is "IF NOT EXISTS".
--
-- A FULL WORLD RESET (decided) keeps experience, decisions, learning_versions, lessons and plays.
-- It wipes remembered places (the row "places" of learning_state) and the builds of the old
-- world (genesis/world/reset.js).
--
-- Rows here have no expiry (events are kept 7 days; nothing needed for training lives only
-- in events).

-- One row per goal. Inserted when the goal starts, with the situation and what was predicted
-- for it; the outcome columns are filled once, when the goal ends. predicted is never
-- updated: the statement that ends a goal does not name it.
CREATE TABLE IF NOT EXISTS experience (
    id            text PRIMARY KEY,
    agent         text NOT NULL,
    goal_id       text,
    decision_id   text,
    call_id       text,                                  -- the planner call behind the goal, when there was one
    option_id     text NOT NULL,
    skill         text NOT NULL,
    args          jsonb NOT NULL DEFAULT '{}'::jsonb,
    chooser       text NOT NULL CHECK (chooser IN ('planner', 'routine', 'network', 'operator', 'recovery')),
    explore       boolean NOT NULL DEFAULT false,
    play_id       text,
    situation     jsonb NOT NULL,                        -- the raw snapshot at goal start, never a feature vector
    predicted     jsonb NOT NULL,                        -- { net_version, source, table {..}, net {..} | null }
    predicted_at  timestamptz NOT NULL,
    started_at    timestamptz NOT NULL,
    world_sha256  text,
    outcome       text CHECK (outcome IS NULL OR outcome IN ('completed', 'failed', 'dropped', 'abandoned')),
    reason        text,
    done          integer,
    total         integer,
    duration_ms   integer,
    steps         jsonb NOT NULL DEFAULT '[]'::jsonb,    -- [{ command, ok, reason, ms, attempts }]
    died          boolean NOT NULL DEFAULT false,
    health_min    real,
    health_lost   real NOT NULL DEFAULT 0,
    stuck         boolean NOT NULL DEFAULT false,
    incident_ids  jsonb NOT NULL DEFAULT '[]'::jsonb,
    gained        jsonb NOT NULL DEFAULT '{}'::jsonb,    -- inventory difference { item: n }
    ended_at      timestamptz,
    CHECK (ended_at IS NULL OR ended_at >= predicted_at),
    CHECK ((outcome IS NULL) = (ended_at IS NULL))
);

CREATE INDEX IF NOT EXISTS experience_agent_ended_idx ON experience (agent, ended_at DESC);
CREATE INDEX IF NOT EXISTS experience_ended_idx ON experience (ended_at);
CREATE INDEX IF NOT EXISTS experience_skill_idx ON experience (skill, ended_at DESC);

-- One row per choice, whoever made it, with everything that was on offer.
CREATE TABLE IF NOT EXISTS decisions (
    decision_id     text PRIMARY KEY,
    agent           text NOT NULL,
    chooser         text NOT NULL CHECK (chooser IN ('planner', 'routine', 'network', 'operator', 'recovery')),
    call_id         text,
    situation       jsonb,
    offered         jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{ id, p_ok, p_danger, secs, n, need, score }]
    chosen          jsonb,                               -- an option id, or a list of them (a planner reply)
    default_choice  jsonb,                               -- what the unlearned rule would have picked
    explore         boolean NOT NULL DEFAULT false,
    net_version     integer,
    prompt_version  text,
    ts              timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS decisions_agent_ts_idx ON decisions (agent, ts DESC);

-- The versions of the network. The weights themselves are files
-- (bots/genesis_learning/weights/net-v000041.json); this is the list the dashboard reads.
CREATE TABLE IF NOT EXISTS learning_versions (
    v                integer PRIMARY KEY,
    feature_version  integer NOT NULL,
    parent           integer,
    examples         integer NOT NULL,
    metrics          jsonb NOT NULL DEFAULT '{}'::jsonb, -- { net_error, table_error, danger_net, danger_table, n }
    sha256           text NOT NULL,
    state            text NOT NULL CHECK (state IN ('candidate', 'in_use', 'kept', 'refused', 'rolled_back')),
    reason           text,
    created_at       timestamptz NOT NULL
);

-- What is kept between restarts beside the weights: the count table, the place memory,
-- the rolling scores. One row per name.
CREATE TABLE IF NOT EXISTS learning_state (
    name        text PRIMARY KEY,
    value       jsonb NOT NULL,
    updated_at  timestamptz NOT NULL
);

-- A lesson: one or two sentences written by the model, resting on computed statements.
CREATE TABLE IF NOT EXISTS lessons (
    id          text PRIMARY KEY,
    agent       text NOT NULL,
    body        text NOT NULL CHECK (length(body) <= 300),   -- one or two sentences of at most 140 characters each (the plan calls this column "text")
    written_by  text NOT NULL CHECK (written_by IN ('model')),
    call_id     text,
    basis       jsonb NOT NULL DEFAULT '[]'::jsonb,      -- [{ stat_id, statement, value, n }]
    tags        jsonb NOT NULL DEFAULT '[]'::jsonb,      -- [skill, item]
    state       text NOT NULL CHECK (state IN ('active', 'stale', 'retired')),
    created_at  timestamptz NOT NULL,
    checked_at  timestamptz
);

CREATE INDEX IF NOT EXISTS lessons_agent_state_idx ON lessons (agent, state);

-- A play: one to three catalog options in order that worked, found by code.
CREATE TABLE IF NOT EXISTS plays (
    id              text PRIMARY KEY,
    agent           text NOT NULL,
    name            text NOT NULL,
    steps           jsonb NOT NULL,                      -- [{ skill, args }], 1 to 3
    support         integer NOT NULL DEFAULT 0,
    tried           integer NOT NULL DEFAULT 0,
    worked          integer NOT NULL DEFAULT 0,
    last10          jsonb NOT NULL DEFAULT '[]'::jsonb,
    state           text NOT NULL CHECK (state IN ('candidate', 'active', 'retired')),
    retired_reason  text,
    found_at        timestamptz NOT NULL,
    CHECK (jsonb_typeof(steps) = 'array' AND jsonb_array_length(steps) BETWEEN 1 AND 3)
);

CREATE INDEX IF NOT EXISTS plays_agent_state_idx ON plays (agent, state);

-- What an agent wanted that was not on its list (logged, never acted on), and the
-- candidates the catalog refused, counted per hour and reason.
CREATE TABLE IF NOT EXISTS wishes (
    id       text PRIMARY KEY,
    agent    text NOT NULL,
    origin   text NOT NULL CHECK (origin IN ('not_offered', 'wish_field', 'prefab', 'operator')),
    body     text NOT NULL,
    call_id  text,
    ts       timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS refusals (
    agent   text NOT NULL,
    skill   text NOT NULL,
    reason  text NOT NULL,
    hour    timestamptz NOT NULL,
    n       integer NOT NULL DEFAULT 0,
    PRIMARY KEY (agent, skill, reason, hour)
);

-- A build project: one prefab on one plot by one builder. The cells are never stored: the
-- world is the truth and is surveyed again every time.
CREATE TABLE IF NOT EXISTS builds (
    build_id        text PRIMARY KEY,
    plot            text NOT NULL,
    prefab          text NOT NULL,
    prefab_sha256   text NOT NULL,
    builder         text NOT NULL,
    stage           text,
    cells_total     integer NOT NULL,
    cells_matching  integer NOT NULL DEFAULT 0,
    started_at      timestamptz NOT NULL,
    finished_at     timestamptz,
    verified_at     timestamptz,
    verified_day    integer                              -- the in-game day of the verification, for the Town view
);

CREATE INDEX IF NOT EXISTS builds_builder_idx ON builds (builder, verified_at);
CREATE INDEX IF NOT EXISTS builds_plot_idx ON builds (plot, started_at DESC);
