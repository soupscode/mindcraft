// Step 10, the places where upstream hands over to recovery, with the real upstream files:
//   src/agent/modes.js             upstream's own stuck detection no longer kills a Genesis agent
//   src/agent/commands/actions.js  no restart after smelting; the operator's !restart is not a crash
//   src/process/agent_process.js   the supervisor decides what happens when a process ends
//   genesis/adapters               the ladder's moves on a (stand-in) bot; the smelting step ends no process
// and the launcher, which puts the supervisor in place. With the genesis_planning setting off
// (upstream's default) every one of these files behaves as upstream wrote it.
//
// mineflayer, the skills and child_process are stand-ins. Nothing connects anywhere.
// Run from the repository root:  node --test genesis/tests/*.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { stubModules, captureConsole, REPO_ROOT } from './helpers/stubs.mjs';
import { settle } from './helpers/fakes.mjs';
import { bootstrappedWorld } from './helpers/bootstrapped.mjs';
import { EXIT_CODES } from '../recovery/exit_codes.js';

const seen = { skills: [], spawned: [], logouts: [], move_ok: true, home_ok: true };
globalThis.genesis_test = seen;

stubModules({
    'src/agent/library/skills.js': `
        const seen = globalThis.genesis_test;
        export async function moveAway(bot, distance) { seen.skills.push(['moveAway', distance]); return seen.move_ok; }
        export async function smeltItem(bot, item, num) { seen.skills.push(['smeltItem', item, num]); return true; }
        export async function goToPosition(bot, x, y, z, near) { seen.skills.push(['goToPosition', x, y, z, near]); return seen.home_ok; }
        export async function goToSurface(bot) { seen.skills.push(['goToSurface']); return true; }
        export function log() {}`,
    'src/agent/library/world.js': 'export function getNearestEntityWhere() { return null; }',
    'src/utils/mcdata.js': 'export function isHostile() { return false; }',
    'src/agent/conversation.js': 'export default { inConversation: () => false };',
    'child_process': `
        import { EventEmitter } from 'node:events';
        export function spawn(command, args, options) {
            const child = new EventEmitter();
            Object.assign(child, { command, args, options, killed: false, signals: [], kill(signal) { child.signals.push(signal); } });
            globalThis.genesis_test.spawned.push(child);
            return child;
        }`,
    'src/mindcraft/mindserver.js': 'export function logoutAgent(name) { globalThis.genesis_test.logouts.push(name); }',
});

const { setSettings } = await import('../../src/agent/settings.js');
const settings = (await import('../../src/agent/settings.js')).default;
const { initModes } = await import('../../src/agent/modes.js');
const { actionsList } = await import('../../src/agent/commands/actions.js');
const { AgentProcess, setRestartSupervisor } = await import('../../src/process/agent_process.js');
const hooks = await import('../agent/hooks.js');
const skills = await import('../../src/agent/library/skills.js');
const { createBotRecovery } = await import('../adapters/bot_recovery.js');
const { createBotOps } = await import('../adapters/bot_ops.js');

const PLANNING = { enabled: true, operators: ['Soup'], world_file: './genesis/genesis.world.json', checkpoint_dir: '/checkpoints', model: { url: 'http://10.0.0.5:11434', model: 'planner' } };
const quietly = async (fn) => (await captureConsole(fn)).result;

// A stand-in for upstream's Agent, as far as the modes, the commands and the adapters reach into it.
function standInAgent() {
    const spot = { distanceTo: () => 0, clone() { return spot; } };
    const agent = {
        name: 'Arthur', kills: [], ran: [], stopped: 0, idle: false, shut_up: false,
        bot: { entity: { position: spot }, targetDigBlock: null },
        prompter: { getInitModes: () => null },
        self_prompter: { isActive: () => false, stopLoop() {}, start() {}, handleLoad: async () => {} },
        actions: {
            currentActionLabel: 'action:genesis_goToPosition', resume_func: null,
            async runAction(label, fn) { agent.ran.push(label); const returned = await fn(); return { ok: returned !== false, interrupted: false, timedout: false, output: '', message: '' }; },
            async stop() { agent.stopped++; },
        },
        isIdle: () => agent.idle,
        openChat() {}, handleMessage() {},
        cleanKill(msg = 'Killing agent process...', code = 1) { agent.kills.push({ msg, code: hooks.genesisExitCode(agent, settings, code) }); },
    };
    return agent;
}

