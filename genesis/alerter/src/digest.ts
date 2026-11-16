// The daily digest (decided): produced at 18:00 in the configured time zone, about exactly
// the 24 hours before that instant. It says, per agent, how many goals were completed, how
// often the agent died and how long it was on its routine; the incidents by outcome; how
// much of the time the model was there; and how many alerts there were.
//
// The alerter keeps its own small copy of the events a digest needs ("facts"), so the
// digest does not depend on the dashboard having been up.

import type { Alert, AlertStore, Clock, DigestRecord, GenesisEvent, Notifier } from './ports.js';
import { isIncident } from './rules.js';
import { lastLocalHour, localDate } from './tz.js';
import { kindLabel, safeName } from './text.js';

export const DAY_MS = 24 * 60 * 60 * 1000;
// how far before the window the facts are read, to know what state the window began in
export const LOOKBACK_MS = 6 * DAY_MS;

const FACT_STATES = ['goal_completed', 'on_routine', 'planning', 'respawned', 'parked', 'model_available', 'model_leaving', 'model_away'];
const SERVICES = ['planner', 'supervisor'];

// What the alerter keeps of an event for the digest, or null when the digest has no use for it.
// Only what is counted is kept: no outputs, no messages.
export function digestFact(event: GenesisEvent): GenesisEvent | null {
    const d = event.data ?? {};
    if (event.type === 'agent.state' && FACT_STATES.includes(d.state)) {
        const detail = typeof d.detail?.deaths === 'number' ? { deaths: d.detail.deaths } : undefined;
        return { ...event, corr: null, data: detail ? { state: d.state, detail } : { state: d.state } };
    }
    if (isIncident(event)) {
        return { ...event, corr: null, data: {
            incident_id: d.incident_id, source: d.source, kind: d.kind, phase: d.phase, is_failure: d.is_failure,
            recovery: null, outcome: d.outcome, needs_operator: d.needs_operator,
        } };
    }
    if (event.type === 'skill.result') return { ...event, corr: null, data: { ok: d.ok === true } };
    return null;
}

interface Change { at: number; state: string }

// How long each state lasted inside [start, end), given every change (also those before start).
// The time before the first known change is "unknown".
function spans(changes: Change[], start: number, end: number): { from: number; to: number; state: string }[] {
    const sorted = [...changes].sort((a, b) => a.at - b.at);
    let state = 'unknown';
    let from = start;
    const out: { from: number; to: number; state: string }[] = [];
    for (const change of sorted) {
        if (change.at <= start) { state = change.state; continue; }
        if (change.at >= end) break;
        if (change.state === state) continue;
        out.push({ from, to: change.at, state });
        from = change.at;
        state = change.state;
    }
    out.push({ from, to: end, state });
    return out.filter((span) => span.to > span.from);
}

const total = (list: { from: number; to: number; state: string }[], state: string) =>
    list.filter((span) => span.state === state).reduce((sum, span) => sum + (span.to - span.from), 0);

export interface DigestBody {
    period_start: string;
    period_end: string;
    tz: string;
    local_date: string;
    totals: { goals: number; deaths: number; incidents: number; model_pct: number | null; critical: number; warnings: number };
    agents: { name: string; goals: number; deaths: number; skills: number; routine_ms: number; model_led_ms: number; unknown_ms: number }[];
    incidents: { total: number; by_outcome: Record<string, { count: number; kinds: Record<string, number> }> };
    model: { available_ms: number; away_ms: number; unknown_ms: number; pct: number | null; away: { from: string; to: string; ms: number }[] };
    alerts: { critical: number; warnings: number; warning_pushes: number };
}

