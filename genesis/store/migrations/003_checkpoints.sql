-- Genesis: the mirror of each agent's latest checkpoint (genesis/store/checkpoint.js).
-- The file on the agent's disk is the one that counts; this row is the copy to fall back on.

CREATE TABLE IF NOT EXISTS agent_checkpoints (
    agent       text PRIMARY KEY,
    seq         bigint NOT NULL,
    saved_at    timestamptz NOT NULL,
    checkpoint  jsonb NOT NULL,                       -- the whole checkpoint, {"v":1,"agent",...}
    updated_at  timestamptz NOT NULL DEFAULT now()
);