// Lets the unstuck mode of the real modes.js see the agent stand still for `seconds`.
// (the mode measures with Date.now(): the clock of this file only ever jumps forward)
const real_now = Date.now;
let clock_ahead = 0;
Date.now = () => real_now() + clock_ahead;
async function standStill(agent, seconds) {
    await agent.bot.modes.update(); // takes the place the agent stands at
    clock_ahead += seconds * 1000;
    await agent.bot.modes.update();
    await settle();
}

function onlyUnstuck(agent) {
    initModes(agent);
    for (const name of Object.keys(agent.bot.modes.getJson())) agent.bot.modes.setOn(name, name === 'unstuck');
    agent.bot.modes.unPauseAll();
}

test('modes.js: with planning on, upstream\'s stuck detection tells the watchdog and neither moves the bot nor arms the kill', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const agent = standInAgent();
    const stuck = [];
    setSettings({ genesis_planning: PLANNING, narrate_behavior: false });
    await quietly(() => hooks.startGenesisAgent(agent, settings, {
        addCommand: () => {},
        build: async () => ({ async start() { return {}; }, async run() {}, stuck: (reason) => { stuck.push(reason); return true; } }),
    }));
    onlyUnstuck(agent);
    seen.skills.length = 0;
    await quietly(() => standStill(agent, 25));
    assert.deepEqual(stuck, ['upstream_unstuck']);
    assert.deepEqual(agent.ran, [], 'upstream ran its own unstuck action');
    assert.deepEqual(seen.skills, []);
    t.mock.timers.tick(60 * 1000);
    assert.deepEqual(agent.kills, [], 'the process was killed for being stuck');
    // told once per stuck period, not on every update
    await quietly(() => agent.bot.modes.update());
    assert.equal(stuck.length, 1);
});

test('modes.js: with planning off, or recovery switched off, upstream\'s stuck detection is as upstream wrote it', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    for (const given of [{}, { genesis_planning: { enabled: false } }, { genesis_planning: PLANNING, genesis_recovery: { enabled: false } }]) {
        const agent = standInAgent();
        setSettings({ narrate_behavior: false, ...given });
        onlyUnstuck(agent);
        seen.skills.length = 0;
        seen.move_ok = true;
        await quietly(() => standStill(agent, 25));
        assert.deepEqual(agent.ran, ['mode:unstuck'], JSON.stringify(given));
        assert.deepEqual(seen.skills, [['moveAway', 5]]);
        t.mock.timers.tick(60 * 1000);
        assert.deepEqual(agent.kills, [], 'the kill timer was not cleared after the move');
        assert.equal(hooks.genesisStuck(agent, settings), false);
    }
});

test('actions.js: smelting restarts the process upstream, and does not for a Genesis agent', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const smelt = actionsList.find((action) => action.name === '!smeltItem');

    setSettings({ genesis_planning: PLANNING });
    const genesis = standInAgent();
    seen.skills.length = 0;
    await smelt.perform(genesis, 'raw_iron', 3);
    t.mock.timers.tick(10 * 1000);
    assert.deepEqual(seen.skills, [['smeltItem', 'raw_iron', 3]]);
    assert.deepEqual(genesis.kills, [], 'a Genesis agent restarted after smelting');

    for (const given of [{}, { genesis_planning: { enabled: false } }]) {
        setSettings(given);
        const upstream = standInAgent();
        await smelt.perform(upstream, 'raw_iron', 3);
        assert.deepEqual(upstream.kills, []);
        t.mock.timers.tick(600);
        assert.deepEqual(upstream.kills, [{ msg: 'Safely restarting to update inventory.', code: 1 }]);
    }
});

test('actions.js and the exit code: a restart the operator asks for ends with its own code, and only for a Genesis agent', async () => {
    const restart = actionsList.find((action) => action.name === '!restart');
    setSettings({ genesis_planning: PLANNING });
    const genesis = standInAgent();
    await restart.perform(genesis);
    assert.deepEqual(genesis.kills, [{ msg: 'Killing agent process...', code: EXIT_CODES.INTENDED_RESTART }]);
    // any other end of the same kind of agent is not "intended"
    const crashed = standInAgent();
    crashed.cleanKill('Code execution refused stop after 10 seconds. Killing process.');
    assert.equal(crashed.kills[0].code, 1);

    for (const given of [{}, { genesis_planning: PLANNING, genesis_recovery: { enabled: false } }]) {
        setSettings(given);
        const upstream = standInAgent();
        await restart.perform(upstream);
        assert.deepEqual(upstream.kills, [{ msg: 'Killing agent process...', code: 1 }]);
    }
    // the exit code of a lost connection: only with recovery on
    setSettings({ genesis_planning: PLANNING });
    assert.deepEqual(['network_error', 'access_denied', 'behavior'].map((type) => hooks.genesisDisconnectCode(settings, type, 1)), [65, 66, 1]);
    setSettings({});
    assert.deepEqual(['network_error', 'access_denied', 'behavior'].map((type) => hooks.genesisDisconnectCode(settings, type, 1)), [1, 1, 1]);
});

