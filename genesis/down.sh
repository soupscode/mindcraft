#!/usr/bin/env bash
# Genesis: stops everything cleanly. The agents first (they save their checkpoints), then the
# dashboard stack, then the Minecraft server (which saves the world).
#
#   genesis/down.sh                 stop everything
#   options: --env-file <file>      default /opt/genesis/.env (or GENESIS_ENV_FILE)
#
# It NEVER deletes data: the world, the database, the checkpoints, the agents' memory and the
# run folder all stay, and there is no flag here that removes any of them. Starting over is a
# separate, explicit act with its own rules: node genesis/world/reset.js (a dry run unless it
# is given --yes-wipe-everything), see genesis/FIRST_RUN.md.
# NOT RUN ANYWHERE YET (no Docker daemon where it was written).

set -u -o pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
ENV_FILE="${GENESIS_ENV_FILE:-/opt/genesis/.env}"
RUN_DIR="${GENESIS_RUN_DIR:-/opt/genesis/run}"
while [ $# -gt 0 ]; do
    case "$1" in
        --env-file) ENV_FILE="${2:-}"; shift ;;
        -h|--help) sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "Unknown option: $1. Nothing was stopped. (This script deletes nothing and has no flag that does.)"; exit 2 ;;
    esac
    shift
done
[ -f "$ENV_FILE" ] || { echo "$ENV_FILE does not exist."; exit 1; }
export GENESIS_SETTINGS_PATH="$RUN_DIR/settings.json"
export GENESIS_PROFILES_PATH="$RUN_DIR/profiles"
failed=0
for stack in agents dashboard minecraft; do
    start=$SECONDS
    if docker compose --env-file "$ENV_FILE" -f "$REPO/genesis/compose.$stack.yaml" down > /dev/null 2>&1; then
        printf '%-46s ok    %4ss\n' "Stopped: $stack" "$((SECONDS - start))"
    else
        printf '%-46s FAIL  %4ss\n' "Stopped: $stack" "$((SECONDS - start))"; failed=1
    fi
done
[ "$failed" -eq 0 ] && echo "Genesis is down. Nothing was deleted." || echo "Something did not stop: docker ps shows what is left."
exit "$failed"
