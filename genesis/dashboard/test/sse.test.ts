import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIngest } from '../src/server/ingest.js';
import { createLive, type Frame } from '../src/server/live.js';
import { validateEvent } from '../src/server/contract.js';
import { encodeFrame, openStream, resumeFrames } from '../src/server/sse.js';
import { buildApp } from '../src/server/app.js';
import { eventMaker, fakeClock, fakeStream, memoryStore } from './fakes.js';

async function rig({ ring_size = 2000 } = {}) {
    const clock = fakeClock();
    const stream = fakeStream(clock);
    const pg = memoryStore();
    const live = createLive({ roster: ['Arthur', 'Mira', 'Felix', 'Nova'], ring_size });
    const make = eventMaker(clock);
    const ingest = createIngest({ stream: stream.client, store: pg.store, live, validate: validateEvent, clock, warn: () => {} });
    const add = async (count: number) => {
        const ids: string[] = [];
        for (let i = 0; i < count; i++) {
            clock.advance(10);
            ids.push(stream.add(make('Mira', 'skill.progress', { skill: 'harvest_crops', done: ids.length + i, total: null })));
        }
        await ingest.step({ block_ms: 0 });
        return ids;
    };
    return { clock, stream, pg, live, make, ingest, add };
}
const ids = (frames: Frame[]) => frames.map((frame) => (frame.kind === 'event' ? frame.id : frame.kind));

test('a first connection gets one snapshot that carries the cursor', async () => {
    const { live, pg, add } = await rig();
    const sids = await add(3);
    const frames = await resumeFrames(live, pg.store, null);
    assert.equal(frames.length, 1);
    assert.equal(frames[0].kind, 'snapshot');
    assert.equal((frames[0] as any).id, sids[2]);
    assert.match(encodeFrame(frames[0]), new RegExp(`^event: snapshot\\nid: ${sids[2]}\\ndata: \\{`));
});

test('a reconnect with Last-Event-ID gets exactly what it missed, in order, from memory', async () => {
    const { live, pg, add } = await rig();
    const sids = await add(6);
    const frames = await resumeFrames(live, pg.store, sids[2]);
    assert.deepEqual(ids(frames), sids.slice(3));
    assert.equal(pg.calls.after, 0, 'Postgres was not needed');
    assert.deepEqual(await resumeFrames(live, pg.store, sids[5]), [], 'nothing missed, nothing sent');
});

test('a reconnect from further back than memory reaches is filled from Postgres, without a hole', async () => {
    const { live, pg, add } = await rig({ ring_size: 4 });
    const sids = await add(10);
    const frames = await resumeFrames(live, pg.store, sids[1]);
    assert.deepEqual(ids(frames), sids.slice(2));
    assert.equal(pg.calls.after, 1);
});

test('Postgres behind the live view: the replay joins Postgres and memory', async () => {
    const { live, pg, add } = await rig({ ring_size: 4 });
    const sids = await add(6);
    pg.down = true;
    sids.push(...await add(2)); // these two are in memory only
    pg.down = false;
    const before_replay = pg.rows.size;
    const frames = await resumeFrames(live, pg.store, sids[0]);
    assert.equal(before_replay, 6);
    assert.deepEqual(ids(frames), sids.slice(1));
});

test('a gap nobody can fill gives a snapshot: Postgres down, too far back, or an id from another life', async () => {
    const { live, pg, add } = await rig({ ring_size: 3 });
    const sids = await add(8);
    pg.down = true;
    assert.deepEqual(ids(await resumeFrames(live, pg.store, sids[0])), ['snapshot']);
    assert.deepEqual(ids(await resumeFrames(live, pg.store, sids[6])), [sids[7]], 'what memory holds still replays while Postgres is down');
    pg.down = false;
    assert.deepEqual(ids(await resumeFrames(live, pg.store, sids[0], 3)), ['snapshot'], 'more than the replay limit');
    assert.deepEqual(ids(await resumeFrames(live, pg.store, '9999999999999-0')), ['snapshot'], 'ahead of the server');
    assert.deepEqual(ids(await resumeFrames(live, pg.store, 'not-an-id')), ['snapshot']);
});

test('openStream: replay first, then live events, never one twice and never out of order', async () => {
    const { live, pg, add, stream, make, clock, ingest } = await rig();
    const sids = await add(4);
    const got: string[] = [];
    // an event arrives while the replay is being put together
    const slow = { ...pg.store, entriesAfter: pg.store.entriesAfter };
    const pending = openStream(live, slow, sids[1], (text) => { got.push(text); });
    clock.advance(10);
    const during = stream.add(make('Nova', 'agent.state', { state: 'planning' }));
    await ingest.step({ block_ms: 0 });
    const close = await pending;
    clock.advance(10);
    const after = stream.add(make('Nova', 'agent.state', { state: 'on_routine' }));
    await ingest.step({ block_ms: 0 });
    const seen = got.map((text) => /id: (\S+)/.exec(text)?.[1]);
    assert.deepEqual(seen, [sids[2], sids[3], during, after]);
    close();
    assert.equal(live.subscribers(), 0);
});

