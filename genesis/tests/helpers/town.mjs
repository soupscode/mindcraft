// The whole decision loop in one process, for the planning and routine tests: the real
// planner broker in its host (as in the MindServer), one real agent runtime per agent, and
// in-process sockets between them. The model is a stub that counts what it is asked, the
// world is helpers/fake-world.mjs, the clock is the fake one.

import { fakeFiles } from './fakes.mjs';
import { campWorld, WORLD_CONFIG, HUT } from './fake-world.mjs';
import { createZones } from '../../catalog/zones.js';
import { createCatalog } from '../../catalog/catalog.js';
import { createCheckpointStore } from '../../store/checkpoint.js';
import { createEmitter } from '../../events/agent_emit.js';
import { createScaffoldTracker } from '../../executor/scaffold.js';
import { createAgentRuntime } from '../../agent/runtime.js';
import { createLedgerClient } from '../../catalog/ledger_client.js';
import { createPlanningHost, createHostGoalStorage, socketGoalStorage } from '../../planning/host.js';
import { startRelay } from '../../relay/server.js';
import { createLearner } from '../../learning/learner.js';
import { createScorer } from '../../learning/scorer.js';
import { memoryLearningStore } from '../../learning/store.js';
import { createLearningService } from '../../learning/service.js';
import { createLearningClient } from '../../learning/client.js';
import { startTown } from '../../town/server.js';
import { createTownClient, townZones, townBlueprints, building } from '../../town/client.js';
import { buildBlueprints } from '../../catalog/blueprints.js';
import { REPO_ROOT } from './stubs.mjs';

// Two ends of one connection: what one end emits, the other end's handlers get (ack
// callbacks included, as with socket.io).
export function socketPair() {
    const make = () => {
        const handlers = new Map();
        const socket = {
            connected: true, peer: null, sent: [],
            on(name, fn) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); return socket; },
            fire(name, ...args) { for (const fn of handlers.get(name) ?? []) fn(...args); },
            emit(name, ...args) {
                if (!socket.connected) throw new Error('not connected');
                socket.sent.push([name, ...args.filter((arg) => typeof arg !== 'function')]);
                socket.peer.fire(name, ...args);
                return true;
            },
        };
        return socket;
    };
    const client = make();
    const server = make();
    client.peer = server;
    server.peer = client;
    return { client, server };
}