test('agent_process.js: with a supervisor set it decides about every exit; without one upstream\'s own rule runs', async () => {
    const calls = [];
    const supervisor = {
        exited: (name, info, restart) => { calls.push({ name, ...info, restart }); return { action: 'restart' }; },
        stopRequested: (name) => { calls.push({ stop: name }); },
    };
    const exits = [];
    const real_exit = process.exit;
    process.exit = (code) => { exits.push(code); };
    try {
        setRestartSupervisor(supervisor);
        seen.spawned.length = 0;
        const felix = new AgentProcess('Felix', 8081);
        await quietly(async () => {
            felix.start(true, null, 2);
            assert.equal(seen.spawned.length, 1);
            // the Minecraft server is down: a code above 1 would end the whole program upstream ("Ending task")
            seen.spawned[0].emit('exit', EXIT_CODES.SERVER_DOWN, null);
        });
        assert.deepEqual(exits, [], 'the whole program was ended');
        assert.deepEqual(calls.map((call) => [call.name, call.code, call.signal]), [['Felix', 65, null]]);
        assert.equal(seen.spawned.length, 1, 'upstream restarted the process by its own rule as well');
        // the supervisor's restart starts the same agent again, with its memory and the restart note
        await quietly(async () => calls[0].restart());
        assert.equal(seen.spawned.length, 2);
        const args = seen.spawned[1].args.map(String);
        assert.ok(args.includes('Felix') && args.includes('Agent process restarted.') && args.includes('8081'), args.join(' '));
        assert.equal(args[args.indexOf('-c') + 1], '2');
        // a stop tells the supervisor, so a restart that waits is called off
        felix.stop();
        assert.deepEqual(calls.at(-1), { stop: 'Felix' });
        assert.deepEqual(seen.spawned[1].signals, ['SIGINT']);

        // ---- no supervisor (upstream's default) ----
        setRestartSupervisor(null);
        const mira = new AgentProcess('Mira', 8081);
        const before = calls.length;
        await quietly(async () => {
            mira.start(false, null, 0);
            seen.spawned.at(-1).emit('exit', 4, null);
        });
        assert.deepEqual(exits, [4], 'upstream ends the program for a code above 1');
        assert.equal(calls.length, before);
    } finally {
        process.exit = real_exit;
        setRestartSupervisor(null);
    }
});

test('adapters: the ladder\'s moves go through the action manager, and a smelting step ends no process', async () => {
    const agent = standInAgent();
    const recovery = createBotRecovery(agent, { skills });
    seen.skills.length = 0;

    // an agent that runs something is stopped; an idle one has nothing to stop
    assert.equal(await recovery.interrupt(), true);
    agent.idle = true;
    assert.equal(await recovery.interrupt(), false);
    assert.equal(agent.stopped, 1);

    seen.move_ok = true;
    assert.equal(await recovery.moveAway(5), true);
    seen.move_ok = false; // shut in: upstream's moveAway finds no way and says so
    assert.equal(await recovery.moveAway(5), false);
    seen.home_ok = true;
    assert.equal(await recovery.surfaceOrHome({ x: 0, y: 64, z: 0 }), true);
    seen.home_ok = false; // no way home: the surface is tried
    assert.equal(await recovery.surfaceOrHome({ x: 0, y: 64, z: 0 }), true);
    assert.deepEqual(seen.skills, [['moveAway', 5], ['moveAway', 5], ['goToPosition', 0, 64, 0, 2], ['goToPosition', 0, 64, 0, 2], ['goToSurface']]);
    assert.deepEqual(agent.ran, ['recovery:move_away', 'recovery:move_away', 'recovery:surface_or_home', 'recovery:surface_or_home']);
    seen.move_ok = true;
    seen.home_ok = true;

    // rung 5 ends the process the way upstream does: a crash, for the supervisor to count
    setSettings({ genesis_planning: PLANNING });
    await recovery.restartProcess('the watchdog found no progress');
    assert.equal(agent.kills.length, 1);
    assert.equal(agent.kills[0].code, 1);
    assert.match(agent.kills[0].msg, /^Genesis watchdog: the watchdog found no progress/);

    // the executor's smelting step calls the skill itself: nothing restarts afterwards
    const smelter = standInAgent();
    smelter.idle = true;
    const ops = createBotOps(smelter, { skills, sleep: async () => {} });
    seen.skills.length = 0;
    const result = await ops.run('smeltItem', ['raw_iron', 4], {});
    assert.equal(result.ok, true);
    assert.deepEqual(seen.skills, [['smeltItem', 'raw_iron', 4]]);
    await settle();
    assert.deepEqual(smelter.kills, [], 'the smelting step ended the process');
});

