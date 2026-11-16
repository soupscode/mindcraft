// The Postgres side of the dashboard.
//
// NOT RUN AGAINST A REAL POSTGRES in the tests (there is no server in the build
// environment): they use the in-memory store of test/fakes.ts, and check with a recording
// pool that every statement here passes as many values as it has placeholders.
//
// `pool` is a pg.Pool, or anything with query(text, values) -> Promise<{ rows, rowCount }>
// and connect() -> client with query() and release().

import type { Entry, GenesisEvent } from '../shared/types.js';
import { isIncidentEvent } from '../shared/fold.js';
import type { ControlRecord, EventQuery, Store } from './ports.js';

export interface PgPool {
    query(text: string, values?: any[]): Promise<{ rows: any[]; rowCount?: number | null }>;
    connect(): Promise<{ query(text: string, values?: any[]): Promise<{ rows: any[]; rowCount?: number | null }>; release(): void }>;
}

export async function createPgPool({ url, max = 6, connect_timeout_ms = 5000 }: { url: string; max?: number; connect_timeout_ms?: number }): Promise<PgPool & { end(): Promise<void> }> {
    const pg: any = await import('pg');
    const Pool = pg.Pool ?? pg.default?.Pool;
    const pool = new Pool({ connectionString: url, max, connectionTimeoutMillis: connect_timeout_ms, statement_timeout: 15000 });
    pool.on('error', () => { /* an idle connection broke: the next query reconnects */ });
    return pool;
}

const UNDEFINED_TABLE = '42P01';

// agent, type and every text value inside data, as one line for the full-text index
export function searchText(event: GenesisEvent, max = 4000): string {
    const parts: string[] = [event.agent, event.type];
    const walk = (value: unknown, depth: number) => {
        if (parts.length > 200 || depth > 5) return;
        if (typeof value === 'string') parts.push(value);
        else if (typeof value === 'number') parts.push(String(value));
        else if (Array.isArray(value)) value.forEach((item) => walk(item, depth + 1));
        else if (value && typeof value === 'object') Object.values(value).forEach((item) => walk(item, depth + 1));
    };
    walk(event.data, 0);
    return parts.join(' ').slice(0, max);
}

export function splitSid(sid: string): [string, string] {
    const [ms, n = '0'] = sid.split('-');
    return [ms, n];
}

const EVENT_COLUMNS = 'id, stream_ms, stream_n, ts, agent, seq, type, corr, severity, data';

function rowToEntry(row: any): Entry {
    return {
        sid: `${row.stream_ms}-${row.stream_n}`,
        event: {
            v: 1, id: row.id, ts: new Date(row.ts).toISOString(), agent: row.agent, seq: Number(row.seq), type: row.type,
            corr: row.corr, severity: row.severity, data: row.data,
        },
    };
}

// "($1, $2), ($3, $4)" for `rows` rows of `width` values; `casts` names the columns that need one
export function placeholders(rows: number, width: number, casts: Record<number, string> = {}): string {
    const groups: string[] = [];
    for (let r = 0; r < rows; r++) {
        const cells: string[] = [];
        for (let c = 0; c < width; c++) cells.push(`$${r * width + c + 1}${casts[c] ?? ''}`);
        groups.push(`(${cells.join(', ')})`);
    }
    return groups.join(', ');
}

