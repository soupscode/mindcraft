import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAlerter, HOUR_MS } from '../src/alerter.js';
import { createReader } from '../src/reader.js';
import { createNtfy } from '../src/ntfy.js';
import { validateEvent } from '../src/contract.js';
import { runRetention, DAY_MS } from '../src/retention.js';
import { scrub } from '../src/text.js';
import { eventMaker, fakeClock, fakeNotifier, fakeStream, idMaker, incident, memoryAlertStore } from './fakes.js';

function rig({ start = Date.parse('2026-11-16T12:10:00.000Z'), enabled = true } = {}) {
    const clock = fakeClock(start);
    const ntfy = fakeNotifier({ enabled });
    const pg = memoryAlertStore();
    const stream = fakeStream(clock);
    const make = eventMaker(clock);
    const alerter = createAlerter({ notifier: ntfy.notifier, store: pg.store, marks: stream.client, clock, ids: idMaker(), warn: () => {} });
    return { clock, ntfy, pg, stream, make, alerter };
}
const escalated = (id: string, name = 'Nova', kind = 'login.refused') =>
    incident(id, name, kind, 'escalated', { outcome: 'needs_operator', needs_operator: true, recovery: { step: 'login', attempt: 3, max: 3, result: 'failed' } });
const modelDown = (make: ReturnType<typeof eventMaker>, agent = 'Mira') =>
    make(agent, 'agent.failure', { kind: 'model', error: 'ModelUnavailableError', message: 'fetch failed', url: 'http://192.168.1.50:11434/api/chat', provider: 'ollama' }, { severity: 'error' });

test('a critical alert pings exactly once, however many matching events arrive', async () => {
    const { ntfy, pg, make, alerter, clock } = rig();
    await alerter.onEvent(make('supervisor', 'agent.failure', escalated('i1'), { severity: 'error' }));
    for (let i = 0; i < 25; i++) {
        clock.advance(30 * 1000);
        await alerter.onEvent(make('supervisor', 'agent.failure', escalated('i1'), { severity: 'error' }));
        await alerter.tick();
    }
    clock.advance(3 * HOUR_MS);
    await alerter.tick();
    assert.equal(ntfy.pushes.length, 1, 'one ping, no repeat, not in the hourly push either');
    assert.equal(ntfy.pushes[0].priority, 'urgent');
    assert.match(ntfy.pushes[0].body, /Nova · Login refused · needs operator/);
    const open = alerter.openAlerts();
    assert.equal(open.length, 1, 'one open alert per problem');
    assert.equal(open[0].occurrences, 26);
    assert.equal(open[0].push_state, 'sent');
    assert.equal(pg.alerts.size, 1);
});

test('two different problems are two alerts and two pings', async () => {
    const { ntfy, make, alerter } = rig();
    await alerter.onEvent(make('supervisor', 'agent.failure', escalated('i1', 'Nova'), { severity: 'error' }));
    await alerter.onEvent(make('Felix', 'agent.failure', escalated('i2', 'Felix', 'nav.stuck'), { severity: 'error' }));
    assert.equal(ntfy.urgent().length, 2);
    assert.equal(alerter.openAlerts().length, 2);
});

test('a ping ntfy refused is tried again until it goes out once; one of unknown fate is never repeated', async () => {
    const { ntfy, make, alerter, clock } = rig();
    ntfy.answers.push('refused', 'refused', 'delivered');
    await alerter.onEvent(make('supervisor', 'agent.failure', escalated('i1'), { severity: 'error' }));
    assert.equal(alerter.openAlerts()[0].push_state, 'failed');
    for (let i = 0; i < 10; i++) { clock.advance(61 * 1000); await alerter.tick(); }
    assert.equal(ntfy.pushes.length, 3);
    assert.equal(alerter.openAlerts()[0].push_state, 'sent');

    ntfy.answers.push('unknown');
    await alerter.onEvent(make('Felix', 'agent.failure', escalated('i2', 'Felix', 'nav.stuck'), { severity: 'error' }));
    for (let i = 0; i < 10; i++) { clock.advance(61 * 1000); await alerter.tick(); }
    assert.equal(ntfy.pushes.length, 4, 'it may have reached the phone: not sent again');
});