test('HTTP: the stream endpoint honours Last-Event-ID, and JSON history falls back to memory', async () => {
    const { live, pg, add } = await rig();
    const sids = await add(3);
    const app = await buildApp({ live, store: pg.store, controls: null, roster: [], heartbeat_ms: 50 });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address() as { port: number };
    try {
        const abort = new AbortController();
        const response = await fetch(`http://127.0.0.1:${address.port}/api/stream`, { headers: { 'Last-Event-ID': sids[0] }, signal: abort.signal });
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
        const reader = response.body!.getReader();
        let text = '';
        while (!text.includes(`id: ${sids[2]}`)) text += new TextDecoder().decode((await reader.read()).value);
        abort.abort();
        assert.ok(text.startsWith('retry: 2000\n\n'));
        assert.ok(!text.includes(`id: ${sids[0]}\n`), 'the event the browser already had is not sent again');
        assert.ok(text.indexOf(`id: ${sids[1]}`) < text.indexOf(`id: ${sids[2]}`));

        const stored = await (await fetch(`http://127.0.0.1:${address.port}/api/events?limit=2`)).json() as any;
        assert.equal(stored.source, 'postgres');
        assert.deepEqual(stored.entries.map((entry: any) => entry.sid), [sids[2], sids[1]]);
        pg.down = true;
        const held = await (await fetch(`http://127.0.0.1:${address.port}/api/events?agent=Mira`)).json() as any;
        assert.equal(held.source, 'memory');
        assert.equal(held.entries.length, 3);
        const state = await (await fetch(`http://127.0.0.1:${address.port}/api/state`)).json() as any;
        assert.equal(state.state.agents.Mira.progress.skill, 'harvest_crops', 'the live view does not need Postgres');
    } finally {
        await app.close();
    }
});

test('history with Redis down: incidents, events and decisions come from Postgres', async () => {
    const { live, pg, stream, make, ingest, clock } = await rig();
    stream.add(make('Felix', 'agent.decision', { decision_id: 'd9', summary: 'Scout the ravine', trigger: 'routine', command: 'explore_site', args: ['explore_site:ravine'], call_id: null, steps: ['!goToCoordinates'], steps_from: 'template' }, { corr: 'd9' }));
    stream.add(make('Felix', 'agent.failure', { incident_id: 'i7', source: { type: 'agent', name: 'Felix' }, kind: 'nav.stuck', phase: 'detected', is_failure: true, recovery: null, outcome: 'pending', needs_operator: false }, { severity: 'warn' }));
    clock.advance(5000);
    stream.add(make('Felix', 'agent.recovery', { incident_id: 'i7', source: { type: 'agent', name: 'Felix' }, kind: 'nav.stuck', phase: 'resolved', is_failure: true, recovery: { step: 'repath', attempt: 1, max: 3, result: 'ok' }, outcome: 'auto_recovered', needs_operator: false }));
    await ingest.step({ block_ms: 0 });
    stream.down = true;
    await assert.rejects(ingest.step({ block_ms: 0 }));

    const app = await buildApp({ live, store: pg.store, controls: null, roster: [], clock });
    const incidents = (await app.inject({ url: '/api/incidents' })).json();
    assert.equal(incidents.source, 'postgres');
    assert.equal(incidents.incidents.length, 1);
    assert.equal(incidents.incidents[0].outcome, 'auto_recovered');
    assert.equal(incidents.incidents[0].steps[0].step, 'repath');
    assert.ok(incidents.incidents[0].ended_at);
    const trace = (await app.inject({ url: '/api/decisions/d9' })).json();
    assert.equal(trace.decision.data.summary, 'Scout the ravine');
    assert.equal(trace.call_source, 'none', 'a routine choice has no planning call behind it');
    const health = (await app.inject({ url: '/api/health' })).json();
    assert.equal(health.redis_ok, false);
    assert.equal(health.postgres_ok, true);
    await app.close();
});

test('a request that names another site is refused', async () => {
    const { live, pg } = await rig();
    const app = await buildApp({ live, store: pg.store, controls: null, roster: [] });
    const refused = await app.inject({ method: 'POST', url: '/api/controls/command', headers: { origin: 'http://elsewhere.example', host: 'dash:8080', 'content-type': 'application/json' }, payload: '{}' });
    assert.equal(refused.statusCode, 403);
    const form = await app.inject({ method: 'POST', url: '/api/controls/command', headers: { 'content-type': 'text/plain' }, payload: '{"action":"stop_all"}' });
    assert.equal(form.statusCode, 415, 'only JSON bodies are read');
    await app.close();
});
