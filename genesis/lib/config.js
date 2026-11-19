// Genesis: builds the settings override for upstream main.js and checks the profiles.
// Upstream main.js applies the SETTINGS_JSON environment variable last, on top of
// settings.js and every other environment override, so Genesis never edits settings.js.
// Depends only on Node built-ins and on the plain-data checks of genesis/catalog/zones.js,
// genesis/routines/routines.js and genesis/world (the world file and the bootstrap manifest).

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { checkZonesConfig, createZones } from '../catalog/zones.js';
import { checkRoutineRanges } from '../routines/routines.js';
import { buildBlueprints } from '../catalog/blueprints.js';
import { checkWorldConfig, describeProblem } from '../world/world_config.js';
import { DEFAULT_MANIFEST_FILE, RESET_MARKER_FILE, manifestPaths, parseManifest, checkManifest } from '../world/manifest.js';
import { WATCHDOG_DEFAULTS, SIGNATURE_DEFAULTS } from '../recovery/watchdog.js';
import { SUPERVISOR_DEFAULTS } from '../recovery/supervisor.js';
import { DEATH_RULES } from '../recovery/death.js';
import { RELAY_LIMITS } from '../relay/relay.js';
import { LINE_LIMITS } from '../relay/lines.js';
import { DECISION_LIMITS } from '../relay/decisions.js';

// Actions Genesis agents must never have, whatever the settings file says.
export const REQUIRED_BLOCKED_ACTIONS = ['!newAction', '!startConversation', '!endConversation'];

// Values that mean "not filled in yet".
export const PLACEHOLDERS = ['GENESIS_MODEL', 'DESKTOP_IP'];
// "Not filled in yet" for the Redis address in genesis_events.redis_url.
export const REDIS_PLACEHOLDER = 'REDIS_HOST';
// "Not filled in yet" for the host of the Postgres address (the environment variable DATABASE_ENV).
export const POSTGRES_PLACEHOLDER = 'POSTGRES_HOST';
// "Not filled in yet" for the operator's Minecraft username in genesis_planning.operators.
export const OPERATOR_PLACEHOLDER = 'OPERATOR_NAME';
// The launcher's environment variable with the agents' Postgres address (it holds the password):
// planner call records, the goal store and the checkpoint mirror go there when it is set.
export const DATABASE_ENV = 'GENESIS_DATABASE_URL';
// The launcher's environment variable that says where the world file is (it replaces
// genesis_planning.world_file; no secret). In Docker it points into the mounted ./bots folder.
export const WORLD_FILE_ENV = 'GENESIS_WORLD_FILE';
// What a Minecraft Java username looks like.
export const MINECRAFT_NAME = /^[A-Za-z0-9_]{3,16}$/;

// Addresses the MindServer may listen on. The agents always connect to it through
// localhost (src/agent/mindserver_proxy.js), so only loopback and "every interface"
// addresses keep them connected. "0.0.0.0" is what makes it reachable from another
// container on the same Docker network.
export const MINDSERVER_HOSTS = ['localhost', '127.0.0.1', '::1', '0.0.0.0', '::'];

// file_settings: the parsed genesis/settings.json
// env_settings_json: an existing SETTINGS_JSON value (operator override), or undefined
// load_memory_env: the GENESIS_LOAD_MEMORY value, or undefined. "false" starts every agent
//   with empty memory (a full reset start); "true" loads saved memory; anything else
//   leaves the settings file's value alone.
// Returns the object to hand to main.js as SETTINGS_JSON.
export function buildSettings(file_settings, env_settings_json, load_memory_env) {
    let settings = { ...file_settings };
    if (env_settings_json) {
        settings = { ...settings, ...JSON.parse(env_settings_json) };
    }
    if (load_memory_env === 'true') settings.load_memory = true;
    if (load_memory_env === 'false') settings.load_memory = false;
    // Model-written code stays off. Not configurable from Genesis.
    settings.allow_insecure_coding = false;
    // Agents never dig through blocks to get somewhere (they destroyed their own builds).
    // Not configurable from Genesis. See genesis/lib/no_dig_pathing.js.
    settings.pathfinding_no_dig = true;
    const blocked = Array.isArray(settings.blocked_actions) ? [...settings.blocked_actions] : [];
    for (const action of REQUIRED_BLOCKED_ACTIONS) {
        if (!blocked.includes(action)) blocked.push(action);
    }
    settings.blocked_actions = blocked;
    return settings;
}

