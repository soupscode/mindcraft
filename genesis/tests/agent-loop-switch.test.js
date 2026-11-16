// Step 7, the switch: with the genesis_planning setting on, Mindcraft's "ask the model
// after every action" loop is off for that agent. No model prompt per message, no
// self-prompter, no restart prompt; what the operator says still reaches the agent, and
// commands the operator types still run. With the setting off or absent, upstream behaves
// as it always did.
//
// Uses the real src/agent/agent.js, the real src/agent/self_prompter.js and the real
// genesis/agent/hooks.js. Everything agent.js imports besides those is a stand-in, and so
// is the runtime the hook builds (the real one needs a mineflayer bot).
// Run from the repository root:  node --test genesis/tests/*.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { stubModules, captureConsole } from './helpers/stubs.mjs';
import { fakeFiles, fakeClock } from './helpers/fakes.mjs';
import { createCheckpointStore } from '../store/checkpoint.js';

const seen = { prompts: [], commands: [], chat: [], built: [], history: [] };
globalThis.genesis_test = seen;

stubModules({
    'src/agent/history.js': `
        export class History {
            add(...entry) { globalThis.genesis_test.history.push(entry); }
            save() {} getHistory() { return []; } load() { return null; }
        }`,
    'src/agent/coder.js': 'export class Coder {}',
    'src/agent/vision/vision_interpreter.js': 'export class VisionInterpreter {}',
    'src/models/prompter.js': `
        export class Prompter {
            getName() { return 'Arthur'; }
            async promptConvo(history) { globalThis.genesis_test.prompts.push('convo'); return 'Sure.'; }
        }`,
    'src/agent/modes.js': 'export function initModes() {}',
    'src/utils/mcdata.js': 'export function initBot() { throw new Error("no bot in this test"); }',
    'src/agent/commands/index.js': `
        export const containsCommand = (message) => (String(message).startsWith('!') ? String(message).split(' ')[0] : null);
        export const commandExists = (name) => name === '!stop' || name === '!goal';
        export async function executeCommand(agent, message) {
            globalThis.genesis_test.commands.push(message);
            if (message.startsWith('!goal')) return agent.self_prompter.start(message.slice(6));
            return 'done';
        }
        export const truncCommandMessage = (message) => message;
        export const isAction = () => true;
        export function blacklistCommands() {}`,
    'src/agent/action_manager.js': 'export class ActionManager {}',
    'src/agent/npc/controller.js': 'export class NPCContoller {}',
    'src/agent/memory_bank.js': 'export class MemoryBank {}',
    'src/agent/conversation.js': `
        export default {
            isOtherAgent: (name) => name === 'Mira', otherAgentInGame: () => false, inConversation: () => false,
            responseScheduledFor: () => false, initAgent() {}, receiveFromBot() {}, endAllConversations() {}, sendToBot() {},
        };`,
    'src/utils/translator.js': 'export const handleTranslation = async (m) => m; export const handleEnglishTranslation = async (m) => m;',
    'src/agent/vision/browser_viewer.js': 'export function addBrowserViewer() {}',
    'src/agent/mindserver_proxy.js': `
        export const serverProxy = { getNumOtherAgents: () => 3, login() {}, shutdown() {} };
        export function sendOutputToServer(name, message) { globalThis.genesis_test.chat.push(message); }`,
    'src/agent/tasks/tasks.js': 'export class Task {}',
    'src/agent/speak.js': 'export function speak() {}',
    'src/agent/connection_handler.js': 'export const log = () => {}; export const validateNameFormat = () => ({ success: true }); export const handleDisconnection = () => ({});',
    // what genesis/agent/hooks.js loads when planning is on: the real one needs mineflayer
    'genesis/adapters/bot_agent.js': 'export async function buildBotRuntime(agent, settings) { return globalThis.genesis_test.build(agent, settings); }',
});

const { Agent } = await import('../../src/agent/agent.js');
const { SelfPrompter } = await import('../../src/agent/self_prompter.js');
const { Prompter } = await import('../../src/models/prompter.js');
const { History } = await import('../../src/agent/history.js');
const { setSettings } = await import('../../src/agent/settings.js');
const hooks = await import('../agent/hooks.js');

