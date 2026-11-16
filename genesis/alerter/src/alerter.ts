// The alerter's engine: what is open, who has been told, and what waits for the hour.
//
//   - One open alert per problem (its problem_key). More matching events only count up.
//   - A CRITICAL alert pings the phone exactly once, when it opens (or when a warning turns
//     critical). No repeat, no acknowledge. A ping ntfy certainly did not take is tried again
//     (up to 5 times, a minute apart); one whose fate is unknown is never sent a second time.
//   - Warnings wait for the top of the hour and go out together as one quiet push.
//   - Redis or Postgres unreachable for 60 seconds in a row is a critical alert of its own.
//
// It keeps working with either store down: the state is in memory, Postgres is written to
// when it is there (what could not be written is written later), and the one-ping mark is
// also set in Redis so that a restart while Postgres is down does not ping again.

import type { Alert, AlerterState, AlertStore, Clock, GenesisEvent, Notifier, Push, StreamClient } from './ports.js';
import { judge, type Verdict } from './rules.js';
import { kindLabel } from './text.js';

export const HOUR_MS = 60 * 60 * 1000;

export const ALERTER_DEFAULTS = Object.freeze({
    outage_ms: 60 * 1000,              // decided: a store down this long is critical
    pending_warning_ms: 10 * 60 * 1000, // an incident still open after this long is a warning
    recurring_count: 5,                // the same thing recovering this often within an hour is a warning
    quiet_close_ms: HOUR_MS,           // a failure alert with no new event for this long closes
    push_attempts: 5,
    push_retry_ms: 60 * 1000,
    claim_ttl_s: 90 * 24 * 3600,
});

export interface AlerterStats {
    events: number; criticals: number; warnings: number; pings: number; batches: number;
    never: number; log_only: number; suppressed: Record<string, number>;
}