// What the launcher's environment may put into the settings: only what is no secret.
// Returns the settings (changed in place).
export function applyEnvironment(settings, env = {}) {
    const world_file = env[WORLD_FILE_ENV];
    const planning = settings.genesis_planning;
    if (typeof world_file === 'string' && world_file.length > 0 && planning !== null && typeof planning === 'object' && !Array.isArray(planning)) {
        settings.genesis_planning = { ...planning, world_file };
    }
    return settings;
}

// Checks the database address of the launcher's environment. Empty or missing is fine: everything
// then works without a database. A problem never repeats the address (it holds a password).
export function checkDatabaseUrl(url) {
    if (url === undefined || url === null || url === '') return [];
    if (typeof url !== 'string' || !/^postgres(ql)?:\/\/[^/]+/.test(url)) return [`environment: ${DATABASE_ENV} must be a postgres:// address, or empty for none`];
    if (url.includes(POSTGRES_PLACEHOLDER)) return [`environment: ${DATABASE_ENV} still holds a placeholder (${POSTGRES_PLACEHOLDER})`];
    return [];
}

// Checks the settings that are not about profiles. Returns a list of problems (empty = fine).
// No mindserver_host at all is fine: upstream then listens on localhost.
export function checkSettings(settings) {
    const problems = [];
    const host = settings.mindserver_host;
    if (host !== undefined && !MINDSERVER_HOSTS.includes(host)) {
        problems.push(`settings: "mindserver_host" must be one of ${MINDSERVER_HOSTS.join(', ')} (got ${JSON.stringify(host)}); `
            + 'the agents connect through localhost and would not find the MindServer on another address');
    }
    problems.push(...checkEventSettings(settings.genesis_events));
    problems.push(...checkPlanningSettings(settings.genesis_planning));
    problems.push(...checkRecoverySettings(settings.genesis_recovery));
    problems.push(...checkRelaySettings(settings.genesis_relay));
    problems.push(...checkLearningSettings(settings.genesis_learning));
    return problems;
}

// Checks the genesis_learning setting (the learner of genesis/learning). Learning goes with planning: it is on
// whenever planning is, unless this says "enabled": false. Nothing here can switch model-written code on: the
// learner only orders what the catalog offers.
//   explore_rate   the share of the learner's own choices that go to an option it is unsure about (decided: 0.25)
export function checkLearningSettings(learning) {
    if (learning === undefined) return [];
    if (learning === null || typeof learning !== 'object' || Array.isArray(learning)) return ['settings: "genesis_learning" must be an object'];
    const problems = [];
    if (learning.enabled !== undefined && typeof learning.enabled !== 'boolean') problems.push('settings: "genesis_learning.enabled" must be true or false');
    if (learning.explore_rate !== undefined && !(Number.isFinite(learning.explore_rate) && learning.explore_rate >= 0 && learning.explore_rate <= 1)) {
        problems.push('settings: "genesis_learning.explore_rate" must be a number from 0 to 1');
    }
    for (const key of Object.keys(learning)) {
        if (key !== 'enabled' && key !== 'explore_rate') problems.push(`settings: "genesis_learning.${key}" is not a setting (known: enabled, explore_rate)`);
    }
    return problems;
}

// The values of genesis_relay that may be given other than their starting value, by part.
export const RELAY_SETTINGS = Object.freeze({ limits: RELAY_LIMITS, line: LINE_LIMITS, decision: DECISION_LIMITS });
// The switches of genesis_relay: each is true or false.
export const RELAY_FLAGS = Object.freeze(['enabled', 'model_lines', 'model_decisions']);

// Checks the genesis_relay setting (structured agent-to-agent messages). The relay goes with
// planning: no setting at all means on, with every starting value. "enabled": false switches
// it off; "model_lines": false makes every spoken line a template line; "model_decisions":
// false lets the code rule decide every incoming request and offer. "decision" holds the
// limits of the model's accept-or-decline call (its own hourly limit and token limit).
function checkRelaySettings(relay) {
    if (relay === undefined) return [];
    if (relay === null || typeof relay !== 'object' || Array.isArray(relay)) return ['settings: "genesis_relay" must be an object'];
    const problems = [];
    for (const flag of RELAY_FLAGS) {
        if (relay[flag] !== undefined && typeof relay[flag] !== 'boolean') problems.push(`settings: "genesis_relay.${flag}" must be true or false`);
    }
    for (const key of Object.keys(relay)) {
        if (!RELAY_FLAGS.includes(key) && !Object.hasOwn(RELAY_SETTINGS, key)) problems.push(`settings: "genesis_relay.${key}" is not a setting (known: ${RELAY_FLAGS.join(', ')}, ${Object.keys(RELAY_SETTINGS).join(', ')})`);
    }
    for (const [part, defaults] of Object.entries(RELAY_SETTINGS)) {
        problems.push(...checkOverrides(`genesis_relay.${part}`, relay[part], defaults));
    }
    return problems;
}

