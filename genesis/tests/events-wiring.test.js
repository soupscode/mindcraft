// Step 4, end to end inside one process: the real action path (ActionManager and the
// command definitions), the real agent-side connection (src/agent/mindserver_proxy.js),
// the real MindServer (src/mindcraft/mindserver.js) and the real event hub, down to a
// fake Redis.
//
// Replaced by stand-ins: socket.io and socket.io-client (a pair of in-process sockets that
// call each other's handlers), express, the skills (mineflayer code) and Redis.
// Run from the repository root:  node --test genesis/tests/*.test.js

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { stubModules, captureConsole, modelFailureLines } from './helpers/stubs.mjs';
import { fakeClock, fakeRedis, settle } from './helpers/fakes.mjs';
import { validateEvent } from '../shared/events.js';
import { createEmitter } from '../events/agent_emit.js';
import { startEventPublishing } from '../events/server.js';
import { ModelUnavailableError, logModelFailure } from '../lib/model_errors.js';

// ---- a pair of connected in-process sockets ----
function socketPair() {
    const make = () => {
        const handlers = new Map();
        const socket = {
            connected: true,
            peer: null,
            on(name, fn) {
                if (!handlers.has(name)) handlers.set(name, []);
                handlers.get(name).push(fn);
                return socket;
            },
            fire(name, ...args) { for (const fn of handlers.get(name) ?? []) fn(...args); },
            emit(name, ...args) { socket.peer.fire(name, ...args); return true; },
        };
        return socket;
    };
    const client = make();
    const server = make();
    client.peer = server;
    server.peer = client;
    return { client, server };
}

const harness = {
    io: null, // the MindServer's socket.io server stand-in
    // what socket.io-client's io(url) does here: connect a new pair to the MindServer
    connect() {
        const { client, server } = socketPair();
        harness.io.handlers.connection(server);
        queueMicrotask(() => client.fire('connect'));
        return client;
    },
};
globalThis.genesis_test = harness;

stubModules({
    'express': `
        export default function express() {
            const app = (req, res) => { res.statusCode = 200; res.end('mindserver stand-in'); };
            app.use = () => {};
            app.get = () => {};
            return app;
        }
        express.static = () => () => {};`,
    'socket.io': `
        export class Server {
            constructor() { this.handlers = {}; globalThis.genesis_test.io = this; }
            on(name, fn) { this.handlers[name] = fn; }
            emit() {}
        }`,
    'socket.io-client': 'export function io(url) { return globalThis.genesis_test.connect(url); }',
    'open': 'export default function open() { throw new Error("the browser must not be opened in a test"); }',
    'src/process/agent_process.js': 'export class AgentProcess {}',
    'src/mindcraft/mcserver.js': 'export async function getServer() { throw new Error("not used"); }',
    'src/agent/library/full_state.js': 'export function getFullState() { return {}; }',
    'src/agent/conversation.js': `
        export default { inConversation: () => false, isOtherAgent: () => false, receiveFromBot() {}, updateAgents() {} };`,
    'src/agent/library/skills.js': `
        export function log(bot, message) { bot.output += message + '\\n'; }
        export async function collectBlock(bot, type, num) { log(bot, 'Could not find any ' + type + ' to collect.'); return false; }
        export async function craftRecipe(bot, name, num) { log(bot, 'Successfully crafted ' + name + '.'); return true; }
        export async function goToBed(bot) { throw new Error('pathfinder exploded'); }`,
});

const { createMindServer, registerAgent, setEventSink } = await import('../../src/mindcraft/mindserver.js');
const { serverProxy } = await import('../../src/agent/mindserver_proxy.js');
const { actionsList } = await import('../../src/agent/commands/actions.js');
const { ActionManager } = await import('../../src/agent/action_manager.js');

const LIMIT = { timeout: 20000 };
let mindserver;
after(() => { mindserver?.closeAllConnections(); mindserver?.close(); });

const EVENT_SETTINGS = { enabled: true, redis_url: 'redis://unused:6379', stream: 'genesis:events', stream_maxlen: 1000, buffer_size: 6 };
const redis = fakeRedis();
const clock = fakeClock();
let hub;