const BASE = { only_chat_with: [], max_commands: -1, chat_ingame: false, speak: false, show_command_syntax: 'full', narrate_behavior: false };
const PLANNING = { enabled: true, world_file: './genesis/genesis.world.json', checkpoint_dir: '/checkpoints', model: { url: 'http://10.0.0.5:11434', model: 'planner' } };

// A stand-in for the Genesis runtime of one agent: it only records what reaches it.
function fakeRuntime() {
    const runtime = {
        started: 0, running: 0, operator: [], requests: [], ignored: 0,
        async start() { runtime.started++; return { resumed: true, load: { status: 'ok' } }; },
        async run() { runtime.running++; },
        operatorMessage(from, text) { runtime.operator.push([from, text]); return true; },
        agentRequest(from, text) { runtime.requests.push([from, text]); return true; },
        ignoredMessage() { runtime.ignored++; },
    };
    return runtime;
}

function makeAgent() {
    const agent = new Agent();
    agent.name = 'Arthur';
    agent.prompter = new Prompter();
    agent.history = new History();
    agent.self_prompter = new SelfPrompter(agent);
    agent.task = { data: null };
    agent.actions = { stop: async () => {} };
    agent.isIdle = () => true;
    agent.bot = {
        handlers: {}, autoEat: {}, modes: { flushBehaviorLog: () => '' },
        on(name, fn) { this.handlers[name] = fn; }, chat() {}, whisper() {},
    };
    return agent;
}

function reset(settings) {
    for (const list of Object.values(seen)) if (Array.isArray(list)) list.length = 0;
    setSettings(settings);
}

const quietly = async (fn) => (await captureConsole(fn)).result;

test('setting off or absent (upstream default): every message prompts the model, and a restart prompts it too', async () => {
    for (const settings of [{ ...BASE }, { ...BASE, genesis_planning: { enabled: false } }]) {
        reset(settings);
        const agent = makeAgent();
        seen.build = () => { throw new Error('the Genesis runtime was built with planning off'); };
        await quietly(() => agent.handleMessage('Soup', 'hello Arthur'));
        assert.deepEqual(seen.prompts, ['convo']);
        // the restart prompt goes to the model, as upstream does it
        await quietly(() => agent._setupEventHandlers(null, 'Agent process restarted.'));
        assert.deepEqual(seen.prompts, ['convo', 'convo']);
        assert.equal(hooks.genesisRuntimeOf(agent), null);
        assert.equal(agent.self_prompter.start, SelfPrompter.prototype.start, 'upstream\'s self-prompter was changed');
        assert.equal(agent.self_prompter.handleLoad, SelfPrompter.prototype.handleLoad);
    }
});

