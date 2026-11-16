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

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSettings, checkProfiles, checkSettings, checkWorld, checkBootstrap } from './lib/config.js';

const repo_root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(repo_root); // upstream resolves profiles and ./bots relative to the working directory

const settings_file = process.env.GENESIS_SETTINGS_FILE || path.join(repo_root, 'genesis', 'settings.json');
const settings = buildSettings(JSON.parse(readFileSync(settings_file, 'utf8')), process.env.SETTINGS_JSON, process.env.GENESIS_LOAD_MEMORY);
const world_problems = checkWorld(settings, repo_root);
const problems = [...checkSettings(settings), ...checkProfiles(settings, repo_root), ...world_problems,
    // the bootstrap is only looked at once the world file itself reads cleanly
    ...(world_problems.length === 0 ? checkBootstrap(settings, repo_root) : [])];

// Model-written code can only be switched on through the environment variable
// read by main.js, or through allow_insecure_coding. Remove the first, the second is forced to false above.
// buildSettings also forces pathfinding_no_dig on: agents never dig to get somewhere.
delete process.env.INSECURE_CODING;
process.env.SETTINGS_JSON = JSON.stringify(settings);

const check_only = process.argv.includes('--check');
if (check_only) {
    console.log(JSON.stringify({ settings_file, settings, problems }, null, 2));
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
    // the planner broker lives in this (the MindServer's) process; the agents reach it over their sockets
    const { startPlanning } = await import('./planning/server.js');
    const host = await startPlanning(settings.genesis_planning, {
        event_sink, extensions, onGate: recovery ? (state, detail) => recovery.onGate(state, detail) : null,
    });
    // the model writes the spoken lines through the broker, and the chest ledger follows what the agents agree on
    if (relay) relay.bind({ broker: host.broker, ledger: host.ledger, ledgerUpdated: () => host.ledgerUpdated() });
}
await import('../main.js');
