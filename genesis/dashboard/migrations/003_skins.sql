-- Genesis dashboard: the agents' skins (decided: the operator provides them through the
-- dashboard). One row per agent: the image, when it was set and by whom (always "Operator":
-- the panel has no login), and how applying it went, as the skin service reported it.

CREATE TABLE IF NOT EXISTS dashboard_skins (
    agent     text PRIMARY KEY,
    png       bytea NOT NULL,                     -- the image as it was uploaded: a 64x64 or 64x32 PNG, 64 KiB at most
    width     integer NOT NULL,
    height    integer NOT NULL,
    bytes     integer NOT NULL,
    sha256    text NOT NULL,
    variant   text NOT NULL DEFAULT 'classic' CHECK (variant IN ('classic', 'slim')),
    set_at    timestamptz NOT NULL,
    set_by    text NOT NULL DEFAULT 'Operator',
    state     text NOT NULL CHECK (state IN ('stored', 'applied', 'failed')),
    state_at  timestamptz NOT NULL,
    detail    text                                -- why it failed, in the skin service's words
);
