// Genesis: the Postgres side of the call store, the goal storage and the checkpoint mirror.
//
// The test suite runs without node_modules and without a database: it only checks, with a recording stand-in for the pool, that every
// statement names the columns of genesis/store/migrations/*.sql and passes as many values
// as it has placeholders. Needs the "pg" package, listed in genesis/package.json (the
// Genesis image installs it; the root package.json does not have it).
//
// Every store takes a `pool` with query(text, values) -> Promise<{ rows }> (a pg.Pool).
// The tables come from genesis/store/migrations/*.sql, which runStoreMigrations() applies at
// start: every statement in them is "IF NOT EXISTS", so running them again changes nothing.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'store', 'migrations');

// Applies every file of genesis/store/migrations in the order of the names. Idempotent.
// Resolves to the names applied; rejects when the database refuses one (a file that failed is
// simply run again next time).
export async function runStoreMigrations(pool, { dir = MIGRATIONS_DIR, list = (folder) => readdirSync(folder), read = (file) => readFileSync(file, 'utf8') } = {}) {
    const names = list(dir).filter((name) => name.endsWith('.sql')).sort();
    for (const name of names) await pool.query(read(path.join(dir, name)));
    return names;
}

// A pg.Pool for the address. Throws when the "pg" package is not installed.
export async function createPgPool({ url, max = 4, connect_timeout_ms = 5000 } = {}) {
    const pg = await import('pg');
    const Pool = pg.Pool ?? pg.default?.Pool;
    const pool = new Pool({ connectionString: url, max, connectionTimeoutMillis: connect_timeout_ms });
    pool.on('error', () => { /* an idle connection broke: the next query reconnects */ });
    return pool;
}

const json = (value) => JSON.stringify(value ?? null);

// The broker's call store: { record(call_record) }.
export function pgCallStore(pool) {
    return {
        async record(r) {
            await pool.query(
                `INSERT INTO planner_calls
                    (call_id, request_id, agent, call_trigger, context, options_offered, raw_output, chosen_ids,
                     valid, attempt, queue_wait_ms, latency_ms, prompt_tokens, completion_tokens, model,
                     outcome, errors, started_at)
                 VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb, $18)
                 ON CONFLICT (call_id) DO NOTHING`,
                [r.call_id, r.request_id, r.agent, r.trigger, r.context, json(r.options_offered), r.raw_output, json(r.chosen_ids),
                    r.valid, r.attempt, r.queue_wait_ms, r.latency_ms, r.prompt_tokens, r.completion_tokens, r.model,
                    r.outcome, json(r.errors), r.started_at],
            );
        },
    };
}

// The goal store's storage: { load(agent), save(agent, goals, change) }.
export function pgGoalStorage(pool) {
    return {
        async load(agent) {
            const { rows } = await pool.query('SELECT long_term, short_term FROM agent_goals WHERE agent = $1', [agent]);
            return rows.length > 0 ? { long_term: rows[0].long_term, short_term: rows[0].short_term } : null;
        },
        // One statement, so the change and the new lists are stored together or not at all.
        async save(agent, goals, change) {
            await pool.query(
                `WITH recorded AS (
                    INSERT INTO goal_changes (id, agent, scope, before, after, reason, source, call_id, ts)
                    VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9)
                 )
                 INSERT INTO agent_goals (agent, long_term, short_term, updated_at)
                 VALUES ($2, $10::jsonb, $11::jsonb, $9)
                 ON CONFLICT (agent) DO UPDATE
                    SET long_term = EXCLUDED.long_term, short_term = EXCLUDED.short_term, updated_at = EXCLUDED.updated_at`,
                [change.id, agent, change.scope, json(change.before), json(change.after), change.reason, change.source,
                    change.call_id, change.ts, json(goals.long_term), json(goals.short_term)],
            );
        },
    };
}

// The checkpoint store's mirror: { save(checkpoint), load(agent) }.
export function pgCheckpointMirror(pool) {
    return {
        // An older checkpoint never replaces a newer one (writes can arrive out of order after a reconnect).
        async save(checkpoint) {
            await pool.query(
                `INSERT INTO agent_checkpoints (agent, seq, saved_at, checkpoint, updated_at)
                 VALUES ($1, $2, $3, $4::jsonb, now())
                 ON CONFLICT (agent) DO UPDATE
                    SET seq = EXCLUDED.seq, saved_at = EXCLUDED.saved_at, checkpoint = EXCLUDED.checkpoint, updated_at = now()
                    WHERE agent_checkpoints.saved_at <= EXCLUDED.saved_at`,
                [checkpoint.agent, checkpoint.seq, checkpoint.saved_at, json(checkpoint)],
            );
        },
        async load(agent) {
            const { rows } = await pool.query('SELECT checkpoint FROM agent_checkpoints WHERE agent = $1', [agent]);
            return rows.length > 0 ? rows[0].checkpoint : null;
        },
    };
}
