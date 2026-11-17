// Genesis alerter. A service of its own, so that alerts survive a dashboard crash.
//
//   node dist/alerter.mjs                  run
//   node dist/alerter.mjs --migrate-only   apply migrations/ and stop
//
// It needs neither store to start: Redis and Postgres are retried in the background, and
// either one being unreachable for 60 seconds is itself an alert.

import { sendTestPush } from './test_push.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAlerter } from './alerter.js';
import { createDigestJob } from './digest.js';
import { createNtfy } from './ntfy.js';
import { createPgAlertStore, createPgPool, runMigrations, type PgPool } from './pg_store.js';
import { createRedisStream } from './redis_stream.js';
import { createReader } from './reader.js';
import { runRetention } from './retention.js';
import { validateEvent, createUlidFactory } from './contract.js';
import { isTimeZone } from './tz.js';
import type { AlertStore, GenesisEvent } from './ports.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;
const log = (level: string, event: string, more: Record<string, unknown> = {}) =>
    console.log(JSON.stringify({ ts: new Date().toISOString(), level, event, ...more }));

const config = {
    redis_url: env.GENESIS_REDIS_URL ?? 'redis://redis:6379',
    database_url: env.GENESIS_DATABASE_URL ?? '',
    stream: env.GENESIS_EVENT_STREAM ?? 'genesis:events',
    group: env.ALERTER_CONSUMER_GROUP ?? 'alerter',
    consumer: env.ALERTER_CONSUMER_NAME ?? 'alerter-1',
    ntfy_server: env.NTFY_SERVER ?? 'https://ntfy.sh', // the hosted service by default (decided); the topic has no default
    ntfy_topic: env.NTFY_TOPIC ?? '',
    ntfy_token: env.NTFY_TOKEN ?? '',
    tz: env.DIGEST_TZ ?? 'America/Chicago',
    hour: Number(env.DIGEST_HOUR ?? 18),
    roster: (env.GENESIS_AGENTS ?? 'Arthur:Builder,Mira:Farmer,Felix:Explorer,Nova:Merchant').split(',').map((part) => part.split(':')[0].trim()).filter(Boolean),
    migrations_dir: env.ALERTER_MIGRATIONS_DIR ?? `${here}/../migrations`,
};

function noStore(): AlertStore {
    const fail = async () => { throw new Error('GENESIS_DATABASE_URL is not set'); };
    return new Proxy({}, { get: () => fail }) as AlertStore;
}

async function main() {
    if (!isTimeZone(config.tz)) throw new Error(`DIGEST_TZ "${config.tz}" is not a time zone`);
    if (!Number.isInteger(config.hour) || config.hour < 0 || config.hour > 23) throw new Error('DIGEST_HOUR must be 0 to 23');
    const pool: (PgPool & { end(): Promise<void> }) | null = config.database_url ? await createPgPool({ url: config.database_url }) : null;
    const migrate = async () => {
        if (!pool) return false;
        try {
            const applied = await runMigrations(pool, config.migrations_dir);
            if (applied.length > 0) log('info', 'alerter_migrated', { applied });
            return true;
        } catch (err: any) {
            log('warn', 'alerter_migration_failed', { message: String(err?.message ?? err) });
            return false;
        }
    };
    if (process.argv.includes('--migrate-only')) {
        const ok = await migrate();
        await pool?.end();
        process.exit(ok ? 0 : 1);
    }

    const store = pool ? createPgAlertStore(pool) : noStore();
    const stream = await createRedisStream({ url: config.redis_url });
    const notifier = createNtfy({ server: config.ntfy_server, topic: config.ntfy_topic, token: config.ntfy_token });
    if (process.argv.includes('--test-push')) {
        // one harmless push through the alerter's own notifier, and a closed record of how it went
        // (genesis/up.sh --test-alert; genesis/status.sh shows whether one was ever accepted)
        const outcome = await sendTestPush({ notifier, store, ids: createUlidFactory() });
        console.log(outcome.line);
        await pool?.end();
        process.exit(outcome.ok ? 0 : 1);
    }
    if (!notifier.enabled()) log('error', 'alerter_no_topic', { message: 'NTFY_TOPIC is not set: alerts are recorded, nobody is pinged' });

    const alerter = createAlerter({ notifier, store, marks: stream, ids: createUlidFactory(), warn: (line) => console.log(line) });
    const digest = createDigestJob({ store, notifier, tz: config.tz, hour: config.hour, roster: config.roster });

    let migrated = await migrate();
    let restored = migrated && await alerter.restore();

    // one thing at a time: events, the store check and the clock never run into each other
    let chain: Promise<unknown> = Promise.resolve();
    const inTurn = <T>(job: () => Promise<T>): Promise<T> => {
        const next = chain.then(job, job);
        chain = next.catch(() => {});
        return next;
    };

    const reader = createReader({
        stream, validate: validateEvent,
        config: { stream: config.stream, group: config.group, consumer: config.consumer },
        onEvent: (event: GenesisEvent) => inTurn(async () => { await alerter.onEvent(event); await digest.onEvent(event); }),
    });
    reader.run().catch((err) => log('error', 'alerter_reader_ended', { message: String(err?.message ?? err) }));

    const alive = async (ping: () => Promise<void>) => { try { await ping(); return true; } catch { return false; } };
    setInterval(() => {
        inTurn(async () => {
            const [redis, postgres] = await Promise.all([alive(() => stream.ping()), alive(() => store.ping())]);
            if (postgres && !migrated) migrated = await migrate();
            if (postgres && migrated && !restored) restored = await alerter.restore();
            await alerter.observeStores({ redis, postgres: pool ? postgres : true });
            await alerter.tick();
            const made = await digest.tick();
            if (made) log('info', 'alerter_digest', { local_date: made.local_date, pushed: made.pushed_at !== null });
        }).catch((err) => log('warn', 'alerter_tick_failed', { message: String(err?.message ?? err) }));
    }, 5000);

    setInterval(() => {
        runRetention(store).then((removed) => log('info', 'alerter_retention', removed)).catch(() => {});
    }, 60 * 60 * 1000).unref();

    log('info', 'alerter_started', { stream: config.stream, group: config.group, tz: config.tz, digest_hour: config.hour, ntfy: notifier.enabled() });

    const stop = async () => {
        reader.stop();
        await stream.close().catch(() => {});
        await pool?.end().catch(() => {});
        process.exit(0);
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
}

main().catch((err) => {
    log('error', 'alerter_failed', { message: String(err?.message ?? err) });
    process.exit(1);
});
