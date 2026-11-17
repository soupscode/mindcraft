# Genesis: first run

Two paths. **Part 1** is the one to use: the Genesis VM with everything in Docker and the model
on the Windows desktop. **Part 2** is the fallback on one Windows machine, if Part 1 blocks.

Words in CAPS are yours to replace: `GENESIS_IP` (the VM), `DESKTOP_IP` (the desktop),
`YOUR_MINECRAFT_NAME`, `SEED` (any whole number). The first two are in the Build runbook's
Values table: confirm them there first. No secret goes into the repository.

Every step has a **Check**. If a check fails, stop and send what the step's **Send** line names.

What was and was not tested before this guide was written is at the end ("Known unverified").
Use a THROWAWAY world: the bootstrap's commands have never met a real server.

---

## Part 1. Genesis VM, everything in Docker

### 1. VM and Docker (Build runbook)

Do the Build runbook's **Phase A** (A1 to A6) and, from **Phase B**, only **B1** (install
Docker) and **B2** (cap container logs). Do NOT do B3 and B4 as written: steps 2 to 4 below
replace them (see "Where the runbook is out of date").

**Check:** on the VM, `docker run --rm hello-world` prints its success message and
`docker compose version` prints a version.

### 2. Clone

```
sudo mkdir -p /opt/genesis/data/minecraft
sudo chown -R "$USER": /opt/genesis
git clone --branch main https://github.com/soupscode/mindcraft.git /opt/genesis/repo
cd /opt/genesis/repo
ls genesis/compose.minecraft.yaml genesis/tools/preflight.js
```

**Check:** the last command lists both files. If it does not, `main` does not hold the
`genesis/first-run` work yet: stop.

### 3. Secrets file

```
cd /opt/genesis
umask 077
cat > .env <<EOF
GENESIS_MINECRAFT_EULA=
GENESIS_MINECRAFT_SEED=SEED
GENESIS_MINECRAFT_BIND=GENESIS_IP
GENESIS_MINECRAFT_DATA=/opt/genesis/data/minecraft
GENESIS_RCON_PASSWORD=$(openssl rand -hex 24)
GENESIS_POSTGRES_PASSWORD=$(openssl rand -hex 24)
GENESIS_NTFY_TOPIC=genesis-$(openssl rand -hex 12)
EOF
chmod 600 .env
nano .env
```

