import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDigest, createDigestJob, DAY_MS, digestFact } from '../src/digest.js';
import { instantOf, lastLocalHour, localTime } from '../src/tz.js';
import { eventMaker, fakeClock, fakeNotifier, incident, memoryAlertStore } from './fakes.js';
import type { GenesisEvent } from '../src/ports.js';

const TZ = 'America/Chicago';
const H = 60 * 60 * 1000;
const ROSTER = ['Arthur', 'Mira', 'Felix', 'Nova'];
const utc = (text: string) => Date.parse(text);

function rig(start: number) {
    const clock = fakeClock(start);
    const ntfy = fakeNotifier();
    const pg = memoryAlertStore();
    const make = eventMaker(clock);
    const job = createDigestJob({ store: pg.store, notifier: ntfy.notifier, clock, tz: TZ, hour: 18, roster: ROSTER });
    const at = async (ms: number, agent: string, type: string, data: Record<string, any>) => { clock.set(ms); await job.onEvent(make(agent, type, data)); };
    return { clock, ntfy, pg, make, job, at };
}

test('18:00 local time is found on ordinary days and on both daylight-saving changes', () => {
    // Chicago: CDT (UTC-5) until 1 Nov 2026 02:00, CST (UTC-6) after; CDT again from 8 Mar 2026 02:00
    assert.equal(instantOf(2026, 7, 4, 18, TZ), utc('2026-07-04T23:00:00Z'));
    assert.equal(instantOf(2026, 10, 31, 18, TZ), utc('2026-10-31T23:00:00Z'));
    assert.equal(instantOf(2026, 11, 1, 18, TZ), utc('2026-11-02T00:00:00Z'));
    assert.equal(instantOf(2026, 3, 7, 18, TZ), utc('2026-03-08T00:00:00Z'));
    assert.equal(instantOf(2026, 3, 8, 18, TZ), utc('2026-03-08T23:00:00Z'));
    assert.equal(lastLocalHour(utc('2026-11-01T23:59:59Z'), TZ, 18), utc('2026-10-31T23:00:00Z'));
    assert.equal(lastLocalHour(utc('2026-11-02T00:00:00Z'), TZ, 18), utc('2026-11-02T00:00:00Z'));
    assert.deepEqual(localTime(utc('2026-11-02T00:00:00Z'), TZ), { year: 2026, month: 11, day: 1, hour: 18, minute: 0, second: 0 });
});

test('the digest is written at 18:00 local and covers exactly the previous 24 hours, across the autumn clock change', async () => {
    const fire = utc('2026-11-02T00:00:00Z');            // 1 Nov 18:00 CST; the day before it was 18:00 CDT, 25 hours earlier
    const { clock, ntfy, pg, job, at } = rig(fire - 30 * H);
    await at(fire - 24 * H - 1, 'Arthur', 'agent.state', { state: 'goal_completed', detail: {} });   // 1 ms too early
    await at(fire - 24 * H, 'Arthur', 'agent.state', { state: 'goal_completed', detail: {} });       // the first instant inside
    await at(fire - 24.5 * H, 'Mira', 'agent.state', { state: 'goal_completed', detail: {} });       // after yesterday's 18:00 local, but more than 24 h ago
    await at(fire - 1, 'Mira', 'agent.state', { state: 'goal_completed', detail: {} });              // the last instant inside
    clock.set(fire - 1000);
    assert.equal(await job.tick(), null, 'not before 18:00');
    assert.equal(ntfy.pushes.length, 0);
    await at(fire, 'Felix', 'agent.state', { state: 'goal_completed', detail: {} });                 // 18:00 sharp belongs to the next day

    clock.set(fire);
    const digest = await job.tick();
    assert.ok(digest);
    assert.equal(digest.period_end, '2026-11-02T00:00:00.000Z');
    assert.equal(digest.period_start, '2026-11-01T00:00:00.000Z');
    assert.equal(Date.parse(digest.period_end) - Date.parse(digest.period_start), DAY_MS);
    assert.equal(digest.local_date, '2026-11-01');
    const goals = Object.fromEntries(digest.body.agents.map((agent: any) => [agent.name, agent.goals]));
    assert.deepEqual(goals, { Arthur: 1, Mira: 1, Felix: 0, Nova: 0 });
    assert.equal(pg.digests.size, 1);

    assert.equal(ntfy.pushes.length, 1, 'sent as one push');
    assert.equal(ntfy.pushes[0].title, 'Genesis digest · 2026-11-01');
    for (let i = 0; i < 100; i++) { clock.advance(5 * 60 * 1000); assert.equal(await job.tick(), null); }
    assert.equal(ntfy.pushes.length, 1, 'one digest a day, one push');

    // the next day is an ordinary one: 24 hours later
    await at(fire + 2 * H, 'Felix', 'agent.state', { state: 'goal_completed', detail: {} });
    clock.set(fire + 24 * H);
    const next = await job.tick();
    assert.equal(next?.period_start, '2026-11-02T00:00:00.000Z');
    assert.equal(next?.body.totals.goals, 2, 'the goal at 18:00 sharp, and the one two hours later');
});

