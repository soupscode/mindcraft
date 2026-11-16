// Genesis: emit() for the agent process. It stamps id, ts, agent and seq on an event and
// hands it to the MindServer over the socket the agent already has. The MindServer is the
// one publisher (genesis/events/hub.js); the agent never talks to Redis.
//
// Off unless the genesis_events setting has "enabled": true. While off, emitEvent() and
// skillStarted() do nothing, so upstream files can call them unconditionally.
//
// emit() never throws and never waits: a broken socket or an invalid event costs the
// event, not the agent. Depends only on Node built-ins and genesis/shared/events.js.

import { AsyncLocalStorage } from 'node:async_hooks';
import { EVENT_VERSION, validateEvent, createUlidFactory, clipText } from '../shared/events.js';

// skill.progress: at most one per second per agent (the rest are thrown away here).
export const PROGRESS_INTERVAL_MS = 1000;

const correlation = new AsyncLocalStorage();

// Runs fn so that every event emitted inside it (also after awaits) carries `corr`,
// unless the emit call names its own. `corr` is the id of the decision being carried out.
export function runWithCorrelation(corr, fn) {
    return correlation.run(corr ?? null, fn);
}

// agent:    the agent's name
// send:     function (event) that hands the event on (the socket emit)
// last_seq: the seq of the last event this agent emitted before a restart (0 = none)
// now, random: injectable for tests
export function createEmitter({ agent, send, last_seq = 0, now = Date.now, random = Math.random,
    progress_interval_ms = PROGRESS_INTERVAL_MS, warn = console.warn } = {}) {
    const ulid = createUlidFactory({ now, random });
    const counters = { emitted: 0, invalid: 0, throttled: 0, send_failed: 0 };
    let seq = Number.isInteger(last_seq) && last_seq > 0 ? last_seq : 0;
    let last_progress_ms = null;
    const warned = new Set();

    function warnOnce(key, record) {
        if (warned.has(key)) return;
        warned.add(key);
        try { warn(JSON.stringify({ ts: new Date(now()).toISOString(), level: 'warn', agent, ...record })); } catch { /* logging must not break emit */ }
    }

    // Returns the event that was handed on, or null when nothing was (invalid or throttled).
    function emit(type, data = {}, { corr, severity = 'info' } = {}) {
        try {
            const at = now();
            if (type === 'skill.progress' && last_progress_ms !== null && at - last_progress_ms < progress_interval_ms) {
                counters.throttled++;
                return null;
            }
            const event = {
                v: EVENT_VERSION,
                id: ulid(),
                ts: new Date(at).toISOString(),
                agent,
                seq: seq + 1,
                type,
                corr: corr !== undefined ? corr : (correlation.getStore() ?? null),
                severity,
                data,
            };
            const checked = validateEvent(event);
            if (!checked.ok) {
                counters.invalid++;
                warnOnce(`invalid:${type}`, { event: 'genesis_event_invalid', type, errors: checked.errors });
                return null;
            }
            seq++; // only a valid event uses up a number, so seq has no gaps on the agent's side
            if (type === 'skill.progress') last_progress_ms = at;
            counters.emitted++;
            try {
                send(event);
            } catch (err) {
                counters.send_failed++;
                warnOnce('send_failed', { event: 'genesis_event_send_failed', message: String(err?.message ?? err) });
            }
            return event;
        } catch (err) {
            counters.invalid++;
            warnOnce('emit_error', { event: 'genesis_event_invalid', type: String(type), errors: [String(err?.message ?? err)] });
            return null;
        }
    }

    return {
        emit,
        stats: () => ({ ...counters, seq }),
    };
}

// ---- the one emitter of this agent process ----

let active = null;

// Called once the agent process has its settings (src/agent/mindserver_proxy.js).
// Returns the emitter, or null when the genesis_events setting leaves events off.
export function initAgentEvents({ agent, settings, send, ...options } = {}) {
    active = settings?.genesis_events?.enabled === true ? createEmitter({ agent, send, ...options }) : null;
    return active;
}

export function agentEventsEnabled() {
    return active !== null;
}

export function agentEventStats() {
    return active ? active.stats() : null;
}

// Emits one event for this agent. Does nothing (and returns null) while events are off.
export function emitEvent(type, data, options) {
    return active ? active.emit(type, data, options) : null;
}

const NO_SKILL_EVENT = Object.freeze({ result: (action_result) => action_result });

function plainArgs(args) {
    if (!Array.isArray(args)) return undefined;
    return args.slice(0, 16).map((arg) => {
        if (arg === null || typeof arg === 'number' || typeof arg === 'boolean') return arg;
        return clipText(typeof arg === 'string' ? arg : String(arg), 200);
    });
}

// The action path (src/agent/action_manager.js): emits skill.started now, and skill.result
// when .result(action_result) is called with the structured result of the action
// ({ok, interrupted, timedout, output}). .result returns what it was given.
export function skillStarted(skill, args) {
    if (!active) return NO_SKILL_EVENT;
    const emitter = active;
    const started_ms = Date.now();
    const plain_args = plainArgs(args);
    emitter.emit('skill.started', plain_args ? { skill: String(skill), args: plain_args } : { skill: String(skill) });
    return {
        result(action_result) {
            const ok = action_result?.ok === true;
            emitter.emit('skill.result', {
                skill: String(skill),
                ok,
                interrupted: action_result?.interrupted === true,
                timedout: action_result?.timedout === true,
                output: clipText(action_result?.output ?? '', 2000),
                duration_ms: Math.max(0, Date.now() - started_ms),
            }, { severity: ok ? 'info' : 'warn' });
            return action_result;
        },
    };
}
