// In-memory stand-ins for Redis, Postgres and the clock, and a maker of valid events.

import { compareSid, isIncidentEvent } from '../src/shared/fold.js';
import type { Entry, GenesisEvent } from '../src/shared/types.js';
import type { ControlRecord, EventQuery, Store, StreamClient, StreamEntry } from '../src/server/ports.js';
import { createUlidFactory } from '../src/server/contract.js';

export function fakeClock(start = Date.parse('2026-11-16T12:00:00.000Z')) {
    let now = start;
    return { now: () => now, advance(ms: number) { now += ms; return now; }, set(ms: number) { now = ms; } };
}

// A Redis stream with one consumer group: entries, what was delivered, what is pending.
export function fakeStream(clock = fakeClock()) {
    const entries: StreamEntry[] = [];
    const groups = new Map<string, { delivered: number; pending: Map<string, string> }>(); // pending: id -> consumer
    let counter = 0;
    const calls = { ack: [] as string[][], read: 0 };
    const self = {
        down: false,
        entries, calls,
        // XADD as the event hub does it: fields { event, agent, type }
        add(event: unknown, raw?: Record<string, string>): string {
            const id = `${clock.now()}-${counter++}`;
            const e = event as any;
            entries.push({ id, fields: raw ?? { event: JSON.stringify(event), agent: String(e?.agent), type: String(e?.type) } });
            return id;
        },
        trim(keep: number) { entries.splice(0, Math.max(0, entries.length - keep)); },
        pendingIds: (group: string) => [...(groups.get(group)?.pending.keys() ?? [])],
        check() { if (self.down) throw new Error('ECONNREFUSED'); },
    };
    const client: StreamClient = {
        async ping() { self.check(); },
        async ensureGroup(_stream, group) {
            self.check();
            if (!groups.has(group)) groups.set(group, { delivered: 0, pending: new Map() });
        },
        async readGroup(_stream, group, consumer, { from, count }) {
            self.check();
            calls.read++;
            const g = groups.get(group);
            if (!g) throw new Error('NOGROUP');
            if (from === '>') {
                const batch = entries.filter((entry) => Number(entry.id.split('-')[1]) >= g.delivered).slice(0, count);
                for (const entry of batch) { g.pending.set(entry.id, consumer); g.delivered = Number(entry.id.split('-')[1]) + 1; }
                return batch.map((entry) => ({ id: entry.id, fields: entry.fields ? { ...entry.fields } : null }));
            }
            const ids = [...g.pending.entries()].filter(([id, owner]) => owner === consumer && compareSid(id, from) > 0)
                .map(([id]) => id).sort(compareSid).slice(0, count);
            return ids.map((id) => {
                const entry = entries.find((candidate) => candidate.id === id);
                return { id, fields: entry?.fields ? { ...entry.fields } : null };
            });
        },
        async ack(_stream, group, ids) {
            self.check();
            calls.ack.push([...ids]);
            for (const id of ids) groups.get(group)?.pending.delete(id);
        },
        async tail(_stream, count) {
            self.check();
            return entries.slice(-count).map((entry) => ({ id: entry.id, fields: entry.fields ? { ...entry.fields } : null }));
        },
        async close() {},
    };
    return Object.assign(self, { client });
}

