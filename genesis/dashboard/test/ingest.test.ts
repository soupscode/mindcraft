import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIngest } from '../src/server/ingest.js';
import { createLive } from '../src/server/live.js';
import { validateEvent } from '../src/server/contract.js';
import { runRetention, DAY_MS } from '../src/server/retention.js';
import { eventMaker, fakeClock, fakeStream, incident, memoryStore } from './fakes.js';

function rig() {
    const clock = fakeClock();
    const stream = fakeStream(clock);
    const pg = memoryStore();
    const live = createLive({ roster: ['Arthur', 'Mira', 'Felix', 'Nova'] });
    const make = eventMaker(clock);
    const ingest = createIngest({ stream: stream.client, store: pg.store, live, validate: validateEvent, clock, warn: () => {} });
    return { clock, stream, pg, live, make, ingest };
}

test('a valid event is folded, stored and acknowledged', async () => {
    const { stream, pg, live, make, ingest } = rig();
    stream.add(make('Felix', 'agent.state', { state: 'held', detail: { by: 'operator' } }));
    assert.equal(await ingest.step({ block_ms: 0 }), 1);
    assert.equal(pg.rows.size, 1);
    assert.equal(live.state.agents.Felix.held?.by, 'operator');
    assert.deepEqual(stream.pendingIds('dashboard'), []);
    assert.equal(live.health.redis_ok, true);
    assert.equal(live.health.postgres_ok, true);
});

test('what breaks the shared schema is counted, acknowledged and never stored', async () => {
    const { stream, pg, live, make, ingest } = rig();
    const good = make('Mira', 'skill.progress', { skill: 'harvest_crops', done: 3, total: 9 });
    stream.add({ ...make('Mira', 'skill.progress', { skill: 'harvest_crops', done: -1, total: 9 }) });   // data breaks the contract
    stream.add({ ...good, extra: true });                                                               // not an envelope field
    stream.add(null, { event: '{not json' });
    stream.add(null, { other: 'field' });
    stream.add(make('Mira', 'made.up', {}));                                                            // unknown type
    stream.add(good);
    await ingest.step({ block_ms: 0 });
    assert.equal(ingest.stats().rejected, 5);
    assert.equal(pg.rows.size, 1);
    assert.deepEqual([...pg.rows.keys()], [good.id]);
    assert.equal(live.health.rejected, 5);
    assert.deepEqual(stream.pendingIds('dashboard'), [], 'an invalid entry is not read again');
});

test('the same event delivered twice is applied once and stored once', async () => {
    const { stream, pg, live, make, ingest } = rig();
    const event = make('Arthur', 'goal.changed', { scope: 'short_term', before: [], after: [{ id: 'g1', title: 'Raise the wall' }], reason: 'Wall first.', source: 'planner', call_id: 'c1' });
    stream.add(event);
    stream.add(event); // the hub writes an event twice after a publish that timed out
    await ingest.step({ block_ms: 0 });
    assert.equal(pg.rows.size, 1);
    assert.equal(live.state.goal_changes.length, 1);
    assert.equal(ingest.stats().duplicates, 1);
});

test('entries read before a crash are replayed: stored, acknowledged, and not shown twice', async () => {
    const { clock, stream, pg, live, make } = rig();
    const first = createIngest({ stream: stream.client, store: pg.store, live, validate: validateEvent, clock, warn: () => {} });
    stream.add(make('Nova', 'agent.state', { state: 'on_routine' }));
    pg.down = true;                       // the process "crashes" with the entry read and not stored
    await first.step({ block_ms: 0 });
    assert.equal(pg.rows.size, 0);
    assert.equal(stream.pendingIds('dashboard').length, 1);

    pg.down = false;
    const seen: string[] = [];
    live.subscribe((frame) => { if (frame.kind === 'event') seen.push(frame.id); });
    const second = createIngest({ stream: stream.client, store: pg.store, live, validate: validateEvent, clock, warn: () => {} });
    await second.step({ block_ms: 0 });
    assert.equal(pg.rows.size, 1);
    assert.deepEqual(stream.pendingIds('dashboard'), []);
    assert.deepEqual(seen, [], 'the live view had it already');
    assert.equal(second.stats().duplicates, 1);
});

test('Postgres down: the live view keeps working from memory, and history is stored once Postgres is back', async () => {
    const { stream, pg, live, make, ingest } = rig();
    pg.down = true;
    stream.add(make('Felix', 'agent.decision', { decision_id: 'd1', summary: 'Scout the ravine', trigger: 'planner', command: 'explore_site', args: ['explore_site:ravine'], steps: ['!goToCoordinates', '!searchForBlock'], steps_from: 'template' }, { corr: 'd1' }));
    stream.add(make('Felix', 'skill.started', { skill: '!goToCoordinates', step: 0, of: 2, attempt: 1 }, { corr: 'd1' }));
    await ingest.step({ block_ms: 0 });
    assert.equal(live.health.postgres_ok, false);
    assert.ok(live.health.postgres_down_since);
    assert.equal(live.state.agents.Felix.plan?.title, 'Scout the ravine');
    assert.equal(live.state.agents.Felix.plan?.running, '!goToCoordinates');
    assert.equal(stream.pendingIds('dashboard').length, 2, 'nothing is acknowledged before it is stored');

    stream.add(make('Felix', 'skill.result', { skill: '!goToCoordinates', ok: true, interrupted: false, timedout: false, output: '', duration_ms: 900, step: 0 }, { corr: 'd1' }));
    await ingest.step({ block_ms: 0 });
    assert.equal(live.state.agents.Felix.plan?.done_through, 0);
    assert.equal(pg.rows.size, 0);

    pg.down = false;
    await ingest.step({ block_ms: 0 });
    assert.equal(pg.rows.size, 3);
    assert.deepEqual(stream.pendingIds('dashboard'), []);
    assert.equal(live.health.postgres_ok, true);
    assert.equal(live.health.postgres_down_since, null);
    assert.equal(ingest.stats().applied, 3, 'the replay did not apply anything a second time');
});

