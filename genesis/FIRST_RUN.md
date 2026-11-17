# Genesis: first run

**Part 1** is the one to use: the Genesis VM, everything in Docker, ONE command. **Part 2** is the
fallback on one Windows machine. The **Appendix** is the same start by hand, step by step, for
troubleshooting.

Words in CAPS are yours to replace: `GENESIS_IP` (the VM), `DESKTOP_IP` (the desktop),
`YOUR_MINECRAFT_NAME`, `SEED` (any whole number). No secret goes into the repository.
What was and was not tested is at the end ("Known unverified"). Use a THROWAWAY world.

---

## Part 1. Fill in the env file, run `genesis/up.sh`

Needs: the VM of the Build runbook's Phase A, Docker with the compose plugin (B1, B2), git.

```
sudo mkdir -p /opt/genesis && sudo chown -R "$USER": /opt/genesis
git clone --branch main https://github.com/soupscode/mindcraft.git /opt/genesis/repo
cd /opt/genesis/repo
genesis/up.sh --init          # writes /opt/genesis/.env (mode 600): generated secrets, empty values for you
nano /opt/genesis/.env
genesis/up.sh
```

In the env file, fill in:

| Key | Value |
|---|---|
| `GENESIS_MINECRAFT_EULA` | Read the Minecraft EULA (https://aka.ms/MinecraftEULA); if you accept it, write exactly `TRUE` (capital letters). No script writes or defaults this. |
| `GENESIS_MINECRAFT_SEED` | `SEED` |
| `GENESIS_MINECRAFT_BIND` | `GENESIS_IP` |
| `GENESIS_OPERATORS` | `YOUR_MINECRAFT_NAME` (several: comma-separated) |
| `GENESIS_MODEL` | `off` for the first start (routines only); later `genesis/up.sh --model on` |
| `GENESIS_MODEL_URL`, `GENESIS_MODEL_NAME` | `http://DESKTOP_IP:11434` and the model's name in Ollama; needed only when the model is on |

Optional keys (each has a default in the file): `GENESIS_MINECRAFT_MEMORY` (heap, 6G),
`GENESIS_MINECRAFT_VIEW_DISTANCE` and `GENESIS_MINECRAFT_SIMULATION_DISTANCE` (chunks, 10 each),
`GENESIS_MINECRAFT_DATA`, `GENESIS_EMBEDDING_MODEL`, `GENESIS_DASHBOARD_BIND`,
`GENESIS_DASHBOARD_ALLOW` (addresses that may open the dashboard, comma-separated),
`GENESIS_WORLDEDIT_WORLD` (the world's name for WorldEdit, `world`).
Every agent's bot keeps the chunks the server sends it in memory: a larger view distance raises
the memory of the server AND of all four agent processes. (The bots ask for mineflayer's own
default view distance, "far"; the fork sets none.)

**If WorldEdit was put into the server's `plugins/` folder by hand** (the first test run did):
delete that jar before the first `up.sh`, `sudo rm /opt/genesis/data/minecraft/plugins/worldedit*.jar`.
The compose file now installs WorldEdit and SkinsRestorer itself, and a second copy of a plugin
stops both from loading. (What the image does with a plugin file it did not install is UNVERIFIED:
its documentation only says that an entry removed from its own list is removed.)

`up.sh` prints one line per step (name, ok or FAIL, seconds):

| Step | What it does, and its check |
|---|---|
| Docker | the daemon and the compose plugin answer |
| Env file | every required value is there (a plain list of what is missing otherwise) |
| Run-time settings | builds `settings.json` and the profiles for this run in `/opt/genesis/run` from the tracked templates and the env file. No tracked file is edited: `git status` stays clean |
| Docker network | creates `genesis` when it is missing |
| Minecraft server | starts it and waits for a line with `Done (` logged AFTER this start |
| bukkit.yml (End off, no login throttle) | sets `allow-end: false` and `connection-throttle: -1` in `bukkit.yml` (Paper refuses several logins from one address within 4 seconds, and the four agents share one), and restarts only when one of them was not set yet |
| Whitelist and operators | whitelists Arthur, Mira, Felix, Nova and you; makes you operator |
| Images | builds them when they are missing or the clone's commit changed |
| Site, levelling and bootstrap | skipped when the manifest matches the world file. Otherwise: picks the site itself around the world spawn (no player online, no coordinates), force-loads its chunks, levels camp, field and plots (WorldEdit; the game's `fill` when the plugin is absent), builds and checks the camp: chests, beds, table, furnace, field, and (decided after the first night) 9 torches so that nothing hostile spawns inside, and a fence with a gate in each side. On the first bootstrap of a new world, and never again, the time is set to morning |
| Redis, Postgres, dashboard, alerter | starts Redis and Postgres, then (once both are healthy) the dashboard and the alerter, and waits until the dashboard says both stores answer |
| Agents | starts them (restarts them when the run-time settings changed). They log in 5 seconds apart |
| Four agents in the game | waits until `list` names all four |

It ends with the dashboard's address, one line on how to subscribe the phone, and `Genesis is up.` Run again on a healthy stack it changes
nothing and says so. **On a failure** it stops at that step, prints the check that failed, and
writes ONE file, `/opt/genesis/run/support-bundle-<time>.txt` (the steps' output, the containers'
last 200 log lines, the manifest's result, versions, the commit), with every value of the env
file replaced by its key name. Send that file.

```
genesis/status.sh             # one screen: containers, who is in the game, the stores, the world, the ports
genesis/up.sh --model on      # stage 2: the model on (no rebuild); --model off goes back to routines
genesis/up.sh --test-alert    # ONE harmless test push to the phone, through the alerter's own path
genesis/down.sh               # stops the agents first, then the rest. Deletes nothing.
```

**Subscribe the phone before anything else**: the ntfy app, "Subscribe to topic", the value of
`GENESIS_NTFY_TOPIC` in the env file (the scripts never print it). Then `genesis/up.sh --test-alert`:
the phone must ring. Without it a critical alert (an agent parked after two deaths, a store down)
reaches nobody. `genesis/status.sh` shows how many critical alerts are open and whether a test
push was ever accepted by ntfy.

Then: the runbook's **B5** (firewall: port 25600 from `DESKTOP_IP` only; on Debian `ufw` cannot be
installed together with `iptables-persistent`: the rule for the Docker-published port lives in
`/etc/ufw/after.rules`). The dashboard has no login: `status.sh` warns while it is published on every
interface without `GENESIS_DASHBOARD_ALLOW`.

**Coming from the first test run (a VM set up by hand):** `genesis/down.sh` is not needed, but stop
the three stacks, then `git checkout -- genesis/settings.json genesis/profiles genesis/compose.agents.yaml`
(your hand edits are replaced by the env file), add the new keys to `/opt/genesis/.env`
(`GENESIS_OPERATORS`, `GENESIS_MODEL`, `GENESIS_MODEL_URL`, `GENESIS_MODEL_NAME`), move the world file
next to its manifest (`sudo mv genesis/genesis.world.json bots/genesis_world/genesis.world.json`), delete
the hand-placed WorldEdit jar, `git pull`, `genesis/up.sh`.

### What you should see

Stage 1 (`GENESIS_MODEL=off`), within 5 minutes of `Genesis is up.`:

1. In the game: it is morning; the camp is lit and fenced (the agents open the gates and close them
   behind them; at night their Shelter phase takes them home, inside the fence). Each agent walks to the
   kits chest and takes its tool and bread. Then Arthur
   gathers wood, Mira sows the field, Felix walks his patrol ring, Nova counts the chests.
2. Dashboard: four cards, none `Offline`; the model pill says `Model away` (never `unknown`);
   **Routines** shows each agent's phase and bounds; **World** shows the site, the zones, how
   the site was chosen and how it was levelled.
3. `ls bots/genesis_checkpoints/` shows four `<Name>.checkpoint.json` files.
4. No push on the phone. The model being away is not an alert. A warning is only ever something
   an agent gave up on; a critical alert is something that needs you.

Stage 2 (`genesis/up.sh --model on`, with Ollama serving on the desktop as in the runbook's C1
and C2, bound to `DESKTOP_IP:11434`, both models pulled): the model pill says available; an
agent's card gets a Thought; **Trace** shows, for every decision, the context, the options
offered, the latency and the tokens (the planner's call records are in the dashboard's database).
Agents may ask each other for anything the catalog knows, and a request waits for the model's yes
or no for up to 120 seconds.

### Troubleshooting

| You see | It means | Do |
|---|---|---|
| `Env file FAIL` | a value is missing | the lines under it name each key |
| `Minecraft server FAIL`, "the container stopped" | the EULA value is not exactly `TRUE`, or the seed is missing | fix the env file |
| `Site, levelling and bootstrap FAIL`, "No place within 48 blocks ... passes" | the land around the spawn is water, forest or hills | Appendix, "The site by hand" |
| ... "the probe stopped at ..." or "WorldEdit is installed but its console commands were not understood" | the server words an answer differently than the script expects. Nothing was changed | send the bundle: the raw answer is in it. `--no-worldedit` levels with the game's `fill` (Appendix) |
| ... "the area is NOT LOADED" | the chunks did not stay loaded | run `genesis/up.sh` again; send the bundle if it repeats |
| On the console of the agents: `<Name> cannot reach the Minecraft server (exit code 65): this is a wait, not a crash. Trying again in ...` | the Minecraft server is down or restarting; the agents wait without limit | `genesis/status.sh` |
| `exited with code 66`, twice, then a push | the server refused the login | `genesis/status.sh`, the whitelist. The log line `[LoginGuard] Disconnected: ...` now carries the server's own words |
| `connection throttled! please wait before reconnecting.` | `connection-throttle` in `bukkit.yml` is not `-1` | `genesis/up.sh` sets it; by hand: Appendix, step 3 |
| Felix skips patrol waypoints | a waypoint that cannot be reached is tried once and skipped until the model has been back: no incident, by design | nothing |
| Your own Minecraft client cannot join although the firewall allows `DESKTOP_IP` | Tailscale on the desktop accepted a subnet route for the home LAN: the traffic leaves through Tailscale and arrives from the subnet router's address, which the rule drops | On the desktop, PowerShell: `Find-NetRoute -RemoteIPAddress GENESIS_IP \| Select-Object InterfaceAlias` shows `Tailscale`. Fix while at home: `tailscale set --accept-routes=false`. The same check then shows `Ethernet` |
| Dashboard: "this address is not on the dashboard's allow-list (seen: ADDRESS)" | `GENESIS_DASHBOARD_ALLOW` does not hold the address the dashboard sees for you | put the address it names into the env file, `genesis/up.sh` |

### Start over (throwaway world)

`down.sh` never deletes anything. Starting over is explicit:

```
genesis/down.sh
docker compose --env-file /opt/genesis/.env -f genesis/compose.agents.yaml run --rm agents node genesis/world/reset.js
```

That is a dry run: it lists what would go. Run it again with `--yes-wipe-everything` added: it
removes the agents' memory, checkpoints and ledger (never the world) and marks the world as reset.
Then delete the world yourself and start again:

```
sudo rm -rf /opt/genesis/data/minecraft/world /opt/genesis/data/minecraft/world_nether /opt/genesis/data/minecraft/world_the_end
genesis/up.sh
```

(The first start of a new server creates an End world before `allow-end: false` can be set:
`world_the_end` exists and is harmless.) The same seed gives the same land, so the world file in
`bots/genesis_world/` still fits and the same site is used; delete that file to have the site
picked anew.

### Skins

The agents' skins come through the SkinsRestorer plugin (the server is in offline mode). The
dashboard stores a skin per agent (`PUT /api/skins/<Agent>` with a 64x64 or 64x32 PNG as the body,
`GET /api/skins`, `DELETE /api/skins/<Agent>`); the upload screen is a mock-up awaiting review and
is not built. APPLYING a skin needs an outside signing service (see the open decisions of the
build report): until that is settled a skin is stored and reported as `failed: no_signer`.

---

## Part 2. Fallback: one Windows machine, no Docker

No Redis, Postgres, dashboard or alerter: agents, Minecraft server and Ollama only. PowerShell.

1. Install **Node 22 LTS**, **Java 21** (Temurin) and **Git**. Check: `node -v`, `java -version`, `git --version`.
2. Clone and install:
   ```
   git clone --branch main https://github.com/soupscode/mindcraft.git C:\genesis\repo
   cd C:\genesis\repo
   npm install
   cd genesis; npm install; cd ..
   node genesis/tools/preflight.js --quiet
   ```
   Check: `patch-package` printed a tick for `mineflayer@4.39.0`, and the last line is
   `Genesis pre-flight: <n> passed, 0 failed.` Send: the output of all four commands.
3. Download **Paper 1.21.6** yourself (papermc.io) into `C:\genesis\server`. Start it once
   (`java -Xms4G -Xmx4G -jar <the paper jar> --nogui`), read and accept the EULA in `eula.txt`
   yourself, then set in `server.properties`:
   ```
   online-mode=false
   server-port=25600
   enable-rcon=true
   rcon.port=25575
   rcon.password=<a password you choose>
   level-seed=SEED
   difficulty=easy
   allow-nether=false
   white-list=true
   spawn-protection=0
   ```
   and in `bukkit.yml`, under `settings:`, `allow-end: false`. Delete the `world*` folders the
   first start made, start the server again, and in its console:
   `whitelist add Arthur`, `whitelist add Mira`, `whitelist add Felix`, `whitelist add Nova`,
   `whitelist add YOUR_MINECRAFT_NAME`, `op YOUR_MINECRAFT_NAME`.
   Check: `seed` in the console prints your seed.
4. The bootstrap picks the site itself (no player needs to be online) and writes the world file:
   ```
   $env:GENESIS_RCON_PASSWORD = "<the password>"; $env:GENESIS_RCON_HOST = "127.0.0.1"
   node genesis/world/bootstrap.js
   ```
   (To choose the place by hand instead: `node genesis/tools/place_world.js --at X Y Z --seed SEED` first.)
   Check: `Site selection PASSED`, then `Bootstrap PASSED`. Send: the output and `bots\genesis_world\bootstrap.manifest.json`.
5. Fill in the placeholders, then edit `genesis\settings.json`: `host` `"127.0.0.1"`,
   `genesis_planning.enabled` `true`, `genesis_planning.operators` `["YOUR_MINECRAFT_NAME"]`.
   Leave `genesis_events.enabled` `false`.
   ```
   Get-ChildItem genesis\profiles\*.json, genesis\settings.json | ForEach-Object { (Get-Content $_ -Raw).Replace('DESKTOP_IP','127.0.0.1').Replace('GENESIS_MODEL','qwen3.8:27b') | Set-Content $_ -NoNewline }
   node genesis/start.js --check
   ```
   Check: the output ends with `"problems": []`.
6. **Stage 1:** quit Ollama (tray icon). Start, keeping a log:
   ```
   node genesis/start.js 2>&1 | Tee-Object -FilePath C:\genesis\agents.log
   ```
   Expect what Part 1 step 10 lists, except the dashboard lines. Checkpoints:
   `bots\genesis_checkpoints\`. Send: `C:\genesis\agents.log`, the server's `logs\latest.log`,
   and the folders `bots\genesis_checkpoints` and `bots\genesis_world`.
7. **Stage 2:** `ollama pull qwen3.8:27b`, `ollama pull embeddinggemma`, start Ollama. No
   restart of the agents. Expect in the log, within a minute, planning to begin; `ollama ps`
   shows the model loaded.
8. **Stop:** Ctrl+C in the agents' window (all four agent processes end with it), then `stop`
   in the server console.

---

---

## Appendix. The same start by hand

Use it to find out which step fails, or to do one step alone. In every new shell on the VM:

```
cd /opt/genesis/repo
export GENESIS_SETTINGS_PATH=/opt/genesis/run/settings.json GENESIS_PROFILES_PATH=/opt/genesis/run/profiles
dc() { docker compose --env-file /opt/genesis/.env "$@"; }
mc() { dc -f genesis/compose.minecraft.yaml exec minecraft rcon-cli "$@"; }
```

1. **Run-time settings.** `genesis/up.sh` builds them; by hand:
   `docker run --rm --env-file /opt/genesis/.env -v "$PWD:/repo:ro" -v /opt/genesis/run:/run node:22-bookworm-slim node /repo/genesis/tools/stack.js render --out /run`
2. **Network and server.** `docker network create genesis`, `dc -f genesis/compose.minecraft.yaml up -d`,
   `dc -f genesis/compose.minecraft.yaml logs -f minecraft` until a line with `Done (`. After every
   restart wait for a NEW `Done (`: the one from before the restart is still in the log.
3. **bukkit.yml.** `dc -f genesis/compose.minecraft.yaml exec minecraft sed -i -e 's/allow-end: .*/allow-end: false/' -e 's/connection-throttle: .*/connection-throttle: -1/' /data/bukkit.yml`,
   then `dc -f genesis/compose.minecraft.yaml restart minecraft` and wait for `Done (` again.
4. **Whitelist.** `for n in Arthur Mira Felix Nova YOUR_MINECRAFT_NAME; do mc whitelist add $n; done; mc op YOUR_MINECRAFT_NAME`.
   Check: `mc seed` prints `Seed: [SEED]`; `mc whitelist list` names all five.
5. **Images.** `dc -f genesis/compose.agents.yaml build`, `dc -f genesis/compose.dashboard.yaml build`.
6. **The site, a dry run.** `dc -f genesis/compose.agents.yaml run --rm agents node genesis/world/bootstrap.js --pick-site`
   reads the land around the world spawn (no player needs to be online), reports the place it would
   choose with its scores, and writes and changes nothing. Options: `--site-radius 96` (search wider),
   `--site-from X Z` (search around another column), `--site-relief 4` (allow more uneven land).
7. **Bootstrap.** `dc -f genesis/compose.agents.yaml run --rm agents node genesis/world/bootstrap.js`
   picks the site when there is no world file yet and writes `bots/genesis_world/genesis.world.json`;
   then seed, rules, levelling, camp, kit, checks. Check: `Site selection PASSED`, `Bootstrap PASSED`,
   `The agents may start`. Add `--no-worldedit` to level with the game's own `fill` command.
   **The site by hand** (the override): stand where the camp should be, read `Block: X Y Z` off F3, and
   before the bootstrap run
   `dc -f genesis/compose.agents.yaml run --rm agents node genesis/tools/place_world.js --at X Y Z --seed SEED`.
   A world file that is there is always used as it is.
8. **The rest.** `dc -f genesis/compose.dashboard.yaml up -d`, `dc -f genesis/compose.agents.yaml up -d`,
   `dc -f genesis/compose.agents.yaml logs -f agents`.

To send, always: `genesis/status.sh > /tmp/status.txt`, and the newest
`/opt/genesis/run/support-bundle-*.txt` if there is one.

---

## Where the runbook is out of date

The runbook was written before the code. What exists differs here:

| Runbook | Now |
|---|---|
| B3: `RCON_PASSWORD`, `POSTGRES_PASSWORD`, `MC_VERSION` in `.env` | `GENESIS_RCON_PASSWORD`, `GENESIS_POSTGRES_PASSWORD`; plus `GENESIS_MINECRAFT_EULA`, `GENESIS_MINECRAFT_SEED`, `GENESIS_MINECRAFT_BIND`, `GENESIS_MINECRAFT_DATA`, `GENESIS_NTFY_TOPIC`. Optional: `GENESIS_MINECRAFT_MEMORY`, `GENESIS_NTFY_SERVER`, `GENESIS_NTFY_TOKEN`, `GENESIS_DIGEST_TZ`, `GENESIS_DASHBOARD_BIND`, `GENESIS_LOAD_MEMORY`. The Minecraft version is fixed in the compose file (1.21.6). `GRAFANA_ADMIN_PASSWORD` and `OBS_WS_PASSWORD` are used by nothing yet. |
| B3: `data/postgres`, `data/redis` folders | Postgres and Redis keep their data in Docker volumes (`genesis-dashboard_genesis-postgres`, `genesis-dashboard_genesis-redis`). Only `data/minecraft` is a folder. |
| B4: one `/opt/genesis/compose.yaml` | Three files in the repository: `genesis/compose.minecraft.yaml`, `genesis/compose.agents.yaml`, `genesis/compose.dashboard.yaml`, passed with `-f` and `--env-file /opt/genesis/.env`. They meet on a Docker network named `genesis`, made once with `docker network create genesis`. |
| B4: `EULA: "TRUE"` written in the file | The operator sets `GENESIS_MINECRAFT_EULA=TRUE` himself; no default. |
| B4: no whitelist, seed, Nether or spawn settings | Whitelist on (names added over RCON), seed required, `allow-nether=false`, `spawn-protection=0` (the camp is at the world spawn; with protection on, agents could not open a chest there), `bukkit.yml` `allow-end: false` (set by `genesis/up.sh`). |
| B4: `postgres:17`, `redis:7`, MediaMTX, Grafana | `postgres:16-alpine`, `redis:7-alpine`. No media server, Grafana or Prometheus exists yet. |
| B4 check: `docker compose exec minecraft rcon-cli list` | Needs `--env-file /opt/genesis/.env -f genesis/compose.minecraft.yaml` (the `mc` shortcut of step 4). |
| B6: backup script | Not built. |
| E1: clone, default branch | Clone branch `main`. The fork's default branch `develop` is the clean copy of upstream. |
| E3: host `GENESIS_IP`, port 25600 for the bots | The agents run inside the Docker network: `host` is `minecraft`, port 25600. `GENESIS_IP:25600` is for your own client and the camera. Settings are in `genesis/settings.json` and `genesis/profiles/*.json`, not `settings.js`. The model address goes in three places per the placeholders: `genesis_planning.model`, and each profile's `model` and `embedding`. |
| E3/E4: start the bots, two profiles | Four profiles. Before the agents start: the world bootstrap over RCON (it picks the site and writes the world file), and the operator's name. `genesis/up.sh` does all of it. Start only through `genesis/start.js` (the image's command). |
| E4 check: each bot completes an instruction given in chat | Agents do not take free-text orders. With planning on, what the operator says is a planning trigger; typed commands (`!stop`, `!resume`) still run. |
| C2: `OLLAMA_HOST` `0.0.0.0:11434` | Bind the desktop's LAN address (`DESKTOP_IP:11434`). Also pull the embedding model (`embeddinggemma`); without it agents fall back to word overlap. |
| C5: launcher sends `desktop_available` / `desktop_leaving` | Not built. Without it the broker finds the model by probing every 15 seconds, and treats two failed probes as away. |
| D4: channel open; off-site heartbeat | ntfy (decided). No heartbeat in Genesis (decided). |
| E1 log: "bot image to use Node 20 LTS" | The images use Node 22 (decided 16 Nov): mineflayer and minecraft-protocol declare Node 22 or newer, and the pre-flight ran on 22. Installs use `npm ci` with committed lockfiles. |
| Not in the runbook | `mineflayer` is pinned to 4.39.0 in `package.json`, the release that belongs with the installed game data (an older one misread packets on 1.21.6 and got agents kicked). The agents image removes the `libstdc++` bundled with the prebuilt `canvas`. `node genesis/tools/preflight.js` checks an install. |

---

## Known unverified

Run for real before this guide (Linux, Node 22, the real packages; no Minecraft server and no
Docker daemon): the test suites; every Genesis module loads; the launcher starts the MindServer and
four agent processes; the store migrations twice on PostgreSQL 16 and the planner's call record,
goals and checkpoint mirror in it, read back by the dashboard from the same database; the new
events through a real Redis; `docker compose config` for all three files.

Seen on the operator's real Paper 1.21.6 server (stage 1 ran 15 minutes on mineflayer 4.39.0 and Node 22
with all four agents online, no kick, no restart, 1,420 events, none rejected): the Paper image works (`itzg/minecraft-server:java21`);
block checks answer "That position is not loaded" with no player near; in the game, WorldEdit
takes `//pos1 234,67,-48`, `//pos2 313,67,11`, `//set grass_block`, `//set air` (coordinates
comma-separated, no spaces).

Never run, most likely to fail first:

1. **`genesis/up.sh`, `down.sh`, `status.sh`.** They parse (`bash -n`); their decisions are tested
   (`genesis/tools/stack.js`); no line that calls Docker has ever run.
2. **The reading commands and the chunk loading** (`genesis/world/survey.js`): `execute if blocks ... masked`
   as a count of what is not air, `forceload add / remove / query`. The probe step stops with the
   raw answer when one is worded differently; nothing is changed before the probe has passed.
3. **WorldEdit from the console** (`genesis/world/worldedit.js`): whether `//world world` lets the
   console hold a selection, whether commands go as `//pos1` or `/pos1` over RCON, and the wording of
   `//distr`. Probed first; every box is read back after `//set`.
4. **The plugins installed by the image** (`MODRINTH_PROJECTS`: WorldEdit 7.4.6, SkinsRestorer 15.12.6).
5. **Everything after an agent spawns**, the whitelist in offline mode, Paper's own limits on bots,
   the real model, real ntfy delivery: as before the first run.
6. **The lit and fenced camp**: `minecraft:torch`, `minecraft:oak_fence`, `minecraft:oak_fence_gate[facing=...,open=false]`
   and `time set day` over RCON; that the pathfinder opens a gate on Paper, and that an agent closing
   it behind itself (`genesis/lib/gate_keeper.js`) does not get in another agent's way. Mobs can still
   step over the fence where the land outside is a block higher than the camp's floor.
7. **Skins**: SkinsRestorer's console commands and their answers; applying a skin makes the server
   send that player's data again, which may disturb a mineflayer bot.
8. **The dashboard's allow-list**: which address the container sees for a client behind Docker's
   published port.
9. **Windows** (Part 2).
