#!/usr/bin/env bash
# Genesis: ONE command that brings the whole stack up on the Genesis VM, from a fresh clone
# and the env file. No tracked file is edited, no question is asked.
#
#   genesis/up.sh --init            write a new env file (generated secrets, empty values for what only you can supply); never overwrites one
#   genesis/up.sh                   bring everything up; run again on a healthy stack it changes nothing and says so
#   genesis/up.sh --model on|off    switch the model on or off (off: routines only), without a rebuild
#   genesis/up.sh --test-alert      send ONE harmless test push to the phone, through the alerter's own path
#   options: --env-file <file>      default /opt/genesis/.env (or GENESIS_ENV_FILE)
#   GENESIS_RUN_DIR                 where this run's generated files and logs go (default /opt/genesis/run; never inside the clone)
#
# Every step is idempotent, has its check and prints ONE line. The first failure stops the
# run, names the check, and writes ONE support bundle file with every value of the env file
# replaced by its key name. What is decided without Docker is decided in genesis/tools/stack.js,
# which the test suite covers; this file only runs Docker and prints.
#
# Needs: bash, Docker with the compose plugin, git. NOT RUN ANYWHERE YET (there is no Docker
# daemon where it was written): bash -n and shellcheck pass, and the report lists what is unexecuted.

set -u -o pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
ENV_FILE="${GENESIS_ENV_FILE:-/opt/genesis/.env}"
RUN_DIR="${GENESIS_RUN_DIR:-/opt/genesis/run}"
NODE_IMAGE="node:22-bookworm-slim"   # the base of the agents image: runs genesis/tools/stack.js before any image is built
WAIT_SERVER=600                       # seconds to wait for the Minecraft server's "Done ("
WAIT_HEALTH=180                       # ... for Redis, Postgres and the dashboard
WAIT_AGENTS=420                       # ... for the four agents to be in the game
MODE="up"
MODEL_SWITCH=""

while [ $# -gt 0 ]; do
    case "$1" in
        --init) MODE="init" ;;
        --model) MODEL_SWITCH="${2:-}"; shift ;;
        --test-alert) MODE="test-alert" ;;
        --env-file) ENV_FILE="${2:-}"; shift ;;
        -h|--help) sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "Unknown option: $1 (see genesis/up.sh --help)"; exit 2 ;;
    esac
    shift
done

# The stack helper, in a throwaway container: the clone read-only, the run folder writable.
helper() {
    local env_args=()
    [ -f "$ENV_FILE" ] && env_args=(--env-file "$ENV_FILE")
    docker run --rm -i -u "$(id -u):$(id -g)" "${env_args[@]}" -v "$REPO:/repo:ro" -v "$RUN_DIR:/run" "$NODE_IMAGE" node /repo/genesis/tools/stack.js "$@"
}

# ---- --init ----
if [ "$MODE" = "init" ]; then
    if [ -e "$ENV_FILE" ]; then echo "$ENV_FILE is already there. Nothing was written."; exit 1; fi
    mkdir -p "$(dirname "$ENV_FILE")" "$RUN_DIR" || exit 1
    ( umask 077; helper init > "$ENV_FILE" ) || { rm -f "$ENV_FILE"; echo "The env file could not be written (is Docker running?)."; exit 1; }
    chmod 600 "$ENV_FILE"
    echo "Wrote $ENV_FILE (mode 600). Fill in the empty values (the EULA is yours to accept), then run genesis/up.sh."
    exit 0
fi