In the editor: replace `SEED` and `GENESIS_IP`. Read the Minecraft EULA
(https://aka.ms/MinecraftEULA); if you accept it, write `GENESIS_MINECRAFT_EULA=TRUE`.
Nothing accepts it for you, and the server does not start without it.

Then, in every new shell on the VM:

```
cd /opt/genesis/repo
dc() { docker compose --env-file /opt/genesis/.env "$@"; }
```

**Check:** `stat -c %a /opt/genesis/.env` prints `600`.

### 4. Network and Minecraft server

```
docker network create genesis
dc -f genesis/compose.minecraft.yaml up -d
dc -f genesis/compose.minecraft.yaml logs -f minecraft
```

Wait for a line with `Done (` and press Ctrl+C. Then the one setting the image cannot set,
the whitelist, and yourself as operator:

```
sudo sed -i 's/allow-end: true/allow-end: false/' /opt/genesis/data/minecraft/bukkit.yml
dc -f genesis/compose.minecraft.yaml restart minecraft
mc() { dc -f genesis/compose.minecraft.yaml exec minecraft rcon-cli "$@"; }
for n in Arthur Mira Felix Nova YOUR_MINECRAFT_NAME; do mc whitelist add $n; done
mc op YOUR_MINECRAFT_NAME
```

(Wait for `Done (` again after the restart before the `mc` lines.)

**Check:**
- `mc seed` prints `Seed: [SEED]`
- `mc whitelist list` names all five
- `grep allow-end /opt/genesis/data/minecraft/bukkit.yml` prints `allow-end: false`
- `grep -E "^(online-mode|white-list|spawn-protection|allow-nether|server-port|difficulty)=" /opt/genesis/data/minecraft/server.properties`
  prints `false`, `true`, `0`, `false`, `25600`, `easy`

**Send:** `dc -f genesis/compose.minecraft.yaml logs --no-color --tail 200 minecraft`

Now do the runbook's **B5** (firewall: port 25600 from `DESKTOP_IP` only).

### 5. Pick the spot

On the desktop, start Minecraft **1.21.6**, multiplayer, server `GENESIS_IP:25600`, as
`YOUR_MINECRAFT_NAME`. Type `/gamemode creative`, fly, and find **flat open land of about
80 by 60 blocks** (plains; no water, no cliff). Land in the middle, stand on the ground,
press **F3** and read the line `Block: X Y Z`. Write the three numbers down.

The bootstrap levels only the camp (25 by 25 around you). The field and the four plots are
used as the land lies.

**Check:** you have X, Y, Z, and `mc list` shows your name.

### 6. Agents image, pre-flight, world file

```
dc -f genesis/compose.agents.yaml build
dc -f genesis/compose.agents.yaml run --rm agents node genesis/tools/preflight.js --quiet
```

**Check:** the last line is `Genesis pre-flight: <n> passed, 0 failed.`
**Send:** the whole output of both commands.

```
dc -f genesis/compose.agents.yaml run --rm agents node genesis/tools/place_world.js --at X Y Z --seed SEED --out ./bots/genesis.world.json
sudo mv bots/genesis.world.json genesis/genesis.world.json
sed -i 's|^      # - ./genesis.world.json:|      - ./genesis.world.json:|' genesis/compose.agents.yaml
dc -f genesis/compose.agents.yaml run --rm agents node genesis/world/bootstrap.js --validate
```

**Check:** the last command prints `./genesis/genesis.world.json is valid (seed SEED, sha256 ...)`.
**Send:** the output, and `genesis/genesis.world.json`.

### 7. Bootstrap the world

```
( set -a; . /opt/genesis/.env; set +a
  docker compose -f genesis/compose.agents.yaml run --rm -e GENESIS_RCON_PASSWORD -e GENESIS_RCON_HOST=minecraft agents node genesis/world/bootstrap.js )
```

**Check:** the output starts with `Bootstrap PASSED` and ends with `The agents may start`.
In the game the camp stands where you stood: chests, four beds, crafting table, furnace, and a
9 by 9 tilled field with water to the east.

**Send:** the whole output and `bots/genesis_world/bootstrap.manifest.json`. A failed run names
its stage and a position. Do not repair the world by hand: delete the world (step "Start over")
and run again.

### 8. Settings and profiles

```
sed -i 's/DESKTOP_IP/<the desktop address>/g; s/GENESIS_MODEL/qwen3.8:27b/g' genesis/settings.json genesis/profiles/*.json
nano genesis/settings.json
```

In `genesis/settings.json` change exactly these:

| Key | Value |
|---|---|
| `host` | `"minecraft"` (the port stays `25600`) |
| `genesis_events.enabled` | `true` |
| `genesis_events.redis_url` | `"redis://redis:6379"` |
| `genesis_planning.enabled` | `true` |
| `genesis_planning.operators` | `["YOUR_MINECRAFT_NAME"]` |

Leave `genesis_planning.postgres_url` empty for the first run. Never commit these two files
as you filled them in.

```
dc -f genesis/compose.agents.yaml run --rm agents node genesis/start.js --check | tail -5
```

**Check:** the output ends with `"problems": []`.
**Send:** the full output of the command without `| tail -5`.

### 9. Dashboard, alerter, phone

```
dc -f genesis/compose.dashboard.yaml up -d --build
curl -s http://localhost:8080/api/health
grep NTFY_TOPIC /opt/genesis/.env
```

On the phone: install the **ntfy** app, "Subscribe to topic", enter the topic the last command
printed (server: the default, ntfy.sh). The topic name is the only protection: keep it private.

**Check:** the health line has `"redis_ok":true,"postgres_ok":true`. The dashboard opens at
`http://GENESIS_IP:8080` from the desktop. (`"mindserver_ok":false` is right until step 10.)

**Send:** `dc -f genesis/compose.dashboard.yaml logs --no-color --tail 100 dashboard alerter`

### 10. Stage 1: routines only (model away)

Keep Ollama **stopped** on the desktop. Then:

```
dc -f genesis/compose.agents.yaml up -d
dc -f genesis/compose.agents.yaml logs -f agents
```

**What you should see within 5 minutes**

1. In the log: `MindServer running on port 8081`, then for each of the four agents
   `<Name> logged in!`, `<Name> spawned.` and one line
   `{"ts":"...","level":"info","event":"genesis_agent_started","agent":"<Name>","resumed":false,"checkpoint":"missing","held":false}`
2. `mc list` shows Arthur, Mira, Felix and Nova.
3. In the game: each agent walks to the kits chest and takes its tool and bread. Then Arthur
   gathers wood, Mira sows the field, Felix walks his patrol ring, Nova counts the chests.
4. Dashboard, Agents: four cards, none `Offline`. Routines: a phase per agent.
5. `ls bots/genesis_checkpoints/` shows four `<Name>.checkpoint.json` files (written every 30 seconds).
6. No push on the phone. The model being away is not an alert.

Harmless lines: `Error with embedding model, using word-overlap instead.`, `keys.json not found`,
an "unknown command" answer to `/skin clear`.

**If it does not happen**

| You see | It means | Look at |
|---|---|---|
| `Not starting. Fix the problems above` | settings or world file | the `Genesis config problem:` lines |
| `Agent process exited with code 65`, again and again, slower each time | the agents cannot reach the Minecraft server; they wait without limit | `host` is `minecraft`, `mc list` answers |
| `exited with code 66`, twice, then nothing, and a push | the server refused the login | `mc whitelist list` |
| `Genesis agent <Name> could not start:` then `exited with code 1` | the Genesis runtime failed on the real bot | the lines after it |
| agents in the game, standing still | no goal could start | dashboard Incidents and Trace |

**Send**, always all of these:

```
dc -f genesis/compose.agents.yaml logs --no-color agents > /tmp/agents.log
dc -f genesis/compose.minecraft.yaml logs --no-color --tail 300 minecraft > /tmp/minecraft.log
curl -s http://localhost:8080/api/health > /tmp/health.json
curl -s "http://localhost:8080/api/events?limit=500" > /tmp/events.json
sudo tar czf /tmp/genesis-state.tgz bots/genesis_checkpoints bots/genesis_world bots/genesis_ledger
```

Let stage 1 run 15 minutes before stage 2.

### 11. Stage 2: model on

On the desktop, the runbook's **C1** and **C2**, with these values (PowerShell):

```
ollama pull qwen3.8:27b
ollama pull embeddinggemma
[Environment]::SetEnvironmentVariable("OLLAMA_HOST", "DESKTOP_IP:11434", "User")
```

Quit and start Ollama again. In an administrator PowerShell:

```
New-NetFirewallRule -DisplayName "Genesis Ollama" -Direction Inbound -Protocol TCP -LocalPort 11434 -RemoteAddress GENESIS_IP -Action Allow
```

`qwen3.8:27b` is about 18 GB and needs a recent Ollama. Lighter fallback: `gpt-oss:20b`.
**Neither has been benchmarked for this project.** To change the model: replace the name in
`genesis/settings.json` and the four profiles, then `dc -f genesis/compose.agents.yaml restart agents`.

**Check:** on the VM, `curl -s http://DESKTOP_IP:11434/api/version` prints a version. From any
other machine on the LAN it fails.

The agents are NOT restarted: the broker asks the model's address every 15 seconds and opens
by itself.

**What you should see within 5 minutes**

1. Dashboard: the model shows available; an agent's card gets a Thought; Trace lists decisions.
2. On the desktop, `ollama ps` shows the model loaded.
3. Agents finish the routine goal they are on, then take goals the model chose.
4. Stop Ollama: after two failed probes (about 30 seconds) the agents are back on routines,
   with no push. Start it: planning returns by itself.

**Send:** the files of step 10, plus `curl -s "http://localhost:8080/api/events?type=agent.decision&limit=100"`
and `grep -i "model\|genesis_" /tmp/agents.log`.

### 12. Test alert (safe)

```
dc -f genesis/compose.dashboard.yaml stop redis
sleep 75
dc -f genesis/compose.dashboard.yaml start redis
```

**Check:** exactly one push, "Genesis critical: Redis has been unreachable for 60 seconds."
Nothing repeats. The agents keep working (their events wait, up to 2,000, and are sent after).

### Stop everything

```
dc -f genesis/compose.agents.yaml down
dc -f genesis/compose.dashboard.yaml down
dc -f genesis/compose.minecraft.yaml down
```

`down` keeps the world, the database, the checkpoints and the agents' memory. To hold one
agent without stopping anything: in the game, `/msg Arthur !stop`; `/msg Arthur !resume` lets
it go on. Only names under `genesis_planning.operators` are listened to.

### Start over (throwaway world)

```
dc -f genesis/compose.agents.yaml down
dc -f genesis/compose.agents.yaml run --rm agents node genesis/world/reset.js
```

That is a dry run: it lists what would go. Run it again with `--yes-wipe-everything` added: it
removes the agents' memory, checkpoints and ledger (never the world) and marks the world as
reset. Without it the next bootstrap believes the camp is already levelled and fails. Then:

```
dc -f genesis/compose.minecraft.yaml down
sudo rm -rf /opt/genesis/data/minecraft/world /opt/genesis/data/minecraft/world_nether /opt/genesis/data/minecraft/world_the_end
dc -f genesis/compose.minecraft.yaml up -d
```

and go back to step 5 (the same seed gives the same land; `place_world.js` needs `--force`).

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
4. Find the spot as in Part 1 step 5 (server address `127.0.0.1:25600`). Then:
   ```
   node genesis/tools/place_world.js --at X Y Z --seed SEED
   node genesis/world/bootstrap.js --validate
   $env:GENESIS_RCON_PASSWORD = "<the password>"; $env:GENESIS_RCON_HOST = "127.0.0.1"
   node genesis/world/bootstrap.js
   ```
   Check: `Bootstrap PASSED`. Send: the output and `bots\genesis_world\bootstrap.manifest.json`.
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

## Where the runbook is out of date

The runbook was written before the code. What exists differs here:

| Runbook | Now |
|---|---|
| B3: `RCON_PASSWORD`, `POSTGRES_PASSWORD`, `MC_VERSION` in `.env` | `GENESIS_RCON_PASSWORD`, `GENESIS_POSTGRES_PASSWORD`; plus `GENESIS_MINECRAFT_EULA`, `GENESIS_MINECRAFT_SEED`, `GENESIS_MINECRAFT_BIND`, `GENESIS_MINECRAFT_DATA`, `GENESIS_NTFY_TOPIC`. Optional: `GENESIS_MINECRAFT_MEMORY`, `GENESIS_NTFY_SERVER`, `GENESIS_NTFY_TOKEN`, `GENESIS_DIGEST_TZ`, `GENESIS_DASHBOARD_BIND`, `GENESIS_LOAD_MEMORY`. The Minecraft version is fixed in the compose file (1.21.6). `GRAFANA_ADMIN_PASSWORD` and `OBS_WS_PASSWORD` are used by nothing yet. |
| B3: `data/postgres`, `data/redis` folders | Postgres and Redis keep their data in Docker volumes (`genesis-dashboard_genesis-postgres`, `genesis-dashboard_genesis-redis`). Only `data/minecraft` is a folder. |
| B4: one `/opt/genesis/compose.yaml` | Three files in the repository: `genesis/compose.minecraft.yaml`, `genesis/compose.agents.yaml`, `genesis/compose.dashboard.yaml`, passed with `-f` and `--env-file /opt/genesis/.env`. They meet on a Docker network named `genesis`, made once with `docker network create genesis`. |
| B4: `EULA: "TRUE"` written in the file | The operator sets `GENESIS_MINECRAFT_EULA=TRUE` himself; no default. |
| B4: no whitelist, seed, Nether or spawn settings | Whitelist on (names added over RCON), seed required, `allow-nether=false`, `spawn-protection=0` (the camp is at the world spawn; with protection on, agents could not open a chest there), `bukkit.yml` `allow-end: false` by hand. |
| B4: `postgres:17`, `redis:7`, MediaMTX, Grafana | `postgres:16-alpine`, `redis:7-alpine`. No media server, Grafana or Prometheus exists yet. |
| B4 check: `docker compose exec minecraft rcon-cli list` | Needs `--env-file /opt/genesis/.env -f genesis/compose.minecraft.yaml` (the `mc` shortcut of step 4). |
| B6: backup script | Not built. |
| E1: clone, default branch | Clone branch `main`. The fork's default branch `develop` is the clean copy of upstream. |
| E3: host `GENESIS_IP`, port 25600 for the bots | The agents run inside the Docker network: `host` is `minecraft`, port 25600. `GENESIS_IP:25600` is for your own client and the camera. Settings are in `genesis/settings.json` and `genesis/profiles/*.json`, not `settings.js`. The model address goes in three places per the placeholders: `genesis_planning.model`, and each profile's `model` and `embedding`. |
| E3/E4: start the bots, two profiles | Four profiles. Before the agents start: a world file (`genesis/tools/place_world.js`), the world bootstrap over RCON, `genesis_planning.operators`. Start only through `genesis/start.js` (the image's command). |
| E4 check: each bot completes an instruction given in chat | Agents do not take free-text orders. With planning on, what the operator says is a planning trigger; typed commands (`!stop`, `!resume`) still run. |
| C2: `OLLAMA_HOST` `0.0.0.0:11434` | Bind the desktop's LAN address (`DESKTOP_IP:11434`). Also pull the embedding model (`embeddinggemma`); without it agents fall back to word overlap. |
| C5: launcher sends `desktop_available` / `desktop_leaving` | Not built. Without it the broker finds the model by probing every 15 seconds, and treats two failed probes as away. |
| D4: channel open; off-site heartbeat | ntfy (decided). No heartbeat in Genesis (decided). |
| E1 log: "bot image to use Node 20 LTS" | The images use Node 22 (decided 16 Nov): mineflayer and minecraft-protocol declare Node 22 or newer, and the pre-flight ran on 22. Installs use `npm ci` with committed lockfiles. |
| Not in the runbook | `mineflayer` is pinned to 4.39.0 in `package.json`, the release that belongs with the installed game data (an older one misread packets on 1.21.6 and got agents kicked). The agents image removes the `libstdc++` bundled with the prebuilt `canvas`. `node genesis/tools/preflight.js` checks an install. |

---

## Known unverified

Tested before this guide, with the real packages on Linux and Node 22, no Minecraft server:
every Genesis module loads; the launcher starts the MindServer and four agent processes; a
closed Minecraft port puts them into the server-down wait (exit code 65) without a crash;
events reach a real Redis and survive Redis stopping; every SQL migration runs twice on
PostgreSQL 16; the dashboard and alerter run against both and the real MindServer; one
critical push per Redis outage; a planning request goes through the real broker to a stand-in
for Ollama and back.

Never run, most likely to fail first:

1. **Everything after an agent spawns.** `genesis/adapters/bot_agent.js` has been loaded and
   its parts checked on a real mineflayer bot object, but no agent has ever spawned in a world:
   the executor, the routines, the watchdog and upstream's skills have only met stand-ins.
2. **The bootstrap's commands on a real 1.21.6 server:** `fill` (levelling: 24 layers of
   25 by 25 air, then the floor), `setblock` with block states (chest halves, beds, farmland),
   `item replace` (the kit), `execute if block` (the checks), `gamerule`, `worldborder`,
   `setworldspawn`, `seed`, `difficulty`, and how each answer is worded. A wording that differs
   fails the run at that stage: send the output.
3. **The Docker images.** None was built (no Docker daemon). `docker compose config` passes for
   all three files. In `compose.minecraft.yaml` the image tag `java21` is marked UNVERIFIED; the
   variable names were read in the image's documentation.
4. **`npm ci` inside the images.** The lockfiles were written on Linux with Node 22 and match
   their `package.json` files, but no image was built with them.
5. **The whitelist in offline mode:** that `whitelist add <name>` over RCON stores the id an
   offline-mode login gets. If agents are refused (exit code 66), send `whitelist.json`.
6. **Paper's own limits** on bots: movement checks, spam limits, the firewall rule of B5.
7. **The real model:** whether `qwen3.8:27b` returns the structured reply within 90 seconds and
   1,200 prompt tokens. A reply that breaks the schema is rejected, retried once, and the agent
   stays on its routine.
8. **Real ntfy delivery** to a phone (the request was checked against a local stand-in).
9. **Windows** (Part 2): `npm install` of the native packages (`canvas`, `gl`) and the launcher.
