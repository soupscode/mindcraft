// Genesis: the planner broker's home in the MindServer process. It owns the broker
// (genesis/broker/broker.js) and joins it to the agent processes over the sockets they
// already have. Nothing here knows about mineflayer or the model's API.
//
// Socket events (the agent's side is genesis/planning/agent_planner.js):
//   genesis-hello         (agent, ack)             -> ack({ gate })        an agent process says it is there
//   genesis-plan-request  ({ agent, trigger, local_id })                   a planning trigger
//   genesis-plan-queued   -> agent  { local_id, request_id, queued_at }
//   genesis-plan-context  -> agent  (request, ack)                         asked when the request is dispatched
//   genesis-plan-result   -> agent  { ok, request_id, local_id, call_id, reply | reason, ... }
//   genesis-gate          -> every agent  { state, reason }                the model gate changed
//   genesis-goals-load    (agent, ack)             -> ack({ ok, goals })   the goal store's storage, kept here so
//   genesis-goals-save    (agent, goals, change, ack) -> ack({ ok })       only this process talks to Postgres
//   genesis-desktop       (name)                   'desktop_available' | 'desktop_leaving', from the desktop launcher
//   genesis-ledger-sync     (agent, ack)           -> ack({ ok, ledger })  the ONE chest ledger lives here
//   genesis-ledger-op       ({ agent, op })                                what an agent saw in a chest, put in or took out
//   genesis-ledger-reserve  ({ agent, chest, item, count }, ack)           -> ack({ ok, count | code, claim, reservations })
//   genesis-ledger-release  ({ agent, chest, item })
//   genesis-ledger-update   -> every agent  { chests: { name: view }, reservations }   after every change
// An agent's requests are only taken from that agent's own process connection.
//
// Injected:
//   model, clock, calls       as the broker takes them
//   goal_storage              { load(agent), save(agent, goals, change) }   (createHostGoalStorage below)
//   ledger                    the shared chest ledger (genesis/catalog/shared_ledger.js)
//   emit(type, data, opts)    where the gate's own events go (optional)
//   onGate(state, detail)     told when the model gate changed (optional): genesis/recovery/server.js
//                             turns it into the model.away and model.available incident events
// Depends only on other Genesis files.

import { createPlannerBroker } from '../broker/broker.js';
import { createSharedLedger } from '../catalog/shared_ledger.js';

export const HOST_DEFAULTS = Object.freeze({ context_timeout_ms: 5000 });

// The goal storage of the MindServer process: memory first, so no agent ever waits for a
// database, and written through to a durable storage (Postgres) in the background, in
// order. While the durable one is down the writes wait in a bounded list; once it is full
// the oldest change record is lost and counted.
export function createHostGoalStorage({ durable = null, max_waiting = 2000, retry_ms = 5000, clock = { setTimeout, clearTimeout }, warn = () => {} } = {}) {
    const current = new Map();   // agent -> { long_term, short_term }
    const waiting = [];          // writes not yet in the durable storage: { agent, goals, change }
    const stats = { saved: 0, durable_saved: 0, durable_failures: 0, lost: 0 };
    let writing = false;
    let retry = null;
    const copy = (value) => JSON.parse(JSON.stringify(value));

    async function flush() {
        if (!durable || writing) return;
        writing = true;
        try {
            while (waiting.length > 0) {
                const next = waiting[0];
                try {
                    await durable.save(next.agent, next.goals, next.change);
                } catch (err) {
                    stats.durable_failures++;
                    warn(`goal storage: not written yet (${err?.message ?? err}), ${waiting.length} waiting`);
                    if (retry === null) {
                        retry = clock.setTimeout(() => { retry = null; flush(); }, retry_ms);
                        retry?.unref?.();
                    }
                    return;
                }
                waiting.shift();
                stats.durable_saved++;
            }
        } finally {
            writing = false;
        }
    }

    return {
        async load(agent) {
            if (current.has(agent)) return copy(current.get(agent));
            if (!durable) return null;
            try {
                const stored = await durable.load(agent);
                if (stored) current.set(agent, copy(stored));
                return stored ?? null;
            } catch (err) {
                warn(`goal storage: could not be read (${err?.message ?? err}), starting ${agent} with empty goals`);
                return null;
            }
        },
        async save(agent, goals, change) {
            current.set(agent, copy(goals));
            stats.saved++;
            if (durable) {
                if (waiting.length >= max_waiting) { waiting.shift(); stats.lost++; }
                waiting.push({ agent, goals: copy(goals), change: copy(change) });
                flush();
            }
        },
        flush,
        stats: () => ({ ...stats, waiting: waiting.length }),
        stop() { if (retry !== null) { clock.clearTimeout(retry); retry = null; } },
    };
}