// The values of genesis_recovery that may be given other than their starting value, by part.
export const RECOVERY_SETTINGS = Object.freeze({
    watchdog: Object.freeze({ ...WATCHDOG_DEFAULTS, ...SIGNATURE_DEFAULTS }),
    supervisor: SUPERVISOR_DEFAULTS,
    death: DEATH_RULES,
});

// Checks an object of overrides against the starting values it may replace: only known
// names, and a value of the same kind (a number of 0 or more, a text, a list of those).
export function checkOverrides(where, given, defaults) {
    if (given === undefined) return [];
    if (given === null || typeof given !== 'object' || Array.isArray(given)) return [`settings: "${where}" must be an object`];
    const problems = [];
    const fits = (value, like) => (typeof like === 'number' ? Number.isFinite(value) && value >= 0
        : typeof like === 'boolean' ? typeof value === 'boolean' : typeof value === 'string' && value.length > 0);
    for (const [key, value] of Object.entries(given)) {
        if (!Object.hasOwn(defaults, key)) {
            problems.push(`settings: "${where}.${key}" is not a setting (known: ${Object.keys(defaults).join(', ')})`);
        } else if (Array.isArray(defaults[key])) {
            if (!Array.isArray(value) || value.length === 0 || !value.every((entry) => fits(entry, defaults[key][0]))) {
                problems.push(`settings: "${where}.${key}" must be a list like ${JSON.stringify(defaults[key])}`);
            }
        } else if (!fits(value, defaults[key])) {
            problems.push(`settings: "${where}.${key}" must be ${typeof defaults[key] === 'number' ? 'a number, 0 or more' : `a ${typeof defaults[key]}`} (starting value ${JSON.stringify(defaults[key])})`);
        }
    }
    return problems;
}

// Checks the genesis_recovery setting (the watchdog and its ladder, the supervisor that
// restarts agent processes, the re-equip after a death). Recovery goes with planning: no
// setting at all means on, with every starting value. "enabled": false switches it off.
function checkRecoverySettings(recovery) {
    if (recovery === undefined) return [];
    if (recovery === null || typeof recovery !== 'object' || Array.isArray(recovery)) {
        return ['settings: "genesis_recovery" must be an object'];
    }
    const problems = [];
    if (recovery.enabled !== undefined && typeof recovery.enabled !== 'boolean') {
        problems.push('settings: "genesis_recovery.enabled" must be true or false');
    }
    for (const key of Object.keys(recovery)) {
        if (key !== 'enabled' && !Object.hasOwn(RECOVERY_SETTINGS, key)) problems.push(`settings: "genesis_recovery.${key}" is not a setting (known: enabled, ${Object.keys(RECOVERY_SETTINGS).join(', ')})`);
    }
    for (const [part, defaults] of Object.entries(RECOVERY_SETTINGS)) {
        problems.push(...checkOverrides(`genesis_recovery.${part}`, recovery[part], defaults));
    }
    return problems;
}