if [ ! -f "$ENV_FILE" ]; then echo "$ENV_FILE does not exist. Run: genesis/up.sh --init"; exit 1; fi
mkdir -p "$RUN_DIR/steps" || { echo "The run folder $RUN_DIR cannot be made (try: sudo mkdir -p $RUN_DIR && sudo chown \$USER: $RUN_DIR)."; exit 1; }
rm -f "$RUN_DIR"/steps/*.log "$RUN_DIR/changed"
: > "$RUN_DIR/changed"

env_get() { grep -m1 "^$1=" "$ENV_FILE" | cut -d= -f2-; }
changed() { echo "$1" >> "$RUN_DIR/changed"; }

# ---- --test-alert: one push through the alerter's own notifier (the stack must be up) ----
if [ "$MODE" = "test-alert" ]; then
    docker compose --env-file "$ENV_FILE" -f "$REPO/genesis/compose.dashboard.yaml" exec -T alerter node dist/alerter.mjs --test-push
    exit $?
fi

# The run-time files that replace hand edits of tracked files (the compose files read these names).
export GENESIS_SETTINGS_PATH="$RUN_DIR/settings.json"
export GENESIS_PROFILES_PATH="$RUN_DIR/profiles"
dc() { local stack="$1"; shift; docker compose --env-file "$ENV_FILE" -f "$REPO/genesis/compose.$stack.yaml" "$@"; }
rcon() { dc minecraft exec -T minecraft rcon-cli "$@"; }

# Without the helper (Docker is broken): the same redaction, in bash.
redact_bash() {
    local text key value
    text="$(cat)"
    while IFS='=' read -r key value; do
        case "$key" in GENESIS_*) [ "${#value}" -ge 4 ] && text="${text//"$value"/<$key>}" ;; esac
    done < "$ENV_FILE"
    printf '%s\n' "$text"
}

# ONE support bundle file, every value of the env file replaced by its key name.
bundle() {
    local failed="$1" out="$RUN_DIR/support-bundle-$(date +%Y%m%d-%H%M%S).txt" raw
    raw="$(mktemp)"
    {
        echo "Genesis support bundle"; date -u +%Y-%m-%dT%H:%M:%SZ
        echo "failed step: $failed"
        echo "commit: $(git -C "$REPO" rev-parse HEAD 2>&1) $(git -C "$REPO" status --porcelain 2>/dev/null | wc -l) changed files"
        echo "docker: $(docker version --format '{{.Server.Version}}' 2>&1); compose: $(docker compose version --short 2>&1); kernel: $(uname -sr)"
        for log in "$RUN_DIR"/steps/*.log; do [ -f "$log" ] && { echo; echo "===== step $(basename "$log" .log) (last 80 lines)"; tail -n 80 "$log"; }; done
        for stack in minecraft dashboard agents; do
            echo; echo "===== docker compose ps ($stack)"; dc "$stack" ps -a 2>&1
            echo "===== logs ($stack, last 200 lines each)"; dc "$stack" logs --no-color --tail 200 2>&1
        done
        echo; echo "===== bootstrap manifest: runs"
        grep -o '"result": "[^"]*"' "$REPO/bots/genesis_world/bootstrap.manifest.json" 2>&1 | tail -n 5
    } > "$raw" 2>&1
    ( umask 077; helper redact < "$raw" > "$out" 2>/dev/null || redact_bash < "$raw" > "$out" )
    rm -f "$raw"
    echo "Support bundle (secrets and addresses replaced by their key names): $out"
}

STEP_N=0
step() {
    local name="$1" fn="$2" start=$SECONDS log
    STEP_N=$((STEP_N + 1))
    log="$(printf '%s/steps/%02d-%s.log' "$RUN_DIR" "$STEP_N" "${name// /-}")"
    if "$fn" > "$log" 2>&1; then
        printf '%-46s ok    %4ss\n' "$name" "$((SECONDS - start))"
    else
        printf '%-46s FAIL  %4ss\n' "$name" "$((SECONDS - start))"
        echo "Failed check: $(grep 'CHECK FAILED' "$log" | tail -n 1 | sed 's/^CHECK FAILED: //')"
        tail -n 6 "$log" | grep -v 'CHECK FAILED' | sed 's/^/    /'
        bundle "$name"
        exit 1
    fi
}
check_failed() { echo "CHECK FAILED: $*"; return 1; }

# ---- the steps ----

s_docker() {
    docker info > /dev/null 2>&1 || check_failed "docker info (is the Docker daemon running, and may this user use it?)" || return 1
    docker compose version > /dev/null 2>&1 || check_failed "docker compose version (the compose plugin is missing)" || return 1
}

s_env() {
    if [ -n "$MODEL_SWITCH" ]; then
        case "$MODEL_SWITCH" in on|off) ;; *) check_failed "--model takes on or off" || return 1 ;; esac
        if [ "$(env_get GENESIS_MODEL)" != "$MODEL_SWITCH" ]; then
            docker run --rm -u "$(id -u):$(id -g)" -v "$REPO:/repo:ro" -v "$(dirname "$ENV_FILE"):/envdir" "$NODE_IMAGE" node /repo/genesis/tools/stack.js set-model "$MODEL_SWITCH" "/envdir/$(basename "$ENV_FILE")" \
                || check_failed "GENESIS_MODEL could not be written into $ENV_FILE" || return 1
            changed "model switched $MODEL_SWITCH"
        fi
    fi
    helper check-env || check_failed "the env file $ENV_FILE is not complete: every line above names a key and what it needs" || return 1
}

s_render() {
    rm -rf "$RUN_DIR/next"
    helper render --repo /repo --out /run/next || check_failed "the run-time settings could not be built from genesis/settings.json and genesis/profiles" || return 1
    if [ -f "$RUN_DIR/settings.json" ] && diff -q "$RUN_DIR/next/settings.json" "$RUN_DIR/settings.json" > /dev/null && diff -rq "$RUN_DIR/next/profiles" "$RUN_DIR/profiles" > /dev/null; then
        rm -rf "$RUN_DIR/next"; echo "unchanged"
    else
        rm -rf "$RUN_DIR/profiles"; mv "$RUN_DIR/next/profiles" "$RUN_DIR/profiles" && mv "$RUN_DIR/next/settings.json" "$RUN_DIR/settings.json" && rm -rf "$RUN_DIR/next"
        : > "$RUN_DIR/settings.changed"; changed "run-time settings written"
    fi
    [ -z "$(git -C "$REPO" status --porcelain -- genesis/settings.json genesis/profiles genesis/compose.agents.yaml 2>/dev/null)" ] \
        || echo "note: tracked settings files have local changes from an earlier, manual set-up; they are not used any more (git checkout -- genesis/ restores them)"
}

s_network() {
    docker network inspect genesis > /dev/null 2>&1 && return 0
    docker network create genesis || check_failed "docker network create genesis" || return 1
    changed "network created"
}

# Waits until the server logged "Done (" AFTER its last start (a line from before a restart does not count).
wait_done() {
    local cid started waited=0
    cid="$(dc minecraft ps -q minecraft)"
    [ -n "$cid" ] || check_failed "the minecraft container exists (docker compose ps -q minecraft)" || return 1
    started="$(docker inspect -f '{{.State.StartedAt}}' "$cid")"
    while [ "$waited" -lt "$WAIT_SERVER" ]; do
        if docker logs --timestamps --since "$started" "$cid" 2>&1 | helper done-after "$started"; then echo "Done ( logged after $started"; return 0; fi
        [ "$(docker inspect -f '{{.State.Running}}' "$cid")" = "true" ] || check_failed "the minecraft container is running (it stopped: see its log; an EULA that is not TRUE stops it)" || return 1
        sleep 5; waited=$((waited + 5))
    done
    check_failed "a line with \"Done (\" logged after $started, within $WAIT_SERVER seconds"
}

s_minecraft() {
    local out
    out="$(dc minecraft up -d 2>&1)" || { echo "$out"; check_failed "docker compose up -d (minecraft)"; return 1; }
    echo "$out"
    echo "$out" | grep -Eq 'Started|Created|Recreated' && changed "minecraft started"
    wait_done
}

# bukkit.yml: the End off, and no login throttle (Paper answers several logins from one address within
# 4 seconds with "connection throttled": four agents log in from one address). Applied only where it
# is not applied yet; the server is restarted only when something changed.
s_bukkit() {
    local edited=0
    if ! dc minecraft exec -T minecraft grep -q 'allow-end: false' /data/bukkit.yml; then
        dc minecraft exec -T minecraft sed -i 's/allow-end: .*/allow-end: false/' /data/bukkit.yml || check_failed "bukkit.yml could be edited inside the container" || return 1
        edited=1
    fi
    if ! dc minecraft exec -T minecraft grep -q 'connection-throttle: -1' /data/bukkit.yml; then
        dc minecraft exec -T minecraft sed -i 's/connection-throttle: .*/connection-throttle: -1/' /data/bukkit.yml || check_failed "bukkit.yml could be edited inside the container" || return 1
        edited=1
    fi
    dc minecraft exec -T minecraft grep -q 'allow-end: false' /data/bukkit.yml || check_failed "bukkit.yml holds allow-end: false" || return 1
    dc minecraft exec -T minecraft grep -q 'connection-throttle: -1' /data/bukkit.yml || check_failed "bukkit.yml holds connection-throttle: -1" || return 1
    if [ "$edited" -eq 0 ]; then echo "already applied"; return 0; fi
    dc minecraft restart minecraft || check_failed "docker compose restart minecraft" || return 1
    changed "bukkit.yml set (End off, no login throttle), server restarted"
    wait_done
}

