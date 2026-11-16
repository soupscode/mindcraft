// Genesis: builds the settings override for upstream main.js and checks the profiles.
// Upstream main.js applies the SETTINGS_JSON environment variable last, on top of
// settings.js and every other environment override, so Genesis never edits settings.js.
// Depends only on Node built-ins and on the plain-data checks of genesis/catalog/zones.js and
// genesis/routines/routines.js.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { checkZonesConfig, createZones } from '../catalog/zones.js';
import { checkRoutineRanges } from '../routines/routines.js';

// Actions Genesis agents must never have, whatever the settings file says.
export const REQUIRED_BLOCKED_ACTIONS = ['!newAction', '!startConversation', '!endConversation'];

// Values that mean "not filled in yet".
export const PLACEHOLDERS = ['GENESIS_MODEL', 'DESKTOP_IP'];
// "Not filled in yet" for the Redis address in genesis_events.redis_url.
export const REDIS_PLACEHOLDER = 'REDIS_HOST';
// "Not filled in yet" for the Postgres address in genesis_planning.postgres_url.
export const POSTGRES_PLACEHOLDER = 'POSTGRES_HOST';

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
    const postgres = planning.postgres_url;
    if (postgres !== undefined && postgres !== null && postgres !== '') {
        if (typeof postgres !== 'string' || !/^postgres(ql)?:\/\/[^/]+/.test(postgres)) {
            problems.push('settings: "genesis_planning.postgres_url" must be a postgres:// address, or empty for none');
        } else if (postgres.includes(POSTGRES_PLACEHOLDER)) {
            problems.push(`settings: "genesis_planning.postgres_url" still holds a placeholder (${postgres})`);
        }
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
