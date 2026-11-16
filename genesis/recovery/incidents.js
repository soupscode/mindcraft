// Genesis: incidents. Every recovery action is told as an agent.failure or agent.recovery
// event whose `data` has the failure-event shape (decided):
//
//   { "incident_id": "<id>", "source": { "type": "agent", "name": "Felix" }, "kind": "nav.stuck",
//     "phase": "recovery_step", "is_failure": true,
//     "recovery": { "step": "repath", "attempt": 1, "max": 3, "result": "ok" },
//     "outcome": "auto_recovered", "needs_operator": false }
//
// One incident keeps one incident_id from the moment it is detected until it is resolved or
// handed to the operator, so a reader can follow it across events (and across a restart of
// the agent process: the id is in the checkpoint).
//
//   agent.failure    the incident was detected, or it is handed to the operator
//   agent.recovery   a recovery step was taken, or the incident is over
//
// model.away and model.available use the same shape with is_failure false and outcome
// "expected" (modelAway / modelAvailable below): they show on the Incidents view and are
// never counted as failures.
//
// Depends only on genesis/shared/events.js.

import { createUlidFactory, clipText } from '../shared/events.js';

export const INCIDENT_KINDS = Object.freeze({
    STUCK: 'nav.stuck',
    DEATH: 'agent.death',
    PROCESS_EXIT: 'process.exit',
    SERVER_DOWN: 'server.down',
    LOGIN_REFUSED: 'login.refused',
    STEP_PARKED: 'step.parked',
    MODEL_AWAY: 'model.away',
    MODEL_AVAILABLE: 'model.available',
});

// The `data` of one incident event. Every field of the shape is always there.
export function incidentData({
    incident_id, source, kind, phase, is_failure = true, recovery = null, outcome = 'pending', needs_operator = false, ...more
} = {}) {
    return {
        incident_id: String(incident_id),
        source: { type: String(source?.type ?? 'agent'), name: String(source?.name ?? 'unknown') },
        kind: String(kind),
        phase,
        is_failure: is_failure === true,
        recovery: recovery ? {
            step: String(recovery.step), attempt: Math.max(0, Math.floor(Number(recovery.attempt) || 0)),
            max: Math.max(0, Math.floor(Number(recovery.max) || 0)), result: recovery.result ?? 'pending',
        } : null,
        outcome,
        needs_operator: needs_operator === true,
        ...more,
    };
}

// The reporter of one source (an agent, or a service such as the supervisor).
//   emit(type, data, { severity, corr })   genesis/events/agent_emit.js shape; never trusted not to throw
//   source                                { type, name } of what the incidents are about (the default for every call)
// Each method returns the data it emitted.
export function createIncidentReporter({ emit = () => null, source, clock = { now: Date.now }, ids = null } = {}) {
    const nextId = ids ?? createUlidFactory({ now: clock.now });
    const counters = { detected: 0, steps: 0, resolved: 0, escalated: 0 };
    const say = (type, data, severity) => {
        try { emit(type, data, { severity, corr: null }); } catch { /* an event must never disturb a recovery */ }
        return data;
    };
    const about = (incident) => ({ incident_id: incident.incident_id, source: incident.source ?? source, kind: incident.kind });
    const note = (more) => (more?.message !== undefined ? { ...more, message: clipText(more.message, 400) } : (more ?? {}));

    return {
        newId: () => nextId(),
        // Something went wrong (or, with is_failure false, something expected happened).
        detected({ kind, incident_id = nextId(), source: about_source = source, is_failure = true, outcome = 'pending', severity = null, ...more }) {
            counters.detected++;
            const incident = { incident_id, source: about_source, kind };
            say('agent.failure', incidentData({ ...about(incident), phase: 'detected', is_failure, outcome, ...note(more) }),
                severity ?? (is_failure ? 'warn' : 'info'));
            return incident;
        },
        // One recovery step: { step, attempt, max, result }.
        step(incident, recovery, { outcome = 'pending', is_failure = true, severity = 'info', ...more } = {}) {
            counters.steps++;
            return say('agent.recovery', incidentData({ ...about(incident), phase: 'recovery_step', is_failure, recovery, outcome, ...note(more) }), severity);
        },
        // The incident is over without the operator.
        resolved(incident, { recovery = null, outcome = 'auto_recovered', is_failure = true, ...more } = {}) {
            counters.resolved++;
            return say('agent.recovery', incidentData({ ...about(incident), phase: 'resolved', is_failure, recovery, outcome, ...note(more) }), 'info');
        },
        // The incident needs the operator. Exactly one such event per incident is the caller's job.
        escalated(incident, { recovery = null, outcome = 'needs_operator', needs_operator = true, ...more } = {}) {
            counters.escalated++;
            return say('agent.failure', incidentData({ ...about(incident), phase: 'escalated', is_failure: true, recovery, outcome, needs_operator, ...note(more) }), 'error');
        },
        stats: () => ({ ...counters }),
    };
}

// The model went away / came back: the incident shape with is_failure false and outcome "expected".
//   reason: desktop_leaving | probe_failed | desktop_available | probe_passed
export function modelAwayData({ incident_id, reason = null, name = 'planner' }) {
    return incidentData({
        incident_id, source: { type: 'service', name }, kind: INCIDENT_KINDS.MODEL_AWAY, phase: 'detected',
        is_failure: false, outcome: 'expected', needs_operator: false, reason,
    });
}
export function modelAvailableData({ incident_id, reason = null, name = 'planner' }) {
    return incidentData({
        incident_id, source: { type: 'service', name }, kind: INCIDENT_KINDS.MODEL_AVAILABLE, phase: 'resolved',
        is_failure: false, outcome: 'expected', needs_operator: false, reason,
    });
}
