// Genesis: the supervisor of the agent processes. It runs in the MindServer process and
// decides what happens when an agent process ends (upstream's own rule is one restart at
// once, unless the process lived for less than 10 seconds: src/process/agent_process.js
// lines 42-51).
//
//   crash           restarted after 5 seconds, 30 seconds, 2 minutes and 5 minutes (decided).
//                   After 5 restarts in 30 minutes the agent stops and ONE operator incident
//                   is emitted (decided).
//   server down     the agent waits and reconnects on its own, with a growing pause and no
//                   limit on how long it waits (decided). Never counted as a crash.
//   login refused   (a whitelist change, a ban, the name in use) goes to the operator after
//                   at most two attempts (decided).
//   intended        a restart somebody asked for is carried out at once and never counted
//                   as a crash (decided).
//   watchdog        a restart the watchdog's ladder ordered (rung 5: the agent made no progress
//                   after four recovery steps) is carried out and does NOT count toward the
//                   5-restarts-in-30-minutes cap (decided): only crashes count. What bounds these
//                   restarts is the ladder's own hourly cap (genesis/recovery/watchdog.js).
//   stop            a deliberate stop (SIGINT, or exit code 0 after a stop was asked for) is left
//                   alone. An exit with code 0 that nobody asked for is a crash: upstream ends
//                   the process that way when its spawn handler throws (src/agent/agent.js
//                   lines 141-144), and never starts it again.
//
// "Reconnect" is a new agent process: the agent's goal, step and incident are in its
// checkpoint, so the new process carries on where the old one was (genesis/executor).
//
// Every decision is an agent.failure or agent.recovery event in the incident shape
// (genesis/recovery/incidents.js), with source { type: "agent", name }.
//
// Everything outside is injected:
//   clock      { now(), setTimeout(fn, ms), clearTimeout(handle) }
//   emit       (type, data, { severity })     where the events go (optional)
//   exited(name, { code, signal }, restart)   restart() starts the agent's process again
// Depends only on other files of genesis/recovery.

import { classifyExit } from './exit_codes.js';
import { createIncidentReporter, INCIDENT_KINDS } from './incidents.js';

export const SUPERVISOR_DEFAULTS = Object.freeze({
    restart_delays_ms: Object.freeze([5 * 1000, 30 * 1000, 2 * 60 * 1000, 5 * 60 * 1000]), // decided
    max_restarts: 5,                        // decided: restarts within the window; the next crash stops the agent
    restart_window_ms: 30 * 60 * 1000,      // decided
    reconnect_delays_ms: Object.freeze([5 * 1000, 10 * 1000, 20 * 1000, 40 * 1000, 60 * 1000]), // proposed: the last one repeats, with no limit
    login_attempts: 2,                      // decided: a refused login goes to the operator after at most two attempts
    login_retry_ms: 15 * 1000,              // proposed: the pause before the second attempt
    intended_delay_ms: 1000,                // proposed: the pause before a restart that was asked for
    watchdog_delay_ms: 5 * 1000,            // proposed: the pause before a restart the watchdog ordered (as after a first crash)
});