// A model that records what it is asked. By default it answers with a valid reply naming
// the first option offered. `replies` queues other answers: objects, raw strings, Errors,
// or functions (request) -> answer.
export function stubModel(clock) {
    const model = {
        name: 'stub-model', requests: [], replies: [], probes: 0, probe_ok: true, delay_ms: 0,
        // the small calls for a spoken line (genesis/relay): kept apart from the planning requests.
        // `lines` queues answers: a line, a function (request, template) -> line, or an Error.
        // By default the model says the plain version with a word of its own in front.
        line_requests: [], lines: [], line_delay_ms: 0,
        // the small calls that decide a request or offer (genesis/relay/decisions.js): kept apart as well.
        // `decisions` queues answers: 'accept' | 'decline', { decision, reason }, a raw string, an Error, or a
        // function (request) -> one of those. By default the model accepts.
        decision_requests: [], decisions: [], decision_delay_ms: 0,
        goal_requests: [], goal_choices: [],
        async probe() { model.probes++; return model.probe_ok; },
        chat(request) {
            if (request.format?.properties?.decision) {
                model.decision_requests.push(request);
                let next = model.decisions.length > 0 ? model.decisions.shift() : 'accept';
                if (typeof next === 'function') next = next(request);
                const answer = () => {
                    if (next instanceof Error) throw next;
                    const content = next === 'accept' || next === 'decline' ? JSON.stringify({ decision: next, reason: next === 'accept' ? 'It can be spared.' : 'It is needed here.' })
                        : (typeof next === 'string' ? next : JSON.stringify(next));
                    return { content, prompt_tokens: 150, completion_tokens: 15, model: 'stub-model:latest' };
                };
                if (model.decision_delay_ms <= 0) return Promise.resolve().then(answer);
                return new Promise((resolve, reject) => {
                    clock.setTimeout(() => { try { resolve(answer()); } catch (err) { reject(err); } }, model.decision_delay_ms);
                });
            }
            if (request.format?.properties?.line) {
                model.line_requests.push(request);
                const template = /Plain version: (.*)$/m.exec(request.messages.at(-1).content)?.[1] ?? '';
                let next = model.lines.length > 0 ? model.lines.shift() : `Well, ${template}`;
                if (typeof next === 'function') next = next(request, template);
                const answer = () => {
                    if (next instanceof Error) throw next;
                    return { content: JSON.stringify({ line: next }), prompt_tokens: 120, completion_tokens: 20, model: 'stub-model:latest' };
                };
                if (model.line_delay_ms <= 0) return Promise.resolve().then(answer);
                return new Promise((resolve, reject) => {
                    clock.setTimeout(() => { try { resolve(answer()); } catch (err) { reject(err); } }, model.line_delay_ms);
                });
            }
            // the small call that chooses an agent's long-term goals (genesis/town/goals.js): kept apart as well.
            // `goal_choices` queues answers: a list of ids, { goals, reason }, a raw string, an Error, or a function
            // (request, ids) -> one of those. By default the model takes the first id.
            if (Array.isArray(request.format?.properties?.goals?.items?.enum)) {
                model.goal_requests.push(request);
                const ids = request.format.properties.goals.items.enum;
                let next = model.goal_choices.length > 0 ? model.goal_choices.shift() : [ids[0]];
                if (typeof next === 'function') next = next(request, ids);
                return Promise.resolve().then(() => {
                    if (next instanceof Error) throw next;
                    const content = Array.isArray(next) ? JSON.stringify({ goals: next, reason: 'These fit my work best.' }) : (typeof next === 'string' ? next : JSON.stringify(next));
                    return { content, prompt_tokens: 140, completion_tokens: 20, model: 'stub-model:latest' };
                });
            }
            model.requests.push(request);
            const offered = request.format.properties.goals.items.properties.option_id.enum;
            let next = model.replies.length > 0 ? model.replies.shift() : null;
            if (typeof next === 'function') next = next(request, offered);
            next ??= { thought: 'First things first.', goals: [{ option_id: offered[0], title: `Do ${offered[0]}`.slice(0, 60), reason: 'it is the first option' }] };
            const answer = () => {
                if (next instanceof Error) throw next;
                return { content: typeof next === 'string' ? next : JSON.stringify(next), prompt_tokens: 600, completion_tokens: 40, model: 'stub-model:latest' };
            };
            if (model.delay_ms <= 0) return Promise.resolve().then(answer);
            return new Promise((resolve, reject) => {
                clock.setTimeout(() => { try { resolve(answer()); } catch (err) { reject(err); } }, model.delay_ms);
            });
        },
        offered: (index = -1) => model.requests.at(index).format.properties.goals.items.properties.option_id.enum,
    };
    return model;
}

export const BLUEPRINTS = { get: (name) => (name === 'hut' ? HUT : null) };

