// Steps 7 and 8, the wiring: the planner host inside the real MindServer, reached through
// the real agent-side connection, and the adapters that put the executor on a real bot.
//
// Real: src/mindcraft/mindserver.js, src/agent/mindserver_proxy.js, src/agent/action_manager.js,
// src/agent/library/skills.js, genesis/planning/server.js and host.js, the agent runtime,
// genesis/adapters/bot_ops.js and bot_world.js, genesis/lib/bot_guards.js.
// Stand-ins: socket.io (in-process sockets), express, the model, the world, mineflayer and
// its pathfinder (helpers/fake-pathfinder.mjs). Nothing here talks to Minecraft, Ollama,
// Redis or Postgres.
// Run from the repository root:  node --test genesis/tests/*.test.js

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stubModules, captureConsole } from './helpers/stubs.mjs';
import { fakeClock, settle, recordingPool } from './helpers/fakes.mjs';
import { SKILLS_STUBS, fakeBot, OPEN, WALLED, pos } from './helpers/fake-pathfinder.mjs';
import { campWorld, WORLD_CONFIG } from './helpers/fake-world.mjs';
import { stubModel } from './helpers/town.mjs';
import { createZones } from '../catalog/zones.js';
import { createCatalog } from '../catalog/catalog.js';
import { classifyFailure } from '../catalog/ops.js';
import { createCheckpointStore } from '../store/checkpoint.js';
import { nodeFiles } from '../store/node_files.js';
import { createAgentRuntime } from '../agent/runtime.js';
import { socketGoalStorage, socketCheckpointMirror } from '../planning/host.js';
import { startPlanning, memoryCallStore, BROKER_EVENT_AGENT } from '../planning/server.js';
import { emitEvent, agentEventStats, initAgentEvents } from '../events/agent_emit.js';
import { validateEvent } from '../shared/events.js';
import { installBotGuards } from '../lib/bot_guards.js';
import { noDigPathingPlugin, pathingPermit } from '../lib/no_dig_pathing.js';
import { createBotOps } from '../adapters/bot_ops.js';
import { createBotView } from '../adapters/bot_world.js';
import { createScaffoldTracker, placementSink, TORCH_REFLEX_ACTION } from '../executor/scaffold.js';
import { readFileSync } from 'node:fs';
import { REPO_ROOT } from './helpers/stubs.mjs';

function socketPair() {
    const make = () => {
        const handlers = new Map();
        const socket = {
            connected: true, peer: null,
            on(name, fn) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); return socket; },
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
    io: null,
    connect() {
        const { client, server } = socketPair();
        harness.io.handlers.connection(server);
        queueMicrotask(() => client.fire('connect'));
        return client;
    },
};
globalThis.genesis_test = harness;

stubModules({
    ...SKILLS_STUBS,
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
    'src/agent/conversation.js': 'export default { inConversation: () => false, isOtherAgent: () => false, receiveFromBot() {}, updateAgents() {} };',
    // upstream's command index is the real one; the two lists it is built from are cut down to what the test needs
    'src/agent/commands/actions.js': `
        export const actionsList = [{
            name: '!stop', description: 'Force stop all actions and commands that are currently executing.',
            perform: async function (agent) { agent.stopped = (agent.stopped ?? 0) + 1; return 'Agent stopped.'; },
        }];`,
    'src/agent/commands/queries.js': 'export const queryList = [];',
});

const { createMindServer, registerAgent, setSocketExtension } = await import('../../src/mindcraft/mindserver.js');
const { serverProxy } = await import('../../src/agent/mindserver_proxy.js');
const { ActionManager } = await import('../../src/agent/action_manager.js');
const skills = await import('../../src/agent/library/skills.js');
const pf = (await import('mineflayer-pathfinder')).default;
const Vec3 = (await import('vec3')).default;

const LIMIT = { timeout: 20000 };
let mindserver;
let host;
after(() => { host?.stop(); mindserver?.closeAllConnections(); mindserver?.close(); });

const checkpoint_dir = mkdtempSync(path.join(tmpdir(), 'genesis-checkpoints-'));
const PLANNING = {
    enabled: true, operators: ['Soup'], world_file: './genesis/genesis.world.json', checkpoint_dir, ledger_file: path.join(checkpoint_dir, 'ledger', 'chest_ledger.json'),
    model: { url: 'http://10.0.0.5:11434', model: 'planner-model' }, postgres_url: '',
};
const SETTINGS = (name) => ({
    profile: { name }, genesis_planning: PLANNING,
    genesis_events: { enabled: true, redis_url: 'redis://unused:6379', stream: 'genesis:events', stream_maxlen: 1000, buffer_size: 100 },
});
const clock = fakeClock();
const model = stubModel(clock);
const broker_events = [];

