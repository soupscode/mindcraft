// The Postgres side of the alerter.
//
// NOT RUN AGAINST A REAL POSTGRES in the tests (there is no server in the build
// environment): they use the in-memory store of test/fakes.ts, and check with a recording
// pool that every statement here passes as many values as it has placeholders.

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Alert, AlertStore, GenesisEvent } from './ports.js';

export interface PgPool {
    query(text: string, values?: any[]): Promise<{ rows: any[]; rowCount?: number | null }>;
    connect(): Promise<{ query(text: string, values?: any[]): Promise<{ rows: any[]; rowCount?: number | null }>; release(): void }>;
}

export async function createPgPool({ url, max = 3, connect_timeout_ms = 5000 }: { url: string; max?: number; connect_timeout_ms?: number }): Promise<PgPool & { end(): Promise<void> }> {
    const pg: any = await import('pg');
    const Pool = pg.Pool ?? pg.default?.Pool;
    const pool = new Pool({ connectionString: url, max, connectionTimeoutMillis: connect_timeout_ms, statement_timeout: 15000 });
    pool.on('error', () => { /* an idle connection broke: the next query reconnects */ });
    return pool;
}

// Applies the plain SQL files of migrations/ in file-name order, each once, each in a transaction.
export async function runMigrations(pool: PgPool, dir: string, table = 'alerter_migrations'): Promise<string[]> {
    await pool.query(`CREATE TABLE IF NOT EXISTS ${table} (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const { rows } = await pool.query(`SELECT name FROM ${table}`);
    const done = new Set(rows.map((row) => row.name));
    const applied: string[] = [];
    for (const name of (await readdir(dir)).filter((file) => file.endsWith('.sql')).sort()) {
        if (done.has(name)) continue;
        const sql = await readFile(path.join(dir, name), 'utf8');
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(sql);
            await client.query(`INSERT INTO ${table} (name) VALUES ($1)`, [name]);
            await client.query('COMMIT');
            applied.push(name);
        } catch (err) {
            try { await client.query('ROLLBACK'); } catch { /* the connection is gone */ }
            throw err;
        } finally {
            client.release();
        }
    }
    return applied;
}

const ALERT_COLUMNS = 'id, problem_key, severity, title, subject, kind, opened_at, updated_at, closed_at, occurrences, push_state, pushed_at';
const iso = (value: any) => (value === null || value === undefined ? null : new Date(value).toISOString());

function rowToAlert(row: any): Alert {
    return {
        id: row.id, problem_key: row.problem_key, severity: row.severity, title: row.title, subject: row.subject, kind: row.kind,
        opened_at: iso(row.opened_at)!, updated_at: iso(row.updated_at)!, closed_at: iso(row.closed_at),
        occurrences: Number(row.occurrences), push_state: row.push_state, pushed_at: iso(row.pushed_at),
    };
}

export function createPgAlertStore(pool: PgPool): AlertStore {
    async function remove(text: string, cutoff: Date): Promise<number> {
        return (await pool.query(text, [cutoff.toISOString()])).rowCount ?? 0;
    }
    return {
        async ping() { await pool.query('SELECT 1'); },

        async saveAlert(a) {
            await pool.query(
                `INSERT INTO alerter_alerts (${ALERT_COLUMNS})
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                 ON CONFLICT (id) DO UPDATE SET severity = EXCLUDED.severity, title = EXCLUDED.title, updated_at = EXCLUDED.updated_at,
                     closed_at = EXCLUDED.closed_at, occurrences = EXCLUDED.occurrences, push_state = EXCLUDED.push_state, pushed_at = EXCLUDED.pushed_at`,
                [a.id, a.problem_key, a.severity, a.title, a.subject, a.kind, a.opened_at, a.updated_at, a.closed_at, a.occurrences, a.push_state, a.pushed_at]);
        },

        async openAlerts() {
            const { rows } = await pool.query(
                `SELECT ${ALERT_COLUMNS} FROM alerter_alerts WHERE closed_at IS NULL OR (severity = 'warning' AND push_state = 'queued') ORDER BY opened_at ASC`);
            return rows.map(rowToAlert);
        },

        async alertsBetween(from, to) {
            const { rows } = await pool.query(
                `SELECT ${ALERT_COLUMNS} FROM alerter_alerts WHERE opened_at >= $1 AND opened_at < $2 ORDER BY opened_at ASC`, [from.toISOString(), to.toISOString()]);
            return rows.map(rowToAlert);
        },

        async saveState(state) {
            await pool.query(
                `INSERT INTO alerter_state (id, state, updated_at) VALUES (1, $1::jsonb, now())
                 ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`, [JSON.stringify(state)]);
        },

        async loadState() {
            const { rows } = await pool.query('SELECT state FROM alerter_state WHERE id = 1');
            const state = rows[0]?.state;
            if (!state || typeof state !== 'object') return null;
            return { gate: ['available', 'leaving', 'away'].includes(state.gate) ? state.gate : 'unknown', held: Array.isArray(state.held) ? state.held.map(String) : [] };
        },

        async saveFacts(facts) {
            if (facts.length === 0) return;
            const values: any[] = [];
            const groups = facts.map((fact, i) => {
                values.push(fact.id, fact.ts, JSON.stringify(fact));
                return `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3}::jsonb)`;
            });
            await pool.query(`INSERT INTO alerter_facts (id, ts, event) VALUES ${groups.join(', ')} ON CONFLICT (id) DO NOTHING`, values);
        },

        async factsBetween(from, to) {
            const { rows } = await pool.query(
                'SELECT event FROM alerter_facts WHERE ts >= $1 AND ts < $2 ORDER BY ts ASC', [from.toISOString(), to.toISOString()]);
            return rows.map((row) => row.event as GenesisEvent);
        },

        async saveDigest(d) {
            const result = await pool.query(
                `INSERT INTO alerter_digests (period_end, period_start, tz, local_date, body, created_at, pushed_at)
                 VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7) ON CONFLICT (period_end) DO NOTHING`,
                [d.period_end, d.period_start, d.tz, d.local_date, JSON.stringify(d.body), d.created_at, d.pushed_at]);
            return (result.rowCount ?? 0) > 0;
        },

        async hasDigest(period_end) {
            const { rows } = await pool.query('SELECT 1 FROM alerter_digests WHERE period_end = $1', [period_end]);
            return rows.length > 0;
        },

        async markDigestPushed(period_end, at) {
            await pool.query('UPDATE alerter_digests SET pushed_at = $2 WHERE period_end = $1', [period_end, at]);
        },

        async saveBatch(at, count) {
            await pool.query('INSERT INTO alerter_batches (pushed_at, warnings) VALUES ($1, $2) ON CONFLICT (pushed_at) DO NOTHING', [at, count]);
        },

        async batchesBetween(from, to) {
            const { rows } = await pool.query('SELECT count(*)::int AS n FROM alerter_batches WHERE pushed_at >= $1 AND pushed_at < $2', [from.toISOString(), to.toISOString()]);
            return Number(rows[0]?.n ?? 0);
        },

        // a closed alert goes 90 days after it was opened; one that is still open stays
        deleteAlertsBefore: (cutoff) => remove('DELETE FROM alerter_alerts WHERE opened_at < $1 AND closed_at IS NOT NULL', cutoff),
        deleteFactsBefore: (cutoff) => remove('DELETE FROM alerter_facts WHERE ts < $1', cutoff),
        deleteDigestsBefore: (cutoff) => remove('DELETE FROM alerter_digests WHERE period_end < $1', cutoff),
    };
}