// recovery: true gives every agent the watchdog and its ladder (the fake world's recovery moves).
// relay: true (or the relay's settings) adds the message relay to the host, as the launcher does, and
//   gives every agent its message desk; what an agent is told to say is kept in a.said.
// learning: true gives the town the one learner (genesis/learning/service.js, with everything in memory) and every
//   agent its client; town.learning is the service, town.learning_store its store.
// town: true (or { prefabs, roles, rules }) gives the rig the ONE town (genesis/town/server.js, its file in the rig's
//   fake files) and every agent its copy of it: the zones are then the world file's with the town layered over, the
//   blueprints are the prefab files, and the building ladder is asked. town.town is the service (after start()).
export function makeTown({ clock, agents = ['Arthur'], config = WORLD_CONFIG, world = null, inventories = {}, positions = {}, host: host_options = {}, runtime: runtime_options = {}, recovery = false, relay = false, blueprints = BLUEPRINTS, learning = false, zones = null, town: town_options = false } = {}) {
    const town = { clock, calls: [], broker_events: [], agents: {} };
    town.world = world ?? campWorld(clock);
    town.zones = zones ?? createZones(config);
    town.model = stubModel(clock);
    town.storage = createHostGoalStorage();
    town.host = createPlanningHost({
        model: town.model, clock, calls: { record: (record) => { town.calls.push(record); } }, goal_storage: town.storage,
        emit: (type, data, opts) => town.broker_events.push({ type, data, ...opts }),
        ...host_options,
    });
    town.broker = town.host.broker;
    town.files = fakeFiles();
    town.learning_events = [];
    if (learning) {
        const settings = learning === true ? {} : learning;
        town.learning_store = settings.store ?? memoryLearningStore();
        let service = null;
        const learner = createLearner({ agents: settings.agents ?? ['Arthur', 'Mira', 'Felix', 'Nova'], clock, seed: settings.seed ?? 7, rules: settings.rules ?? {}, onVersion: (record) => service?.onVersion(record) });
        const scorer = createScorer({ learner, clock, seed: settings.seed ?? 7, rules: settings.scorer ?? {} });
        service = createLearningService({ learner, scorer, store: town.learning_store, versions: settings.versions ?? null, clock, emit: (type, data, opts) => town.learning_events.push({ type, data, ...opts }), ...(settings.service ?? {}) });
        town.learning = service;
    }
    town.messages = []; // every agent.message event of the relay
    if (relay) {
        town.relay_service = startRelay(relay === true ? {} : relay, {
            agents, clock, emit: (type, data, opts) => { if (type === 'agent.message') town.messages.push({ type, data, ...opts }); },
        });
        town.relay = town.relay_service.relay;
        town.relay_service.bind({ broker: town.broker, ledger: town.host.ledger, ledgerUpdated: () => town.host.ledgerUpdated() });
    }

    // Starts (or restarts) the process of one agent.
    town.join = async (agent, { last_seq = 0 } = {}) => {
        if (!town.world.body(agent)) {
            const home = town.zones.home(agent) ?? { x: 0, y: 64, z: 0 };
            town.world.addAgent(agent, { position: positions[agent] ?? home, inventory: inventories[agent] ?? {} });
        }
        const { client, server } = socketPair();
        town.host.attach(server, { isAgentSocket: () => true });
        town.town?.attach(server, { isAgentSocket: (name) => name === agent });
        town.relay_service?.attach(server, { isAgentSocket: (name) => name === agent });
        town.learning?.attach(server, { isAgentSocket: (name) => name === agent });
        const a = { agent, socket: client, server_socket: server, events: [], dead: false, said: [] };
        a.emitter = createEmitter({ agent, send: (event) => { if (!a.dead) a.events.push(event); }, last_seq, now: clock.now, warn: () => {}, progress_interval_ms: 0 });
        // the files as this process sees them: a process that was killed writes nothing any more
        const files = {
            write: async (...args) => (a.dead ? undefined : town.files.write(...args)),
            rename: async (...args) => (a.dead ? undefined : town.files.rename(...args)),
            read: async (...args) => (a.dead ? null : town.files.read(...args)),
            remove: async (...args) => (a.dead ? undefined : town.files.remove(...args)),
        };
        a.scaffold = createScaffoldTracker({ zones: town.zones });
        a.ops = town.world.ops(agent, { on_place: (pos, how) => { if (how !== 'skill') a.scaffold.placed(pos, { reflex_torch: how === 'reflex_torch' }); } });
        // the agent's copy of the one chest ledger the host holds
        a.ledger = createLedgerClient({ agent, send: (event, ...args) => client.emit(event, ...args), clock });
        client.on('genesis-ledger-update', (message) => a.ledger.onUpdate(message));
        a.claims = [];
        // with a town: this agent's copy of it, layered over the world file's zones
        let agent_zones = town.zones;
        let agent_blueprints = blueprints;
        let town_runtime = {};
        if (town.town) {
            a.town = createTownClient({ agent, send: (event, ...args) => client.emit(event, ...args), clock });
            client.on('genesis-town-update', (message) => a.town.onUpdate(message));
            agent_zones = townZones(town.zones, a.town, agent);
            agent_blueprints = townBlueprints(town.prefabs);
            town_runtime = { town: a.town, building: building(a.town, town.prefabs), prefabs: town.prefabs };
        }
        a.zones = agent_zones;
        a.runtime = createAgentRuntime({
            agent, zones: agent_zones, catalog: createCatalog({ zones: agent_zones, blueprints: agent_blueprints }),
            ...town_runtime,
            view: town.world.view(agent), ops: a.ops, scaffold: a.scaffold,
            goal_storage: socketGoalStorage({ socket: client, clock }),
            checkpoints: createCheckpointStore({ files, dir: '/checkpoints', clock }),
            ...(recovery ? { recovery_ops: town.world.recovery(agent) } : {}),
            ...(relay ? { messaging: true, relay_limits: relay === true ? {} : relay.limits ?? {} } : {}),
            ...(town.learning ? { learning: createLearningClient({ agent, send: (event, ...args) => client.emit(event, ...args), clock }) } : {}),
            send: (event, ...args) => client.emit(event, ...args),
            emit: a.emitter.emit, getSeq: () => a.emitter.stats().seq, clock,
            ledger: a.ledger, onContestedClaim: (claim) => a.claims.push(claim),
            ...runtime_options,
        });
        client.on('genesis-plan-context', (request, ack) => a.runtime.onPlanContext(request, ack));
        client.on('genesis-plan-queued', (message) => a.runtime.onPlanQueued(message));
        client.on('genesis-plan-result', (result) => { a.results.push(result); a.pending_results.push(a.runtime.onPlanResult(result)); });
        client.on('genesis-gate', (message) => a.runtime.onGate(message));
        a.message_work = [];
        client.on('genesis-msg', (message) => { a.message_work.push(a.runtime.onMessage(message)); });
        client.on('genesis-msg-state', (update) => { a.message_work.push(a.runtime.onMessageState(update)); });
        client.on('genesis-msg-speak', (said) => { a.said.push(said.line); });
        a.results = [];
        a.pending_results = [];
        a.eventsOf = (type) => a.events.filter((event) => event.type === type);
        a.queue = async () => (await a.runtime.goals.get(agent)).goals.short_term;
        a.changes = () => a.eventsOf('goal.changed').map((event) => event.data);
        a.started = await a.runtime.start();
        town.agents[agent] = a;
        return a;
    };
    // The process of one agent ends at once (a crash, a kick, a restart): nothing of it writes,
    // emits or sends any more, and the MindServer sees its connection close.
    town.kill = (agent) => {
        const a = town.agents[agent];
        if (!a || a.dead) return a ?? null;
        a.dead = true;
        a.runtime.stop();
        a.socket.connected = false;
        a.server_socket.connected = false;
        a.server_socket.fire('disconnect');
        town.world.interrupt(agent);
        return a;
    };
    town.start = async ({ available = true } = {}) => {
        town.model.probe_ok = available;
        if (town_options) {
            const settings = town_options === true ? {} : town_options;
            town.prefabs = settings.prefabs ?? buildBlueprints({ root: REPO_ROOT });
            town.town_events = [];
            town.town = await startTown({ town_file: '/town/genesis.town.json' }, {
                zones_config: config, prefabs: town.prefabs, files: town.files, clock, agents, world_sha256: settings.world_sha256 ?? 'test-world',
                roles: settings.roles ?? { Arthur: 'builder', Mira: 'farmer', Felix: 'explorer', Nova: 'merchant' }, operator_dir: '/prefabs/operator',
                emit: (type, data, opts) => town.town_events.push({ type, data, ...opts }), warn: () => {},
            });
            town.town.bind({ broker: town.broker, ledger: town.host.ledger, store: town.learning_store ?? null });
        }
        await town.host.start();
        for (const agent of agents) await town.join(agent);
        return town;
    };
    // Lets every agent's executor run on the fake clock.
    town.run = () => { town.running = Object.values(town.agents).map((a) => a.runtime.run()); };
    // Stops everything. A skill that is still running on the fake clock is given time to end.
    town.stop = async () => {
        for (const a of Object.values(town.agents)) a.runtime.stop();
        town.host.stop();
        await clock.advance(10 * 60 * 1000);
        await Promise.all(town.running ?? []);
    };
    return town;
}