s_whitelist() {
    local listed entry name
    listed="$(rcon whitelist list)" || check_failed "rcon-cli whitelist list answers" || return 1
    while read -r entry; do
        name="${entry#op }"
        echo "$listed" | grep -qw "$name" || { rcon whitelist add "$name"; changed "whitelisted $name"; }
        case "$entry" in "op "*) rcon op "$name" ;; esac
    done < <(helper names)
    listed="$(rcon whitelist list)"
    while read -r entry; do
        name="${entry#op }"
        echo "$listed" | grep -qw "$name" || check_failed "whitelist list names $name" || return 1
    done < <(helper names)
}

s_images() {
    local commit built=""
    commit="$(git -C "$REPO" rev-parse HEAD 2>/dev/null || echo unknown)"
    [ -f "$RUN_DIR/built.commit" ] && built="$(cat "$RUN_DIR/built.commit")"
    if [ "$commit" = "$built" ] && docker image inspect genesis-agents genesis-dashboard genesis-alerter > /dev/null 2>&1; then echo "images are those of commit $commit"; return 0; fi
    dc agents build || check_failed "docker compose build (agents)" || return 1
    dc dashboard build || check_failed "docker compose build (dashboard, alerter)" || return 1
    echo "$commit" > "$RUN_DIR/built.commit"; changed "images built"
}

