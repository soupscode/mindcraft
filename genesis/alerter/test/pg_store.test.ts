// There is no Postgres in the build environment, so the SQL itself is NOT run here. What is
// checked: every statement passes exactly as many values as it has placeholders, and the
// migration runner applies each file once.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPgAlertStore, runMigrations, type PgPool } from '../src/pg_store.js';
import { eventMaker } from './fakes.js';

const migrations_dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
const highest = (text: string) => Math.max(0, ...[...text.matchAll(/\$(\d+)/g)].map((match) => Number(match[1])));

test('every statement passes as many values as it has placeholders', async () => {
    const calls: { text: string; values: any[] }[] = [];
    const query = async (text: string, values: any[] = []) => { calls.push({ text, values }); return { rows: [], rowCount: 1 }; };
    const pool: PgPool = { query, connect: async () => ({ query, release() {} }) };
    const store = createPgAlertStore(pool);
    const make = eventMaker();
    const day = new Date('2026-11-01T00:00:00Z');
    const later = new Date('2026-11-02T00:00:00Z');
    await store.ping();
    await store.saveAlert({ id: 'a', problem_key: 'incident:i1', severity: 'critical', title: 't', subject: 'Nova', kind: 'login.refused', opened_at: day.toISOString(), updated_at: day.toISOString(), closed_at: null, occurrences: 1, push_state: 'sent', pushed_at: null });
    await store.openAlerts();
    await store.alertsBetween(day, later);
    await store.saveState({ gate: 'away', held: ['Felix'] });
    await store.loadState();
    await store.saveFacts([make('Mira', 'skill.result', { ok: true }), make('Mira', 'skill.result', { ok: false })]);
    await store.factsBetween(day, later);
    assert.equal(await store.saveDigest({ period_end: later.toISOString(), period_start: day.toISOString(), tz: 'America/Chicago', local_date: '2026-11-01', body: {}, created_at: later.toISOString(), pushed_at: null }), true);
    await store.hasDigest(later.toISOString());
    await store.markDigestPushed(later.toISOString(), later.toISOString());
    await store.saveBatch(later.toISOString(), 3);
    await store.batchesBetween(day, later);
    await store.deleteAlertsBefore(day);
    await store.deleteFactsBefore(day);
    await store.deleteDigestsBefore(day);
    assert.equal(calls.length, 16);
    for (const call of calls) assert.equal(call.values.length, highest(call.text), call.text);
    assert.match(calls.find((call) => call.text.includes('DELETE FROM alerter_alerts'))!.text, /closed_at IS NOT NULL/, 'an alert that is still open is never deleted');
});

test('migrations run in file-name order, each once', async () => {
    const noted = new Set<string>();
    const query = async (text: string, values: any[] = []) => {
        if (text.startsWith('SELECT name')) return { rows: [...noted].map((name) => ({ name })) };
        if (text.startsWith('INSERT INTO alerter_migrations')) noted.add(values[0]);
        return { rows: [] };
    };
    const pool: PgPool = { query, connect: async () => ({ query, release() {} }) };
    assert.deepEqual(await runMigrations(pool, migrations_dir), ['001_alerter.sql']);
    assert.deepEqual(await runMigrations(pool, migrations_dir), []);
});
