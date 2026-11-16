// Step 4: the event envelope, emit() in the agent process, and the publisher (hub) in the
// MindServer with its bounded buffer.
//
// No Redis here: the hub writes through an injected interface, and the tests hand it the
// in-memory fake from helpers/fakes.mjs. The wiring through the real MindServer and the
// real action path is in events-wiring.test.js.
// Run from the repository root:  node --test genesis/tests/*.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    EVENT_TYPES, SEVERITIES, MAX_EVENT_BYTES, validateEvent, checkEventData, createUlidFactory, clipText,
} from '../shared/events.js';
import {
    createEmitter, initAgentEvents, emitEvent, agentEventsEnabled, skillStarted, runWithCorrelation,
} from '../events/agent_emit.js';
import { createEventHub } from '../events/hub.js';
import { startEventPublishing } from '../events/server.js';
import { fakeClock, fakeRedis, settle } from './helpers/fakes.mjs';

// One valid `data` for every event type.
const SAMPLES = {
    'agent.decision': { decision_id: '01JZ0000000000000000000000', summary: 'collect oak logs for the hall', trigger: 'idle', command: '!collectBlocks', args: ['oak_log', 8] },
    'skill.started': { skill: 'action:collectBlocks', args: ['oak_log', 8] },
    'skill.progress': { skill: 'action:collectBlocks', done: 3, total: 8 },
    'skill.result': { skill: 'action:collectBlocks', ok: false, interrupted: false, timedout: false, output: 'Could not find any oak_log to collect.', duration_ms: 1200 },
    'goal.changed': { scope: 'short_term', before: [], after: [{ id: 'g1', title: 'Collect oak logs' }], reason: 'the hall needs wood', source: 'planner', call_id: 'call-1' },
    'agent.failure': { kind: 'model', error: 'ModelTimeoutError', message: 'Ollama request timed out after 90000 ms.' },
    'agent.recovery': { kind: 'model', message: 'the model answers again' },
    'agent.message': { to: 'Mira', text: 'Do you have spare wheat?' },
    'agent.state': { state: 'idle', detail: { health: 20 } },
};

const quiet = { warn: () => {} };

function collectingEmitter(agent, options = {}) {
    const sent = [];
    const emitter = createEmitter({ agent, send: (event) => sent.push(event), ...quiet, ...options });
    return { emitter, sent };
}