test('the spring clock change: 18:00 comes after 23 hours, the digest still covers 24', async () => {
    const fire = utc('2026-03-08T23:00:00Z');            // 8 Mar 18:00 CDT; the day before it was 18:00 CST, 23 hours earlier
    const { clock, pg, job, at } = rig(fire - 30 * H);
    await at(fire - 23.5 * H, 'Nova', 'agent.state', { state: 'goal_completed', detail: {} });       // before yesterday's 18:00 local, yet inside the 24 hours
    clock.set(utc('2026-03-08T00:00:00Z'));
    const first = await job.tick();
    assert.equal(first?.period_end, '2026-03-08T00:00:00.000Z');
    clock.set(fire - 1);
    assert.equal(await job.tick(), null);
    clock.set(fire);
    const digest = await job.tick();
    assert.equal(digest?.period_start, '2026-03-07T23:00:00.000Z');
    assert.equal(digest?.body.totals.goals, 1, 'that hour is in both digests: each covers its own full 24 hours');
    assert.equal(pg.digests.size, 2);
});

test('what a digest says: goals, deaths, time on routine, incidents by outcome, model availability, alert counts', async () => {
    const end = utc('2026-11-17T00:00:00Z');             // 16 Nov 18:00 CST
    const start = end - DAY_MS;
    const { clock, pg, job, at, ntfy } = rig(start - 2 * H);
    await at(start - H, 'planner', 'agent.state', { state: 'model_available', detail: {} });
    await at(start - H, 'Arthur', 'agent.state', { state: 'planning', detail: {} });
    // the model is away from hour 6 to hour 12, and again for the last 3 hours
    await at(start + 6 * H, 'planner', 'agent.state', { state: 'model_leaving', detail: {} });
    await at(start + 6 * H, 'supervisor', 'agent.failure', { incident_id: 'away1', source: { type: 'service', name: 'planner' }, kind: 'model.away', phase: 'detected', is_failure: false, recovery: null, outcome: 'expected', needs_operator: false });
    await at(start + 6 * H, 'Arthur', 'agent.state', { state: 'on_routine', detail: {} });
    await at(start + 12 * H, 'supervisor', 'agent.recovery', { incident_id: 'away1', source: { type: 'service', name: 'planner' }, kind: 'model.available', phase: 'resolved', is_failure: false, recovery: null, outcome: 'expected', needs_operator: false });
    await at(start + 12 * H, 'planner', 'agent.state', { state: 'model_available', detail: {} });
    await at(start + 12 * H, 'Arthur', 'agent.state', { state: 'planning', detail: {} });
    await at(start + 21 * H, 'planner', 'agent.state', { state: 'model_away', detail: { reason: 'probe_failed' } });
    // Arthur: 3 goals, 5 skills. Felix: 1 goal, 2 deaths, says nothing about its mode (the gate decides)
    for (const h of [1, 2, 13]) await at(start + h * H, 'Arthur', 'agent.state', { state: 'goal_completed', detail: {} });
    for (let i = 0; i < 5; i++) await at(start + 2 * H + i, 'Arthur', 'skill.result', { skill: '!collectBlocks', ok: i !== 2, interrupted: false, timedout: false, output: 'long text that is not kept', duration_ms: 10 });
    await at(start + 3 * H, 'Felix', 'agent.state', { state: 'goal_completed', detail: {} });
    await at(start + 4 * H, 'Felix', 'agent.state', { state: 'respawned', detail: { deaths: 1 } });
    await at(start + 5 * H, 'Felix', 'agent.state', { state: 'parked', detail: { deaths: 2 } });
    // incidents: one recovered, one given up, one for the operator, one that began before the window and ended inside
    await at(start - 30 * 60 * 1000, 'Mira', 'agent.failure', incident('i0', 'Mira', 'server.down', 'detected'));
    await at(start + 60 * 1000, 'Mira', 'agent.recovery', incident('i0', 'Mira', 'server.down', 'resolved', { outcome: 'auto_recovered' }));
    await at(start + 7 * H, 'Felix', 'agent.failure', incident('i1', 'Felix', 'nav.stuck', 'detected'));
    await at(start + 7 * H + 1000, 'Felix', 'agent.recovery', incident('i1', 'Felix', 'nav.stuck', 'resolved', { outcome: 'auto_recovered' }));
    await at(start + 8 * H, 'Arthur', 'agent.failure', incident('i2', 'Arthur', 'step.parked', 'detected', { outcome: 'gave_up' }));
    await at(start + 9 * H, 'supervisor', 'agent.failure', incident('i3', 'Nova', 'login.refused', 'detected'));
    await at(start + 9 * H + 5000, 'supervisor', 'agent.failure', incident('i3', 'Nova', 'login.refused', 'escalated', { outcome: 'needs_operator', needs_operator: true }));
    // alerts of the window (written by the alerter's engine in real life)
    const alert = (id: string, severity: 'critical' | 'warning', opened: number) => pg.alerts.set(id, { id, problem_key: id, severity, title: id, subject: 'x', kind: 'x', opened_at: new Date(opened).toISOString(), updated_at: new Date(opened).toISOString(), closed_at: null, occurrences: 1, push_state: 'sent', pushed_at: null });
    alert('c1', 'critical', start + 9 * H); alert('w1', 'warning', start + 8 * H); alert('w2', 'warning', start + 10 * H); alert('before', 'critical', start - 1);
    pg.batches.push({ at: new Date(start + 9 * H).toISOString(), count: 1 }, { at: new Date(start + 11 * H).toISOString(), count: 1 });

    clock.set(end);
    const body = (await job.tick())!.body;
    assert.deepEqual(body.totals, { goals: 4, deaths: 2, incidents: 5, model_pct: 63, critical: 1, warnings: 2 });
    const arthur = body.agents.find((agent: any) => agent.name === 'Arthur');
    assert.deepEqual(arthur, { name: 'Arthur', goals: 3, deaths: 0, skills: 5, routine_ms: 6 * H, model_led_ms: 18 * H, unknown_ms: 0 });
    const felix = body.agents.find((agent: any) => agent.name === 'Felix');
    assert.deepEqual(felix, { name: 'Felix', goals: 1, deaths: 2, skills: 0, routine_ms: 9 * H, model_led_ms: 15 * H, unknown_ms: 0 });
    assert.deepEqual(body.incidents.by_outcome, {
        auto_recovered: { count: 2, kinds: { 'Server disconnect': 1, 'Navigation stuck': 1 } },
        expected: { count: 1, kinds: { 'Model away': 1 } },
        gave_up: { count: 1, kinds: { 'Step parked': 1 } },
        needs_operator: { count: 1, kinds: { 'Login refused': 1 } },
    });
    assert.equal(body.model.available_ms, 15 * H);
    assert.equal(body.model.away_ms, 9 * H);
    assert.deepEqual(body.model.away.map((span: any) => span.ms), [6 * H, 3 * H]);
    assert.deepEqual(body.alerts, { critical: 1, warnings: 2, warning_pushes: 2 });
    assert.equal(ntfy.pushes[0].body, 'Goals 4 · Deaths 2\nIncidents 5 (1 for the operator)\nModel 63%\nAlerts: 1 critical, 2 warnings');
    assert.equal(ntfy.pushes[0].priority, 'default');
});