function makeAgent(name) {
    const agent = {
        name,
        bot: { output: '', interrupt_code: false, entity: { position: { x: 0, y: 64, z: 0 } }, emit() {} },
        memory_bank: { recallPlace: () => null },
        self_prompter: { isActive: () => false },
        history: { add() {} },
        isIdle() { return !this.actions.executing; },
        clearBotLogs() { this.bot.output = ''; this.bot.interrupt_code = false; },
        requestInterrupt() { this.bot.interrupt_code = true; },
        cleanKill() { throw new Error('cleanKill called'); },
    };
    agent.actions = new ActionManager(agent);
    return agent;
}

async function perform(agent, name, ...args) {
    const command = actionsList.find((a) => a.name === name);
    const { result } = await captureConsole(() => command.perform(agent, ...args));
    await new Promise((resolve) => setTimeout(resolve, 30)); // upstream counts quicker repeats as a runaway loop
    return result;
}

let arthur;

test('set-up: MindServer, one agent process connection, events on', LIMIT, async () => {
    await captureConsole(async () => {
        mindserver = createMindServer(false, 0);
        await once(mindserver, 'listening');
        registerAgent({ profile: { name: 'Arthur' }, genesis_events: EVENT_SETTINGS }, 3000);
        registerAgent({ profile: { name: 'Mira' }, genesis_events: EVENT_SETTINGS }, 3001);
        await serverProxy.connect('Arthur', mindserver.address().port);
    });
    arthur = makeAgent('Arthur');
    serverProxy.setAgent(arthur);
});

test('upstream default: with no event sink the MindServer ignores events, and the agent is unharmed', LIMIT, async () => {
    const text = await perform(arthur, '!craftRecipe', 'stick', 1);
    assert.equal(text, 'Action output:\nSuccessfully crafted stick.\n');
    assert.equal(redis.calls, 0);
});

test('a failed skill yields skill.started, then skill.result with ok false', LIMIT, async () => {
    hub = await startEventPublishing(EVENT_SETTINGS, { setEventSink, createClient: async () => redis, timers: clock, warn: () => {} });
    const text = await perform(arthur, '!collectBlocks', 'oak_log', 3);
    assert.match(text, /Action did not succeed\./);
    await hub.drain();

    const [started, result] = redis.events();
    assert.equal(redis.events().length, 2);
    for (const event of [started, result]) {
        assert.deepEqual(validateEvent(event), { ok: true, errors: [] });
        assert.equal(event.agent, 'Arthur');
        assert.equal(event.corr, null);
    }
    assert.equal(started.type, 'skill.started');
    assert.deepEqual(started.data, { skill: 'action:collectBlocks', args: ['oak_log', 3] });
    assert.equal(started.severity, 'info');
    assert.equal(result.type, 'skill.result');
    assert.equal(result.data.skill, 'action:collectBlocks');
    assert.equal(result.data.ok, false);
    assert.equal(result.data.interrupted, false);
    assert.equal(result.data.timedout, false);
    assert.match(result.data.output, /Could not find any oak_log to collect\./);
    assert.ok(result.data.duration_ms >= 0);
    assert.equal(result.severity, 'warn');
    assert.equal(result.seq, started.seq + 1);
});

test('a skill that succeeds yields ok true, one that throws yields ok false with the error', LIMIT, async () => {
    const before = redis.events().length;
    await perform(arthur, '!craftRecipe', 'stick', 1);
    await perform(arthur, '!goToBed');
    await hub.drain();
    const events = redis.events().slice(before);
    assert.deepEqual(events.map((e) => e.type), ['skill.started', 'skill.result', 'skill.started', 'skill.result']);
    assert.equal(events[1].data.ok, true);
    assert.equal(events[1].severity, 'info');
    assert.equal(events[1].data.output, 'Action output:\nSuccessfully crafted stick.\n');
    assert.equal(events[3].data.ok, false);
    assert.match(events[3].data.output, /pathfinder exploded/);
    // seq increases by one over everything this agent has emitted (the first two went nowhere: no sink yet)
    assert.deepEqual(redis.events().map((e) => e.seq), [3, 4, 5, 6, 7, 8]);
});

