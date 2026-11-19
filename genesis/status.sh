#!/usr/bin/env bash
# Genesis: one screen of health. Changes nothing.
#
#   genesis/status.sh               containers, who is in the game, the stores, the model switch, the world, the published ports
#   options: --env-file <file>      default /opt/genesis/.env (or GENESIS_ENV_FILE)
# NOT RUN ANYWHERE YET (no Docker daemon where it was written).

set -u -o pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
ENV_FILE="${GENESIS_ENV_FILE:-/opt/genesis/.env}"
RUN_DIR="${GENESIS_RUN_DIR:-/opt/genesis/run}"
[ "${1:-}" = "--env-file" ] && ENV_FILE="${2:-}"
[ -f "$ENV_FILE" ] || { echo "$ENV_FILE does not exist. Run: genesis/up.sh --init"; exit 1; }
export GENESIS_SETTINGS_PATH="$RUN_DIR/settings.json"
export GENESIS_PROFILES_PATH="$RUN_DIR/profiles"
env_get() { grep -m1 "^$1=" "$ENV_FILE" | cut -d= -f2-; }
dc() { local stack="$1"; shift; docker compose --env-file "$ENV_FILE" -f "$REPO/genesis/compose.$stack.yaml" "$@"; }

echo "Genesis status   commit $(git -C "$REPO" rev-parse --short HEAD 2> /dev/null || echo unknown)   model: $(env_get GENESIS_MODEL | grep -q '^on$' && echo on || echo 'off (routines only)')"
echo
echo "Containers (name, state, published ports):"
docker ps -a --filter network=genesis --format '  {{.Names}}\t{{.Status}}\t{{.Ports}}' 2>&1 | sed 's/0\.0\.0\.0:/every interface:/g'
echo
echo "In the game:      $(dc minecraft exec -T minecraft rcon-cli list 2>&1 | head -n 1)"
echo "Dashboard health: $(dc dashboard exec -T dashboard node -e "fetch('http://127.0.0.1:8080/api/health').then((r) => r.text()).then((t) => console.log(t)).catch(() => console.log('no answer'))" 2>&1 | head -n 1)"
# open critical alerts, and whether a test push was ever accepted by ntfy (from the alerter's own records, through the dashboard)
echo "Alerts:           $(dc dashboard exec -T dashboard node -e "fetch('http://127.0.0.1:8080/api/alerts?days=90').then((r) => r.json()).then((d) => { const a = d.alerts || []; const open = a.filter((x) => x.severity === 'critical' && !x.closed_at).length; const test = a.filter((x) => x.kind === 'test' && x.push_state === 'sent').map((x) => x.pushed_at).sort().pop(); console.log(open + ' critical open; test push: ' + (test ? 'accepted by ntfy on ' + String(test).slice(0, 16).replace('T', ' ') + ' UTC' : 'never confirmed (genesis/up.sh --test-alert; is the phone subscribed?)')); }).catch(() => console.log('no answer'))" 2>&1 | head -n 1)"
# planner calls recorded in the last hour (the agents write them into the dashboard's database: on by default,
# its address is built from GENESIS_POSTGRES_PASSWORD; 0 with the model on means they are not being stored)
echo "Planner calls:    $(dc dashboard exec -T postgres psql -U genesis -d genesis -tAc "SELECT count(*) || ' recorded in the last hour' FROM planner_calls WHERE recorded_at > now() - interval '1 hour'" 2>&1 | head -n 1)"
manifest="$REPO/bots/genesis_world/bootstrap.manifest.json"
if [ -f "$manifest" ]; then echo "World:            bootstrap manifest $(grep -o '"verified": [a-z]*' "$manifest" | head -n 1), last run: $(grep -o '"result": "[^"]*"' "$manifest" | tail -n 1)"
else echo "World:            not bootstrapped yet (no manifest)"; fi
echo
bind="$(env_get GENESIS_DASHBOARD_BIND)"
allow="$(env_get GENESIS_DASHBOARD_ALLOW)"
echo "Published ports: Minecraft 25600 on $(env_get GENESIS_MINECRAFT_BIND) (who may reach it is the firewall's business, not this script's);"
echo "                 dashboard 8080 on ${bind:-0.0.0.0}${allow:+, answering only $allow}. RCON, Redis, Postgres and the MindServer are not published."
if [ -z "$allow" ] && { [ -z "$bind" ] || [ "$bind" = "0.0.0.0" ]; }; then
    echo "WARNING: the dashboard is published on every interface without an allow-list. It has no login and can stop and reconfigure agents:"
    echo "         set GENESIS_DASHBOARD_ALLOW (addresses, comma-separated) or GENESIS_DASHBOARD_BIND in $ENV_FILE, or keep the port behind the firewall."
fi