test('a restart does not ping again: Postgres remembers the open alert, and Redis the mark when Postgres is down', async () => {
    const { ntfy, pg, stream, make, alerter, clock } = rig();
    const event = make('supervisor', 'agent.failure', escalated('i1'), { severity: 'error' });
    await alerter.onEvent(event);
    assert.equal(ntfy.pushes.length, 1);

    const second = createAlerter({ notifier: ntfy.notifier, store: pg.store, marks: stream.client, clock, ids: idMaker(), warn: () => {} });
    assert.equal(await second.restore(), true);
    await second.onEvent(event); // the stream delivers it again after the crash
    assert.equal(ntfy.pushes.length, 1);

    pg.down = true;
    const third = createAlerter({ notifier: ntfy.notifier, store: pg.store, marks: stream.client, clock, ids: idMaker(), warn: () => {} });
    assert.equal(await third.restore(), false);
    await third.onEvent(event);
    assert.equal(ntfy.pushes.length, 1, 'the mark in Redis stood in for Postgres');
});

test('model away, the desktop leaving and model available never alert', async () => {
    const { ntfy, make, alerter, clock } = rig();
    await alerter.onEvent(make('planner', 'agent.state', { state: 'model_leaving', detail: { reason: 'desktop_leaving' } }));
    await alerter.onEvent(make('planner', 'agent.state', { state: 'model_away', detail: { reason: 'desktop_leaving' } }));
    await alerter.onEvent(make('supervisor', 'agent.failure', { incident_id: 'away-1', source: { type: 'service', name: 'planner' }, kind: 'model.away', phase: 'detected', is_failure: false, recovery: null, outcome: 'expected', needs_operator: false, reason: 'desktop_leaving' }));
    await alerter.onEvent(make('planner', 'agent.state', { state: 'model_away', detail: { reason: 'probe_failed', failed_probes: 2 } }));
    await alerter.onEvent(make('Mira', 'agent.state', { state: 'on_routine', detail: { gate: 'AWAY' } }));
    clock.advance(9 * HOUR_MS);
    await alerter.tick();
    await alerter.onEvent(make('supervisor', 'agent.recovery', { incident_id: 'away-1', source: { type: 'service', name: 'planner' }, kind: 'model.available', phase: 'resolved', is_failure: false, recovery: null, outcome: 'expected', needs_operator: false }));
    await alerter.onEvent(make('planner', 'agent.state', { state: 'model_available', detail: { reason: 'desktop_available' } }));
    clock.advance(2 * HOUR_MS);
    await alerter.tick();
    assert.equal(ntfy.pushes.length, 0);
    assert.equal(alerter.openAlerts().length, 0);
    assert.equal(alerter.queuedWarnings().length, 0);
    assert.equal(alerter.state().gate, 'available');
});

test('"the model is unreachable" chat failures do not alert while the gate is away, leaving or not yet known', async () => {
    const { ntfy, make, alerter, clock } = rig();
    await alerter.onEvent(modelDown(make));                       // gate not known yet
    await alerter.onEvent(make('planner', 'agent.state', { state: 'model_leaving', detail: {} }));
    await alerter.onEvent(modelDown(make));
    await alerter.onEvent(make('planner', 'agent.state', { state: 'model_away', detail: {} }));
    for (let i = 0; i < 40; i++) await alerter.onEvent(modelDown(make, i % 2 ? 'Felix' : 'Arthur'));
    clock.advance(2 * HOUR_MS);
    await alerter.tick();
    assert.equal(ntfy.pushes.length, 0);
    assert.equal(alerter.openAlerts().length, 0);
    // (decided: a model call that failed is in the history only, whatever the gate says: nobody is told)
    assert.equal(alerter.queuedWarnings().length, 0);
});

test('decided: a model failure is never a warning, with the gate open or closed (warnings are only what an agent gave up on)', async () => {
    const { ntfy, make, alerter, clock } = rig();
    await alerter.onEvent(make('planner', 'agent.state', { state: 'model_available', detail: {} }));
    await alerter.onEvent(modelDown(make));
    await alerter.onEvent(modelDown(make));
    await alerter.onEvent(make('planner', 'agent.state', { state: 'model_away', detail: {} }));
    await alerter.onEvent(make('Mira', 'agent.failure', { kind: 'model', error: 'ModelInvalidResponseError', message: 'not JSON' }, { severity: 'error' }));
    clock.advance(2 * HOUR_MS);
    await alerter.tick();
    assert.equal(alerter.queuedWarnings().length, 0);
    assert.equal(alerter.openAlerts().length, 0);
    assert.equal(ntfy.pushes.length, 0);
});