test('a model failure yields one agent.failure next to the one log line', LIMIT, async () => {
    const before = redis.events().length;
    const error = new ModelUnavailableError('Ollama request failed: fetch failed (ECONNREFUSED)',
        { provider: 'ollama', model: 'test-model', url: 'http://192.0.2.10:11434/api/chat', timeout_ms: 90000, elapsed_ms: 12 });
    const { lines } = await captureConsole(() => logModelFailure(error, { agent: 'Arthur', call: 'conversation' }));
    await hub.drain();
    assert.equal(modelFailureLines(lines).length, 1);
    const events = redis.events().slice(before);
    assert.equal(events.length, 1);
    assert.deepEqual(validateEvent(events[0]), { ok: true, errors: [] });
    assert.equal(events[0].type, 'agent.failure');
    assert.equal(events[0].severity, 'error');
    assert.deepEqual(events[0].data, {
        kind: 'model', call: 'conversation', error: 'ModelUnavailableError',
        message: 'Ollama request failed: fetch failed (ECONNREFUSED)', provider: 'ollama', model: 'test-model',
        url: 'http://192.0.2.10:11434/api/chat', status: null, timeout_ms: 90000, elapsed_ms: 12,
    });
});

test('only an agent\'s own connection may hand in events under its name', LIMIT, async () => {
    const before = hub.stats().accepted;
    // another client of the MindServer (the web page, a dashboard) pretending to be Arthur
    const { result: stranger } = await captureConsole(() => harness.connect());
    const forged = createEmitter({ agent: 'Arthur', send: (event) => stranger.emit('genesis-event', event), last_seq: 500 });
    forged.emit('agent.state', { state: 'forged' });
    stranger.emit('genesis-event', null);
    stranger.emit('genesis-event', 'junk');
    assert.equal(hub.stats().accepted, before);

    // Mira's process connection: accepted under her name, not under Arthur's
    const { result: mira_socket } = await captureConsole(() => harness.connect());
    mira_socket.emit('connect-agent-process', 'Mira');
    const mira = createEmitter({ agent: 'Mira', send: (event) => mira_socket.emit('genesis-event', event) });
    const as_arthur = createEmitter({ agent: 'Arthur', send: (event) => mira_socket.emit('genesis-event', event), last_seq: 900 });
    mira.emit('agent.state', { state: 'idle' });
    mira.emit('agent.state', { state: 'farming' });
    as_arthur.emit('agent.state', { state: 'forged' });
    await hub.drain();
    assert.equal(hub.stats().accepted, before + 2);
    assert.deepEqual(redis.events().filter((e) => e.agent === 'Mira').map((e) => e.seq), [1, 2]);
    assert.ok(redis.events().every((e) => e.data.state !== 'forged'));
});

test('with Redis failing the agent keeps running and the dropped counter rises', LIMIT, async () => {
    redis.failing = true;
    const before = { published: hub.stats().published, dropped: hub.stats().dropped, in_redis: redis.events().length };
    const last_arthur_seq = redis.events().filter((e) => e.agent === 'Arthur').at(-1).seq;
    const dropped_seen = [];
    for (let i = 0; i < 6; i++) { // 12 events into a buffer of 6
        const started = Date.now();
        const text = await perform(arthur, '!craftRecipe', 'stick', 1);
        assert.equal(text, 'Action output:\nSuccessfully crafted stick.\n'); // the action itself is untouched
        assert.ok(Date.now() - started < 1000, 'the action waited for Redis');
        dropped_seen.push(hub.stats().dropped);
    }
    await settle();
    const stats = hub.stats();
    assert.equal(stats.redis_ok, false);
    assert.equal(stats.published, before.published);
    assert.equal(stats.buffered, 6);
    assert.equal(stats.dropped, before.dropped + 6);
    assert.ok(dropped_seen.at(-1) > dropped_seen[0], `dropped did not rise: ${dropped_seen}`);
    assert.equal(redis.events().length, before.in_redis);

    // Redis is back: the six newest events arrive, still in order
    redis.failing = false;
    await clock.advance(60_000);
    const arrived = redis.events().slice(before.in_redis);
    assert.deepEqual(arrived.map((e) => e.seq), [7, 8, 9, 10, 11, 12].map((n) => last_arthur_seq + n));
    assert.equal(hub.stats().buffered, 0);
});