test('setting on: start-up builds the Genesis runtime, and no restart prompt or saved self-prompter reaches the model', async () => {
    reset({ ...BASE, genesis_planning: PLANNING });
    const agent = makeAgent();
    const runtime = fakeRuntime();
    seen.build = (built_for, settings) => { seen.built.push([built_for.name, settings.genesis_planning.enabled]); return runtime; };
    // a restart, with a self-prompt that was running and a conversation partner saved
    const save_data = { self_prompt: 'build a great hall', self_prompting_state: 1, last_sender: 'Mira' };
    await quietly(() => agent._setupEventHandlers(save_data, 'Agent process restarted.'));

    assert.deepEqual(seen.built, [['Arthur', true]]);
    assert.equal(runtime.started, 1);
    assert.equal(runtime.running, 1);
    assert.equal(hooks.genesisRuntimeOf(agent), runtime);
    assert.deepEqual(seen.prompts, [], 'the restart prompted the model');
    assert.equal(agent.self_prompter.isActive(), false, 'the saved self-prompter was started');
    assert.deepEqual(seen.chat, [], 'the agent greeted or answered in chat');
    assert.deepEqual(seen.history, []);
    // the chat handlers are still there: that is how the operator reaches the agent
    assert.equal(typeof agent.bot.handlers.whisper, 'function');
    assert.equal(typeof agent.respondFunc, 'function');

    // what the operator says (the panel sends it through respondFunc) reaches the runtime, with no prompt
    await quietly(() => agent.respondFunc('Soup', 'Arthur, please bring wood to the camp'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(runtime.operator, [['Soup', 'Arthur, please bring wood to the camp']]);
    assert.equal(await quietly(() => agent.handleMessage('Soup', 'and hurry')), false);
    assert.equal(runtime.operator.length, 2);
    // a command the operator types still runs, without the model
    assert.equal(await quietly(() => agent.handleMessage('Soup', '!stop')), true);
    assert.deepEqual(seen.commands, ['!stop']);
    // another agent's message is a request, not a prompt
    await quietly(() => agent.handleMessage('Mira', 'can you spare a hoe?'));
    assert.deepEqual(runtime.requests, [['Mira', 'can you spare a hoe?']]);
    // upstream's own notes to the model go nowhere: the restart note, a death, an interrupted action
    for (const note of ['Agent process restarted.', 'You died at position x: 1.00, y: 64.00, z: 2.00', '(AUTO MESSAGE)Your previous action was interrupted by self_defense.']) {
        assert.equal(await quietly(() => agent.handleMessage('system', note)), false);
    }
    assert.equal(runtime.ignored, 3);
    // the self-prompter cannot be started, not even by the operator's !goal
    await quietly(() => agent.handleMessage('Soup', '!goal build a tower'));
    assert.equal(agent.self_prompter.isActive(), false);
    assert.match(seen.chat.at(-1), /Self-prompting is off/);
    agent.self_prompter.update(5000);

    assert.deepEqual(seen.prompts, [], 'something prompted the model');
    assert.deepEqual(seen.history, [], 'messages were added to the model\'s chat history');
});

test('setting on: an agent whose runtime cannot be built stops, it never falls back to prompting the model', async () => {
    reset({ ...BASE, genesis_planning: PLANNING });
    const agent = makeAgent();
    const exits = [];
    seen.build = () => { throw new Error('genesis.world.json: the world config file does not exist'); };
    const { result, lines } = await captureConsole(() => hooks.startGenesisAgent(agent, { genesis_planning: PLANNING }, { exit: (code) => exits.push(code) }));
    assert.equal(result, true, 'upstream would carry on with its own start-up');
    assert.deepEqual(exits, [1]);
    assert.match(lines.join('\n'), /could not start/);
    assert.deepEqual(seen.prompts, []);
    // a message that arrives before the runtime exists is not prompted either
    assert.equal(await quietly(() => agent.handleMessage('Soup', 'hello?')), false);
    assert.deepEqual(seen.prompts, []);
});

test('the event seq goes on from the checkpoint: genesisLastSeq reads it, and is 0 whenever it cannot', async () => {
    const files = fakeFiles();
    const store = createCheckpointStore({ files, dir: '/checkpoints', clock: fakeClock() });
    const checkpoint = {
        v: 1, agent: 'Arthur', seq: 4321, saved_at: '2026-01-01T00:00:00.000Z', plan: null, routine: null,
        position: { x: 0, y: 64, z: 0, dimension: 'overworld' }, places: {}, pending_request: null, budgets: {},
    };
    assert.equal((await store.write(checkpoint)).ok, true);
    assert.equal(await hooks.genesisLastSeq('Arthur', { genesis_planning: PLANNING }, { store }), 4321);
    assert.equal(await hooks.genesisLastSeq('Mira', { genesis_planning: PLANNING }, { store }), 0, 'no checkpoint yet');
    assert.equal(await hooks.genesisLastSeq('Arthur', { genesis_planning: { enabled: false } }, { store }), 0, 'planning off');
    assert.equal(await hooks.genesisLastSeq('Arthur', {}, { store }), 0);
    files.store.set('/checkpoints/Arthur.checkpoint.json', '{"sha256":"0","checkpoint":{}}');
    assert.equal(await hooks.genesisLastSeq('Arthur', { genesis_planning: PLANNING }, { store }), 0, 'a damaged checkpoint');
    assert.equal(await hooks.genesisLastSeq('Arthur', { genesis_planning: PLANNING }, { store: { load: async () => { throw new Error('disk gone'); } } }), 0);
    assert.equal(hooks.genesisPlanningOn({ genesis_planning: { enabled: 'yes' } }), false, 'only true switches planning on');
});