test('an agent the operator holds never alerts, until the hold is released', async () => {
    const { ntfy, make, alerter, clock } = rig();
    await alerter.onEvent(make('planner', 'agent.state', { state: 'model_available', detail: {} }));
    await alerter.onEvent(make('Felix', 'agent.state', { state: 'held', detail: { by: 'operator', reason: 'operator_stop' } }));
    await alerter.onEvent(make('Felix', 'agent.failure', incident('i1', 'Felix', 'nav.stuck', 'detected'), { severity: 'warn' }));
    await alerter.onEvent(make('Felix', 'agent.failure', escalated('i1', 'Felix', 'nav.stuck'), { severity: 'error' }));
    await alerter.onEvent(make('Felix', 'agent.failure', incident('i2', 'Felix', 'step.parked', 'detected', { outcome: 'gave_up' }), { severity: 'warn' }));
    await alerter.onEvent(modelDown(make, 'Felix'));
    clock.advance(2 * HOUR_MS);
    await alerter.tick();
    assert.equal(ntfy.pushes.length, 0);
    assert.equal(alerter.openAlerts().length, 0);
    assert.deepEqual(alerter.state().held, ['Felix']);

    await alerter.onEvent(make('Felix', 'agent.state', { state: 'hold_released', detail: { by: 'operator' } }));
    await alerter.onEvent(make('Felix', 'agent.failure', escalated('i3', 'Felix', 'nav.stuck'), { severity: 'error' }));
    assert.equal(ntfy.urgent().length, 1);
});

test('warnings wait for the top of the hour and go out as ONE quiet push', async () => {
    const { ntfy, pg, make, alerter, clock } = rig({ start: Date.parse('2026-11-16T12:10:00.000Z') });
    await alerter.onEvent(make('planner', 'agent.state', { state: 'model_available', detail: {} }));
    await alerter.onEvent(make('Arthur', 'agent.failure', incident('i1', 'Arthur', 'step.parked', 'detected', { outcome: 'gave_up' }), { severity: 'warn' }));
    await alerter.onEvent(make('Mira', 'agent.failure', incident('i2', 'Mira', 'step.parked', 'detected', { outcome: 'gave_up' }), { severity: 'warn' }));
    await alerter.onEvent(modelDown(make, 'Felix'));
    await alerter.onEvent(modelDown(make, 'Felix'));
    for (let minute = 11; minute < 60; minute++) { clock.advance(60 * 1000); await alerter.tick(); }
    assert.equal(ntfy.pushes.length, 0, 'nothing before the hour');
    clock.advance(60 * 1000); // 13:00
    await alerter.tick();
    assert.equal(ntfy.pushes.length, 1);
    assert.equal(ntfy.pushes[0].priority, 'low');
    assert.equal(ntfy.pushes[0].title, 'Genesis · 2 warnings');
    assert.match(ntfy.pushes[0].body, /Arthur · Step parked · gave up\nMira · Step parked · gave up/);
    assert.ok(!/Model call failed/.test(ntfy.pushes[0].body), 'a model failure is not a warning (decided)');
    assert.equal(pg.batches.length, 1);

    for (let i = 0; i < 180; i++) { clock.advance(60 * 1000); await alerter.tick(); }
    assert.equal(ntfy.pushes.length, 1, 'an hour with no new warning sends nothing, and nothing is sent twice');
});

