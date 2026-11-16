// Genesis dashboard: starts the ingest, the retention job, the MindServer link and the web server.
//
//   node dist/server.mjs                  run
//   node dist/server.mjs --migrate-only   apply migrations/ and stop
//
// Nothing here waits for Redis, Postgres or the MindServer to be there: each is retried in
// the background and the pages say what is missing.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig } from './config.js';
import { validateEvent, createUlidFactory } from './contract.js';
import { createLive } from './live.js';
import { createIngest } from './ingest.js';
import { createPgPool, createPgStore, type PgPool } from './pg_store.js';
import { createRedisStream } from './redis_stream.js';
import { runMigrations } from './migrate.js';
import { runRetention } from './retention.js';
import { createControls } from './controls.js';
import { createMindLink } from './mindserver_link.js';
import { buildApp } from './app.js';
import type { Store } from './ports.js';
import { goalList } from './seed.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const config = readConfig(process.env, here);
const log = (level: string, event: string, more: Record<string, unknown> = {}) =>
    console.log(JSON.stringify({ ts: new Date().toISOString(), level, event, ...more }));

async function migrate(pool: PgPool): Promise<boolean> {
    try {
        const applied = await runMigrations(pool, config.migrations_dir);
        if (applied.length > 0) log('info', 'dashboard_migrated', { applied });
        return true;
    } catch (err: any) {
        log('warn', 'dashboard_migration_failed', { message: String(err?.message ?? err) });
        return false;
    }
}

// The store when no database address was given: every call fails, so the dashboard runs on memory alone.
function noStore(): Store {
    const fail = async () => { throw new Error('GENESIS_DATABASE_URL is not set'); };
    return new Proxy({}, { get: () => fail }) as Store;
}

async function main() {
    const pool = config.database_url ? await createPgPool({ url: config.database_url }) : null;
    if (process.argv.includes('--migrate-only')) {
        if (!pool) throw new Error('GENESIS_DATABASE_URL is not set');
        const ok = await migrate(pool);
        await pool.end();
        process.exit(ok ? 0 : 1);
    }
    if (!pool) log('warn', 'dashboard_no_database', { message: 'GENESIS_DATABASE_URL is not set: history is not kept' });

    const store = pool ? createPgStore(pool) : noStore();
    const live = createLive({ roster: config.roster.map((agent) => agent.name) });
    const stream = await createRedisStream({ url: config.redis_url });
    const ingest = createIngest({
        stream, store, live, validate: validateEvent,
        config: { stream: config.stream, group: config.group, consumer: config.consumer },
    });

    let migrated = pool ? await migrate(pool) : false;
    const warmed = await ingest.warm();
    log('info', 'dashboard_warmed', warmed);

    // The goals as the planner's own table has them, for an agent the stream has said nothing about yet
    // (long-term goals in particular: no event carries them until one changes).
    async function seedGoals() {
        try {
            for (const row of await store.agentGoals()) {
                const agent = live.state.agents[row.agent];
                if (!agent) continue;
                if (agent.long_change === null) agent.long_term = goalList(row.long_term);
                if (agent.short_change === null && agent.short_term.length === 0) agent.short_term = goalList(row.short_term);
            }
        } catch { /* Postgres is down, or the table belongs to another database */ }
    }
    await seedGoals();

    const link = await createMindLink({ url: config.mindserver_url, live });
    const controls = createControls({ link, store, live, ids: createUlidFactory() });
    const app = await buildApp({ live, store, controls, roster: config.roster, public_dir: config.public_dir });

    ingest.run().catch((err) => log('error', 'dashboard_ingest_ended', { message: String(err?.message ?? err) }));

    const every = (ms: number, job: () => Promise<unknown>) => setInterval(() => { job().catch(() => {}); }, ms).unref();
    every(5000, async () => {
        const ok = await ingest.checkStore();
        if (ok && pool && !migrated) migrated = await migrate(pool); // Postgres was not there at start
    });
    every(5 * 60 * 1000, seedGoals);
    every(60 * 60 * 1000, async () => {
        const removed = await runRetention(store);
        log('info', 'dashboard_retention', removed);
    });
    setTimeout(() => { runRetention(store).then((removed) => log('info', 'dashboard_retention', removed)).catch(() => {}); }, 30000).unref();

    await app.listen({ host: config.host, port: config.port });
    log('info', 'dashboard_listening', { host: config.host, port: config.port });

    const stop = async () => {
        ingest.stop();
        link.close();
        await app.close().catch(() => {});
        await stream.close().catch(() => {});
        await pool?.end().catch(() => {});
        process.exit(0);
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
}

main().catch((err) => {
    log('error', 'dashboard_failed', { message: String(err?.message ?? err) });
    process.exit(1);
});
