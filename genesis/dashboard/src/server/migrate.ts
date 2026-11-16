// Applies the plain SQL files of migrations/ in file-name order, each once and each inside
// its own transaction. What ran is noted in a table named after the service, so the
// dashboard and the alerter can share one database without knowing of each other.

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { PgPool } from './pg_store.js';

export async function runMigrations(pool: PgPool, dir: string, table = 'dashboard_migrations'): Promise<string[]> {
    await pool.query(`CREATE TABLE IF NOT EXISTS ${table} (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const { rows } = await pool.query(`SELECT name FROM ${table}`);
    const done = new Set(rows.map((row) => row.name));
    const files = (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort();
    const applied: string[] = [];
    for (const name of files) {
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