export function createRestartSupervisor({ clock = { now: Date.now, setTimeout, clearTimeout }, emit = () => null, ids = null, ...options } = {}) {
    const config = { ...SUPERVISOR_DEFAULTS };
    for (const key of Object.keys(SUPERVISOR_DEFAULTS)) {
        if (options[key] !== undefined) config[key] = options[key];
    }
    const reporter = createIncidentReporter({ emit, clock, ids, source: { type: 'service', name: 'supervisor' } });
    const agents = new Map(); // name -> state
    const stats = { exits: 0, crashes: 0, restarts: 0, intended: 0, watchdog: 0, reconnects: 0, refused: 0, stopped: 0, operator_incidents: 0, logins: 0 };

    const of = (name) => {
        if (!agents.has(name)) {
            agents.set(name, {
                restarts: [],        // when crash restarts were ordered, within the window
                timer: null,         // the restart that waits
                restart: null,       // how the process is started again
                crash: null,         // the open incident of a series of crashes
                down: null,          // { incident, attempts, since }: the server is down
                refused: null,       // { incident, attempts }: the login was refused
                stopped: null,       // why the agent is no longer restarted
                stop_wanted: false,  // somebody asked for the agent to be stopped, and its process has not ended yet
                last: null,          // the last decision
            });
        }
        return agents.get(name);
    };
    const about = (name) => ({ type: 'agent', name });
    const pick = (list, index) => list[Math.min(index, list.length - 1)];

    function schedule(name, state, delay_ms) {
        if (state.timer !== null) clock.clearTimeout(state.timer);
        state.timer = clock.setTimeout(() => {
            state.timer = null;
            stats.restarts++;
            try { state.restart?.(); } catch { /* a start that throws is seen as the next exit, or not at all */ }
        }, delay_ms);
        state.timer?.unref?.();
    }

    function stop(name, state, incident, more) {
        state.stopped = more.reason;
        stats.stopped++;
        stats.operator_incidents++;
        reporter.escalated(incident, more); // the one operator-level incident
    }

    return {
        config,
        // An agent process ended. Returns the decision:
        //   { action: 'restart', kind, delay_ms, attempt } | { action: 'stop', kind, reason } | { action: 'none', kind }
        exited(name, { code = null, signal = null } = {}, restart = null) {
            const state = of(name);
            const now = clock.now();
            let kind = classifyExit({ code, signal });
            if (kind === 'stop' && signal !== 'SIGINT' && !state.stop_wanted) kind = 'crash'; // it ended "cleanly", and nobody had asked it to
            state.stop_wanted = false;
            stats.exits++;
            if (typeof restart === 'function') state.restart = restart;
            if (state.timer !== null) { clock.clearTimeout(state.timer); state.timer = null; }
            let decision;

            if (kind === 'stop') {
                // somebody stopped the agent: what was counted against it is forgotten
                state.restarts = [];
                state.crash = null;
                state.down = null;
                state.refused = null;
                decision = { action: 'none', kind };
            } else if (kind === 'intended') {
                stats.intended++;
                const incident = { incident_id: reporter.newId(), source: about(name), kind: INCIDENT_KINDS.PROCESS_EXIT };
                reporter.step(incident, { step: 'restart', attempt: 1, max: 1, result: 'pending' }, { is_failure: false, outcome: 'expected', code, intended: true });
                schedule(name, state, config.intended_delay_ms);
                decision = { action: 'restart', kind, delay_ms: config.intended_delay_ms, attempt: 0, counted: false };
            } else if (kind === 'watchdog') {
                // decided: only crashes count toward the restart cap. This restart is part of the watchdog's own
                // incident (its fifth rung, which is in the agent's checkpoint); here it is told as one step, uncounted
                stats.watchdog++;
                const incident = { incident_id: reporter.newId(), source: about(name), kind: INCIDENT_KINDS.PROCESS_EXIT };
                reporter.step(incident, { step: 'restart', attempt: 1, max: 1, result: 'pending' }, { code, ordered_by: 'watchdog', counted: false, delay_ms: config.watchdog_delay_ms });
                schedule(name, state, config.watchdog_delay_ms);
                decision = { action: 'restart', kind, delay_ms: config.watchdog_delay_ms, attempt: 0, counted: false };
            } else if (kind === 'server_down') {
                stats.reconnects++;
                state.down ??= { incident: reporter.detected({ kind: INCIDENT_KINDS.SERVER_DOWN, source: about(name), code }), attempts: 0, since: now };
                const delay_ms = pick(config.reconnect_delays_ms, state.down.attempts);
                state.down.attempts++;
                // max 0: there is no limit on how long an agent waits for the server
                reporter.step(state.down.incident, { step: 'reconnect', attempt: state.down.attempts, max: 0, result: 'pending' }, { delay_ms, waited_ms: now - state.down.since });
                schedule(name, state, delay_ms);
                decision = { action: 'restart', kind, delay_ms, attempt: state.down.attempts, counted: false };
            } else if (kind === 'login_refused') {
                stats.refused++;
                state.refused ??= { incident: reporter.detected({ kind: INCIDENT_KINDS.LOGIN_REFUSED, source: about(name), code }), attempts: 0 };
                state.refused.attempts++;
                const recovery = { step: 'login', attempt: state.refused.attempts, max: config.login_attempts, result: 'failed' };
                if (state.refused.attempts >= config.login_attempts) {
                    stop(name, state, state.refused.incident, { recovery, reason: 'login_refused', code });
                    decision = { action: 'stop', kind, reason: 'login_refused', attempt: state.refused.attempts };
                } else {
                    reporter.step(state.refused.incident, recovery, { delay_ms: config.login_retry_ms });
                    schedule(name, state, config.login_retry_ms);
                    decision = { action: 'restart', kind, delay_ms: config.login_retry_ms, attempt: state.refused.attempts, counted: false };
                }
            } else {
                stats.crashes++;
                state.restarts = state.restarts.filter((at) => at > now - config.restart_window_ms);
                if (state.restarts.length === 0 || state.crash === null) {
                    state.crash = reporter.detected({ kind: INCIDENT_KINDS.PROCESS_EXIT, source: about(name), code, signal });
                }
                if (state.restarts.length >= config.max_restarts) {
                    // this would be one restart too many within the window: the agent stops
                    stop(name, state, state.crash, {
                        recovery: { step: 'restart', attempt: state.restarts.length + 1, max: config.max_restarts, result: 'skipped' },
                        reason: 'restart_limit', code, signal, restarts: state.restarts.length, window_ms: config.restart_window_ms,
                    });
                    decision = { action: 'stop', kind, reason: 'restart_limit', attempt: state.restarts.length + 1 };
                    // the operator has it now: if they start the agent again, it starts with a clean count
                    state.crash = null;
                    state.restarts = [];
                } else {
                    const delay_ms = pick(config.restart_delays_ms, state.restarts.length);
                    state.restarts.push(now);
                    reporter.step(state.crash, { step: 'restart', attempt: state.restarts.length, max: config.max_restarts, result: 'pending' }, { delay_ms, code, signal });
                    schedule(name, state, delay_ms);
                    decision = { action: 'restart', kind, delay_ms, attempt: state.restarts.length, counted: true };
                }
            }
            state.last = { ...decision, at: now };
            return decision;
        },
        // The agent is in the game again (its process logged in): what was waiting for that is over.
        loggedIn(name) {
            const state = of(name);
            stats.logins++;
            state.stopped = null;
            if (state.down) {
                reporter.resolved(state.down.incident, {
                    recovery: { step: 'reconnect', attempt: state.down.attempts, max: 0, result: 'ok' }, waited_ms: clock.now() - state.down.since,
                });
                state.down = null;
            }
            if (state.refused) {
                reporter.resolved(state.refused.incident, { recovery: { step: 'login', attempt: state.refused.attempts + 1, max: config.login_attempts, result: 'ok' } });
                state.refused = null;
            }
            if (state.crash && state.restarts.length > 0) {
                reporter.step(state.crash, { step: 'restart', attempt: state.restarts.length, max: config.max_restarts, result: 'ok' }, { outcome: 'auto_recovered' });
            }
        },
        // The operator stopped the agent: a restart that waits is called off.
        stopRequested(name) {
            const state = of(name);
            state.stop_wanted = true;
            const waiting = state.timer !== null;
            if (waiting) { clock.clearTimeout(state.timer); state.timer = null; }
            return waiting;
        },
        state(name) {
            const state = agents.get(name);
            if (!state) return null;
            return {
                restarts_in_window: state.restarts.filter((at) => at > clock.now() - config.restart_window_ms).length,
                waiting: state.timer !== null, server_down: state.down !== null, login_refused: state.refused !== null,
                stopped: state.stopped, last: state.last ? { ...state.last } : null,
            };
        },
        stats: () => ({ ...stats }),
        close() { for (const state of agents.values()) if (state.timer !== null) { clock.clearTimeout(state.timer); state.timer = null; } },
    };
}