test('decided: warnings are ONLY what an agent gave up on: an incident still open, or recovering again and again, is log only', async () => {
    const { ntfy, make, alerter, clock } = rig();
    await alerter.onEvent(make('Felix', 'agent.failure', incident('i1', 'Felix', 'nav.stuck', 'detected'), { severity: 'warn' }));
    clock.advance(40 * 1000);
    await alerter.onEvent(make('Felix', 'agent.recovery', incident('i1', 'Felix', 'nav.stuck', 'resolved', { outcome: 'auto_recovered' })));
    // still open after 10 minutes: was a warning, is not one any more
    await alerter.onEvent(make('Mira', 'agent.failure', incident('i2', 'Mira', 'server.down', 'detected'), { severity: 'warn' }));
    clock.advance(20 * 60 * 1000);
    await alerter.tick();
    // the same thing recovering by itself 5 times in an hour: was a warning, is not one any more
    for (let i = 0; i < 6; i++) {
        await alerter.onEvent(make('Felix', 'agent.failure', incident(`s${i}`, 'Felix', 'nav.stuck', 'detected'), { severity: 'warn' }));
        await alerter.onEvent(make('Felix', 'agent.recovery', incident(`s${i}`, 'Felix', 'nav.stuck', 'resolved', { outcome: 'auto_recovered' })));
    }
    clock.advance(HOUR_MS);
    await alerter.tick();
    assert.deepEqual([alerter.queuedWarnings().length, alerter.openAlerts().length, ntfy.pushes.length], [0, 0, 0]);
    // what an agent gave up on IS a warning, and the only kind
    await alerter.onEvent(make('Arthur', 'agent.failure', incident('g1', 'Arthur', 'step.parked', 'detected', { outcome: 'gave_up' }), { severity: 'warn' }));
    assert.deepEqual(alerter.queuedWarnings().map((alert) => alert.title), ['Arthur · Step parked · gave up']);
});

test('a warning that turns critical stays one alert and pings once', async () => {
    const { ntfy, make, alerter, clock } = rig();
    await alerter.onEvent(make('Mira', 'agent.failure', incident('i1', 'Mira', 'step.parked', 'detected', { outcome: 'gave_up' }), { severity: 'warn' }));
    assert.equal(alerter.queuedWarnings().length, 1);
    await alerter.onEvent(make('supervisor', 'agent.failure', escalated('i1', 'Mira', 'step.parked'), { severity: 'error' }));
    await alerter.onEvent(make('supervisor', 'agent.failure', escalated('i1', 'Mira', 'step.parked'), { severity: 'error' }));
    assert.equal(alerter.openAlerts().length, 1);
    assert.equal(alerter.openAlerts()[0].severity, 'critical');
    assert.equal(ntfy.urgent().length, 1);
    clock.advance(HOUR_MS);
    await alerter.tick();
    assert.equal(ntfy.pushes.length, 1, 'it is not in the hourly push as well');
});

test('the 60-second rule: a store down for 60 seconds in a row is one critical ping; a shorter blip is none', async () => {
    const { ntfy, alerter, clock } = rig();
    for (let s = 0; s < 55; s += 5) { await alerter.observeStores({ redis: false, postgres: true }); clock.advance(5000); }
    await alerter.observeStores({ redis: true, postgres: true });   // back after 55 seconds
    assert.equal(ntfy.pushes.length, 0);

    for (let s = 0; s < 60; s += 5) { await alerter.observeStores({ redis: false, postgres: true }); clock.advance(5000); }
    assert.equal(ntfy.pushes.length, 0, '59.999 seconds is not 60');
    await alerter.observeStores({ redis: false, postgres: true });
    assert.equal(ntfy.urgent().length, 1);
    assert.match(ntfy.pushes[0].body, /Redis has been unreachable for 60 seconds/);
    for (let s = 0; s < 3600; s += 5) { clock.advance(5000); await alerter.observeStores({ redis: false, postgres: true }); await alerter.tick(); }
    assert.equal(ntfy.pushes.length, 1, 'no repeat while it stays down');

    await alerter.observeStores({ redis: true, postgres: true });
    assert.equal(alerter.openAlerts().length, 0, 'it closes when the store is back');
    for (let s = 0; s <= 60; s += 5) { await alerter.observeStores({ redis: true, postgres: false }); clock.advance(5000); }
    assert.equal(ntfy.urgent().length, 2, 'Postgres is a problem of its own; a new outage is a new alert');
    assert.match(ntfy.pushes[1].body, /Postgres has been unreachable/);
});

test('with Postgres down the alerter still pings, and writes the alert once Postgres is back', async () => {
    const { ntfy, pg, make, alerter } = rig();
    pg.down = true;
    await alerter.onEvent(make('supervisor', 'agent.failure', escalated('i1'), { severity: 'error' }));
    assert.equal(ntfy.urgent().length, 1);
    assert.equal(pg.alerts.size, 0);
    pg.down = false;
    await alerter.tick();
    assert.equal(pg.alerts.size, 1);
    assert.equal([...pg.alerts.values()][0].push_state, 'sent');
});

