-- Genesis dashboard: where a custom skin went. Decided: the server sends an uploaded skin to MineSkin
-- (an outside service) to be signed; the texture then lives at an address on Mojang's texture server,
-- which is PUBLIC. That address is kept and shown, labelled public. `message` is what the skin service
-- said when applying failed, in words (the reason's short name stays in `detail`).

ALTER TABLE dashboard_skins ADD COLUMN IF NOT EXISTS texture_url text;
ALTER TABLE dashboard_skins ADD COLUMN IF NOT EXISTS message text;