// ---- the launcher ----

const GENESIS = path.join(REPO_ROOT, 'genesis');
const PRELOAD = pathToFileURL(path.join(GENESIS, 'tests', 'helpers', 'preload-main-stubs.mjs')).href;

function launch(env) {
    const clean_env = { ...process.env };
    for (const key of ['SETTINGS_JSON', 'INSECURE_CODING', 'PROFILES', 'BLOCKED_ACTIONS', 'MINECRAFT_PORT', 'MINDSERVER_PORT', 'GENESIS_SETTINGS_FILE']) delete clean_env[key];
    const child = spawnSync(process.execPath, ['--import', PRELOAD, 'genesis/start.js'], { cwd: REPO_ROOT, env: { ...clean_env, ...env }, encoding: 'utf8', timeout: 30000 });
    const recorded = (tag) => child.stdout.split('\n').filter((line) => line.startsWith(`${tag} `)).map((line) => JSON.parse(line.slice(tag.length + 1)));
    return { status: child.status, stdout: child.stdout, stderr: child.stderr, supervisors: recorded('GENESIS_TEST_RESTART_SUPERVISOR'), agents: recorded('GENESIS_TEST_AGENT') };
}

test('launcher: the supervisor is put in place with planning, before any agent is created, and not when recovery is switched off', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'genesis-recovery-'));
    const profiles = [];
    for (const name of ['arthur', 'mira', 'felix', 'nova']) {
        const text = readFileSync(path.join(GENESIS, 'profiles', `${name}.json`), 'utf8').replaceAll('DESKTOP_IP', '192.0.2.10').replaceAll('GENESIS_MODEL', 'some-model:latest');
        writeFileSync(path.join(dir, `${name}.json`), text);
        profiles.push(path.join(dir, `${name}.json`));
    }
    const settings_file = path.join(dir, 'settings.json');
    const shipped = JSON.parse(readFileSync(path.join(GENESIS, 'settings.json'), 'utf8'));
    assert.deepEqual(shipped.genesis_recovery, { enabled: true });
    writeFileSync(settings_file, JSON.stringify({ ...shipped, profiles }));
    const { world_file, manifest_file } = await bootstrappedWorld(dir);
    const planning = { ...PLANNING, world_file, manifest_file, checkpoint_dir: path.join(dir, 'checkpoints'), ledger_file: path.join(dir, 'ledger.json'), model: { url: 'http://192.0.2.10:11434', model: 'some-model:latest' } };

    const off = launch({ GENESIS_SETTINGS_FILE: settings_file });
    assert.equal(off.status, 0, off.stderr);
    assert.deepEqual(off.supervisors, [], 'planning is off: upstream restarts agents by its own rule');

    const on = launch({ GENESIS_SETTINGS_FILE: settings_file, SETTINGS_JSON: JSON.stringify({ genesis_planning: planning }) });
    assert.equal(on.status, 0, on.stderr);
    assert.deepEqual(on.supervisors, [{ exited: true }]);
    assert.ok(on.stdout.indexOf('GENESIS_TEST_RESTART_SUPERVISOR') < on.stdout.indexOf('GENESIS_TEST_AGENT'));
    assert.equal(on.agents.length, 4);
    for (const agent of on.agents) assert.deepEqual(agent.genesis_recovery, { enabled: true });

    const without = launch({ GENESIS_SETTINGS_FILE: settings_file, SETTINGS_JSON: JSON.stringify({ genesis_planning: planning, genesis_recovery: { enabled: false } }) });
    assert.equal(without.status, 0, without.stderr);
    assert.deepEqual(without.supervisors, []);
    assert.equal(without.agents.length, 4);

    const bad = launch({ GENESIS_SETTINGS_FILE: settings_file, SETTINGS_JSON: JSON.stringify({ genesis_planning: planning, genesis_recovery: { watchdog: { interval_ms: 'fast' } } }) });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /"genesis_recovery.watchdog.interval_ms" must be a number/);
    assert.deepEqual(bad.agents, []);
});
