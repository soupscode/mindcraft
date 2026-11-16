// In-memory stand-ins for Redis, Postgres, the clock and ntfy, and a maker of valid events.

import type { Alert, AlerterState, AlertStore, DigestRecord, GenesisEvent, Notifier, Push, SendResult, StreamClient, StreamEntry } from '../src/ports.js';
import { createUlidFactory } from '../src/contract.js';

export function fakeClock(start = Date.parse('2026-11-16T12:00:00.000Z')) {
    let now = start;
    return { now: () => now, advance(ms: number) { now += ms; return now; }, set(ms: number) { now = ms; } };
}

// ntfy: records every push; `answers` says how the next sends end (default: delivered).
export function fakeNotifier({ enabled = true } = {}) {
    const self = {
        pushes: [] as Push[],
        answers: [] as SendResult[],
        notifier: {
            enabled: () => enabled,
            async send(push: Push): Promise<SendResult> {
                self.pushes.push(push);
                return self.answers.shift() ?? 'delivered';
            },
        } as Notifier,
        urgent: () => self.pushes.filter((push) => push.priority === 'urgent'),
        text: () => self.pushes.map((push) => `${push.title}\n${push.body}`).join('\n'),
    };
    return self;
}

export function fakeStream(clock = fakeClock()) {
    const entries: StreamEntry[] = [];
    const groups = new Map<string, { delivered: number; pending: Set<string> }>();
    const marks = new Set<string>();
    let counter = 0;
    const self = {
        down: false, entries, marks,
        add(event: unknown, raw?: Record<string, string>) {
            const id = `${clock.now()}-${counter++}`;
            entries.push({ id, fields: raw ?? { event: JSON.stringify(event) } });
            return id;
        },
        pending: (group: string) => [...(groups.get(group)?.pending ?? [])],
        check() { if (self.down) throw new Error('ECONNREFUSED'); },
    };
    const client: StreamClient = {
        async ping() { self.check(); },
        async ensureGroup(_stream, group) { self.check(); if (!groups.has(group)) groups.set(group, { delivered: 0, pending: new Set() }); },
        async readGroup(_stream, group, _consumer, { from, count }) {
            self.check();
            const g = groups.get(group);
            if (!g) throw new Error('NOGROUP');
            if (from !== '>') return entries.filter((entry) => g.pending.has(entry.id) && entry.id > from).slice(0, count);
            const batch = entries.filter((entry) => Number(entry.id.split('-')[1]) >= g.delivered).slice(0, count);
            for (const entry of batch) { g.pending.add(entry.id); g.delivered = Number(entry.id.split('-')[1]) + 1; }
            return batch;
        },
        async ack(_stream, group, ids) { self.check(); for (const id of ids) groups.get(group)?.pending.delete(id); },
        async claim(key) { self.check(); if (marks.has(key)) return false; marks.add(key); return true; },
        async close() {},
    };
    return Object.assign(self, { client });
}

export function memoryAlertStore() {
    const alerts = new Map<string, Alert>();
    const facts = new Map<string, GenesisEvent>();
    const digests = new Map<string, DigestRecord>();
    const batches: { at: string; count: number }[] = [];
    let state: AlerterState | null = null;
    const self = {
        down: false, alerts, facts, digests, batches,
        check() { if (self.down) throw new Error('connection refused'); },
    };
    const between = (value: string, from: Date, to: Date) => Date.parse(value) >= from.getTime() && Date.parse(value) < to.getTime();
    const store: AlertStore = {
        async ping() { self.check(); },
        async saveAlert(alert) { self.check(); alerts.set(alert.id, { ...alert }); },
        async openAlerts() { self.check(); return [...alerts.values()].filter((a) => a.closed_at === null || (a.severity === 'warning' && a.push_state === 'queued')).map((a) => ({ ...a })); },
        async alertsBetween(from, to) { self.check(); return [...alerts.values()].filter((a) => between(a.opened_at, from, to)); },
        async saveState(next) { self.check(); state = JSON.parse(JSON.stringify(next)); },
        async loadState() { self.check(); return state ? JSON.parse(JSON.stringify(state)) : null; },
        async saveFacts(list) { self.check(); for (const fact of list) if (!facts.has(fact.id)) facts.set(fact.id, fact); },
        async factsBetween(from, to) { self.check(); return [...facts.values()].filter((f) => between(f.ts, from, to)).sort((a, b) => (a.ts < b.ts ? -1 : 1)); },
        async saveDigest(digest) { self.check(); if (digests.has(digest.period_end)) return false; digests.set(digest.period_end, { ...digest }); return true; },
        async hasDigest(period_end) { self.check(); return digests.has(period_end); },
        async markDigestPushed(period_end, at) { self.check(); const d = digests.get(period_end); if (d) d.pushed_at = at; },
        async saveBatch(at, count) { self.check(); batches.push({ at, count }); },
        async batchesBetween(from, to) { self.check(); return batches.filter((b) => between(b.at, from, to)).length; },
        async deleteAlertsBefore(cutoff) {
            self.check();
            let gone = 0;
            for (const [id, a] of alerts) if (Date.parse(a.opened_at) < cutoff.getTime() && a.closed_at !== null) { alerts.delete(id); gone++; }
            return gone;
        },
        async deleteFactsBefore(cutoff) {
            self.check();
            let gone = 0;
            for (const [id, f] of facts) if (Date.parse(f.ts) < cutoff.getTime()) { facts.delete(id); gone++; }
            return gone;
        },
        async deleteDigestsBefore(cutoff) {
            self.check();
            let gone = 0;
            for (const [id, d] of digests) if (Date.parse(d.period_end) < cutoff.getTime()) { digests.delete(id); gone++; }
            return gone;
        },
    };
    return Object.assign(self, { store });
}

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

export const idMaker = () => { let n = 0; return () => `a-${++n}`; };
