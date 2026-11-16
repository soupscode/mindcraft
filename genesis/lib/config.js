// Genesis: builds the settings override for upstream main.js and checks the profiles.
// Upstream main.js applies the SETTINGS_JSON environment variable last, on top of
// settings.js and every other environment override, so Genesis never edits settings.js.
// Depends only on Node built-ins.

import { readFileSync } from 'node:fs';
import path from 'node:path';

// Actions Genesis agents must never have, whatever the settings file says.
export const REQUIRED_BLOCKED_ACTIONS = ['!newAction', '!startConversation', '!endConversation'];

// Values that mean "not filled in yet".
export const PLACEHOLDERS = ['GENESIS_MODEL', 'DESKTOP_IP'];

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
    const blocked = Array.isArray(settings.blocked_actions) ? [...settings.blocked_actions] : [];
    for (const action of REQUIRED_BLOCKED_ACTIONS) {
        if (!blocked.includes(action)) blocked.push(action);
    }
    settings.blocked_actions = blocked;
    return settings;
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