export function createPlanningHost({
    model, clock = { now: Date.now, setTimeout, clearTimeout }, calls = { record() {} },
    goal_storage = createHostGoalStorage(), ledger = null, emit = () => {}, onGate = null, broker: broker_options = {}, ...options
} = {}) {
    const chest_ledger = ledger ?? createSharedLedger({ clock });
    const config = { ...HOST_DEFAULTS };
    for (const key of Object.keys(HOST_DEFAULTS)) {
        if (options[key] !== undefined) config[key] = options[key];
    }
    const agents = new Map(); // agent -> the socket of its process
    const stats = { hellos: 0, requests: 0, refused_sender: 0, context_failures: 0, results: 0, undelivered: 0, ledger_ops: 0, ledger_updates: 0 };

    const toAgent = (agent, event, ...args) => {
        const socket = agents.get(agent);
        if (!socket || socket.connected === false) return false;
        try { socket.emit(event, ...args); return true; } catch { return false; }
    };

    // The context of a request is asked from the agent at the moment the request goes out.
    function buildContext(request) {
        return new Promise((resolve, reject) => {
            let settled = false;
            const finish = (fn, value) => { if (settled) return; settled = true; clock.clearTimeout(timer); fn(value); };
            const timer = clock.setTimeout(() => {
                stats.context_failures++;
                finish(reject, new Error(`${request.agent} did not answer with its options within ${config.context_timeout_ms} ms`));
            }, config.context_timeout_ms);
            const asked = toAgent(request.agent, 'genesis-plan-context', { id: request.id, trigger: request.trigger, kind: request.kind }, (answer) => {
                if (answer && typeof answer.context === 'string' && Array.isArray(answer.options)) {
                    finish(resolve, { context: answer.context, options: answer.options.map((option) => ({ id: option.id, description: option.description })) });
                } else {
                    stats.context_failures++;
                    finish(reject, new Error(String(answer?.error ?? 'the agent sent no context')));
                }
            });
            if (!asked) {
                stats.context_failures++;
                finish(reject, new Error(`${request.agent} is not connected`));
            }
        });
    }

    function deliver(result) {
        stats.results++;
        const message = {
            ok: result.ok === true, request_id: result.request.id, local_id: result.request.ref ?? null, call_id: result.call_id ?? null,
            ...(result.ok ? { reply: result.reply, chosen_ids: result.chosen_ids }
                : { reason: result.reason, retry_at: result.retry_at ?? null, errors: result.errors ?? (result.error ? [result.error] : []) }),
        };
        if (!toAgent(result.request.agent, 'genesis-plan-result', message)) stats.undelivered++;
    }

    function gateEvent(type, data, opts) {
        try { emit(type, data, opts); } catch { /* an event must never disturb the broker */ }
        if (type !== 'agent.state' || typeof data?.state !== 'string' || !data.state.startsWith('model_')) return;
        const message = { state: broker.gate.state(), reason: data.detail?.reason ?? null };
        for (const agent of agents.keys()) toAgent(agent, 'genesis-gate', message);
        if (onGate) { try { onGate(message.state, { ...(data.detail ?? {}) }); } catch { /* the listener's problem */ } }
    }

    const broker = createPlannerBroker({ model, clock, calls, buildContext, deliver, emit: gateEvent, ...broker_options });

    // Every agent is told what the ledger now says about a chest, and who has reserved what.
    function ledgerChanged(chest = null) {
        stats.ledger_updates++;
        const message = { chests: chest ? { [chest]: chest_ledger.view(chest) } : {}, reservations: chest_ledger.reservations() };
        for (const agent of agents.keys()) toAgent(agent, 'genesis-ledger-update', message);
    }

    return {
        broker,
        goal_storage,
        ledger: chest_ledger,
        // Called for every connection to the MindServer. `isAgentSocket(name)` says whether this
        // connection is the process of that agent (the MindServer knows; a test may just say yes).
        attach(socket, { isAgentSocket = () => true } = {}) {
            const own = (agent) => {
                if (typeof agent === 'string' && agent.length > 0 && isAgentSocket(agent)) return true;
                stats.refused_sender++;
                return false;
            };
            socket.on('genesis-hello', (agent, ack) => {
                if (!own(agent)) return;
                stats.hellos++;
                agents.set(agent, socket);
                if (typeof ack === 'function') ack({ gate: broker.gate.state(), reason: broker.gate.awayReason() });
            });
            socket.on('genesis-plan-request', (message) => {
                if (!own(message?.agent)) return;
                stats.requests++;
                agents.set(message.agent, socket);
                const kind = typeof message.trigger?.kind === 'string' ? message.trigger.kind : null;
                // a request the budget refuses is answered from inside submit(): local_id lets the agent know it as its own
                const submitted = broker.submit({ agent: message.agent, trigger: message.trigger ?? null, ref: message.local_id ?? null });
                if (submitted.ok) {
                    toAgent(message.agent, 'genesis-plan-queued', {
                        local_id: message.local_id ?? null, request_id: submitted.request.id,
                        queued_at: new Date(submitted.request.queued_at).toISOString(), trigger: kind,
                    });
                }
            });
            socket.on('genesis-goals-load', async (agent, ack) => {
                if (!own(agent) || typeof ack !== 'function') return;
                try { ack({ ok: true, goals: await goal_storage.load(agent) }); } catch (err) { ack({ ok: false, error: String(err?.message ?? err) }); }
            });
            socket.on('genesis-goals-save', async (agent, goals, change, ack) => {
                if (!own(agent) || typeof ack !== 'function') return;
                try { await goal_storage.save(agent, goals, change); ack({ ok: true }); } catch (err) { ack({ ok: false, error: String(err?.message ?? err) }); }
            });
            socket.on('genesis-desktop', (name) => {
                if (name === 'desktop_available' || name === 'desktop_leaving') broker.signal(name).catch(() => {});
            });
            // ---- the shared chest ledger ----
            socket.on('genesis-ledger-sync', (agent, ack) => {
                if (!own(agent) || typeof ack !== 'function') return;
                agents.set(agent, socket);
                ack({ ok: true, ledger: chest_ledger.snapshot() });
            });
            socket.on('genesis-ledger-op', (message) => {
                if (!own(message?.agent)) return;
                stats.ledger_ops++;
                agents.set(message.agent, socket);
                const done = chest_ledger.apply(message.agent, message.op);
                // told also when nothing changed: the agent's copy took the op and must be put right
                ledgerChanged(done?.chest ?? (typeof message.op?.chest === 'string' ? message.op.chest : null));
            });
            socket.on('genesis-ledger-reserve', (message, ack) => {
                if (!own(message?.agent)) return;
                agents.set(message.agent, socket);
                const outcome = chest_ledger.reserve(message.agent, message);
                if (typeof ack === 'function') ack({ ...outcome, reservations: chest_ledger.reservations() });
                if (outcome.ok) ledgerChanged();
            });
            socket.on('genesis-ledger-release', (message) => {
                if (!own(message?.agent)) return;
                if (chest_ledger.release(message.agent, message)) ledgerChanged();
            });
            socket.on('disconnect', () => {
                for (const [agent, known] of agents) {
                    if (known !== socket) continue;
                    agents.delete(agent);
                    // a process that is gone holds nothing: what it had reserved is free again
                    if (chest_ledger.releaseAll(agent)) ledgerChanged();
                }
            });
        },
        // The ledger was changed from inside this process (the relay moved a reservation): every agent is told.
        ledgerUpdated: (chest = null) => ledgerChanged(chest),
        signal: (name) => broker.signal(name),
        start: (start_options) => broker.start(start_options),
        stop() { broker.stop(); goal_storage.stop?.(); },
        stats: () => ({ ...stats, agents: agents.size, broker: broker.stats() }),
    };
}

// The agent's end of the goal storage: the goal store's { load, save }, carried over the socket.
export function socketGoalStorage({ socket, timeout_ms = 5000, clock = { setTimeout, clearTimeout } } = {}) {
    const ask = (event, ...args) => new Promise((resolve, reject) => {
        const timer = clock.setTimeout(() => reject(new Error(`the MindServer did not answer ${event} within ${timeout_ms} ms`)), timeout_ms);
        try {
            socket.emit(event, ...args, (answer) => {
                clock.clearTimeout(timer);
                if (answer?.ok) resolve(answer); else reject(new Error(String(answer?.error ?? 'refused')));
            });
        } catch (err) {
            clock.clearTimeout(timer);
            reject(err);
        }
    });
    return {
        load: async (agent) => (await ask('genesis-goals-load', agent)).goals ?? null,
        save: async (agent, goals, change) => { await ask('genesis-goals-save', agent, goals, change); },
    };
}