test('a push carries no address, token or free text of the event', async () => {
    const { ntfy, make, alerter, clock } = rig();
    await alerter.onEvent(make('planner', 'agent.state', { state: 'model_available', detail: {} }));
    await alerter.onEvent(make('Mira', 'agent.failure', {
        kind: 'model', error: 'ModelTimeoutError', message: 'no answer from http://192.168.1.50:11434 with key sk-abcdefghijklmnopqrstuvwxyz123456',
        url: 'http://desktop.soups.lol:11434/api/chat', provider: 'ollama',
    }, { severity: 'error' }));
    await alerter.onEvent(make('supervisor', 'agent.failure', {
        ...escalated('i9', 'Nova'), message: 'kicked by 10.0.0.7:25565, token=hunter2', reason: 'see https://example.com/x?auth=abc',
    }, { severity: 'error' }));
    await alerter.onEvent(make('supervisor', 'agent.failure', { ...escalated('i10', 'http://evil.example/x'), kind: 'Bearer abc.def' }, { severity: 'error' }));
    clock.advance(HOUR_MS);
    await alerter.tick();
    const text = ntfy.text();
    assert.equal(ntfy.pushes.length, 2); // the two critical ones; the model failure is no alert at all (decided)
    for (const secret of ['192.168', '10.0.0.7', 'soups.lol', 'http', 'sk-abc', 'hunter2', 'example', 'Bearer', '11434', 'kicked']) {
        assert.ok(!text.includes(secret), `"${secret}" must not be in a push`);
    }
    assert.match(text, /unknown · Problem · needs operator/, 'a name or kind that is not a plain word is not repeated');
    assert.equal(scrub('see http://10.1.2.3:8080/a and host.ts.net:443 token=abc user@mail.com'), 'see [removed] and [removed] [removed] [removed]');
});

test('ntfy: the topic and server come from the caller, the request is JSON to the server root, and no topic means no send', async () => {
    const calls: any[] = [];
    const ntfy = createNtfy({ server: 'https://ntfy.example/', topic: 'TOPIC_PLACEHOLDER', fetch: async (url, init) => { calls.push({ url, ...init, body: JSON.parse(init.body) }); return { ok: true, status: 200 }; } });
    assert.equal(await ntfy.send({ title: 'Genesis critical', body: 'Nova · Login refused · needs operator', priority: 'urgent', tags: ['rotating_light'] }), 'delivered');
    assert.equal(calls[0].url, 'https://ntfy.example');
    assert.deepEqual(calls[0].body, { topic: 'TOPIC_PLACEHOLDER', title: 'Genesis critical', message: 'Nova · Login refused · needs operator', priority: 5, tags: ['rotating_light'] });
    assert.equal(calls[0].headers.authorization, undefined);

    const refused = createNtfy({ server: 'https://ntfy.example', topic: 'T', fetch: async () => ({ ok: false, status: 429 }) });
    assert.equal(await refused.send({ title: 't', body: 'b', priority: 'low', tags: [] }), 'refused');
    const cut = createNtfy({ server: 'https://ntfy.example', topic: 'T', fetch: async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); } });
    assert.equal(await cut.send({ title: 't', body: 'b', priority: 'low', tags: [] }), 'unknown');
    const down = createNtfy({ server: 'https://ntfy.example', topic: 'T', fetch: async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); } });
    assert.equal(await down.send({ title: 't', body: 'b', priority: 'low', tags: [] }), 'refused');

    const off = createNtfy({ server: 'https://ntfy.example', topic: '' });
    assert.equal(off.enabled(), false);
    const { ntfy: none, make, alerter } = rig({ enabled: false });
    await alerter.onEvent(make('supervisor', 'agent.failure', escalated('i1'), { severity: 'error' }));
    assert.equal(none.pushes.length, 0);
    assert.equal(alerter.openAlerts()[0].push_state, 'off', 'the alert is still recorded');
});