test('the planner host lives in the MindServer: an agent process plans through its own connection', LIMIT, async () => {
    // the agent's last run left a checkpoint: its event seq must go on from there
    const store = createCheckpointStore({ files: nodeFiles(), dir: checkpoint_dir });
    assert.equal((await store.write({
        v: 1, agent: 'Arthur', seq: 777, saved_at: new Date().toISOString(), plan: null, routine: null,
        position: { x: 0, y: 64, z: 0, dimension: 'overworld' }, places: {}, pending_request: null, budgets: {},
    })).ok, true);

    const created = [];
    await captureConsole(async () => {
        mindserver = createMindServer(false, 0);
        await once(mindserver, 'listening');
        registerAgent(SETTINGS('Arthur'), 3000);
        registerAgent(SETTINGS('Mira'), 3001);
        // what the launcher does when the setting is on, before any agent process connects
        host = await startPlanning(PLANNING, {
            setSocketExtension, clock,
            createModel: (options) => { created.push(options); return model; },
            event_sink: (event) => broker_events.push(event),
        });
        await settle();
        await serverProxy.connect('Arthur', mindserver.address().port);
    });
    assert.deepEqual(created, [{ url: 'http://10.0.0.5:11434', model: 'planner-model', options: null }]);
    assert.equal(host.broker.gate.state(), 'AVAILABLE', 'the broker did not probe once at start-up');
    assert.equal(agentEventStats().seq, 777, 'the event seq did not go on from the checkpoint');
    // the gate's own events are published under the broker's name
    assert.deepEqual(broker_events.map((event) => [event.agent, event.type, event.data.state, validateEvent(event).ok]), [[BROKER_EVENT_AGENT, 'agent.state', 'model_available', true]]);

    // the agent's runtime, on the socket the agent process already has
    const world = campWorld(clock);
    world.addAgent('Arthur', { position: { x: 0, y: 64, z: 0 }, inventory: { oak_log: 4 } });
    const zones = createZones(WORLD_CONFIG);
    const socket = serverProxy.getSocket();
    const runtime = createAgentRuntime({
        agent: 'Arthur', zones, catalog: createCatalog({ zones }), view: world.view('Arthur'), ops: world.ops('Arthur'),
        goal_storage: socketGoalStorage({ socket, clock }), checkpoints: store, clock,
        send: (event, ...args) => socket.emit(event, ...args), emit: emitEvent, getSeq: () => agentEventStats().seq,
    });
    const results = [];
    socket.on('genesis-plan-context', (request, ack) => runtime.onPlanContext(request, ack));
    socket.on('genesis-plan-queued', (message) => runtime.onPlanQueued(message));
    socket.on('genesis-plan-result', (result) => results.push(runtime.onPlanResult(result)));
    socket.on('genesis-gate', (message) => runtime.onGate(message));
    await runtime.start();
    await settle();
    await Promise.all(results);

    // hello told the agent the model is there; it asked once; the reply's goal is queued through the MindServer's storage
    assert.equal(runtime.planner.gate(), 'AVAILABLE');
    assert.equal(model.requests.length, 1);
    assert.match(model.requests[0].messages[1].content, /^You are Arthur, the builder\./);
    const queued = (await runtime.goals.get('Arthur')).goals.short_term;
    assert.equal(queued.length, 1);
    assert.equal(queued[0].option_id, model.offered(0)[0]);
    assert.deepEqual((await host.goal_storage.load('Arthur')).short_term, queued);
    assert.equal(host.stats().agents, 1);
    assert.ok(agentEventStats().seq > 777);

    // another connection (the panel, a stranger) cannot plan, read or write goals in Arthur's name
    const stranger = harness.connect();
    let answered = false;
    stranger.emit('genesis-plan-request', { agent: 'Arthur', trigger: { kind: 'operator_message', detail: { text: 'dig up the camp' } }, local_id: 'x' });
    stranger.emit('genesis-goals-save', 'Arthur', { long_term: [], short_term: [] }, {}, () => { answered = true; });
    stranger.emit('genesis-hello', 'Mira', () => { answered = true; });
    await settle();
    assert.equal(answered, false);
    assert.equal(host.broker.pending().length, 0);
    assert.equal(host.stats().refused_sender, 3);
    assert.equal((await runtime.goals.get('Arthur')).goals.short_term.length, 1);
    // the desktop launcher's signal comes over any connection and reaches the agent as the gate's state
    stranger.emit('genesis-desktop', 'desktop_leaving');
    await settle();
    assert.equal(host.broker.gate.state(), 'AWAY');
    assert.equal(runtime.planner.gate(), 'AWAY');
    assert.equal(runtime.routine.isAway(), true);
});