export function createAlerter({ notifier, store, marks = null, clock = { now: Date.now }, ids, warn = console.warn, ...options }: {
    notifier: Notifier; store: AlertStore; marks?: Pick<StreamClient, 'claim'> | null; clock?: Clock; ids: () => string;
    warn?: (line: string) => void;
} & Partial<typeof ALERTER_DEFAULTS>) {
    const config = { ...ALERTER_DEFAULTS };
    for (const key of Object.keys(ALERTER_DEFAULTS) as (keyof typeof ALERTER_DEFAULTS)[]) {
        if (options[key] !== undefined) (config as any)[key] = options[key];
    }
    const state: AlerterState = { gate: 'unknown', held: [] };
    const open = new Map<string, Alert>();                 // problem_key -> the one open alert
    const queued: Alert[] = [];                            // warnings that wait for the hourly push
    const watching = new Map<string, { since: number; subject: string; kind: string }>(); // incidents that began
    const recovered = new Map<string, number[]>();         // subject:kind -> when it recovered by itself
    const retries: { alert: Alert; push: Push; attempts: number; next_at: number }[] = [];
    const unsaved = new Map<string, Alert>();              // alerts Postgres has not got yet
    const down_since: Record<'redis' | 'postgres', number | null> = { redis: null, postgres: null };
    const stats: AlerterStats = { events: 0, criticals: 0, warnings: 0, pings: 0, batches: 0, never: 0, log_only: 0, suppressed: {} };
    let state_dirty = false;
    let next_batch_at = Math.floor(clock.now() / HOUR_MS) * HOUR_MS + HOUR_MS;

    const iso = (ms = clock.now()) => new Date(ms).toISOString();
    const log = (event: string, more: Record<string, unknown> = {}) => { try { warn(JSON.stringify({ ts: iso(), level: 'warn', event, ...more })); } catch { /* never */ } };

    async function save(alert: Alert) {
        unsaved.set(alert.id, alert);
        await flush();
    }
    // Writes what Postgres has not got yet. Quietly gives up while it is down.
    async function flush() {
        for (const [id, alert] of [...unsaved]) {
            try {
                await store.saveAlert({ ...alert });
            } catch (err: any) {
                // 23505: Postgres already holds an open alert for this problem (from an earlier life of this process)
                if (err?.code !== '23505') return; // Postgres is down: kept in memory, written later
            }
            if (unsaved.get(id) === alert) unsaved.delete(id);
        }
        if (state_dirty) {
            try { await store.saveState({ gate: state.gate, held: [...state.held] }); state_dirty = false; } catch { /* later */ }
        }
    }

    // The one ping of a critical alert.
    async function ping(alert: Alert, push: Push) {
        if (alert.push_state === 'sent' || alert.push_state === 'unconfirmed' || alert.push_state === 'sending') return;
        if (!notifier.enabled()) { alert.push_state = 'off'; log('alerter_no_topic', { alert: alert.title }); await save(alert); return; }
        // the mark in Redis survives a restart of this process, also while Postgres is down
        if (marks && alert.push_state !== 'failed') {
            try {
                if (!(await marks.claim(`genesis:alerter:pinged:${alert.problem_key}`, config.claim_ttl_s))) {
                    alert.push_state = 'sent'; // an earlier life of this process sent it
                    await save(alert);
                    return;
                }
            } catch { /* Redis is down: memory and Postgres decide */ }
        }
        alert.push_state = 'sending';
        const result = await notifier.send(push);
        stats.pings++;
        if (result === 'delivered') { alert.push_state = 'sent'; alert.pushed_at = iso(); }
        else if (result === 'unknown') { alert.push_state = 'unconfirmed'; alert.pushed_at = iso(); log('alerter_ping_unconfirmed', { alert: alert.title }); }
        else {
            alert.push_state = 'failed';
            const entry = retries.find((retry) => retry.alert === alert);
            if (entry) { entry.attempts++; entry.next_at = clock.now() + config.push_retry_ms; }
            else retries.push({ alert, push, attempts: 1, next_at: clock.now() + config.push_retry_ms });
            log('alerter_ping_refused', { alert: alert.title });
        }
        await save(alert);
    }

    async function openAlert(v: Extract<Verdict, { action: 'open' }>, more: { body?: string } = {}) {
        const now = iso();
        let alert = open.get(v.key);
        if (alert) {
            alert.occurrences++;
            alert.updated_at = now;
            if (alert.severity === 'warning' && v.severity === 'critical') {
                // the same problem got worse: still one alert, and now its one ping
                alert.severity = 'critical';
                alert.title = v.title;
                const at = queued.indexOf(alert);
                if (at >= 0) queued.splice(at, 1);
                stats.criticals++;
                await ping(alert, { title: 'Genesis critical', body: more.body ?? v.title, priority: 'urgent', tags: ['rotating_light'] });
                return alert;
            }
            await save(alert);
            return alert;
        }
        alert = {
            id: ids(), problem_key: v.key, severity: v.severity, title: v.title, subject: v.subject, kind: v.kind,
            opened_at: now, updated_at: now, closed_at: null, occurrences: 1, push_state: 'queued', pushed_at: null,
        };
        open.set(v.key, alert);
        watching.delete(v.key);
        if (v.severity === 'critical') {
            stats.criticals++;
            await ping(alert, { title: 'Genesis critical', body: more.body ?? v.title, priority: 'urgent', tags: ['rotating_light'] });
        } else {
            stats.warnings++;
            queued.push(alert);
            await save(alert);
        }
        return alert;
    }

    async function closeAlert(key: string) {
        watching.delete(key);
        const alert = open.get(key);
        if (!alert) return;
        open.delete(key);
        alert.closed_at = iso();
        alert.updated_at = alert.closed_at;
        await save(alert);
    }

    const suppress = (why: string) => { stats.never++; stats.suppressed[why] = (stats.suppressed[why] ?? 0) + 1; };

    // One event from the stream.
    async function onEvent(event: GenesisEvent) {
        stats.events++;
        const verdict = judge(event, state);
        switch (verdict.action) {
            case 'gate':
                if (state.gate !== verdict.gate) { state.gate = verdict.gate; state_dirty = true; }
                suppress('model_gate');
                break;
            case 'hold': {
                const at = state.held.indexOf(verdict.agent);
                if (verdict.held && at < 0) state.held.push(verdict.agent);
                if (!verdict.held && at >= 0) state.held.splice(at, 1);
                state_dirty = true;
                suppress('held');
                break;
            }
            case 'open': await openAlert(verdict); break;
            case 'watch':
                if (!open.has(verdict.key) && !watching.has(verdict.key)) watching.set(verdict.key, { since: clock.now(), subject: verdict.subject, kind: verdict.kind });
                else if (open.has(verdict.key)) { const alert = open.get(verdict.key)!; alert.occurrences++; alert.updated_at = iso(); }
                stats.log_only++;
                break;
            case 'close': {
                await closeAlert(verdict.key);
                if (verdict.recovered) {
                    const key = `${verdict.subject}:${verdict.kind}`;
                    const times = (recovered.get(key) ?? []).filter((at) => at > clock.now() - HOUR_MS);
                    times.push(clock.now());
                    recovered.set(key, times);
                    if (times.length >= config.recurring_count && !state.held.includes(verdict.subject)) {
                        await openAlert({ action: 'open', severity: 'warning', key: `recurring:${key}`, subject: verdict.subject, kind: verdict.kind,
                            title: `${verdict.subject} · ${kindLabel(verdict.kind)} · ${times.length} times in an hour` });
                    }
                }
                stats.log_only++;
                break;
            }
            default:
                if (verdict.why === 'log_only' || verdict.why === 'state') stats.log_only++; else suppress(verdict.why);
        }
        if (state_dirty) await flush();
    }

    // Told every few seconds whether each store answered. Down for 60 seconds in a row: critical, once.
    async function observeStores(seen: { redis: boolean; postgres: boolean }) {
        const now = clock.now();
        for (const name of ['redis', 'postgres'] as const) {
            const key = `store:${name}`;
            const label = name === 'redis' ? 'Redis' : 'Postgres';
            if (seen[name]) {
                down_since[name] = null;
                if (open.has(key)) await closeAlert(key);
                continue;
            }
            down_since[name] ??= now;
            if (now - down_since[name]! >= config.outage_ms && !open.has(key)) {
                await openAlert({ action: 'open', severity: 'critical', key, subject: label, kind: `store.${name}`, title: `${label} unreachable` },
                    { body: `${label} has been unreachable for ${Math.round(config.outage_ms / 1000)} seconds.` });
            }
        }
    }

    // The top of the hour: every warning that waits goes out in ONE quiet push.
    async function hourly() {
        stats.batches++;
        const batch = queued.splice(0, queued.length);
        if (batch.length === 0) return 0;
        if (!notifier.enabled()) {
            for (const alert of batch) { alert.push_state = 'off'; await save(alert); }
            return 0;
        }
        const lines = batch.slice(0, 8).map((alert) => `${alert.title}${alert.occurrences > 1 ? ` ×${alert.occurrences}` : ''}`);
        if (batch.length > lines.length) lines.push(`and ${batch.length - lines.length} more`);
        const result = await notifier.send({
            title: `Genesis · ${batch.length} warning${batch.length === 1 ? '' : 's'}`, body: lines.join('\n'), priority: 'low', tags: ['warning'],
        });
        if (result === 'refused') { queued.unshift(...batch); return 0; } // they wait for the next hour
        const now = iso();
        for (const alert of batch) { alert.push_state = 'batched'; alert.pushed_at = now; await save(alert); }
        try { await store.saveBatch(now, batch.length); } catch { /* Postgres is down: the digest counts one push less */ }
        return batch.length;
    }

    // Called every few seconds. Everything that depends on time happens here.
    async function tick() {
        const now = clock.now();
        // a ping ntfy refused is tried again; never one that may have gone out
        for (const retry of [...retries]) {
            if (retry.next_at > now) continue;
            if (retry.alert.push_state !== 'failed' || retry.attempts >= config.push_attempts) { retries.splice(retries.indexOf(retry), 1); continue; }
            await ping(retry.alert, retry.push);
            if (retry.alert.push_state !== 'failed') retries.splice(retries.indexOf(retry), 1);
        }
        // an incident that is still open after 10 minutes
        for (const [key, watched] of [...watching]) {
            if (now - watched.since < config.pending_warning_ms) continue;
            watching.delete(key);
            if (state.held.includes(watched.subject)) continue;
            await openAlert({ action: 'open', severity: 'warning', key, subject: watched.subject, kind: watched.kind,
                title: `${watched.subject} · ${kindLabel(watched.kind)} · still recovering` });
        }
        // a failure that has not come again for an hour is over: the next one is a new alert
        for (const [key, alert] of [...open]) {
            if ((key.startsWith('failure:') || key.startsWith('recurring:')) && now - Date.parse(alert.updated_at) >= config.quiet_close_ms) await closeAlert(key);
        }
        while (now >= next_batch_at) {
            next_batch_at += HOUR_MS;
            if (now < next_batch_at) await hourly();
        }
        await flush();
    }

    // What an earlier life of this process left in Postgres.
    async function restore() {
        try {
            const saved = await store.loadState();
            if (saved) { state.gate = saved.gate; state.held = [...saved.held]; }
            for (const alert of await store.openAlerts()) {
                if (alert.closed_at === null) open.set(alert.problem_key, alert);
                if (alert.severity === 'warning' && alert.push_state === 'queued') queued.push(alert);
            }
            return true;
        } catch { return false; }
    }

    return {
        onEvent, observeStores, tick, hourly, restore, flush,
        state: () => ({ gate: state.gate, held: [...state.held] }),
        openAlerts: () => [...open.values()],
        queuedWarnings: () => [...queued],
        stats: () => ({ ...stats, suppressed: { ...stats.suppressed } }),
    };
}