test('the reader: valid events reach the rules in order, invalid ones are dropped, a crash before the ack replays without a second ping', async () => {
    const { ntfy, pg, stream, make, alerter, clock } = rig();
    const reader = createReader({ stream: stream.client, validate: validateEvent, onEvent: (event) => alerter.onEvent(event) });
    stream.add(make('supervisor', 'agent.failure', escalated('i1'), { severity: 'error' }));
    stream.add({ nonsense: true });
    stream.add(null, { event: '{broken' });
    await reader.step({ block_ms: 0 });
    assert.deepEqual(reader.stats(), { read: 3, handled: 1, rejected: 2, failed: 0 });
    assert.deepEqual(stream.pending('alerter'), []);
    assert.equal(ntfy.urgent().length, 1);

    // read but not acknowledged: the process ends inside the batch
    stream.add(make('supervisor', 'agent.failure', escalated('i1'), { severity: 'error' }));
    await stream.client.readGroup('genesis:events', 'alerter', 'alerter-1', { from: '>', count: 10 });
    assert.equal(stream.pending('alerter').length, 1);
    const again = createAlerter({ notifier: ntfy.notifier, store: pg.store, marks: stream.client, clock, ids: idMaker(), warn: () => {} });
    await again.restore();
    const reader2 = createReader({ stream: stream.client, validate: validateEvent, onEvent: (event) => again.onEvent(event) });
    await reader2.step({ block_ms: 0 });
    assert.deepEqual(stream.pending('alerter'), []);
    assert.equal(ntfy.urgent().length, 1);
});

test('retention deletes only what is past its window: alerts 90 days, digests a year, facts 8 days', async () => {
    const { pg, clock } = rig();
    const now = clock.now();
    const alert = (id: string, age_days: number, closed: boolean) => pg.alerts.set(id, {
        id, problem_key: id, severity: 'warning', title: id, subject: 'Felix', kind: 'nav.stuck', opened_at: new Date(now - age_days * DAY_MS).toISOString(),
        updated_at: new Date(now).toISOString(), closed_at: closed ? new Date(now - age_days * DAY_MS + 1000).toISOString() : null, occurrences: 1, push_state: 'batched', pushed_at: null,
    });
    alert('old-closed', 90.01, true);
    alert('kept-closed', 89.99, true);
    alert('old-open', 200, false);
    const digest = (age_days: number) => pg.digests.set(`d${age_days}`, { period_end: new Date(now - age_days * DAY_MS).toISOString(), period_start: '', tz: 'UTC', local_date: '', body: {}, created_at: '', pushed_at: null });
    digest(366); digest(364); digest(1);
    const fact = (id: string, age_days: number) => pg.facts.set(id, { v: 1, id, ts: new Date(now - age_days * DAY_MS).toISOString(), agent: 'Mira', seq: 1, type: 'skill.result', corr: null, severity: 'info', data: { ok: true } });
    fact('f-old', 8.01); fact('f-kept', 7.99);

    assert.deepEqual(await runRetention(pg.store, clock), { alerts: 1, facts: 1, digests: 1 });
    assert.deepEqual([...pg.alerts.keys()], ['kept-closed', 'old-open']);
    assert.deepEqual([...pg.digests.keys()], ['d364', 'd1']);
    assert.deepEqual([...pg.facts.keys()], ['f-kept']);
    assert.deepEqual(await runRetention(pg.store, clock), { alerts: 0, facts: 0, digests: 0 });
});

test('the test push goes through the alerter\'s own notifier once, says nothing is wrong, and leaves a closed record of how it went', async () => {
    const { sendTestPush } = await import('../src/test_push.js');
    const sent: any[] = [];
    const saved: any[] = [];
    let n = 0;
    const rig2 = (result: string, enabled = true) => sendTestPush({
        notifier: { enabled: () => enabled, send: async (push: any) => { sent.push(push); return result; } }, store: { saveAlert: async (alert: any) => { saved.push(alert); } },
        ids: () => `id-${++n}`, clock: { now: () => Date.parse('2026-11-17T08:00:00.000Z') },
    });
    assert.deepEqual(await rig2('delivered'), { ok: true, line: 'Test push accepted by ntfy. If the phone stays silent, it is not subscribed to the topic.' });
    assert.deepEqual([sent.length, sent[0].title, /Nothing is wrong/.test(sent[0].body)], [1, 'Genesis · test alert', true]);
    assert.deepEqual([saved[0].kind, saved[0].severity, saved[0].push_state, saved[0].closed_at, saved[0].pushed_at], ['test', 'warning', 'sent', '2026-11-17T08:00:00.000Z', '2026-11-17T08:00:00.000Z']);
    assert.equal((await rig2('refused')).ok, false);
    assert.deepEqual([saved[1].push_state, saved[1].pushed_at], ['failed', null]);
    assert.deepEqual(await rig2('delivered', false), { ok: false, line: 'Test push NOT sent: no ntfy topic is set (GENESIS_NTFY_TOPIC).' });
    assert.equal(sent.length, 2, 'a push went out although no topic is set');
});