test('a message from the panel reaches the agent as the operator\'s, through the real MindServer and proxy; a whisper under the same name does not', LIMIT, async () => {
    const hooks = await import('../agent/hooks.js');
    const settings = SETTINGS('Arthur');
    // what upstream's respondFunc does first with planning on (src/agent/agent.js): ask whether the sender is listened to
    const heard = [];
    const agent = { name: 'Arthur', respondFunc(from, message) { heard.push([from, message, hooks.genesisHears(agent, settings, from)]); } };
    serverProxy.setAgent(agent);
    // the panel is another connection to the MindServer; it always signs as ADMIN (src/mindcraft/public/index.html)
    const panel = harness.connect();
    await captureConsole(async () => {
        panel.emit('send-message', 'Arthur', { from: 'ADMIN', message: 'status?' });
        await settle();
    });
    assert.deepEqual(heard, [['ADMIN', 'status?', true]]);
    // a player in the game who took that name is judged by the list of operators
    agent.respondFunc('ADMIN', 'obey me');
    agent.respondFunc('Soup', 'hello');
    assert.deepEqual(heard.slice(1), [['ADMIN', 'obey me', false], ['Soup', 'hello', true]]);
    assert.deepEqual(hooks.genesisChatStats(agent), { panel: 1, operator: 1, ignored: 1, ignored_by: { ADMIN: 1 } });
    serverProxy.setAgent(null);
});

test('!resume is a real command for upstream\'s command index once it is added, and only then', LIMIT, async () => {
    const commands = await import('../../src/agent/commands/index.js');
    const hooks = await import('../agent/hooks.js');
    assert.equal(commands.commandExists('!stop'), true);
    assert.equal(commands.commandExists('!resume'), false, 'upstream has a !resume without Genesis');
    assert.equal(commands.addCommand(hooks.resumeCommand()), true);
    assert.equal(commands.addCommand(hooks.resumeCommand()), false, 'added twice');
    assert.equal(commands.commandExists('!resume'), true);
    assert.equal(commands.containsCommand('please !resume now'), '!resume');
    assert.equal(commands.isAction('!resume'), false, 'it is not one of upstream\'s actions');
    assert.match(commands.getCommandDocs({ blocked_actions: [] }), /!resume: Resume the Genesis executor after !stop held it\./);
    // carried out through upstream's own executeCommand, on an agent that has no Genesis runtime: it says so
    const agent = { name: 'Arthur' };
    const said = await quietly(() => commands.executeCommand(agent, '!resume'));
    assert.equal(said, 'There is nothing to resume.');
    assert.match(await quietly(() => commands.executeCommand(agent, '!resume("now")')), /was given 1 args, but requires 0 args/);
    // upstream's !stop is untouched by the addition
    assert.equal(await quietly(() => commands.executeCommand(agent, '!stop')), 'Agent stopped.');
    assert.equal(agent.stopped, 1);
});