// The digest of [start, end). `facts` may reach back before `start` (and should: LOOKBACK_MS).
export function buildDigest({ facts, alerts, warning_pushes, start, end, tz, roster }: {
    facts: GenesisEvent[]; alerts: Alert[]; warning_pushes: number; start: number; end: number; tz: string; roster: string[];
}): DigestBody {
    const at = (event: GenesisEvent) => Date.parse(event.ts);
    const inside = (event: GenesisEvent) => at(event) >= start && at(event) < end;
    const states = facts.filter((event) => event.type === 'agent.state');

    // the model gate: its own events, and the supervisor's away / available incidents
    const gate_changes: Change[] = [];
    for (const event of facts) {
        if (event.type === 'agent.state' && String(event.data.state).startsWith('model_')) {
            gate_changes.push({ at: at(event), state: event.data.state === 'model_available' ? 'available' : 'away' });
        } else if (isIncident(event) && (event.data.kind === 'model.away' || event.data.kind === 'model.available')) {
            gate_changes.push({ at: at(event), state: event.data.kind === 'model.available' ? 'available' : 'away' });
        }
    }
    const gate = spans(gate_changes, start, end);
    const available_ms = total(gate, 'available');
    const away_ms = total(gate, 'away');
    const known = available_ms + away_ms;
    const pct = known > 0 ? Math.round((available_ms / known) * 100) : null;

    const names = [...roster];
    for (const event of facts) if (inside(event) && !SERVICES.includes(event.agent) && !names.includes(event.agent)) names.push(event.agent);

    const agents = names.map((name) => {
        const mine = states.filter((event) => event.agent === name);
        const own = spans(mine.filter((event) => event.data.state === 'on_routine' || event.data.state === 'planning')
            .map((event) => ({ at: at(event), state: event.data.state === 'on_routine' ? 'routine' : 'model' })), start, end);
        // where the agent itself has said nothing yet, the model gate decides: away means routine
        let routine_ms = 0, model_led_ms = 0, unknown_ms = 0;
        for (const span of own) {
            if (span.state === 'routine') routine_ms += span.to - span.from;
            else if (span.state === 'model') model_led_ms += span.to - span.from;
            else {
                const within = spans(gate_changes, span.from, span.to);
                routine_ms += total(within, 'away');
                model_led_ms += total(within, 'available');
                unknown_ms += total(within, 'unknown');
            }
        }
        const in_window = facts.filter((event) => event.agent === name && inside(event));
        return {
            name: safeName(name),
            goals: in_window.filter((event) => event.type === 'agent.state' && event.data.state === 'goal_completed').length,
            // one "respawned" or "parked" state per death (genesis/agent/runtime.js, died)
            deaths: in_window.filter((event) => event.type === 'agent.state' && (event.data.state === 'respawned' || event.data.state === 'parked') && event.data.detail?.deaths !== undefined).length,
            skills: in_window.filter((event) => event.type === 'skill.result').length,
            routine_ms, model_led_ms, unknown_ms,
        };
    });

    // incidents that had an event inside the window, by how they stood at its end
    const incidents = new Map<string, { kind: string; outcome: string; is_failure: boolean; needs_operator: boolean; touched: boolean; last: number }>();
    for (const event of [...facts].sort((a, b) => at(a) - at(b))) {
        if (!isIncident(event) || at(event) >= end) continue;
        const d = event.data;
        if (d.kind === 'model.available') { const away = incidents.get(d.incident_id); if (away && inside(event)) away.touched = true; continue; }
        const known_incident = incidents.get(d.incident_id) ?? { kind: String(d.kind), outcome: 'pending', is_failure: false, needs_operator: false, touched: false, last: 0 };
        known_incident.outcome = String(d.outcome);
        known_incident.is_failure = known_incident.is_failure || d.is_failure === true;
        known_incident.needs_operator = known_incident.needs_operator || d.needs_operator === true;
        known_incident.touched = known_incident.touched || inside(event);
        known_incident.last = at(event);
        incidents.set(d.incident_id, known_incident);
    }
    const by_outcome: DigestBody['incidents']['by_outcome'] = {};
    let incident_total = 0;
    for (const incident of incidents.values()) {
        if (!incident.touched) continue;
        incident_total++;
        const group = !incident.is_failure ? 'expected' : incident.needs_operator ? 'needs_operator' : incident.outcome;
        by_outcome[group] ??= { count: 0, kinds: {} };
        by_outcome[group].count++;
        const label = kindLabel(incident.kind);
        by_outcome[group].kinds[label] = (by_outcome[group].kinds[label] ?? 0) + 1;
    }

    const critical = alerts.filter((alert) => alert.severity === 'critical').length;
    const warnings = alerts.filter((alert) => alert.severity === 'warning').length;
    return {
        period_start: new Date(start).toISOString(), period_end: new Date(end).toISOString(), tz, local_date: localDate(end, tz),
        totals: {
            goals: agents.reduce((sum, agent) => sum + agent.goals, 0), deaths: agents.reduce((sum, agent) => sum + agent.deaths, 0),
            incidents: incident_total, model_pct: pct, critical, warnings,
        },
        agents,
        incidents: { total: incident_total, by_outcome },
        model: {
            available_ms, away_ms, unknown_ms: total(gate, 'unknown'), pct,
            away: gate.filter((span) => span.state === 'away').map((span) => ({ from: new Date(span.from).toISOString(), to: new Date(span.to).toISOString(), ms: span.to - span.from })),
        },
        alerts: { critical, warnings, warning_pushes },
    };
}

