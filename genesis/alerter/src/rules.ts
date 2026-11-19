// The alert rules (decided). One event in, one verdict out; no state is changed here.
//
//   CRITICAL  an incident that needs the operator (escalated, or needs_operator).
//             (A store that is down for 60 seconds is the other critical alert: outage.ts.)
//   WARNING   ONLY what an agent gave up on (decided): an incident whose outcome is "gave_up"
//             and that does not need the operator. Nothing else is a warning any more: not an
//             incident that is still open after a while, not the same thing recovering by
//             itself again and again, not an error-level failure outside an incident.
//   NEVER     the model going away or coming back, the desktop leaving, an agent the operator
//             holds, an intended restart, anything with is_failure false.
//   LOG ONLY  everything else: it is in the dashboard's history, nobody is told.

import type { AlerterState, GenesisEvent, Severity } from './ports.js';
import { kindLabel, safeName } from './text.js';

export type Verdict =
    | { action: 'none'; why: 'log_only' | 'expected' | 'held' | 'gate_away' | 'state' }
    | { action: 'gate'; gate: AlerterState['gate'] }
    | { action: 'hold'; agent: string; held: boolean }
    | { action: 'open'; severity: Severity; key: string; subject: string; kind: string; title: string }
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
        return { action: 'none', why: 'log_only' }; // an incident that is being recovered from: history only
    }

    // an error-level failure outside an incident (a model call that failed): history only (decided)
    return { action: 'none', why: 'log_only' };
}
