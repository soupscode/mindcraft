// Genesis launcher: starts the agents with genesis/settings.json.
//
//   node genesis/start.js           start the agents
//   node genesis/start.js --check   print the settings that would be applied and any problems, then exit
//
// It hands the Genesis settings to upstream main.js through the SETTINGS_JSON
// environment variable (main.js applies it last, so it wins over settings.js and
// the other environment overrides), then runs main.js unchanged.
// GENESIS_SETTINGS_FILE may point to another settings file (used by the tests).
// A SETTINGS_JSON that is already set is merged on top of the file, for one-off overrides.
// GENESIS_LOAD_MEMORY=false starts every agent with empty memory (a full reset start);
// unset or true loads saved memory, as genesis/settings.json says.
//
// Structured events ("genesis_events" in the settings file) are off until "enabled" is
// true. Then the agents hand their events to the MindServer, which publishes them to the
// Redis stream named there. That needs the "redis" package and a filled-in redis_url.
// A Redis that is down or missing never stops or slows an agent: events wait in a bounded
// buffer in the MindServer and are counted as dropped once it is full.
//
// The Genesis decision loop ("genesis_planning" in the settings file) is off until
// "enabled" is true. Then the agents stop asking the model after every action: they carry
// out goals from the skill templates (genesis/catalog, genesis/executor), ask the planner
// broker (which runs in this process) only when something changed, and work from their
// role routines while the model is away. That needs the world config file named there
// (genesis.world.json: the seed, the camp, the field, the plots, each agent's home and range,
// and the game rules), AND a bootstrapped world: the launcher refuses to turn planning on
// unless the world file passes its checks and a bootstrap manifest for exactly that file
// exists (node genesis/world/bootstrap.js writes it once the starter camp is built and
// checked). It also needs the operator's Minecraft username under "operators".
//
// GENESIS_WORLD_FILE names the world file instead of the setting (in Docker: a path in ./bots).
//
// The database (optional): GENESIS_DATABASE_URL, a postgres:// address with its password, in the
// launcher's environment (the same .env file as the other secrets), NEVER in the settings file.
// When it is set, the planner call records, the goal store and the checkpoint mirror are kept
// there (the tables are made at start, genesis/store/migrations); it is the dashboard's database,
// so the Decision trace shows the context, the options offered, the latency and the tokens of
// every call. Without it everything works from memory and files, as before.
//
// Recovery ("genesis_recovery" in the settings file) goes with planning: it is on whenever
// planning is, unless it says "enabled": false. Then a supervisor in this process restarts
// an agent process that ended (after 5 seconds, 30 seconds, 2 minutes and 5 minutes; after 5
// restarts in 30 minutes the agent stops and the operator is told), waits without limit for
// a Minecraft server that is down, and each agent runs the watchdog and its recovery ladder.
//
// Agent messages ("genesis_relay" in the settings file) go with planning as well, unless it
// says "enabled": false. Agents then coordinate through structured messages (request, offer,
// accept, decline, inform, warn) that ONE relay in this process carries, limits and turns
// into events; the line an agent says in the game chat is only how a message is shown.
// The planner may choose to send a request or an offer as a goal (ask_agent, offer_agent), and
// a request or offer that arrives is decided by the model with a small call of its own
// ("genesis_relay.decision" holds its hourly limit and token limit; "model_decisions": false
// leaves every such decision to the code rule, as it is whenever the model is away).

// Learning ("genesis_learning" in the settings file) goes with planning, unless it says "enabled": false.
// ONE learner in this process records every goal of every agent (the situation and what it predicted
// when the goal starts, what happened when it ends), trains a small network on those outcomes, orders
// and annotates the options the planner is shown, and chooses among them while the model is away. It
// never names an action the catalog did not offer and never runs code. Its weights are files under
// ./bots/genesis_learning; its rows are in the database when there is one.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSettings, applyEnvironment, checkDatabaseUrl, checkProfiles, checkSettings, checkWorld, checkBootstrap, DATABASE_ENV, WORLD_FILE_ENV } from './lib/config.js';