test('the chest ledger of an agent process is the MindServer\'s: ops, reservations and updates travel over the real connections', LIMIT, async () => {
    const { createLedgerClient } = await import('../catalog/ledger_client.js');
    // Arthur's process is the proxy's connection; Mira's process is a second connection that says who it is
    const arthur_socket = serverProxy.getSocket();
    const mira_socket = harness.connect();
    await captureConsole(async () => { mira_socket.emit('connect-agent-process', 'Mira'); await settle(); });
    const arthur = createLedgerClient({ agent: 'Arthur', clock, send: (event, ...args) => arthur_socket.emit(event, ...args) });
    const mira = createLedgerClient({ agent: 'Mira', clock, send: (event, ...args) => mira_socket.emit(event, ...args) });
    arthur_socket.on('genesis-ledger-update', (message) => arthur.onUpdate(message));
    mira_socket.on('genesis-ledger-update', (message) => mira.onUpdate(message));
    assert.equal(await arthur.sync(), true);
    assert.equal(await mira.sync(), true);

    arthur.set('shared', { bread: 8 }, clock.now());
    assert.deepEqual(host.ledger.view('shared'), { items: { bread: 8 }, seen_at: clock.now(), seen_by: 'Arthur' });
    assert.equal(mira.count('shared', 'bread'), 8, 'what Arthur saw did not reach Mira\'s process');
    assert.deepEqual(mira.reserve('shared', 'bread', 8), { ok: true, count: 8 });
    assert.deepEqual(arthur.reserve('shared', 'bread', 4).claim, { chest: 'shared', item: 'bread', count: 4, holder: 'Mira', held: 8, asker: 'Arthur', in_chest: 8 });
    // a stranger's connection cannot write to the ledger under an agent's name
    const stranger = harness.connect();
    stranger.emit('genesis-ledger-op', { agent: 'Mira', op: { kind: 'observe', chest: 'shared', contents: { diamond: 64 }, at: clock.now() + 5 } });
    assert.deepEqual(host.ledger.view('shared').items, { bread: 8 });
    // Mira's process goes away: what it had reserved is free again, and Arthur's process is told
    mira_socket.peer.fire('disconnect');
    assert.equal(arthur.available('shared', 'bread'), 8);
    // the ledger file is in the folder the setting names, written a moment after the change
    await clock.advance(3000);
    await host.ledger_file.flush();
    const saved = JSON.parse(await nodeFiles().read(PLANNING.ledger_file));
    assert.deepEqual(saved.chests.shared.base, { bread: 8 });
});

// Two ends of one socket: what the client emits (with its acknowledgement) runs the server's handler.
function fakeWire() {
    const handlers = new Map();
    const sent = [];
    return {
        sent,
        server: { on: (event, handler) => handlers.set(event, handler), emit() {}, connected: true },
        client: { connected: true, emit(event, ...args) { sent.push(event); handlers.get(event)?.(...args); } },
    };
}