test('every event type validates, with the envelope the design names', () => {
    assert.deepEqual(Object.keys(SAMPLES).sort(), [...EVENT_TYPES].sort());
    const { emitter, sent } = collectingEmitter('Arthur');
    for (const type of EVENT_TYPES) {
        const event = emitter.emit(type, SAMPLES[type], { corr: 'decision-7', severity: 'info' });
        assert.ok(event, `${type} was not emitted`);
        assert.deepEqual(validateEvent(event), { ok: true, errors: [] });
        assert.deepEqual(Object.keys(event), ['v', 'id', 'ts', 'agent', 'seq', 'type', 'corr', 'severity', 'data']);
        assert.equal(event.v, 1);
        assert.match(event.id, /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
        assert.equal(new Date(event.ts).toISOString(), event.ts);
        assert.equal(event.agent, 'Arthur');
        assert.equal(event.type, type);
        assert.equal(event.corr, 'decision-7');
        // an event survives the trip through JSON unchanged
        assert.deepEqual(JSON.parse(JSON.stringify(event)), event);
    }
    assert.equal(sent.length, EVENT_TYPES.length);
});

test('every event type refuses data that lacks a required field', () => {
    for (const type of EVENT_TYPES) {
        assert.deepEqual(checkEventData(type, SAMPLES[type]), []);
        const required = Object.keys(SAMPLES[type]).filter((key) => {
            const without = { ...SAMPLES[type] };
            delete without[key];
            return checkEventData(type, without).length > 0;
        });
        assert.ok(required.length > 0, `${type}: no field is required`);
        assert.ok(checkEventData(type, {}).length > 0, `${type}: empty data passed`);
        assert.ok(checkEventData(type, null).length > 0);
        assert.ok(checkEventData(type, []).length > 0);
    }
    assert.ok(checkEventData('goal.changed', { ...SAMPLES['goal.changed'], reason: '  ' }).length > 0, 'a blank reason passed');
    assert.ok(checkEventData('goal.changed', { ...SAMPLES['goal.changed'], source: 'somebody' }).length > 0);
    assert.ok(checkEventData('skill.result', { ...SAMPLES['skill.result'], ok: 'no' }).length > 0);
    assert.deepEqual(checkEventData('skill.progress', { skill: 'x', done: 1, total: null }), []);
});

test('the envelope is checked field by field, and nothing makes the validator throw', () => {
    const { emitter } = collectingEmitter('Arthur');
    const good = emitter.emit('agent.state', { state: 'idle' });
    const broken = {
        v: 2, id: 'not-a-ulid', ts: '2026-01-01 12:00', agent: '', seq: 0, type: 'agent.unknown',
        corr: '', severity: 'fatal', data: [],
    };
    for (const [key, value] of Object.entries(broken)) {
        const result = validateEvent({ ...good, [key]: value });
        assert.equal(result.ok, false, `${key}=${JSON.stringify(value)} passed`);
        assert.ok(result.errors.length > 0);
    }
    for (const key of Object.keys(good)) {
        const without = { ...good };
        delete without[key];
        assert.equal(validateEvent(without).ok, false, `an event without "${key}" passed`);
    }
    assert.equal(validateEvent({ ...good, extra: 1 }).ok, false);
    assert.equal(validateEvent({ ...good, seq: 1.5 }).ok, false);
    assert.equal(validateEvent({ ...good, data: { state: 'x', detail: { text: 'y'.repeat(MAX_EVENT_BYTES) } } }).ok, false);
    const circular = { state: 'x' };
    circular.detail = { self: circular };
    assert.equal(validateEvent({ ...good, data: circular }).ok, false);
    for (const junk of [null, undefined, 42, 'event', [], () => {}]) {
        assert.equal(validateEvent(junk).ok, false);
    }
    for (const severity of SEVERITIES) assert.equal(validateEvent({ ...good, severity }).ok, true);
    assert.equal(validateEvent({ ...good, corr: null }).ok, true);
});

test('ids are ULIDs that sort in the order they were made, also within one millisecond', () => {
    let now = Date.parse('2026-03-01T00:00:00.000Z');
    const ulid = createUlidFactory({ now: () => now });
    const ids = [];
    for (let i = 0; i < 50; i++) ids.push(ulid());   // same millisecond
    now += 1;
    for (let i = 0; i < 50; i++) ids.push(ulid());
    now -= 5;                                        // a clock that steps back
    for (let i = 0; i < 50; i++) ids.push(ulid());
    assert.equal(new Set(ids).size, ids.length);
    assert.deepEqual([...ids].sort(), ids);
    for (const id of ids) assert.match(id, /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    // the random part cannot overflow into a broken id
    const maxed = createUlidFactory({ now: () => 1, random: () => 0.999999 });
    maxed();
    assert.match(maxed(), /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
});

test('seq increases by one per agent', () => {
    const arthur = collectingEmitter('Arthur');
    const mira = collectingEmitter('Mira');
    for (let i = 0; i < 5; i++) {
        arthur.emitter.emit('agent.state', { state: `a${i}` });
        if (i % 2 === 0) mira.emitter.emit('agent.state', { state: `m${i}` });
        arthur.emitter.emit('skill.started', { skill: 'action:stay' });
    }
    assert.deepEqual(arthur.sent.map((e) => e.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.deepEqual(mira.sent.map((e) => e.seq), [1, 2, 3]);
    assert.ok(arthur.sent.every((e) => e.agent === 'Arthur'));
    assert.ok(mira.sent.every((e) => e.agent === 'Mira'));
    assert.equal(arthur.emitter.stats().seq, 10);
});

test('seq has no gaps: an invalid event or a throttled one uses no number, a failed hand-over does', () => {
    let fail_send = false;
    const sent = [];
    let now = 1_000_000;
    const emitter = createEmitter({
        agent: 'Felix', now: () => now, ...quiet,
        send: (event) => { if (fail_send) throw new Error('socket is gone'); sent.push(event); },
    });
    assert.equal(emitter.emit('agent.state', { state: 'one' }).seq, 1);
    assert.equal(emitter.emit('agent.state', {}), null);                    // invalid data
    assert.equal(emitter.emit('no.such.type', { state: 'x' }), null);       // unknown type
    assert.equal(emitter.emit('agent.state', { state: 'x' }, { severity: 'loud' }), null);
    assert.equal(emitter.emit('skill.progress', { skill: 's', done: 1, total: 5 }).seq, 2);
    assert.equal(emitter.emit('skill.progress', { skill: 's', done: 2, total: 5 }), null); // within the same second
    assert.equal(emitter.emit('agent.state', { state: 'two' }).seq, 3);
    fail_send = true;
    assert.doesNotThrow(() => emitter.emit('agent.state', { state: 'lost' }));
    fail_send = false;
    assert.equal(emitter.emit('agent.state', { state: 'three' }).seq, 5);
    assert.deepEqual(sent.map((e) => e.seq), [1, 2, 3, 5]);
    assert.deepEqual(emitter.stats(), { emitted: 5, invalid: 3, throttled: 1, send_failed: 1, seq: 5 });
});

test('seq carries on from the last number before a restart', () => {
    const { emitter } = collectingEmitter('Nova', { last_seq: 1041 });
    assert.equal(emitter.emit('agent.state', { state: 'back' }).seq, 1042);
});

test('skill.progress: at most one per second per agent', () => {
    let now = Date.parse('2026-01-01T00:00:00.000Z');
    const arthur = collectingEmitter('Arthur', { now: () => now });
    const mira = collectingEmitter('Mira', { now: () => now });
    for (let ms = 0; ms < 5000; ms += 100) {      // 50 progress reports in 5 seconds
        now += 100;
        arthur.emitter.emit('skill.progress', { skill: 'action:collectBlocks', done: ms / 100, total: 50 });
        arthur.emitter.emit('agent.state', { state: 'busy' }); // other types are not limited
    }
    mira.emitter.emit('skill.progress', { skill: 'action:till', done: 1, total: null }); // her own limit
    const progress = arthur.sent.filter((e) => e.type === 'skill.progress');
    assert.equal(progress.length, 5);
    for (let i = 1; i < progress.length; i++) {
        assert.ok(Date.parse(progress[i].ts) - Date.parse(progress[i - 1].ts) >= 1000);
    }
    assert.equal(arthur.sent.filter((e) => e.type === 'agent.state').length, 50);
    assert.equal(arthur.emitter.stats().throttled, 45);
    assert.equal(mira.sent.length, 1);
});

test('events are off unless the genesis_events setting turns them on', () => {
    const sent = [];
    const send = (event) => sent.push(event);
    for (const settings of [undefined, {}, { genesis_events: {} }, { genesis_events: { enabled: false } },
        { genesis_events: { enabled: 'true' } }, { genesis_events: { enabled: 1 } }]) {
        assert.equal(initAgentEvents({ agent: 'Arthur', settings, send }), null);
        assert.equal(agentEventsEnabled(), false);
        assert.equal(emitEvent('agent.state', { state: 'idle' }), null);
        const result = { ok: true, interrupted: false, timedout: false, output: 'x' };
        assert.equal(skillStarted('action:stay').result(result), result);
    }
    assert.deepEqual(sent, []);

    assert.ok(initAgentEvents({ agent: 'Arthur', settings: { genesis_events: { enabled: true } }, send, ...quiet }));
    assert.equal(agentEventsEnabled(), true);
    assert.equal(emitEvent('agent.state', { state: 'idle' }).seq, 1);
    assert.equal(sent.length, 1);
    initAgentEvents({ agent: 'Arthur', settings: {}, send }); // leave it off for the tests that follow
});

test('events emitted while a decision is carried out carry its id as corr', async () => {
    const { emitter, sent } = collectingEmitter('Arthur');
    emitter.emit('agent.state', { state: 'before' });
    await runWithCorrelation('decision-42', async () => {
        emitter.emit('skill.started', { skill: 'action:stay' });
        await new Promise((resolve) => setTimeout(resolve, 5));
        emitter.emit('skill.result', { ...SAMPLES['skill.result'], ok: true });
        emitter.emit('agent.state', { state: 'own' }, { corr: 'other' });
        emitter.emit('agent.state', { state: 'none' }, { corr: null });
    });
    emitter.emit('agent.state', { state: 'after' });
    assert.deepEqual(sent.map((e) => e.corr), [null, 'decision-42', 'decision-42', 'other', null, null]);
});

test('long text is cut before it goes into an event', () => {
    assert.equal(clipText('short', 100), 'short');
    const cut = clipText('a'.repeat(3000) + 'THE END', 200);
    assert.equal(cut.length, 200);
    assert.ok(cut.endsWith('THE END'));
    assert.equal(clipText(null), '');
});

// ---- the publisher in the MindServer ----

function hubWith(options = {}) {
    const redis = fakeRedis();
    const clock = fakeClock();
    const lines = [];
    const hub = createEventHub({ client: redis, timers: clock, now: clock.now, warn: (line) => lines.push(JSON.parse(line)), ...options });
    return { hub, redis, clock, lines };
}

function eventsFrom(agent, count, first_seq = 1) {
    const { emitter, sent } = collectingEmitter(agent, { last_seq: first_seq - 1 });
    for (let i = 0; i < count; i++) emitter.emit('agent.state', { state: `s${first_seq + i}` });
    return sent;
}

test('hub: events are written to a capped stream in the order they came', async () => {
    const { hub, redis } = hubWith({ stream_maxlen: 5 });
    const events = eventsFrom('Arthur', 8);
    for (const event of events) assert.equal(hub.accept(event), true);
    await hub.drain();
    assert.deepEqual(redis.events().map((e) => e.seq), [4, 5, 6, 7, 8]); // capped at 5 entries
    assert.deepEqual(redis.events().at(-1), events.at(-1));
    const entry = redis.streams.get('genesis:events').at(-1);
    assert.deepEqual(Object.keys(entry.fields).sort(), ['agent', 'event', 'type']);
    assert.deepEqual(hub.stats(), {
        accepted: 8, published: 8, dropped: 0, rejected: 0, publish_failures: 0, seq_gaps: 0,
        buffered: 0, redis_ok: true, last_error: null,
    });
});

test('hub: one stream per agent when the setting asks for it', async () => {
    const { hub, redis } = hubWith({ stream_per_agent: true, stream: 'gen' });
    for (const event of [...eventsFrom('Arthur', 2), ...eventsFrom('Mira', 3)]) hub.accept(event);
    await hub.drain();
    assert.deepEqual([...redis.streams.keys()].sort(), ['gen:Arthur', 'gen:Mira']);
    assert.deepEqual(redis.events('gen:Mira').map((e) => e.seq), [1, 2, 3]);
});

test('hub: an invalid event is refused and counted, and never reaches Redis', async () => {
    const { hub, redis } = hubWith();
    const [good] = eventsFrom('Arthur', 1);
    for (const bad of [null, 'text', {}, { ...good, seq: 0 }, { ...good, type: 'x.y' }, { ...good, extra: true }]) {
        assert.equal(hub.accept(bad), false);
    }
    await hub.drain();
    assert.equal(redis.calls, 0);
    assert.equal(hub.stats().rejected, 6);
    assert.equal(hub.stats().accepted, 0);
});

test('hub: with Redis down nothing waits, the buffer stays bounded and the dropped counter rises', async () => {
    const { hub, redis, clock, lines } = hubWith({ buffer_size: 10 });
    redis.failing = true;
    const events = eventsFrom('Arthur', 35);
    const dropped_seen = [];
    for (const event of events) {
        const started = performance.now();
        assert.equal(hub.accept(event), true);          // returns at once, there is nothing to await
        assert.ok(performance.now() - started < 50);
        await settle(2);
        dropped_seen.push(hub.stats().dropped);
        assert.ok(hub.stats().buffered <= 10);
    }
    assert.equal(hub.stats().dropped, 25);
    assert.deepEqual([...dropped_seen].sort((a, b) => a - b), dropped_seen); // only ever rises
    assert.equal(hub.stats().published, 0);
    assert.equal(hub.stats().redis_ok, false);
    assert.match(hub.stats().last_error, /fake Redis is down/);
    // one line when Redis goes down, not one per event
    assert.equal(lines.filter((l) => l.event === 'genesis_events_redis_down').length, 1);

    // it retries by itself, with a growing pause, and stays quiet while Redis is still down
    const calls_before = redis.calls;
    await clock.advance(60_000);
    assert.ok(redis.calls > calls_before);
    assert.ok(redis.calls - calls_before <= 8, `retried ${redis.calls - calls_before} times in a minute`);
    assert.equal(lines.filter((l) => l.event === 'genesis_events_redis_down').length, 1);

    // Redis comes back: what is still in the buffer (the newest 10) is written, in order
    redis.failing = false;
    await clock.advance(30_000);
    assert.deepEqual(redis.events().map((e) => e.seq), [26, 27, 28, 29, 30, 31, 32, 33, 34, 35]);
    assert.equal(hub.stats().buffered, 0);
    assert.equal(hub.stats().redis_ok, true);
    assert.equal(hub.stats().dropped, 25);
    assert.equal(lines.filter((l) => l.event === 'genesis_events_redis_back').length, 1);
});

test('hub: a Redis that never answers is treated as down after the publish timeout', async () => {
    const { hub, redis, clock } = hubWith({ buffer_size: 3, publish_timeout_ms: 5000 });
    redis.hanging = true;
    for (const event of eventsFrom('Arthur', 6)) assert.equal(hub.accept(event), true);
    await settle();
    assert.equal(hub.stats().dropped, 3);
    assert.equal(hub.stats().publish_failures, 0); // the first write is still hanging
    await clock.advance(5000);
    assert.equal(hub.stats().publish_failures, 1);
    assert.equal(hub.stats().redis_ok, false);
    redis.hanging = false;
    await clock.advance(10_000);
    // the event that was being written when the others were thrown away is kept, then the newest
    assert.deepEqual(redis.events().map((e) => e.seq), [1, 5, 6]);
});

test('hub: a client that throws instead of rejecting, or a missing client, harms nothing', async () => {
    const throwing = hubWith({ client: { xadd() { throw new Error('boom'); } } });
    const missing = hubWith({ client: undefined });
    for (const { hub } of [throwing, missing]) {
        for (const event of eventsFrom('Arthur', 3)) assert.equal(hub.accept(event), true);
        await hub.drain();
        assert.equal(hub.stats().published, 0);
        assert.equal(hub.stats().buffered, 3);
        assert.equal(hub.stats().redis_ok, false);
    }
});

test('hub: a gap in an agent\'s seq is counted', async () => {
    const { hub } = hubWith();
    const events = eventsFrom('Arthur', 6);
    for (const event of [events[0], events[1], events[4], events[5]]) hub.accept(event);
    for (const event of eventsFrom('Mira', 2)) hub.accept(event);
    hub.accept(eventsFrom('Arthur', 1)[0]); // Arthur restarted and counts from 1 again: not a gap
    await hub.drain();
    assert.equal(hub.stats().seq_gaps, 2);
});

test('hub: after close() nothing is accepted and no retry is left behind', async () => {
    const { hub, redis, clock } = hubWith();
    redis.failing = true;
    hub.accept(eventsFrom('Arthur', 1)[0]);
    await settle();
    assert.equal(clock.pending(), 1);
    hub.close();
    assert.equal(clock.pending(), 0);
    assert.equal(hub.accept(eventsFrom('Arthur', 1)[0]), false);
});

test('startEventPublishing: gives the MindServer a sink that feeds the hub with the settings', async () => {
    const redis = fakeRedis();
    let sink = null;
    let asked_url = null;
    const hub = await startEventPublishing(
        { enabled: true, redis_url: 'redis://cache:6379', stream: 'world:events', stream_maxlen: 100, buffer_size: 50 },
        { setEventSink: (fn) => { sink = fn; }, createClient: async ({ url }) => { asked_url = url; return redis; }, warn: () => {} },
    );
    assert.equal(asked_url, 'redis://cache:6379');
    for (const event of eventsFrom('Nova', 3)) sink(event);
    await hub.drain();
    assert.deepEqual(redis.events('world:events').map((e) => e.seq), [1, 2, 3]);
});

test('startEventPublishing: a Redis client that cannot even be created costs events, nothing else', async () => {
    let sink = null;
    const hub = await startEventPublishing(
        { enabled: true, redis_url: 'redis://cache:6379', stream: 's', stream_maxlen: 100, buffer_size: 2 },
        { setEventSink: (fn) => { sink = fn; }, createClient: async () => { throw new Error('no such package'); }, warn: () => {}, timers: fakeClock() },
    );
    for (const event of eventsFrom('Nova', 5)) assert.doesNotThrow(() => sink(event));
    await settle();
    assert.equal(hub.stats().dropped, 3);
    assert.match(hub.stats().last_error, /no such package/);
});