// Checks the genesis_planning setting (the Genesis decision loop: executor, planner broker,
// routines). No setting at all, or "enabled": false, leaves it off: the agents then ask the
// model after every action as upstream does, and the rest of the setting is not looked at.
function checkPlanningSettings(planning) {
    if (planning === undefined) return [];
    if (planning === null || typeof planning !== 'object' || Array.isArray(planning)) {
        return ['settings: "genesis_planning" must be an object'];
    }
    if (planning.enabled !== true && planning.enabled !== false) {
        return ['settings: "genesis_planning.enabled" must be true or false'];
    }
    if (!planning.enabled) return [];
    const problems = [];
    for (const key of ['world_file', 'checkpoint_dir']) {
        if (typeof planning[key] !== 'string' || planning[key].length === 0) {
            problems.push(`settings: "genesis_planning.${key}" must be a path`);
        }
    }
    const model = planning.model;
    if (model === null || typeof model !== 'object' || Array.isArray(model)) {
        problems.push('settings: "genesis_planning.model" must be an object with url and model');
    } else {
        for (const field of ['url', 'model']) {
            if (typeof model[field] !== 'string' || model[field].length === 0) {
                problems.push(`settings: "genesis_planning.model.${field}" is missing`);
            } else if (PLACEHOLDERS.some((p) => model[field].includes(p))) {
                problems.push(`settings: "genesis_planning.model.${field}" still holds a placeholder (${model[field]})`);
            }
        }
        let url = null;
        try { url = new URL(model.url); } catch { /* reported below */ }
        if (typeof model.url === 'string' && model.url.length > 0 && (!url || !['http:', 'https:'].includes(url.protocol))) {
            problems.push('settings: "genesis_planning.model.url" must be an http:// or https:// address');
        }
    }
    // The operator's Minecraft username(s). In the game, only they are listened to; everybody
    // else's chat is ignored and counted (genesis/agent/hooks.js). The panel always counts as the operator.
    const operators = planning.operators;
    if (!Array.isArray(operators) || operators.length === 0) {
        problems.push('settings: "genesis_planning.operators" must list the operator\'s Minecraft username (at least one)');
    } else {
        for (const name of operators) {
            if (name === OPERATOR_PLACEHOLDER) {
                problems.push(`settings: "genesis_planning.operators" still holds a placeholder (${name})`);
            } else if (typeof name !== 'string' || !MINECRAFT_NAME.test(name)) {
                problems.push(`settings: "genesis_planning.operators" holds ${JSON.stringify(name)}, which is not a Minecraft username (3 to 16 letters, digits or _)`);
            }
        }
    }
    for (const key of ['manifest_file', 'ledger_file', 'town_file']) {
        if (planning[key] !== undefined && (typeof planning[key] !== 'string' || planning[key].length === 0)) {
            problems.push(`settings: "genesis_planning.${key}" must be a path, or left out for the default`);
        }
    }
    // Decided: the database address holds a password and is never read from the settings file. It
    // comes from the launcher's environment (DATABASE_ENV below). A value here is refused, not ignored,
    // so that a password never sits in a tracked file by mistake. (Its text is not repeated.)
    const postgres = planning.postgres_url;
    if (postgres !== undefined && postgres !== null && postgres !== '') {
        problems.push(`settings: "genesis_planning.postgres_url" is not read any more and must be empty: the database address comes from the environment variable ${DATABASE_ENV} of the launcher (the same .env file as the other secrets)`);
    }
    return problems;
}

// Checks the world config file the genesis_planning setting names (the zones: camp, field,
// plots, and each agent's home and range). Only looked at while planning is on.
// Returns a list of problems (empty = fine).
export function checkWorld(settings, repo_root) {
    const planning = settings.genesis_planning;
    if (planning?.enabled !== true || typeof planning.world_file !== 'string' || planning.world_file.length === 0) return [];
    const file = planning.world_file;
    let config;
    try {
        config = JSON.parse(readFileSync(path.resolve(repo_root, file), 'utf8'));
    } catch (err) {
        return [`${file}: the world config cannot be read as JSON (${err.code === 'ENOENT' ? 'the file does not exist' : err.message})`];
    }
    const problems = checkZonesConfig(config).map((problem) => `${file}: ${problem}`);
    if (problems.length > 0) return problems;
    const zones = createZones(config);
    problems.push(...checkRoutineRanges(zones).map((problem) => `${file}: ${problem.replace(/^world config: /, '')}`));
    // every agent that is started needs a home and a range
    for (const profile_path of Array.isArray(settings.profiles) ? settings.profiles : []) {
        try {
            const name = JSON.parse(readFileSync(path.resolve(repo_root, profile_path), 'utf8')).name;
            if (name && zones.home(name) === null && !problems.some((problem) => problem.includes(`agents.${name} `))) {
                problems.push(`${file}: agents.${name} is missing (home and range)`);
            }
        } catch { /* an unreadable profile is reported by checkProfiles */ }
    }
    return problems;
}

// The gate in front of planning: with planning on, the world file must be the full "v": 2
// file and pass every check of genesis/world/world_config.js, AND the bootstrap must have run
// for exactly that file: a manifest whose hash matches and whose checks passed
// (genesis/world/bootstrap.js writes it). While the marker of a full reset is there
// (genesis/world/reset.js), the world has to be regenerated first.
// Call it after checkWorld came back clean. Returns a list of problems (empty = fine).
export function checkBootstrap(settings, repo_root) {
    const planning = settings.genesis_planning;
    if (planning?.enabled !== true || typeof planning.world_file !== 'string' || planning.world_file.length === 0) return [];
    const file = planning.world_file;
    let config;
    try {
        config = JSON.parse(readFileSync(path.resolve(repo_root, file), 'utf8'));
    } catch {
        return []; // reported by checkWorld
    }
    const world_problems = checkWorldConfig(config, { blueprints: buildBlueprints({ root: repo_root }) });
    if (world_problems.length > 0) return world_problems.map((problem) => `${file}: ${describeProblem(problem)}`);

    const manifest_file = planning.manifest_file || DEFAULT_MANIFEST_FILE;
    const paths = manifestPaths(path.resolve(repo_root, manifest_file));
    const how = 'run  node genesis/world/bootstrap.js  against the Minecraft server first';
    if (existsSync(paths.reset_marker)) {
        return [`${manifest_file}: a full reset was run and the world has not been bootstrapped since (${RESET_MARKER_FILE} is there): regenerate the world, then ${how}`];
    }
    let text = null;
    try { text = readFileSync(paths.manifest, 'utf8'); } catch { /* no manifest */ }
    if (text === null) return [`${manifest_file}: there is no bootstrap manifest, so planning stays off: ${how}`];
    const manifest = parseManifest(text);
    if (!manifest) return [`${manifest_file}: is not a bootstrap manifest: ${how}`];
    return checkManifest(manifest, config).map((problem) => `${manifest_file}: ${problem}: ${how}`);
}