test('planning server: no database configured keeps calls in memory; a configured one gets the calls and the goals', async () => {
    const store = memoryCallStore(2);
    for (const id of ['a', 'b', 'c']) store.record({ call_id: id });
    assert.deepEqual(store.records.map((record) => record.call_id), ['b', 'c']);

    const pool = recordingPool([]);
    const extensions = [];
    // decided: the address is the launcher's to give (from its environment); one in the settings is not looked at
    const ignored = await startPlanning({ ...PLANNING, postgres_url: 'postgres://genesis@db:5432/genesis' }, {
        setSocketExtension: () => {}, clock: fakeClock(), createModel: () => stubModel(clock), createPool: async () => { throw new Error('a pool was made from the settings file'); },
    });
    assert.deepEqual(ignored.database, { configured: false, connected: false, migrated: false, migrations: [] });
    ignored.stop();

    const notes = [];
    const second = await startPlanning(PLANNING, {
        postgres_url: 'postgres://genesis@db:5432/genesis', warn: (line) => notes.push(JSON.parse(line)),
        setSocketExtension: (extension) => extensions.push(extension), clock: fakeClock(),
        createModel: () => stubModel(clock), createPool: async ({ url }) => { pool.url = url; return pool; },
    });
    assert.equal(pool.url, 'postgres://genesis@db:5432/genesis');
    assert.equal(extensions.length, 1);
    // the tables are made at start, from the files of genesis/store/migrations, in order
    assert.deepEqual(second.database, { configured: true, connected: true, migrated: true, migrations: ['001_planner_calls.sql', '002_goals.sql', '003_checkpoints.sql', '004_learning.sql'] });
    assert.deepEqual(pool.queries.slice(0, 3).map((query) => /CREATE TABLE IF NOT EXISTS ([a-z_]+)/.exec(query.text)[1]), ['planner_calls', 'agent_goals', 'agent_checkpoints']);
    assert.ok(pool.queries.slice(0, 3).every((query) => query.values.length === 0 && !/\bDROP\b|\bDELETE\b|\bTRUNCATE\b/i.test(query.text)));
    assert.equal(notes.find((note) => note.event === 'genesis_planning_database_ready').level, 'info');
    // the checkpoint mirror: an agent's own checkpoint goes to the database through its socket, and comes back
    const wire = fakeWire();
    extensions[0](wire.server, { isAgentSocket: (name) => name === 'Nova' });
    const mirror = socketCheckpointMirror({ socket: wire.client });
    await mirror.save({ v: 1, agent: 'Nova', seq: 7, saved_at: '2026-01-01T00:00:00.000Z' });
    assert.ok(pool.queries.some((query) => /INSERT INTO agent_checkpoints/.test(query.text) && query.values[0] === 'Nova' && query.values[1] === 7), 'the checkpoint did not reach the database');
    await assert.rejects(mirror.save({ v: 1, agent: 'Arthur', seq: 1, saved_at: '2026-01-01T00:00:00.000Z' }), /did not answer|not this agent/);
    assert.equal(second.stats().checkpoints_mirrored, 1);
    await second.goal_storage.save('Nova', { long_term: [], short_term: [] },
        { id: 'c1', agent: 'Nova', scope: 'short_term', before: [], after: [], reason: 'r', source: 'executor', call_id: null, ts: '2026-01-01T00:00:00.000Z' });
    await settle();
    assert.ok(pool.queries.some((query) => /INSERT INTO goal_changes/.test(query.text)), 'the goal change did not reach the database');
    second.stop();

    // a database that cannot be reached at start is not a reason to stop: everything is kept in memory
    const warnings = [];
    const third_extensions = [];
    const third = await startPlanning(PLANNING, {
        postgres_url: 'postgres://genesis@db:5432/genesis',
        setSocketExtension: (extension) => third_extensions.push(extension), clock: fakeClock(), createModel: () => stubModel(clock), warn: (line) => warnings.push(JSON.parse(line)),
        createPool: async () => { throw new Error("Cannot find package 'pg'"); },
    });
    assert.equal(warnings[0].event, 'genesis_planning_no_database');
    await third.goal_storage.save('Nova', { long_term: [], short_term: [] }, {});
    assert.deepEqual(await third.goal_storage.load('Nova'), { long_term: [], short_term: [] });
    // without a database the agent's mirror is told so once, and then stays quiet: nothing fails, nothing is reported
    const lone = fakeWire();
    third_extensions[0](lone.server, { isAgentSocket: () => true });
    const no_mirror = socketCheckpointMirror({ socket: lone.client });
    await no_mirror.save({ v: 1, agent: 'Nova', seq: 1, saved_at: '2026-01-01T00:00:00.000Z' });
    assert.equal(no_mirror.isOff(), true);
    const sent_before = lone.sent.length;
    await no_mirror.save({ v: 1, agent: 'Nova', seq: 2, saved_at: '2026-01-01T00:00:30.000Z' });
    assert.equal(await no_mirror.load('Nova'), null);
    assert.equal(lone.sent.length, sent_before, 'the agent kept asking a MindServer that has no mirror');
    third.stop();

    // a database that is not up yet when the launcher starts: the tables are tried again until they are made
    const late_clock = fakeClock();
    const late_notes = [];
    let attempts = 0;
    const late = await startPlanning(PLANNING, {
        postgres_url: 'postgres://genesis@db:5432/genesis', setSocketExtension: () => {}, clock: late_clock, createModel: () => stubModel(clock),
        warn: (line) => late_notes.push(JSON.parse(line)), createPool: async () => recordingPool([]),
        migrate: async () => { if (++attempts < 3) throw new Error('connect ECONNREFUSED'); return ['001_planner_calls.sql']; },
    });
    assert.deepEqual([late.database.connected, late.database.migrated, attempts], [true, false, 1]);
    assert.match(late_notes[0].message, /connect ECONNREFUSED; trying again in 30 s/);
    await late_clock.advance(61 * 1000);
    assert.deepEqual([late.database.migrated, attempts], [true, 3]);
    late.stop();
});

// ---- the executor on a bot ---------------------------------------------------------------

function botAgent(search) {
    const bot = fakeBot(search);
    bot.placed = [];
    bot.placeBlock = async (reference, face) => { bot.placed.push([reference.position.x + face.x, reference.position.y + face.y, reference.position.z + face.z]); };
    noDigPathingPlugin(bot);
    const agent = {
        name: 'Arthur', bot,
        self_prompter: { isActive: () => false },
        history: { add() {} },
        isIdle() { return !this.actions.executing; },
        clearBotLogs() { bot.output = ''; bot.interrupt_code = false; },
        requestInterrupt() { bot.interrupt_code = true; },
        cleanKill() { throw new Error('cleanKill called'); },
    };
    agent.actions = new ActionManager(agent);
    return agent;
}
const pause = () => new Promise((resolve) => setTimeout(resolve, 30)); // upstream counts quicker repeats as a runaway loop
const quietly = async (fn) => (await captureConsole(fn)).result;

