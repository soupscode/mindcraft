// Step 11, the switch: the relay goes with planning, is started by the launcher inside the
// MindServer process, and can be switched off. With planning off (upstream's default)
// nothing of it is loaded.
// Run from the repository root:  node --test genesis/tests/*.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from './helpers/stubs.mjs';
import { bootstrappedWorld } from './helpers/bootstrapped.mjs';
import { genesisRelayOn, genesisRecoveryOn, genesisPlanningOn } from '../agent/hooks.js';
import { buildSettings } from '../lib/config.js';

const GENESIS = path.join(REPO_ROOT, 'genesis');
const PRELOAD = pathToFileURL(path.join(GENESIS, 'tests', 'helpers', 'preload-main-stubs.mjs')).href;
const PLANNING = { enabled: true, operators: ['Soup'], model: { url: 'http://192.0.2.10:11434', model: 'some-model:latest' } };

function launch(env) {
    const clean_env = { ...process.env };
    for (const key of ['SETTINGS_JSON', 'INSECURE_CODING', 'PROFILES', 'BLOCKED_ACTIONS', 'MINECRAFT_PORT', 'MINDSERVER_PORT', 'GENESIS_SETTINGS_FILE']) delete clean_env[key];
    const child = spawnSync(process.execPath, ['--import', PRELOAD, 'genesis/start.js'], { cwd: REPO_ROOT, env: { ...clean_env, ...env }, encoding: 'utf8', timeout: 30000 });
    const recorded = (tag) => child.stdout.split('\n').filter((line) => line.startsWith(`${tag} `)).map((line) => JSON.parse(line.slice(tag.length + 1)));
    return { status: child.status, stdout: child.stdout, stderr: child.stderr, extensions: recorded('GENESIS_TEST_SOCKET_EXTENSION'), agents: recorded('GENESIS_TEST_AGENT') };
}

test('the relay and recovery go with planning: on when it is, off when it is not, and each can be switched off alone', () => {
    const on = { genesis_planning: { enabled: true } };
    assert.deepEqual([genesisPlanningOn(on), genesisRelayOn(on), genesisRecoveryOn(on)], [true, true, true]);
    assert.deepEqual([genesisRelayOn({ ...on, genesis_relay: { enabled: false } }), genesisRecoveryOn({ ...on, genesis_relay: { enabled: false } })], [false, true]);
    assert.deepEqual([genesisRelayOn({ ...on, genesis_recovery: { enabled: false } }), genesisRecoveryOn({ ...on, genesis_recovery: { enabled: false } })], [true, false]);
    for (const off of [{}, { genesis_planning: { enabled: false } }, { genesis_relay: { enabled: true }, genesis_recovery: { enabled: true } }]) {
        assert.deepEqual([genesisRelayOn(off), genesisRecoveryOn(off)], [false, false]);
    }
    // whatever the settings say, the free-text conversation commands and model-written code stay off
    const built = buildSettings({ blocked_actions: [], allow_insecure_coding: true, genesis_relay: { enabled: true } });
    for (const action of ['!newAction', '!startConversation', '!endConversation']) assert.ok(built.blocked_actions.includes(action));
    assert.equal(built.allow_insecure_coding, false);
});

test('launcher: the relay is started with planning inside the MindServer process, every agent gets the setting, and a bad setting starts nothing', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'genesis-relay-'));
    const profiles = [];
    for (const name of ['arthur', 'mira', 'felix', 'nova']) {
        const text = readFileSync(path.join(GENESIS, 'profiles', `${name}.json`), 'utf8').replaceAll('DESKTOP_IP', '192.0.2.10').replaceAll('GENESIS_MODEL', 'some-model:latest');
        writeFileSync(path.join(dir, `${name}.json`), text);
        profiles.push(path.join(dir, `${name}.json`));
    }
    const settings_file = path.join(dir, 'settings.json');
    const shipped = JSON.parse(readFileSync(path.join(GENESIS, 'settings.json'), 'utf8'));
    assert.deepEqual(shipped.genesis_relay, { enabled: true, model_lines: true });
    writeFileSync(settings_file, JSON.stringify({ ...shipped, profiles }));
    const { world_file, manifest_file } = await bootstrappedWorld(dir);
    const planning = { ...PLANNING, world_file, manifest_file, checkpoint_dir: path.join(dir, 'checkpoints'), ledger_file: path.join(dir, 'ledger.json') };

    const on = launch({ GENESIS_SETTINGS_FILE: settings_file, SETTINGS_JSON: JSON.stringify({ genesis_planning: planning }) });
    assert.equal(on.status, 0, on.stderr);
    assert.equal(on.extensions.length, 1, 'the MindServer has one place for socket handlers: planning, recovery and the relay share it');
    assert.equal(on.agents.length, 4);
    for (const agent of on.agents) {
        assert.deepEqual(agent.genesis_relay, { enabled: true, model_lines: true });
        for (const action of ['!newAction', '!startConversation', '!endConversation']) assert.ok(agent.blocked_actions.includes(action));
    }

    const off = launch({ GENESIS_SETTINGS_FILE: settings_file, SETTINGS_JSON: JSON.stringify({ genesis_planning: planning, genesis_relay: { enabled: false } }) });
    assert.equal(off.status, 0, off.stderr);
    assert.equal(off.agents.length, 4);
    for (const agent of off.agents) assert.equal(genesisRelayOn(agent), false);

    const bad = launch({ GENESIS_SETTINGS_FILE: settings_file, SETTINGS_JSON: JSON.stringify({ genesis_planning: planning, genesis_relay: { limits: { max_turns: 'six' } } }) });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /"genesis_relay.limits.max_turns" must be a number/);
    assert.deepEqual(bad.agents, []);
});