test('a fact keeps only what is counted', () => {
    const make = eventMaker();
    const kept = digestFact(make('Mira', 'skill.result', { skill: '!x', ok: true, interrupted: false, timedout: false, output: 'secret at http://10.0.0.1', duration_ms: 3 }));
    assert.deepEqual(kept?.data, { ok: true });
    assert.equal(digestFact(make('Mira', 'agent.message', { to: 'Nova', text: 'hello' })), null);
    assert.equal(digestFact(make('Mira', 'agent.state', { state: 'goal_started', detail: {} })), null);
    const inc = digestFact(make('Mira', 'agent.failure', { ...incident('i', 'Mira', 'nav.stuck', 'detected'), message: 'free text', url: 'http://x' }));
    assert.deepEqual(Object.keys(inc!.data).sort(), ['incident_id', 'is_failure', 'kind', 'needs_operator', 'outcome', 'phase', 'recovery', 'source']);
});

test('started after 18:00 with nothing recorded: no digest about nothing; with facts: the missed digest is caught up once', async () => {
    const fire = utc('2026-11-17T00:00:00Z');
    const empty = rig(fire + 2 * H);
    assert.equal(await empty.job.tick(), null);
    assert.equal(empty.ntfy.pushes.length, 0);

    const { clock, pg, ntfy, make } = rig(fire - 5 * H);
    clock.set(fire - 4 * H);
    await pg.store.saveFacts([make('Arthur', 'agent.state', { state: 'goal_completed' })]);
    clock.set(fire + 2 * H);                              // the alerter was down at 18:00 and starts two hours late
    const late = createDigestJob({ store: pg.store, notifier: ntfy.notifier, clock, tz: TZ, hour: 18, roster: ROSTER });
    const digest = await late.tick();
    assert.equal(digest?.period_end, '2026-11-17T00:00:00.000Z');
    assert.equal(digest?.body.totals.goals, 1);
    const again = createDigestJob({ store: pg.store, notifier: ntfy.notifier, clock, tz: TZ, hour: 18, roster: ROSTER });
    assert.equal(await again.tick(), null, 'another start does not write or push it a second time');
    assert.equal(ntfy.pushes.length, 1);
});