s_world() {
    # the launcher's own check: with the manifest of exactly this world file there is nothing to do
    if dc agents run --rm --no-deps -T agents node genesis/start.js --check > /dev/null 2>&1; then echo "the world is bootstrapped (the manifest matches the world file)"; return 0; fi
    dc agents run --rm --no-deps -T agents node genesis/world/bootstrap.js || check_failed "node genesis/world/bootstrap.js ends with \"Bootstrap PASSED\" (the lines above say which stage failed)" || return 1
    changed "site picked and world bootstrapped"
    dc agents run --rm --no-deps -T agents node genesis/start.js --check > /dev/null || check_failed "node genesis/start.js --check has no problems after the bootstrap" || return 1
}

s_services() {
    local out waited=0
    out="$(dc dashboard up -d 2>&1)" || { echo "$out"; check_failed "docker compose up -d (redis, postgres, dashboard, alerter)"; return 1; }
    echo "$out"
    echo "$out" | grep -Eq 'Started|Created|Recreated' && changed "dashboard stack started"
    while [ "$waited" -lt "$WAIT_HEALTH" ]; do
        if dc dashboard exec -T dashboard node -e "fetch('http://127.0.0.1:8080/api/health').then((r) => r.json()).then((h) => process.exit(h.redis_ok && h.postgres_ok ? 0 : 1)).catch(() => process.exit(1))" 2> /dev/null; then return 0; fi
        sleep 3; waited=$((waited + 3))
    done
    check_failed "the dashboard's /api/health says redis_ok and postgres_ok within $WAIT_HEALTH seconds"
}

s_agents() {
    local out
    out="$(dc agents up -d 2>&1)" || { echo "$out"; check_failed "docker compose up -d (agents)"; return 1; }
    echo "$out"
    if echo "$out" | grep -Eq 'Started|Created|Recreated'; then changed "agents started"
    elif [ -f "$RUN_DIR/settings.changed" ]; then
        dc agents restart agents || check_failed "docker compose restart agents (new run-time settings)" || return 1
        changed "agents restarted with new settings"
    fi
    rm -f "$RUN_DIR/settings.changed"
}

s_online() {
    local waited=0 listed missing name
    while [ "$waited" -lt "$WAIT_AGENTS" ]; do
        listed="$(rcon list 2> /dev/null)"; missing=""
        for name in Arthur Mira Felix Nova; do echo "$listed" | grep -qw "$name" || missing="$missing $name"; done
        [ -z "$missing" ] && { echo "$listed"; return 0; }
        sleep 5; waited=$((waited + 5))
    done
    check_failed "rcon-cli list names Arthur, Mira, Felix and Nova within $WAIT_AGENTS seconds (missing:$missing)"
}

step "Docker" s_docker
step "Env file" s_env
step "Run-time settings (no tracked file edited)" s_render
step "Docker network" s_network
step "Minecraft server (Done after this start)" s_minecraft
step "bukkit.yml (End off, no login throttle)" s_bukkit
step "Whitelist and operators" s_whitelist
step "Images" s_images
step "Site, levelling and bootstrap" s_world
step "Redis, Postgres, dashboard, alerter" s_services
step "Agents" s_agents
step "Four agents in the game" s_online

bind="$(env_get GENESIS_DASHBOARD_BIND)"; [ -z "$bind" ] || [ "$bind" = "0.0.0.0" ] && bind="$(env_get GENESIS_MINECRAFT_BIND)"
echo "Dashboard: http://$bind:8080   model: $(env_get GENESIS_MODEL | grep -q '^on$' && echo on || echo "off (routines only; switch with genesis/up.sh --model on)")"
if [ -s "$RUN_DIR/changed" ]; then echo "Changed in this run: $(paste -sd';' "$RUN_DIR/changed" | sed 's/;/; /g')"; else echo "Nothing needed changing: the stack was already up."; fi
echo "Alerts: subscribe your phone once, in the ntfy app, to the topic that is the value of GENESIS_NTFY_TOPIC in $ENV_FILE; then try it: genesis/up.sh --test-alert"
echo "Genesis is up."
