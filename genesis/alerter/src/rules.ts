// The alert rules (decided). One event in, one verdict out; no state is changed here.
//
//   CRITICAL  an incident that needs the operator (escalated, or needs_operator).
//             (A store that is down for 60 seconds is the other critical alert: outage.ts.)
//   WARNING   an incident that was given up without the operator being needed; an incident
//             still open after 10 minutes; the same thing recovering by itself 5 times in an
//             hour; an error-level failure that is not an incident (a model call that failed
//             while the model should be there).
//   NEVER     the model going away or coming back, the desktop leaving, an agent the operator
//             holds, an intended restart, anything with is_failure false; and a chat-call
//             failure that only says "the model is unreachable" while the model gate is not
//             open (those are emitted as error events by design).
//   LOG ONLY  everything else: it is in the dashboard's history, nobody is told.

import type { AlerterState, GenesisEvent, Severity } from './ports.js';
import { kindLabel, safeErrorName, safeName } from './text.js';

export type Verdict =
    | { action: 'none'; why: 'log_only' | 'expected' | 'held' | 'gate_away' | 'state' }
    | { action: 'gate'; gate: AlerterState['gate'] }
    | { action: 'hold'; agent: string; held: boolean }
    | { action: 'open'; severity: Severity; key: string; subject: string; kind: string; title: string }
    | { action: 'watch'; key: string; subject: string; kind: string }        // an incident began: a warning if it stays open
    | { action: 'close'; key: string; subject: string; kind: string; recovered: boolean };

export const isIncident = (event: GenesisEvent) =>
    (event.type === 'agent.failure' || event.type === 'agent.recovery') && typeof event.data?.incident_id === 'string';

const GATES: Record<string, AlerterState['gate']> = { model_available: 'available', model_leaving: 'leaving', model_away: 'away' };

export function judge(event: GenesisEvent, state: AlerterState): Verdict {
    const d = event.data ?? {};

    if (event.type === 'agent.state') {
        const name = String(d.state);
        if (GATES[name]) return { action: 'gate', gate: GATES[name] };
        if (name === 'held') return { action: 'hold', agent: event.agent, held: true };
        if (name === 'hold_released') return { action: 'hold', agent: event.agent, held: false };
        return { action: 'none', why: 'state' };
    }

    if (isIncident(event)) {
        if (d.kind === 'model.away') return { action: 'gate', gate: 'away' };
        if (d.kind === 'model.available') return { action: 'gate', gate: 'available' };
        const subject = safeName(d.source?.name);
        const kind = String(d.kind);
        const key = `incident:${String(d.incident_id).slice(0, 80)}`;
        const over = d.phase === 'resolved' || d.outcome === 'auto_recovered';
        if (over) return { action: 'close', key, subject, kind, recovered: d.is_failure === true && d.outcome === 'auto_recovered' };
        if (d.is_failure !== true || d.outcome === 'expected') return { action: 'none', why: 'expected' };
        if (state.held.includes(subject)) return { action: 'none', why: 'held' };
        const label = kindLabel(kind);
        if (d.needs_operator === true || d.phase === 'escalated' || d.outcome === 'needs_operator') {
            return { action: 'open', severity: 'critical', key, subject, kind, title: `${subject} · ${label} · needs operator` };
        }
        if (d.outcome === 'gave_up') return { action: 'open', severity: 'warning', key, subject, kind, title: `${subject} · ${label} · gave up` };
        return { action: 'watch', key, subject, kind };
    }

    if (event.type === 'agent.failure') {
        if (event.severity !== 'error') return { action: 'none', why: 'log_only' };
        const subject = safeName(event.agent);
        const error = safeErrorName(d.error);
        // "the model is unreachable" while the gate is not known to be open is the normal state
        if (d.kind === 'model' && d.error === 'ModelUnavailableError' && state.gate !== 'available') return { action: 'none', why: 'gate_away' };
        if (state.held.includes(subject)) return { action: 'none', why: 'held' };
        const kind = typeof d.kind === 'string' ? d.kind : 'failure';
        return {
            action: 'open', severity: 'warning', key: `failure:${subject}:${kindLabel(kind)}:${error ?? 'error'}`, subject, kind,
            title: `${subject} · ${kindLabel(kind)}${error ? ` · ${error}` : ''}`,
        };
    }

    return { action: 'none', why: 'log_only' };
}
