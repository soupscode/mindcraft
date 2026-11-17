// There is no Postgres in the build environment, so the SQL itself is NOT run here. What is
// checked: every statement passes exactly as many values as it has placeholders, names only
// tables and columns the migrations create, and the migration runner applies each file once.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPgStore, placeholders, searchText, type PgPool } from '../src/server/pg_store.js';
import { runMigrations } from '../src/server/migrate.js';
import { eventMaker, incident } from './fakes.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrations_dir = path.join(here, '../migrations');

function recordingPool(rows: any[] = []) {
    const calls: { text: string; values: any[] }[] = [];
    const query = async (text: string, values: any[] = []) => { calls.push({ text, values }); return { rows, rowCount: 0 }; };
    const pool: PgPool = { query, connect: async () => ({ query, release() {} }) };
    return { pool, calls };
}
const highest = (text: string) => Math.max(0, ...[...text.matchAll(/\$(\d+)/g)].map((match) => Number(match[1])));

test('every statement passes as many values as it has placeholders', async () => {
    const { pool, calls } = recordingPool();
    const store = createPgStore(pool);
    const make = eventMaker();
    const day = new Date('2026-11-01T00:00:00Z');
    await store.ping();
    await store.insertEntries([
        { sid: '1731700000000-0', event: make('Felix', 'agent.failure', incident('i1', 'Felix', 'nav.stuck', 'detected')) },
        { sid: '1731700000000-1', event: make('Mira', 'agent.state', { state: 'planning' }) },
    ]);
    await store.entriesAfter('1731700000000-0', 50);
    await store.latestEntries(10);
    await store.searchEvents({ limit: 20 });
    await store.searchEvents({ agent: 'Felix', type: 'agent.state', severity: 'warn', corr: 'd1', q: 'oak logs', before: '1731700000000-5', limit: 20 });
    await store.incidentEvents(day);
    await store.insertControl({ id: 'c1', at: day.toISOString(), actor: 'Operator', origin: 'lan', action: 'Stop', target: 'Felix', ok: true, detail: null });
    await store.controls(10);
    await store.plannerCall('call-1');
    await store.agentGoals();
    await store.alerts(day, 10);
    await store.digests(10);
    await store.deleteEventsBefore(day);
    await store.deleteIncidentEventsBefore(day);
    await store.deleteControlsBefore(day);
    const statements = calls.filter((call) => !/^(BEGIN|COMMIT|ROLLBACK)$/.test(call.text));
    assert.ok(statements.length >= 17);
    for (const call of statements) assert.equal(call.values.length, highest(call.text), call.text);
    assert.equal(placeholders(2, 3, { 2: '::jsonb' }), '($1, $2, $3::jsonb), ($4, $5, $6::jsonb)');
});

test('the statements name only tables and columns the migrations create', async () => {
    const sql = readdirSync(migrations_dir).filter((name) => name.endsWith('.sql')).sort().map((name) => readFileSync(path.join(migrations_dir, name), 'utf8')).join('\n');
    const columns = (table: string) => {
        const body = new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`).exec(sql)?.[1] ?? '';
        return body.split('\n').map((line) => /^\s+([a-z_]+)\s+(text|bigint|timestamptz|jsonb|boolean|integer)/.exec(line)?.[1]).filter(Boolean);
    };
    assert.deepEqual(columns('dashboard_events'), ['id', 'stream_ms', 'stream_n', 'ts', 'agent', 'seq', 'type', 'corr', 'severity', 'data', 'search_text']);
    assert.deepEqual(columns('dashboard_incident_events'), ['id', 'incident_id', 'ts', 'event']);
    assert.deepEqual(columns('dashboard_controls'), ['id', 'at', 'actor', 'origin', 'action', 'target', 'ok', 'detail']);
    const { pool, calls } = recordingPool();
    const store = createPgStore(pool);
    await store.insertEntries([{ sid: '5-0', event: eventMaker()('Felix', 'agent.failure', incident('i1', 'Felix', 'nav.stuck', 'detected')) }]);
    const inserts = calls.filter((call) => call.text.includes('INSERT'));
    assert.match(inserts[0].text, /INSERT INTO dashboard_events \(id, stream_ms, stream_n, ts, agent, seq, type, corr, severity, data, search_text\)/);
    assert.match(inserts[1].text, /INSERT INTO dashboard_incident_events \(id, incident_id, ts, event\)/);
    assert.deepEqual(calls.map((call) => call.text).filter((text) => /^(BEGIN|COMMIT)$/.test(text)), ['BEGIN', 'COMMIT'], 'both inserts are one transaction');
});

test('a table of another service that does not exist yet gives an empty answer, any other error is passed on', async () => {
    const missing = Object.assign(new Error('relation does not exist'), { code: '42P01' });
    const store = createPgStore({ query: async () => { throw missing; }, connect: async () => { throw missing; } });
    assert.equal(await store.plannerCall('x'), null);
    assert.deepEqual(await store.agentGoals(), []);
    assert.deepEqual(await store.alerts(new Date(), 5), []);
    assert.deepEqual(await store.digests(5), []);
    const down = createPgStore({ query: async () => { throw new Error('ECONNREFUSED'); }, connect: async () => { throw new Error('ECONNREFUSED'); } });
    await assert.rejects(down.digests(5));
});

test('the search text holds the agent, the type and the text inside data, and is bounded', () => {
    const event = eventMaker()('Felix', 'goal.changed', { scope: 'short_term', before: [], after: [{ id: 'g', title: 'Collect 16 oak logs' }], reason: 'Arthur asked', source: 'planner', call_id: 'call-9' });
    const line = searchText(event);
    for (const part of ['Felix', 'goal.changed', 'Collect 16 oak logs', 'Arthur asked', 'call-9']) assert.ok(line.includes(part), part);
    assert.equal(searchText({ ...event, data: { output: 'x'.repeat(9000) } }).length, 4000);
});

test('migrations run in file-name order, each once', async () => {
    const applied: string[] = [];
    const noted = new Set<string>();
    const query = async (text: string, values: any[] = []) => {
        if (text.startsWith('SELECT name')) return { rows: [...noted].map((name) => ({ name })) };
        if (text.startsWith('INSERT INTO dashboard_migrations')) { noted.add(values[0]); applied.push(values[0]); }
        return { rows: [] };
    };
    const pool: PgPool = { query, connect: async () => ({ query, release() {} }) };
    assert.deepEqual(await runMigrations(pool, migrations_dir), ['001_events.sql', '002_incidents_controls.sql', '003_skins.sql']);
    assert.deepEqual(await runMigrations(pool, migrations_dir), []);
});