// Postgres, as far as the dashboard uses it. `down = true` makes every call reject.
export function memoryStore() {
    const rows = new Map<string, Entry>();                    // event id -> entry
    const incident_rows = new Map<string, GenesisEvent>();
    const controls: ControlRecord[] = [];
    const self = {
        down: false,
        rows, incident_rows, controls,
        calls: { insert: 0, after: 0 },
        planner_calls: new Map<string, Record<string, any>>(),
        skin_rows: new Map<string, any>(),
        digest_rows: [] as Record<string, any>[],
        alert_rows: [] as Record<string, any>[],
        check() { if (self.down) throw new Error('connection refused'); },
    };
    const sorted = () => [...rows.values()].sort((a, b) => compareSid(a.sid, b.sid));
    const store: Store = {
        async ping() { self.check(); },
        async insertEntries(entries) {
            self.check();
            self.calls.insert++;
            for (const entry of entries) {
                if (rows.has(entry.event.id)) continue;
                rows.set(entry.event.id, JSON.parse(JSON.stringify(entry)));
                if (isIncidentEvent(entry.event)) incident_rows.set(entry.event.id, JSON.parse(JSON.stringify(entry.event)));
            }
        },
        async entriesAfter(sid, limit) {
            self.check();
            self.calls.after++;
            return sorted().filter((entry) => compareSid(entry.sid, sid) > 0).slice(0, limit);
        },
        async latestEntries(limit) { self.check(); return sorted().slice(-limit); },
        async searchEvents(query: EventQuery) {
            self.check();
            return sorted().reverse().filter(({ sid, event }) => (!query.agent || event.agent === query.agent)
                && (!query.type || event.type === query.type) && (!query.severity || event.severity === query.severity)
                && (!query.corr || event.corr === query.corr)
                && (!query.q || JSON.stringify(event).toLowerCase().includes(query.q.toLowerCase()))
                && (!query.before || compareSid(sid, query.before) < 0)).slice(0, query.limit);
        },
        async incidentEvents(since) {
            self.check();
            return [...incident_rows.values()].filter((event) => Date.parse(event.ts) >= since.getTime());
        },
        async insertControl(record) { self.check(); controls.unshift(record); },
        async controls(limit) { self.check(); return controls.slice(0, limit); },
        async plannerCall(call_id) { self.check(); return self.planner_calls.get(call_id) ?? null; },
        async agentGoals() { self.check(); return []; },
        async skinPut(record: any) { self.check(); self.skin_rows.set(record.agent, { ...record }); },
        async skin(agent: string) { self.check(); const row = self.skin_rows.get(agent); return row ? { ...row } : null; },
        async skins() { self.check(); return [...self.skin_rows.values()].map((row) => ({ ...row })); },
        async skinState(agent: string, state: any, at: string, detail: string | null) { self.check(); const row = self.skin_rows.get(agent); if (row) Object.assign(row, { state, state_at: at, detail }); },
        async skinClear(agent: string) { self.check(); return self.skin_rows.delete(agent); },
        async alerts() { self.check(); return self.alert_rows; },
        async digests(limit) { self.check(); return self.digest_rows.slice(0, limit); },
        async deleteEventsBefore(cutoff) {
            self.check();
            let gone = 0;
            for (const [id, entry] of rows) if (Date.parse(entry.event.ts) < cutoff.getTime()) { rows.delete(id); gone++; }
            return gone;
        },
        async deleteIncidentEventsBefore(cutoff) {
            self.check();
            let gone = 0;
            for (const [id, event] of incident_rows) if (Date.parse(event.ts) < cutoff.getTime()) { incident_rows.delete(id); gone++; }
            return gone;
        },
        async deleteControlsBefore(cutoff) {
            self.check();
            const before = controls.length;
            for (let i = controls.length - 1; i >= 0; i--) if (Date.parse(controls[i].at) < cutoff.getTime()) controls.splice(i, 1);
            return before - controls.length;
        },
    };
    return Object.assign(self, { store });
}

// Makes valid events the way genesis/events/agent_emit.js does: id, ts and a seq per agent.
export function eventMaker(clock = fakeClock()) {
    let n = 0;
    const ulid = createUlidFactory({ now: clock.now, random: () => ((n++ * 7919) % 1000) / 1000 });
    const seq = new Map<string, number>();
    return function make(agent: string, type: string, data: Record<string, any>, more: Partial<GenesisEvent> = {}): GenesisEvent {
        const next = (seq.get(agent) ?? 0) + 1;
        seq.set(agent, next);
        return { v: 1, id: ulid(), ts: new Date(clock.now()).toISOString(), agent, seq: next, type, corr: null, severity: 'info', data, ...more };
    };
}

export const incident = (id: string, name: string, kind: string, phase: string, more: Record<string, any> = {}) => ({
    incident_id: id, source: { type: 'agent', name }, kind, phase, is_failure: true, recovery: null, outcome: 'pending', needs_operator: false, ...more,
});