test('Postgres down at 18:00: the digest is made from memory, pushed once, and stored when Postgres is back', async () => {
    const fire = utc('2026-11-17T00:00:00Z');
    const { clock, pg, ntfy, job, at } = rig(fire - 10 * H);
    await at(fire - 9 * H, 'planner', 'agent.state', { state: 'model_available', detail: {} });
    pg.down = true;
    await at(fire - 2 * H, 'Mira', 'agent.state', { state: 'goal_completed', detail: {} });
    clock.set(fire);
    const digest = await job.tick();
    assert.equal(digest?.body.totals.goals, 1);
    assert.equal(ntfy.pushes.length, 1);
    assert.equal(pg.digests.size, 0);
    pg.down = false;
    clock.advance(5000);
    assert.equal(await job.tick(), null);
    assert.equal(pg.digests.size, 1);
    assert.equal(pg.facts.size, 2);
    assert.equal(ntfy.pushes.length, 1);
});

test('buildDigest alone: time nobody can account for is reported as unknown, not guessed', () => {
    const end = utc('2026-11-17T00:00:00Z');
    const start = end - DAY_MS;
    const facts: GenesisEvent[] = [
        { v: 1, id: 'a', ts: new Date(start + 12 * H).toISOString(), agent: 'planner', seq: 1, type: 'agent.state', corr: null, severity: 'info', data: { state: 'model_away' } },
    ];
    const body = buildDigest({ facts, alerts: [], warning_pushes: 0, start, end, tz: TZ, roster: ['Mira'] });
    assert.equal(body.model.unknown_ms, 12 * H);
    assert.equal(body.model.pct, 0);
    assert.deepEqual(body.agents[0], { name: 'Mira', goals: 0, deaths: 0, skills: 0, routine_ms: 12 * H, model_led_ms: 0, unknown_ms: 12 * H });
    const nothing = buildDigest({ facts: [], alerts: [], warning_pushes: 0, start, end, tz: TZ, roster: ['Mira'] });
    assert.equal(nothing.model.pct, null);
    assert.equal(nothing.totals.model_pct, null);
});