// The one push of a digest: numbers only.
export function digestPush(body: DigestBody): { title: string; body: string } {
    const t = body.totals;
    const operator = body.incidents.by_outcome.needs_operator?.count ?? 0;
    return {
        title: `Genesis digest · ${body.local_date}`,
        body: [
            `Goals ${t.goals} · Deaths ${t.deaths}`,
            `Incidents ${t.incidents}${operator > 0 ? ` (${operator} for the operator)` : ''}`,
            `Model ${t.model_pct === null ? 'unknown' : `${t.model_pct}%`}`,
            `Alerts: ${t.critical} critical, ${t.warnings} warning${t.warnings === 1 ? '' : 's'}`,
        ].join('\n'),
    };
}

// Keeps the facts (in Postgres, and the newest in memory for when Postgres is down) and
// writes the digest when its hour has come.
export function createDigestJob({ store, notifier, clock = { now: Date.now }, tz, hour = 18, roster, catch_up_ms = 12 * 60 * 60 * 1000, memory_max = 30000 }: {
    store: AlertStore; notifier: Notifier; clock?: Clock; tz: string; hour?: number; roster: string[]; catch_up_ms?: number; memory_max?: number;
}) {
    const started_at = clock.now();
    const memory: GenesisEvent[] = [];         // every fact of the last days, bounded
    const unsaved: GenesisEvent[] = [];        // facts Postgres has not got yet
    const done = new Set<string>();            // period ends a digest exists for
    let last: DigestRecord | null = null;
    let not_stored: DigestRecord | null = null; // a digest made while Postgres was down

    async function flush() {
        if (not_stored) {
            try { await store.saveDigest(not_stored); not_stored = null; } catch { /* still down */ }
        }
        if (unsaved.length === 0) return;
        const batch = unsaved.slice(0, 500);
        try { await store.saveFacts(batch); unsaved.splice(0, batch.length); } catch { /* Postgres is down: kept for later */ }
    }

    async function produce(end: number): Promise<DigestRecord | null> {
        const start = end - DAY_MS; // exactly 24 hours, whatever the clocks on the wall did in between
        const key = new Date(end).toISOString();
        let facts: GenesisEvent[];
        let alerts: Alert[] = [];
        let pushes = 0;
        let stored = true;
        try {
            await flush();
            if (await store.hasDigest(key)) { done.add(key); return null; }
            facts = await store.factsBetween(new Date(start - LOOKBACK_MS), new Date(end));
            // what Postgres has not got yet still counts
            const have = new Set(facts.map((fact) => fact.id));
            facts.push(...unsaved.filter((fact) => !have.has(fact.id) && Date.parse(fact.ts) < end));
            alerts = await store.alertsBetween(new Date(start), new Date(end));
            pushes = await store.batchesBetween(new Date(start), new Date(end));
        } catch {
            stored = false; // Postgres is down: the digest is made from memory and still pushed
            facts = memory.filter((fact) => Date.parse(fact.ts) >= start - LOOKBACK_MS && Date.parse(fact.ts) < end);
        }
        // nothing ran in that window and this process was not up for it: no digest about nothing
        if (end < started_at && !facts.some((fact) => Date.parse(fact.ts) >= start)) { done.add(key); return null; }
        const body = buildDigest({ facts, alerts, warning_pushes: pushes, start, end, tz, roster });
        const record: DigestRecord = { period_end: key, period_start: body.period_start, tz, local_date: body.local_date, body, created_at: new Date(clock.now()).toISOString(), pushed_at: null };
        if (stored) {
            try { if (!(await store.saveDigest(record))) { done.add(key); return null; } } catch { stored = false; }
        }
        done.add(key);
        last = record;
        if (!stored) not_stored = record;
        if (notifier.enabled()) {
            const push = digestPush(body);
            const result = await notifier.send({ ...push, priority: 'default', tags: ['scroll'] });
            if (result !== 'refused') {
                record.pushed_at = new Date(clock.now()).toISOString();
                if (stored) { try { await store.markDigestPushed(key, record.pushed_at); } catch { /* told anyway */ } }
            }
        }
        return record;
    }

    return {
        // One event from the stream: kept when a digest will need it.
        async onEvent(event: GenesisEvent) {
            const fact = digestFact(event);
            if (!fact) return;
            memory.push(fact);
            if (memory.length > memory_max) memory.splice(0, memory.length - memory_max);
            unsaved.push(fact);
            if (unsaved.length > memory_max) unsaved.splice(0, unsaved.length - memory_max);
            if (unsaved.length >= 50) await flush();
        },
        // Called every few seconds: writes the digest of the last 18:00 if there is none yet.
        async tick(): Promise<DigestRecord | null> {
            await flush();
            const now = clock.now();
            const end = lastLocalHour(now, tz, hour);
            if (done.has(new Date(end).toISOString()) || now - end > catch_up_ms) return null;
            return produce(end);
        },
        produce,
        flush,
        last: () => last,
        unsaved: () => unsaved.length,
    };
}