export function createPgStore(pool: PgPool): Store {
    async function optional<T>(fallback: T, run: () => Promise<T>): Promise<T> {
        try { return await run(); } catch (err: any) {
            if (err?.code === UNDEFINED_TABLE) return fallback; // the other service has not made its table yet
            throw err;
        }
    }
    async function remove(text: string, cutoff: Date): Promise<number> {
        const result = await pool.query(text, [cutoff.toISOString()]);
        return result.rowCount ?? 0;
    }

    return {
        async ping() { await pool.query('SELECT 1'); },

        async insertEntries(entries) {
            if (entries.length === 0) return;
            const values: any[] = [];
            for (const { sid, event } of entries) {
                const [ms, n] = splitSid(sid);
                values.push(event.id, ms, n, event.ts, event.agent, event.seq, event.type, event.corr, event.severity,
                    JSON.stringify(event.data), searchText(event));
            }
            const incidents = entries.filter((entry) => isIncidentEvent(entry.event));
            const incident_values: any[] = [];
            for (const { event } of incidents) incident_values.push(event.id, String(event.data.incident_id), event.ts, JSON.stringify(event));

            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                await client.query(
                    `INSERT INTO dashboard_events (${EVENT_COLUMNS}, search_text)
                     VALUES ${placeholders(entries.length, 11, { 9: '::jsonb' })}
                     ON CONFLICT (id) DO NOTHING`, values);
                if (incidents.length > 0) {
                    await client.query(
                        `INSERT INTO dashboard_incident_events (id, incident_id, ts, event)
                         VALUES ${placeholders(incidents.length, 4, { 3: '::jsonb' })}
                         ON CONFLICT (id) DO NOTHING`, incident_values);
                }
                await client.query('COMMIT');
            } catch (err) {
                try { await client.query('ROLLBACK'); } catch { /* the connection is gone */ }
                throw err;
            } finally {
                client.release();
            }
        },

        async entriesAfter(sid, limit) {
            const [ms, n] = splitSid(sid);
            const { rows } = await pool.query(
                `SELECT ${EVENT_COLUMNS} FROM dashboard_events
                 WHERE (stream_ms, stream_n) > ($1::bigint, $2::bigint)
                 ORDER BY stream_ms ASC, stream_n ASC LIMIT $3`, [ms, n, limit]);
            return rows.map(rowToEntry);
        },

        async latestEntries(limit) {
            const { rows } = await pool.query(
                `SELECT ${EVENT_COLUMNS} FROM dashboard_events ORDER BY stream_ms DESC, stream_n DESC LIMIT $1`, [limit]);
            return rows.map(rowToEntry).reverse();
        },

        async searchEvents(query: EventQuery) {
            const where: string[] = [];
            const values: any[] = [];
            const add = (clause: (n: number) => string, ...more: any[]) => {
                where.push(clause(values.length + 1));
                values.push(...more);
            };
            if (query.agent) add((n) => `agent = $${n}`, query.agent);
            if (query.type) add((n) => `type = $${n}`, query.type);
            if (query.severity) add((n) => `severity = $${n}`, query.severity);
            if (query.corr) add((n) => `corr = $${n}`, query.corr);
            if (query.q) add((n) => `to_tsvector('simple', search_text) @@ plainto_tsquery('simple', $${n})`, query.q);
            if (query.before) {
                const [ms, n] = splitSid(query.before);
                add((i) => `(stream_ms, stream_n) < ($${i}::bigint, $${i + 1}::bigint)`, ms, n);
            }
            values.push(query.limit);
            const { rows } = await pool.query(
                `SELECT ${EVENT_COLUMNS} FROM dashboard_events
                 ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY stream_ms DESC, stream_n DESC LIMIT $${values.length}`, values);
            return rows.map(rowToEntry);
        },

        async incidentEvents(since) {
            const { rows } = await pool.query(
                'SELECT event FROM dashboard_incident_events WHERE ts >= $1 ORDER BY ts ASC LIMIT 20000', [since.toISOString()]);
            return rows.map((row) => row.event as GenesisEvent);
        },

        async insertControl(record: ControlRecord) {
            await pool.query(
                `INSERT INTO dashboard_controls (id, at, actor, origin, action, target, ok, detail)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING`,
                [record.id, record.at, record.actor, record.origin, record.action, record.target, record.ok, record.detail]);
        },

        async controls(limit) {
            const { rows } = await pool.query(
                'SELECT id, at, actor, origin, action, target, ok, detail FROM dashboard_controls ORDER BY at DESC LIMIT $1', [limit]);
            return rows.map((row) => ({ ...row, at: new Date(row.at).toISOString() }));
        },

        // ---- tables of other services (read only) ----

        plannerCall: (call_id) => optional(null, async () => {
            const { rows } = await pool.query(
                `SELECT call_id, request_id, agent, call_trigger, context, options_offered, raw_output, chosen_ids, valid, attempt,
                        queue_wait_ms, latency_ms, prompt_tokens, completion_tokens, model, outcome, errors, started_at
                 FROM planner_calls WHERE call_id = $1`, [call_id]);
            return rows[0] ?? null;
        }),

        agentGoals: () => optional([], async () => {
            const { rows } = await pool.query('SELECT agent, long_term, short_term, updated_at FROM agent_goals');
            return rows.map((row) => ({ ...row, updated_at: new Date(row.updated_at).toISOString() }));
        }),

        alerts: (since, limit) => optional([], async () => {
            const { rows } = await pool.query(
                `SELECT id, problem_key, severity, title, subject, kind, opened_at, updated_at, closed_at, occurrences, push_state, pushed_at
                 FROM alerter_alerts WHERE opened_at >= $1 ORDER BY opened_at DESC LIMIT $2`, [since.toISOString(), limit]);
            return rows;
        }),

        digests: (limit) => optional([], async () => {
            const { rows } = await pool.query(
                `SELECT period_end, period_start, tz, local_date, body, created_at, pushed_at
                 FROM alerter_digests ORDER BY period_end DESC LIMIT $1`, [limit]);
            return rows;
        }),

        // ---- retention ----

        deleteEventsBefore: (cutoff) => remove('DELETE FROM dashboard_events WHERE ts < $1', cutoff),
        deleteIncidentEventsBefore: (cutoff) => remove('DELETE FROM dashboard_incident_events WHERE ts < $1', cutoff),
        deleteControlsBefore: (cutoff) => remove('DELETE FROM dashboard_controls WHERE at < $1', cutoff),
    };
}
