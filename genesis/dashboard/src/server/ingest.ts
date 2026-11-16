// Reads the one event stream through a consumer group, checks every event against the
// shared contract, folds it into the live view and writes it to the store.
//
//   - An entry is acknowledged only once it is in Postgres. While Postgres is down the
//     events still reach the live view; they stay "pending" in Redis and are read again
//     (and then stored) as soon as Postgres answers. The same happens after a crash.
//   - An entry that is not a valid event is counted, acknowledged and dropped: reading it
//     again would not make it valid.
//   - Delivery is at-least-once. The live view ignores an entry it has already applied and
//     the store keeps one row per event id.

import type { Entry, GenesisEvent } from '../shared/types.js';
import type { Clock, Store, StreamClient, StreamEntry } from './ports.js';
import type { Live } from './live.js';

export interface IngestConfig {
    stream: string;
    group: string;
    consumer: string;
    batch: number;
    block_ms: number;
    warm_count: number;
}

export const INGEST_DEFAULTS: IngestConfig = Object.freeze({
    stream: 'genesis:events', group: 'dashboard', consumer: 'dashboard-1', batch: 200, block_ms: 2000, warm_count: 2000,
});

export interface IngestStats {
    read: number; applied: number; stored: number; rejected: number; lost: number; duplicates: number;
}

type Validate = (event: unknown) => { ok: boolean; errors: string[] };

// Turns one stream entry into an event. Returns null for anything that is not one.
export function parseEntry(entry: StreamEntry, validate: Validate): GenesisEvent | null {
    const raw = entry.fields?.event;
    if (typeof raw !== 'string') return null;
    let event: unknown;
    try { event = JSON.parse(raw); } catch { return null; }
    return validate(event).ok ? (event as GenesisEvent) : null;
}

export function createIngest({ stream, store, live, validate, clock = { now: Date.now }, config: overrides = {}, warn = console.warn }: {
    stream: StreamClient; store: Store; live: Live; validate: Validate; clock?: Clock;
    config?: Partial<IngestConfig>; warn?: (line: string) => void;
}) {
    const config = { ...INGEST_DEFAULTS, ...overrides };
    const stats: IngestStats = { read: 0, applied: 0, stored: 0, rejected: 0, lost: 0, duplicates: 0 };
    let group_ready = false;
    let has_pending = true;     // not known at start: entries read before a crash may wait
    let stopped = false;

    const iso = () => new Date(clock.now()).toISOString();
    const log = (event: string, message: string) => { try { warn(JSON.stringify({ ts: iso(), level: 'warn', event, message })); } catch { /* never */ } };

    function redisIs(ok: boolean) {
        if (ok && live.health.redis_ok !== true) live.setHealth({ redis_ok: true, redis_down_since: null });
        if (!ok && live.health.redis_ok !== false) {
            live.setHealth({ redis_ok: false, redis_down_since: iso() });
            group_ready = false; // a Redis that came back empty has no group
        }
    }
    function postgresIs(ok: boolean) {
        if (ok && live.health.postgres_ok !== true) live.setHealth({ postgres_ok: true, postgres_down_since: null });
        if (!ok && live.health.postgres_ok !== false) live.setHealth({ postgres_ok: false, postgres_down_since: iso() });
    }

    // Folds, stores and acknowledges one batch. Returns false when the store refused it.
    async function take(batch: StreamEntry[]): Promise<boolean> {
        const done: string[] = [];      // nothing more to do with these: acknowledge
        const valid: Entry[] = [];
        for (const raw of batch) {
            stats.read++;
            if (raw.fields === null) { stats.lost++; done.push(raw.id); continue; }
            const event = parseEntry(raw, validate);
            if (!event) { stats.rejected++; live.health.rejected++; done.push(raw.id); continue; }
            const entry = { sid: raw.id, event };
            if (live.apply(entry)) { stats.applied++; live.health.ingested++; } else stats.duplicates++;
            valid.push(entry);
        }
        let stored = true;
        if (valid.length > 0) {
            try {
                await store.insertEntries(valid);
                stats.stored += valid.length;
                done.push(...valid.map((entry) => entry.sid));
                postgresIs(true);
            } catch (err: any) {
                stored = false;
                has_pending = true;
                if (live.health.postgres_ok !== false) log('dashboard_postgres_down', String(err?.message ?? err));
                postgresIs(false);
            }
        }
        if (done.length > 0) await stream.ack(config.stream, config.group, done);
        return stored;
    }

    // Stores what was read but never acknowledged (Postgres was down, or the process ended).
    async function replayPending(): Promise<number> {
        let from = '0';
        let total = 0;
        for (;;) {
            const batch = await stream.readGroup(config.stream, config.group, config.consumer, { from, count: config.batch });
            if (batch.length === 0) { has_pending = false; break; }
            total += batch.length;
            if (!(await take(batch))) break; // still down: they stay pending
            from = batch[batch.length - 1].id;
        }
        live.health.unstored = has_pending ? Math.max(live.health.unstored, total) : 0;
        return total;
    }

    // One round: pending entries first (oldest first), then what is new. Returns how many
    // entries were read. Rejects when Redis cannot be reached.
    async function step({ block_ms = config.block_ms }: { block_ms?: number } = {}): Promise<number> {
        try {
            if (!group_ready) {
                await stream.ensureGroup(config.stream, config.group);
                group_ready = true;
            }
            let count = 0;
            if (has_pending) count += await replayPending();
            const fresh = await stream.readGroup(config.stream, config.group, config.consumer, { from: '>', count: config.batch, block_ms });
            redisIs(true);
            if (fresh.length > 0) {
                count += fresh.length;
                if (!(await take(fresh))) live.health.unstored += fresh.length;
            }
            return count;
        } catch (err: any) {
            if (live.health.redis_ok !== false) log('dashboard_redis_down', String(err?.message ?? err));
            redisIs(false);
            throw err;
        }
    }

    // Fills the live view at start: from Postgres, or from the stream itself when Postgres
    // is down (the stream keeps the newest events anyway).
    async function warm(): Promise<{ from: 'postgres' | 'redis' | 'nothing'; count: number }> {
        try {
            const entries = await store.latestEntries(config.warm_count);
            postgresIs(true);
            return { from: 'postgres', count: live.warm(entries) };
        } catch (err: any) {
            log('dashboard_postgres_down', String(err?.message ?? err));
            postgresIs(false);
        }
        try {
            const tail = await stream.tail(config.stream, config.warm_count);
            redisIs(true);
            const entries: Entry[] = [];
            for (const raw of tail) {
                const event = parseEntry(raw, validate);
                if (event) entries.push({ sid: raw.id, event });
            }
            return { from: 'redis', count: live.warm(entries) };
        } catch {
            redisIs(false);
            return { from: 'nothing', count: 0 };
        }
    }

    // Postgres is asked now and then even when no event comes, so the health line is true.
    async function checkStore(): Promise<boolean> {
        try { await store.ping(); postgresIs(true); return true; } catch { postgresIs(false); return false; }
    }

    async function run({ retry_ms = 1000, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) } = {}) {
        while (!stopped) {
            try { await step(); } catch { if (!stopped) await sleep(retry_ms); }
        }
    }

    return { step, warm, run, checkStore, stats: () => ({ ...stats }), hasPending: () => has_pending, stop() { stopped = true; } };
}
