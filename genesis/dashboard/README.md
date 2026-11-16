# Genesis dashboard and alerter

Two services, on purpose: the **dashboard** (`genesis/dashboard`, port 8080) and the
**alerter** (`genesis/alerter`, no port). The alerter reads the event stream on its own, so
alerts keep coming when the dashboard is down.

Both read the one Redis stream `genesis:events` (genesis/events/hub.js), each through its own
consumer group, and check every entry with the shared contract `genesis/shared/events.js`
(imported as it is, never copied).

## Run

```
# in an .env file next to genesis/compose.dashboard.yaml, or in the environment
GENESIS_POSTGRES_PASSWORD=<POSTGRES_PASSWORD>
GENESIS_NTFY_TOPIC=<NTFY_TOPIC>

docker compose -f genesis/compose.dashboard.yaml up -d --build
```

The dashboard is then on port 8080. It has **no password** (decided): whoever can reach the
port can use the Controls view. Set `GENESIS_DASHBOARD_BIND` to the host's Tailscale address
to publish it there only.

A password with characters such as `@ : / ?` must be URL-encoded: it is put inside a
`postgres://` address.

### Joining the agents

The agents container (genesis/compose.agents.yaml, not changed by this work) has to be on the
network `genesis` under the name `agents`:

```
docker network connect --alias agents genesis <agents container>
```

and `genesis/settings.json` needs `genesis_events.enabled: true` with
`redis_url: redis://redis:6379`. For the Decision trace's call records and for long-term goals
before their first change, point `genesis_planning.postgres_url` at the same database and
apply genesis/store/migrations/*.sql to it.

## Environment

Dashboard

| Variable | Default | |
|---|---|---|
| `DASHBOARD_PORT` | `8080` | |
| `DASHBOARD_HOST` | `0.0.0.0` | |
| `GENESIS_REDIS_URL` | `redis://redis:6379` | |
| `GENESIS_DATABASE_URL` | none | unset: no history, live view only |
| `GENESIS_EVENT_STREAM` | `genesis:events` | |
| `DASHBOARD_CONSUMER_GROUP` / `DASHBOARD_CONSUMER_NAME` | `dashboard` / `dashboard-1` | |
| `GENESIS_MINDSERVER_URL` | `http://agents:8081` | Controls, positions, online count |
| `GENESIS_AGENTS` | `Arthur:Builder,Mira:Farmer,Felix:Explorer,Nova:Merchant` | names and roles |
| `DASHBOARD_PUBLIC_DIR` / `DASHBOARD_MIGRATIONS_DIR` | next to the build | |

Alerter

| Variable | Default | |
|---|---|---|
| `GENESIS_REDIS_URL`, `GENESIS_DATABASE_URL`, `GENESIS_EVENT_STREAM`, `GENESIS_AGENTS` | as above | |
| `ALERTER_CONSUMER_GROUP` / `ALERTER_CONSUMER_NAME` | `alerter` / `alerter-1` | |
| `NTFY_SERVER` | `https://ntfy.sh` | |
| `NTFY_TOPIC` | none | unset: alerts are recorded, nobody is pinged |
| `NTFY_TOKEN` | none | only for a protected topic |
| `DIGEST_TZ` | `America/Chicago` | |
| `DIGEST_HOUR` | `18` | |
| `ALERTER_MIGRATIONS_DIR` | next to the build | |

The compose file takes `GENESIS_POSTGRES_PASSWORD`, `GENESIS_NTFY_TOPIC`, `GENESIS_NTFY_SERVER`,
`GENESIS_NTFY_TOKEN`, `GENESIS_DIGEST_TZ`, `GENESIS_DASHBOARD_BIND`, `GENESIS_MINDSERVER_URL`
and `GENESIS_AGENTS` and hands them on under the names above.

## How it holds together

- **Ingest.** An entry is acknowledged only once it is in Postgres. While Postgres is down the
  events still reach the live view; they stay pending in Redis and are stored when Postgres
  answers again (also after a crash). An entry that breaks the contract is counted,
  acknowledged and dropped.
- **Live updates.** One server-sent-events stream, `/api/stream`. Each event carries its Redis
  stream id as the SSE id; a browser that reconnects sends it back (`Last-Event-ID`) and gets
  what it missed, from memory or from Postgres. If the gap cannot be filled it gets one
  snapshot instead.
- **Either store down.** Redis down: history from Postgres. Postgres down: the live view from
  memory, and the history endpoints answer from memory and say so (`"source": "memory"`).
- **Storage.** `dashboard_events` 7 days (full-text searchable), `dashboard_incident_events`
  and `dashboard_controls` 90 days; `alerter_alerts` 90 days, `alerter_digests` a year,
  `alerter_facts` 8 days. Plain SQL in `migrations/`, applied at start, each file once.
- **Alerts.** One open alert per problem. A critical alert pings once (ntfy priority 5); no
  repeat, no acknowledge. Warnings go out together at the top of the hour (priority 2). Model
  away, the desktop leaving, held agents and "model unreachable" chat failures while the gate
  is not open never alert. Redis or Postgres unreachable for 60 seconds is critical. A push is
  made of fixed words, an agent's name and an incident's kind; nothing else of an event.
- **Digest.** At 18:00 in `DIGEST_TZ`, about exactly the 24 hours before; stored, shown on the
  Digest view, sent as one push.
- **Controls.** Sent to the MindServer over its own socket calls. No confirmation except Shut
  down. `!newAction` is refused before anything is sent; a settings change copies the agent's
  settings and replaces four keys only, so `allow_insecure_coding` and `blocked_actions` go
  back exactly as read.

## API

`GET /api/health` · `GET /api/state` · `GET /api/stream` (SSE) ·
`GET /api/events?agent=&type=&severity=&corr=&q=&before=&limit=` · `GET /api/incidents?days=` ·
`GET /api/messages` · `GET /api/decisions` · `GET /api/decisions/:id` · `GET /api/alerts` ·
`GET /api/digests` · `GET /api/controls` · `GET /api/controls/settings/:agent` ·
`POST /api/controls/command`

## Develop

```
cd genesis/dashboard && npm install && npm test && npm run typecheck && npm run build
cd genesis/alerter   && npm install && npm test && npm run typecheck && npm run build
```

`npx tsx scripts/fixture-server.ts 8099` serves the built front end with the real ingest and
HTTP code over in-memory stand-ins and made-up events, to look at the pages without the stack
(`scripts/shots.sh` takes screenshots with an installed Chrome). None of that is in the image.

Fonts (Cormorant Garamond, Inter, JetBrains Mono) are bundled from the `@fontsource` packages
at build time; nothing is fetched from a font CDN at run time.

## Not run

- The SQL against a real Postgres (none in the build environment). The tests check placeholder
  counts, column names against the migrations, and the migration runner.
- Delivery through a real ntfy server. The JSON request was checked against a local stand-in.
- The real MindServer. Controls were tested against a recording stand-in for its socket.
- The Docker images were not built; the compose file was checked with `docker compose config`.
