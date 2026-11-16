// Step 10, why an agent process ends: with the real src/agent/agent.js and the real
// src/agent/connection_handler.js. A Genesis agent whose connection to the Minecraft server
// is lost ends with an exit code that says why (server down, login refused), so the
// supervisor can wait for the server or tell the operator; with the genesis_planning setting
// off the code is 1, as upstream has it.
//
// Everything else agent.js imports is a stand-in, and so is process.exit.
// Run from the repository root:  node --test genesis/tests/*.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { stubModules, captureConsole } from './helpers/stubs.mjs';
import { EXIT_CODES } from '../recovery/exit_codes.js';

globalThis.genesis_test = { bots: [], output: [] };

stubModules({
    'src/agent/history.js': 'export class History { add() {} save() {} getHistory() { return []; } load() { return null; } }',
    'src/agent/coder.js': 'export class Coder {}',
    'src/agent/vision/vision_interpreter.js': 'export class VisionInterpreter {}',
    'src/models/prompter.js': 'export class Prompter { getName() { return "Felix"; } async initExamples() {} }',
    'src/agent/modes.js': 'export function initModes() {}',
    'src/utils/mcdata.js': `
        import { EventEmitter } from 'node:events';
        export function initBot(name) {
            const bot = new EventEmitter();
            Object.assign(bot, { username: name, chats: [], chat(text) { bot.chats.push(text); } });
            globalThis.genesis_test.bots.push(bot);
            return bot;
        }`,
    'src/agent/commands/index.js': `
        export const containsCommand = () => null; export const commandExists = () => false; export async function executeCommand() {}
        export const truncCommandMessage = (m) => m; export const isAction = () => false; export function blacklistCommands() {}`,
    'src/agent/action_manager.js': 'export class ActionManager {}',
    'src/agent/npc/controller.js': 'export class NPCContoller {}',
    'src/agent/memory_bank.js': 'export class MemoryBank {}',
    'src/agent/self_prompter.js': 'export class SelfPrompter {}',
    'src/agent/conversation.js': 'export default { initAgent() {}, isOtherAgent: () => false };',
    'src/utils/translator.js': 'export const handleTranslation = async (m) => m; export const handleEnglishTranslation = async (m) => m;',
    'src/agent/vision/browser_viewer.js': 'export function addBrowserViewer() {}',
    'src/agent/mindserver_proxy.js': `
        export const serverProxy = { login() {}, shutdown() {}, getNumOtherAgents: () => 3 };
        export function sendOutputToServer(name, message) { globalThis.genesis_test.output.push(message); }`,
    'src/agent/tasks/tasks.js': 'export class Task {}',
    'src/agent/speak.js': 'export function speak() {}',
});

const { Agent } = await import('../../src/agent/agent.js');
const { setSettings } = await import('../../src/agent/settings.js');
const hooks = await import('../agent/hooks.js');

const PLANNING = { enabled: true, operators: ['Soup'], world_file: './genesis/genesis.world.json', checkpoint_dir: '/checkpoints', model: { url: 'http://10.0.0.5:11434', model: 'planner' } };
const BASE = { blocked_actions: [], spawn_timeout: 30, only_chat_with: [], profile: {} };

// Starts a real Agent up to the point where it waits for the bot to spawn, lets `lose(bot)`
// end the connection, and returns the exit codes the process would have ended with.
async function exitCodeAfter(t, settings, lose) {
    t.mock.timers.enable({ apis: ['setTimeout'] }); // the spawn timeout never fires
    setSettings({ ...BASE, ...settings });
    const exits = [];
    const real_exit = process.exit;
    process.exit = (code) => { exits.push(code); };
    try {
        await captureConsole(async () => {
            const agent = new Agent();
            await agent.start(false, null, 0);
            lose(globalThis.genesis_test.bots.at(-1), agent);
        });
    } finally {
        process.exit = real_exit;
        t.mock.timers.reset();
    }
    return exits;
}

const WHITELIST = '{"translate":"multiplayer.disconnect.not_whitelisted","text":"You are not white-listed on this server!"}';
const refusedConnection = () => Object.assign(new Error('connect ECONNREFUSED 192.168.1.190:25600'), { code: 'ECONNREFUSED', syscall: 'connect' });