const repo_root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(repo_root); // upstream resolves profiles and ./bots relative to the working directory

const settings_file = process.env.GENESIS_SETTINGS_FILE || path.join(repo_root, 'genesis', 'settings.json');
const settings = applyEnvironment(buildSettings(JSON.parse(readFileSync(settings_file, 'utf8')), process.env.SETTINGS_JSON, process.env.GENESIS_LOAD_MEMORY), process.env);
// The database address holds a password: it is read here, kept in this process only, and taken out of
// the environment before upstream starts the agent processes. It never goes into the settings.
const database_url = process.env[DATABASE_ENV] || '';
delete process.env[DATABASE_ENV];
// the same for the RCON password (the skin service uses it): this process only
const rcon_password = process.env.GENESIS_RCON_PASSWORD || '';
delete process.env.GENESIS_RCON_PASSWORD;
// and for the MineSkin API key (custom skins are signed there: genesis/skins/mineskin.js): this process only, never printed
const mineskin_env = { GENESIS_MINESKIN_API_KEY: process.env.GENESIS_MINESKIN_API_KEY || '', GENESIS_MINESKIN_VISIBILITY: process.env.GENESIS_MINESKIN_VISIBILITY || '' };
delete process.env.GENESIS_MINESKIN_API_KEY;
const world_problems = checkWorld(settings, repo_root);
const problems = [...checkSettings(settings), ...checkDatabaseUrl(database_url), ...checkProfiles(settings, repo_root), ...world_problems,
    // the bootstrap is only looked at once the world file itself reads cleanly
    ...(world_problems.length === 0 ? checkBootstrap(settings, repo_root) : [])];

// Model-written code can only be switched on through the environment variable
// read by main.js, or through allow_insecure_coding. Remove the first, the second is forced to false above.
// buildSettings also forces pathfinding_no_dig on: agents never dig to get somewhere.
delete process.env.INSECURE_CODING;
// The agents log in a few seconds apart (seen on the real server: Paper answers several logins from one
// address within 4 seconds with "connection throttled"). main.js reads this; 0 starts them all at once.
if (settings.genesis_planning?.enabled === true && settings.genesis_start_gap_ms === undefined) settings.genesis_start_gap_ms = 5000;
process.env.SETTINGS_JSON = JSON.stringify(settings);