test('bot_ops: a step is one upstream skill through the action manager, with the permit only while it runs', LIMIT, async () => {
    const zones = createZones(WORLD_CONFIG);
    const agent = botAgent(WALLED);
    const guards = installBotGuards(agent.bot, { zones });
    const ops = createBotOps(agent, { skills, guards });
    const emitted = [];
    initAgentEvents({ agent: 'Arthur', settings: { genesis_events: { enabled: true } }, send: (event) => emitted.push(event) });

    // walking: no permit, so the wall is not dug through and the step fails with the name the catalog knows
    const walk = await quietly(() => ops.run('goToPosition', [20, 64, 0, 2], { permit: null }));
    assert.deepEqual([walk.ok, walk.interrupted, walk.timedout], [false, false, false]);
    assert.equal(classifyFailure('goToPosition', walk), 'no_safe_path');
    assert.deepEqual(agent.bot.dug, []);
    await pause();

    // a gather step: the permit lets the path dig (outside the zones), and is gone afterwards
    const permit = { dig: (position) => zones.isProtected(position), no_place: false };
    agent.bot.blockAt = (p) => ({ name: 'oak_log', position: pos(p.x, p.y, p.z), canHarvest: () => true });
    const broke = await quietly(() => ops.run('breakBlockAt', [-30, 64, 0], { permit }));
    assert.equal(broke.ok, true, broke.output);
    assert.match(broke.output, /Broke oak_log at x:-30\.0, y:64\.0, z:0\.0\./);
    assert.ok(agent.bot.searches.some((search) => search.can_dig === true), 'the gather step was not allowed to tunnel');
    assert.equal(pathingPermit(agent.bot), null, 'the permit outlived the step');
    assert.ok(agent.bot.dug.length >= 1);
    await pause();

    // the executor's steps are not reported a second time by the action manager
    assert.deepEqual(emitted, [], 'the action manager emitted events for an executor step');
    // a command that is not in the table is never called
    const bad = await ops.run('newAction', ['process.exit()'], {});
    assert.equal(classifyFailure('newAction', bad), 'unknown_command');
    assert.equal(bad.ok, false);
    const digDown = await ops.run('digDown', [10], {});
    assert.equal(digDown.ok, false, 'a skill outside the table was run');

    // while something else has the bot (a reflex, an operator command) the step waits its turn
    agent.actions.executing = true;
    let waited = 0;
    const patient = createBotOps(agent, { skills, guards, idle_patience_ms: 900, sleep: async () => { waited++; if (waited === 2) agent.actions.executing = false; } });
    const after_wait = await quietly(() => patient.run('pickupNearbyItems', [], {}));
    assert.equal(waited, 2);
    assert.equal(after_wait.ok, true);
    await pause();
    agent.actions.executing = true;
    const gave_up = await createBotOps(agent, { skills, guards, idle_patience_ms: 600, sleep: async () => {} }).run('pickupNearbyItems', [], {});
    assert.deepEqual([gave_up.ok, gave_up.interrupted], [false, true], 'a step that could not start counts as a failure');
    agent.actions.executing = false;
    initAgentEvents({ agent: 'Arthur', settings: {}, send: () => {} });
});

test('bot_guards: nothing in a protected zone is broken except the one cell a step was allowed, and placed blocks are reported', LIMIT, async () => {
    const zones = createZones(WORLD_CONFIG);
    const agent = botAgent(OPEN);
    const { bot } = agent;
    const scaffold = createScaffoldTracker({ zones });
    const guards = installBotGuards(bot, { zones, onPlace: (at) => scaffold.placed(at) });
    assert.equal(installBotGuards(bot, { zones }), guards, 'the guard was installed twice');
    const block = (x, y, z) => ({ name: 'oak_planks', position: pos(x, y, z) });

    await assert.rejects(bot.dig(block(3, 65, 3)), (err) => err.name === 'ProtectedZone' && /inside the camp/.test(err.message));
    await assert.rejects(bot.dig(block(15, 64, 0)), /inside the field/);
    await assert.rejects(bot.dig(block(-18, 65, 14)), /inside the plot:plot-1/);
    await bot.dig(block(-40, 64, 0)); // outside every zone
    assert.equal(bot.dug.length, 1);
    guards.allowBreak({ x: 15, y: 64, z: 0 }); // the crop the harvest step names
    await bot.dig(block(15, 64, 0));
    await assert.rejects(bot.dig(block(16, 64, 0)), /inside the field/);
    guards.allowBreak(null);
    await assert.rejects(bot.dig(block(15, 64, 0)), /inside the field/);
    assert.deepEqual(guards.stats(), { digs_refused: 5, digs_allowed_in_zone: 1, placed: 0 });

    // through the real skill: the operator (or anything else) asking the bot to break a camp block gets a failure, not a hole
    const ops = createBotOps(agent, { skills, guards: { allowBreak() {} } }); // a caller that forgot to allow anything
    bot.blockAt = (p) => ({ name: 'oak_planks', position: pos(p.x, p.y, p.z), canHarvest: () => true });
    const refused = await quietly(() => ops.run('breakBlockAt', [3, 65, 3], {}));
    assert.equal(refused.ok, false);
    assert.match(refused.output, /not breaking oak_planks at 3, 65, 3: it is inside the camp/);
    assert.equal(bot.dug.length, 2);

    // every block the bot places (the pathfinder's scaffolding goes through bot.placeBlock) is reported
    await bot.placeBlock({ position: pos(5, 64, 5) }, { x: 0, y: 1, z: 0 });
    await bot.placeBlock({ position: pos(-40, 64, 0) }, { x: 1, y: 0, z: 0 });
    assert.deepEqual(bot.placed, [[5, 65, 5], [-39, 64, 0]]);
    assert.deepEqual(scaffold.snapshot(), [[5, 65, 5]], 'only what stands inside a zone has to be taken away again');
    assert.throws(() => installBotGuards({}, { zones }), /cannot be installed/);
});