test('a Genesis agent that cannot reach the Minecraft server ends with the "server down" code', async (t) => {
    const on = { genesis_planning: PLANNING };
    assert.deepEqual(await exitCodeAfter(t, on, (bot) => bot.emit('error', refusedConnection())), [EXIT_CODES.SERVER_DOWN]);
    assert.deepEqual(await exitCodeAfter(t, on, (bot) => bot.emit('end', 'socketClosed')), [EXIT_CODES.SERVER_DOWN]);
    assert.deepEqual(await exitCodeAfter(t, on, (bot) => bot.emit('kicked', '{"text":"Server closed"}')), [EXIT_CODES.SERVER_DOWN]);
    assert.deepEqual(await exitCodeAfter(t, on, (bot) => bot.emit('kicked', '{"text":"The server is full!"}')), [EXIT_CODES.SERVER_DOWN]);
    // ended once, however many events the lost connection raises
    assert.deepEqual(await exitCodeAfter(t, on, (bot) => { bot.emit('kicked', '{"text":"Server closed"}'); bot.emit('end', 'socketClosed'); }), [EXIT_CODES.SERVER_DOWN]);
});

test('a bot that never spawns (the server\'s machine is unreachable) is "server down" for a Genesis agent, and 1 upstream', async (t) => {
    const waitedOut = async (settings) => exitCodeAfter(t, settings, () => { t.mock.timers.tick(31 * 1000); });
    assert.deepEqual(await waitedOut({ genesis_planning: PLANNING }), [EXIT_CODES.SERVER_DOWN]);
    assert.deepEqual(await waitedOut({}), [1]);
    assert.deepEqual(await waitedOut({ genesis_planning: PLANNING, genesis_recovery: { enabled: false } }), [1]);
});

test('a Genesis agent whose login is refused ends with the "login refused" code; anything else is a crash', async (t) => {
    const on = { genesis_planning: PLANNING };
    assert.deepEqual(await exitCodeAfter(t, on, (bot) => bot.emit('kicked', WHITELIST)), [EXIT_CODES.LOGIN_REFUSED]);
    assert.deepEqual(await exitCodeAfter(t, on, (bot) => bot.emit('kicked', '{"text":"You are banned from this server"}')), [EXIT_CODES.LOGIN_REFUSED]);
    assert.deepEqual(await exitCodeAfter(t, on, (bot) => bot.emit('kicked', '{"translate":"multiplayer.disconnect.duplicate_login"}')), [EXIT_CODES.LOGIN_REFUSED]);
    assert.deepEqual(await exitCodeAfter(t, on, (bot) => bot.emit('kicked', '{"text":"Kicked for flying"}')), [1]);
    assert.deepEqual(await exitCodeAfter(t, on, (bot) => bot.emit('kicked', '{"text":"Because."}')), [1]);
});

test('with planning off, or recovery switched off, every lost connection ends with 1, as upstream has it', async (t) => {
    for (const settings of [{}, { genesis_planning: { enabled: false } }, { genesis_planning: PLANNING, genesis_recovery: { enabled: false } }]) {
        assert.deepEqual(await exitCodeAfter(t, settings, (bot) => bot.emit('error', refusedConnection())), [1]);
        assert.deepEqual(await exitCodeAfter(t, settings, (bot) => bot.emit('kicked', WHITELIST)), [1]);
        assert.deepEqual(await exitCodeAfter(t, settings, (bot) => bot.emit('end', 'socketClosed')), [1]);
    }
});

test('cleanKill: the code it is given, except for a restart that was asked for by a Genesis agent\'s operator', async (t) => {
    const kill = async (settings, prepare, ...args) => exitCodeAfter(t, settings, (bot, agent) => { prepare(agent); agent.cleanKill(...args); });
    const on = { genesis_planning: PLANNING };
    assert.deepEqual(await kill(on, () => {}), [1]);
    assert.deepEqual(await kill(on, () => {}, 'Got stuck', 1), [1]);
    assert.deepEqual(await kill(on, (agent) => hooks.genesisIntendedRestart(agent)), [EXIT_CODES.INTENDED_RESTART]);
    assert.deepEqual(await kill({}, (agent) => hooks.genesisIntendedRestart(agent)), [1]);
    assert.deepEqual(await kill({}, () => {}, 'Not all required players/bots are present in the world. Exiting.', 4), [4]);
    // the last word in the game chat is upstream's
    assert.equal(globalThis.genesis_test.bots.at(-1).chats.at(-1), 'Restarting.');
});