// Whole-number settings of genesis_events, with the smallest value each may have.
export const EVENT_NUMBER_SETTINGS = { stream_maxlen: 100, buffer_size: 2 };

// Checks the genesis_events setting (structured events, published to Redis streams by the
// MindServer). No setting at all, or "enabled": false, leaves events off: nothing is
// emitted, nothing connects to Redis, and the rest of the setting is not looked at.
function checkEventSettings(events) {
    if (events === undefined) return [];
    if (events === null || typeof events !== 'object' || Array.isArray(events)) {
        return ['settings: "genesis_events" must be an object'];
    }
    if (events.enabled !== true && events.enabled !== false) {
        return ['settings: "genesis_events.enabled" must be true or false'];
    }
    if (!events.enabled) return [];
    const problems = [];
    let url = null;
    try { url = new URL(events.redis_url); } catch { /* reported below */ }
    if (typeof events.redis_url !== 'string' || !url || !['redis:', 'rediss:'].includes(url.protocol) || !url.hostname) {
        problems.push('settings: "genesis_events.redis_url" must be a redis:// or rediss:// address');
    } else if (events.redis_url.includes(REDIS_PLACEHOLDER)) {
        problems.push(`settings: "genesis_events.redis_url" still holds a placeholder (${events.redis_url})`);
    }
    if (typeof events.stream !== 'string' || events.stream.length === 0) {
        problems.push('settings: "genesis_events.stream" must be a non-empty string');
    }
    if (events.stream_per_agent !== undefined && typeof events.stream_per_agent !== 'boolean') {
        problems.push('settings: "genesis_events.stream_per_agent" must be true or false');
    }
    for (const [key, least] of Object.entries(EVENT_NUMBER_SETTINGS)) {
        if (!Number.isInteger(events[key]) || events[key] < least) {
            problems.push(`settings: "genesis_events.${key}" must be a whole number, ${least} or more`);
        }
    }
    return problems;
}

// Checks each profile listed in the settings. Returns a list of problems (empty = fine).
// The short string forms of `model` and `embedding` are rejected on purpose:
// upstream then silently talks to an Ollama on localhost.
export function checkProfiles(settings, repo_root) {
    const problems = [];
    const profiles = Array.isArray(settings.profiles) ? settings.profiles : [];
    if (profiles.length === 0) problems.push('settings: no profiles listed');
    for (const profile_path of profiles) {
        let profile;
        try {
            profile = JSON.parse(readFileSync(path.resolve(repo_root, profile_path), 'utf8'));
        } catch (err) {
            problems.push(`${profile_path}: cannot be read as JSON (${err.message})`);
            continue;
        }
        if (!profile.name) problems.push(`${profile_path}: "name" is missing`);
        if (settings.genesis_planning?.enabled === true && Array.isArray(settings.genesis_planning.operators)
            && settings.genesis_planning.operators.includes(profile.name)) {
            problems.push(`${profile_path}: the agent ${profile.name} is listed under "genesis_planning.operators": an agent is never the operator`);
        }
        for (const key of ['model', 'embedding']) {
            const spec = profile[key];
            if (!spec || typeof spec !== 'object') {
                problems.push(`${profile_path}: "${key}" must be an object with api, url and model`);
                continue;
            }
            for (const field of ['api', 'url', 'model']) {
                if (typeof spec[field] !== 'string' || spec[field].length === 0) {
                    problems.push(`${profile_path}: "${key}.${field}" is missing`);
                } else if (PLACEHOLDERS.some((p) => spec[field].includes(p))) {
                    problems.push(`${profile_path}: "${key}.${field}" still holds a placeholder (${spec[field]})`);
                }
            }
        }
    }
    return problems;
}