test('bot_guards: a torch placed while upstream\'s torch mode runs is reported as a reflex torch and stays; anything else is scaffolding', LIMIT, async () => {
    // upstream: the torch_placing mode places through skills.placeBlock, and every mode runs under the label `mode:<name>`
    const modes = readFileSync(path.join(REPO_ROOT, 'src/agent/modes.js'), 'utf8').split('\n');
    assert.match(modes[225], /name: 'torch_placing'/);
    assert.match(modes[237], /await skills\.placeBlock\(agent\.bot, 'torch', pos\.x, pos\.y, pos\.z, 'bottom', true\);/);
    assert.match(modes[316], /agent\.actions\.runAction\(`mode:\$\{mode\.name\}`/);
    assert.match(readFileSync(path.join(REPO_ROOT, 'src/agent/action_manager.js'), 'utf8').split('\n')[100], /this\.currentActionLabel = actionLabel;/);

    const zones = createZones(WORLD_CONFIG);
    const agent = botAgent(OPEN);
    const { bot } = agent;
    const scaffold = createScaffoldTracker({ zones });
    // wired as genesis/adapters/bot_agent.js wires it
    installBotGuards(bot, { zones, onPlace: placementSink(scaffold, () => agent.actions?.currentActionLabel ?? null) });
    const real_place = bot.placed;
    const place = (x, y, z, item) => async () => {
        bot.heldItem = { name: item };
        const done = bot.placeBlock({ position: pos(x, y - 1, z) }, { x: 0, y: 1, z: 0 });
        bot.heldItem = null; // the last one of the stack: gone from the hand by the time the block is confirmed
        await done;
    };
    // the reflex, through upstream's real action manager: the torch is in the camp and is not tracked
    await quietly(() => agent.actions.runAction(TORCH_REFLEX_ACTION, place(3, 65, 3, 'torch'), {}));
    assert.deepEqual([scaffold.count(), scaffold.exempted()], [0, 1]);
    await pause();
    // a block the pathfinder puts down during a Genesis step, in the camp: tracked, to be taken away
    await quietly(() => agent.actions.runAction('action:genesis_goToPosition', place(4, 65, 3, 'cobblestone'), {}));
    await pause();
    // a torch that is not the reflex's (another action runs) is scaffolding like everything else
    await quietly(() => agent.actions.runAction('action:genesis_goToPosition', place(5, 65, 3, 'torch'), {}));
    await pause();
    // while the torch mode runs, something that is not a torch is not exempt either
    await quietly(() => agent.actions.runAction(TORCH_REFLEX_ACTION, place(6, 65, 3, 'dirt'), {}));
    assert.deepEqual(scaffold.snapshot(), [[4, 65, 3], [5, 65, 3], [6, 65, 3]]);
    assert.equal(scaffold.exempted(), 1);
    assert.equal(real_place.length, 4, 'a block was not really placed');
});

test('bot_world: the view reads the bot through upstream\'s helpers, and its path check never digs', LIMIT, async () => {
    const bot = fakeBot(OPEN);
    noDigPathingPlugin(bot);
    Object.assign(bot, {
        username: 'Arthur', health: 17.5, food: 12, time: { timeOfDay: 9000 }, game: { dimension: 'overworld', gameMode: 'survival' },
        inventory: { emptySlotCount: () => 30, items: () => [{ name: 'wooden_pickaxe', type: 700, count: 1 }, { name: 'coal', type: 5, count: 6 }] },
        registry: { blocksByName: { stone: { harvestTools: { 700: true } }, diamond_ore: { harvestTools: { 999: true } }, oak_log: {} } },
        recipesFor: (id, meta, count, table) => (id === 'item:stick' ? [{}] : id === 'item:bread' && table ? [{}] : []),
    });
    bot.blockAt = (p) => (p.y < 0 ? null : { name: p.y === 64 ? 'wheat' : 'stone', position: pos(p.x, p.y, p.z), metadata: 3, getProperties: () => (p.y === 64 ? { age: 7 } : {}) });
    const asked = [];
    const world = {
        getInventoryCounts: () => ({ wooden_pickaxe: 1, coal: 6 }),
        getNearestBlocks: (b, names, distance, count) => { asked.push([names, distance, count]); return [bot.blockAt(pos(3, 64, 1)), null]; },
    };
    const mc = {
        getBlockId: (name) => (name === 'unobtainium' ? null : `block:${name}`),
        getItemId: (name) => (name === 'elytra' ? null : `item:${name}`),
        getItemCraftingRecipes: (name) => (name === 'bedrock' ? null : [[{}, {}]]),
        isSmeltable: (name) => name.includes('raw'),
        getSmeltingFuel: (b) => b.inventory.items().find((item) => item.name === 'coal'),
        getFuelSmeltOutput: () => 8,
    };
    let now = 0;
    const view = createBotView(bot, { world, mc, pf, Vec3, now: () => now });

    assert.deepEqual(view.position(), { x: 0, y: 64, z: 0 });
    assert.deepEqual([view.dimension(), view.health(), view.food(), view.freeSlots(), view.dayTicksLeft()], ['overworld', 17.5, 12, 30, 3000]);
    bot.time.timeOfDay = 13000;
    assert.equal(view.dayTicksLeft(), 0);
    assert.deepEqual(view.inventory(), { wooden_pickaxe: 1, coal: 6 });
    assert.deepEqual(view.blockAt({ x: 3.7, y: 64, z: 1.2 }), { name: 'wheat', x: 3, y: 64, z: 1, age: 7 });
    assert.deepEqual(view.blockAt({ x: 3, y: 60, z: 1 }), { name: 'stone', x: 3, y: 60, z: 1, age: 3 });
    assert.equal(view.blockAt({ x: 3, y: -70, z: 1 }), null, 'a cell that is not loaded');
    assert.deepEqual(view.findBlocks(['wheat', 'unobtainium'], 32, 5), [{ name: 'wheat', x: 3, y: 64, z: 1, age: 7 }]);
    assert.deepEqual(asked, [[['wheat'], 32, 5]], 'a block name this version does not have was passed on');
    assert.deepEqual(view.findBlocks(['unobtainium'], 32, 5), []);
    assert.deepEqual(view.recipe('stick'), { craftable: true, needs_table: false });
    assert.deepEqual(view.recipe('bread'), { craftable: true, needs_table: true });
    assert.deepEqual(view.recipe('chest'), { craftable: false, needs_table: false });
    assert.equal(view.recipe('elytra'), null);
    assert.equal(view.recipe('bedrock'), null);
    assert.deepEqual([view.canHarvest('stone'), view.canHarvest('diamond_ore'), view.canHarvest('oak_log'), view.canHarvest('mystery')], [true, false, true, true]);
    assert.deepEqual(view.fuel(), { name: 'coal', count: 6, per_item: 8 });
    assert.deepEqual([view.isSmeltable('raw_iron'), view.isSmeltable('coal')], [true, false]);

    // the path check: quick, never digging, and not repeated for the same place
    const there = view.pathTo({ x: 20, y: 64, z: 0 }, 2);
    assert.equal(there.status, 'ok');
    assert.deepEqual(bot.searches, [{ can_dig: false, timeout: 150 }]);
    view.pathTo({ x: 20, y: 64, z: 0 }, 2);
    assert.equal(bot.searches.length, 1, 'the same path was searched twice within the cache time');
    now += 11000;
    view.pathTo({ x: 20, y: 64, z: 0 }, 2);
    assert.equal(bot.searches.length, 2);
    const walled = fakeBot(WALLED);
    noDigPathingPlugin(walled);
    assert.deepEqual(createBotView(walled, { world, mc, pf, Vec3 }).pathTo({ x: 20, y: 64, z: 0 }, 2), { status: 'none' });
    assert.deepEqual(walled.dug, []);
});