test('Redis down: the step fails, health says so, and the live view is warmed from Postgres', async () => {
    const { clock, stream, pg, make, ingest, live } = rig();
    stream.add(make('Mira', 'goal.changed', { scope: 'long_term', before: [], after: [{ id: 'g', title: 'Fill the food chest' }], reason: 'set at start', source: 'operator', call_id: null }));
    await ingest.step({ block_ms: 0 });
    stream.down = true;
    await assert.rejects(ingest.step({ block_ms: 0 }));
    assert.equal(live.health.redis_ok, false);
    assert.ok(live.health.redis_down_since);

    // a dashboard that starts while Redis is down still has its history
    const fresh = createLive({ roster: ['Mira'] });
    const restarted = createIngest({ stream: stream.client, store: pg.store, live: fresh, validate: validateEvent, clock, warn: () => {} });
    assert.deepEqual(await restarted.warm(), { from: 'postgres', count: 1 });
    assert.equal(fresh.state.agents.Mira.long_term[0].title, 'Fill the food chest');

    stream.down = false;
    await ingest.step({ block_ms: 0 });
    assert.equal(live.health.redis_ok, true);
});

test('both stores down at start: nothing to show, and nothing throws', async () => {
    const { stream, pg, ingest } = rig();
    stream.down = true;
    pg.down = true;
    assert.deepEqual(await ingest.warm(), { from: 'nothing', count: 0 });
});

test('Postgres down at start: the live view is warmed from the stream itself', async () => {
    const { stream, pg, live, make, ingest } = rig();
    stream.add(make('planner', 'agent.state', { state: 'model_away', detail: { reason: 'desktop_leaving' } }));
    pg.down = true;
    assert.deepEqual(await ingest.warm(), { from: 'redis', count: 1 });
    assert.equal(live.state.model.state, 'away');
});

test('a pending entry the stream no longer holds is acknowledged and counted as lost', async () => {
    const { stream, pg, make, ingest } = rig();
    stream.add(make('Arthur', 'agent.state', { state: 'planning' }));
    pg.down = true;
    await ingest.step({ block_ms: 0 });
    stream.trim(0);
    pg.down = false;
    await ingest.step({ block_ms: 0 });
    assert.equal(ingest.stats().lost, 1);
    assert.deepEqual(stream.pendingIds('dashboard'), []);
});

test('incident events are kept apart for their own, longer window', async () => {
    const { stream, pg, make, ingest } = rig();
    stream.add(make('Felix', 'agent.failure', incident('i1', 'Felix', 'nav.stuck', 'detected'), { severity: 'warn' }));
    stream.add(make('Felix', 'agent.failure', { kind: 'model', error: 'ModelUnavailableError', message: 'no answer' }, { severity: 'error' }));
    await ingest.step({ block_ms: 0 });
    assert.equal(pg.rows.size, 2);
    assert.equal(pg.incident_rows.size, 1);
});

test('retention deletes only what is past its window: events 7 days, incidents and the control log 90', async () => {
    const { clock, stream, pg, make, ingest } = rig();
    const now = clock.now();
    const at = (age_ms: number) => { clock.set(now - age_ms); };
    at(91 * DAY_MS); stream.add(make('Felix', 'agent.failure', incident('old', 'Felix', 'nav.stuck', 'detected')));
    at(90 * DAY_MS - 1000); stream.add(make('Felix', 'agent.failure', incident('kept', 'Felix', 'nav.stuck', 'detected')));
    at(7 * DAY_MS + 1000); stream.add(make('Mira', 'agent.state', { state: 'planning' }));
    at(7 * DAY_MS - 1000); stream.add(make('Mira', 'agent.state', { state: 'on_routine' }));
    at(0); stream.add(make('Mira', 'agent.state', { state: 'planning' }));
    await ingest.step({ block_ms: 0 });
    pg.controls.push(
        { id: 'c-new', at: new Date(now - 89 * DAY_MS).toISOString(), actor: 'Operator', origin: 'lan', action: 'Stop', target: 'Felix', ok: true, detail: null },
        { id: 'c-old', at: new Date(now - 90 * DAY_MS - 1).toISOString(), actor: 'Operator', origin: 'lan', action: 'Stop', target: 'Felix', ok: true, detail: null },
    );
    assert.equal(pg.rows.size, 5);

    const removed = await runRetention(pg.store, clock);
    assert.deepEqual(removed, { events: 3, incident_events: 1, controls: 1 });
    assert.deepEqual([...pg.rows.values()].map((entry) => entry.event.data.state), ['on_routine', 'planning']);
    assert.deepEqual([...pg.incident_rows.values()].map((event) => event.data.incident_id), ['kept']);
    assert.deepEqual(pg.controls.map((record) => record.id), ['c-new']);

    assert.deepEqual(await runRetention(pg.store, clock), { events: 0, incident_events: 0, controls: 0 }, 'a second run finds nothing more');
});
