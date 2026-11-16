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

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSettings, checkProfiles, checkSettings } from './lib/config.js';

const repo_root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(repo_root); // upstream resolves profiles and ./bots relative to the working directory

const settings_file = process.env.GENESIS_SETTINGS_FILE || path.join(repo_root, 'genesis', 'settings.json');
const settings = buildSettings(JSON.parse(readFileSync(settings_file, 'utf8')), process.env.SETTINGS_JSON, process.env.GENESIS_LOAD_MEMORY);
const problems = [...checkSettings(settings), ...checkProfiles(settings, repo_root)];

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
if (settings.genesis_events?.enabled === true) {
    const { startEventPublishing } = await import('./events/server.js');
    await startEventPublishing(settings.genesis_events);
}
await import('../main.js');