const check_only = process.argv.includes('--check');
if (check_only) {
    const environment = { [DATABASE_ENV]: database_url ? 'set (not shown)' : 'not set', [WORLD_FILE_ENV]: process.env[WORLD_FILE_ENV] || 'not set' };
    console.log(JSON.stringify({ settings_file, environment, settings, problems }, null, 2));
    process.exit(problems.length > 0 ? 1 : 0);
}
if (problems.length > 0) {
    for (const problem of problems) console.error(`Genesis config problem: ${problem}`);
    console.error('Not starting. Fix the problems above (see genesis/profiles and genesis/settings.json).');
    process.exit(1);
}
let event_hub = null;
if (settings.genesis_events?.enabled === true) {
    const { startEventPublishing } = await import('./events/server.js');
    event_hub = await startEventPublishing(settings.genesis_events);
}
if (settings.genesis_planning?.enabled === true) {
    const event_sink = event_hub ? event_hub.accept : null;
    if (event_sink) {
        // the site, the zones and the summary of the bootstrap manifest, as events (the dashboard's World view)
        const { announceWorld } = await import('./world/announce.js');
        announceWorld({ planning: settings.genesis_planning, repo_root, event_sink });
    }
    const extensions = [];
    let recovery = null;
    if (settings.genesis_recovery?.enabled !== false) {
        // the supervisor of the agent processes lives in this process too
        const { startRecovery } = await import('./recovery/server.js');
        recovery = await startRecovery(settings.genesis_recovery ?? {}, { event_sink });
        extensions.push((socket, helpers) => recovery.attach(socket, helpers));
    }
    let relay = null;
    if (settings.genesis_relay?.enabled !== false) {
        // the ONE relay of agent-to-agent messages lives in this process as well
        const { startRelay } = await import('./relay/server.js');
        const names = settings.profiles.map((profile) => JSON.parse(readFileSync(path.resolve(repo_root, profile), 'utf8')).name);
        relay = startRelay(settings.genesis_relay ?? {}, { agents: names, event_sink });
        extensions.push((socket, helpers) => relay.attach(socket, helpers));
    }
    // agent skins: the dashboard hands a skin over, this process tells SkinsRestorer over RCON (never an agent)
    {
        const { startSkins, rconOnDemand } = await import('./skins/server.js');
        const { mineSkinFromEnv } = await import('./skins/mineskin.js');
        const names = settings.profiles.map((profile) => JSON.parse(readFileSync(path.resolve(repo_root, profile), 'utf8')).name);
        const skins = startSkins({
            event_sink, agents: names,
            // the only place anything is sent outside: one upload to MineSkin per skin the operator uploads (refused without the key)
            signer: mineSkinFromEnv(mineskin_env),
            rcon: rcon_password ? rconOnDemand({ host: process.env.GENESIS_RCON_HOST || settings.host, port: Number(process.env.GENESIS_RCON_PORT || 25575), password: rcon_password }) : null,
        });
        extensions.push((socket, helpers) => skins.attach(socket, helpers));
    }
    // the planner broker lives in this (the MindServer's) process; the agents reach it over their sockets
    const { startPlanning } = await import('./planning/server.js');
    // the town (genesis/town): the ONE town file, layered over the world file's zones by every agent. Plots and bridges
    // that code proposes, the builds and the homes are kept there; the world file itself is never written.
    let town = null;
    let roles = {};
    {
        const { startTown } = await import('./town/server.js');
        const { buildBlueprints } = await import('./catalog/blueprints.js');
        const { nodeFiles } = await import('./store/node_files.js');
        const { worldHash } = await import('./world/world_config.js');
        const { ROUTINES } = await import('./routines/routines.js');
        const world_file = path.resolve(repo_root, process.env[WORLD_FILE_ENV] || settings.genesis_planning.world_file);
        const zones_config = JSON.parse(readFileSync(world_file, 'utf8'));
        roles = Object.fromEntries(Object.entries(ROUTINES).map(([name, routine]) => [name, routine.role]));
        town = await startTown(settings.genesis_planning, {
            zones_config, prefabs: buildBlueprints({ root: repo_root }), files: nodeFiles(), event_sink, world_sha256: worldHash(zones_config), roles,
        });
        extensions.push((socket, helpers) => town.attach(socket, helpers));
    }
    // the one learner of all agents lives here too (off only with "genesis_learning": { "enabled": false })
    const agent_names = settings.profiles.map((profile) => JSON.parse(readFileSync(path.resolve(repo_root, profile), 'utf8')).name);
    const learning = settings.genesis_learning?.enabled !== false
        ? { agents: agent_names, roles, ...(Number.isFinite(settings.genesis_learning?.explore_rate) ? { scorer: { explore_rate: settings.genesis_learning.explore_rate } } : {}) }
        : null;
    const host = await startPlanning(settings.genesis_planning, {
        event_sink, extensions, onGate: recovery ? (state, detail) => recovery.onGate(state, detail) : null,
        postgres_url: database_url || null, learning,
    });
    // the model writes the spoken lines through the broker, and the chest ledger follows what the agents agree on
    if (relay) relay.bind({ broker: host.broker, ledger: host.ledger, ledgerUpdated: () => host.ledgerUpdated() });
    // the model chooses the agents' long-term goals through the broker; the town's stock is the shared chest's ledger;
    // the builds are also rows of the learner's store
    town?.bind({ broker: host.broker, ledger: host.ledger, store: host.learning?.store ?? null });
}
await import('../main.js');
