// Step 10, recovery: the watchdog and its ladder, the supervisor that restarts agent
// processes, waiting for a Minecraft server that is down, a refused login, and what an agent
// does after it died.
//
// The agents run their real runtime (executor, planner client, routine, watchdog) against
// the stand-in world, with the real broker in its host; the supervisor is the real one, and
// "a process" is one agent's runtime that the test kills and starts again from the same
// files. Time is the fake clock.
// Run from the repository root:  node --test genesis/tests/*.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeClock, settle } from './helpers/fakes.mjs';
import { makeTown } from './helpers/town.mjs';
import { campWorld } from './helpers/fake-world.mjs';
import { validateEvent, INCIDENT_PHASES, INCIDENT_OUTCOMES } from '../shared/events.js';
import { decodeCheckpoint } from '../store/checkpoint.js';
import { createWatchdog, progressSignature, inventoryHash, LADDER, WATCHDOG_DEFAULTS, SIGNATURE_DEFAULTS } from '../recovery/watchdog.js';
import { createIncidentReporter, incidentData, INCIDENT_KINDS } from '../recovery/incidents.js';
import { createRestartSupervisor, SUPERVISOR_DEFAULTS } from '../recovery/supervisor.js';
import { EXIT_CODES, classifyExit, exitCodeForDisconnect } from '../recovery/exit_codes.js';
import { DEATH_RULES } from '../recovery/death.js';
import { startRecovery, RECOVERY_EVENT_AGENT } from '../recovery/server.js';
import { createPlanningHost } from '../planning/host.js';
import { checkSettings } from '../lib/config.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const NAMES = ['Arthur', 'Mira', 'Felix', 'Nova'];

function assertEventsValid(events) {
    for (const event of events) assert.deepEqual(validateEvent(event), { ok: true, errors: [] }, `${event.type} ${JSON.stringify(event.data)}`);
}
// The incident events (agent.failure and agent.recovery in the incident shape) of one kind.
const incidents = (events, kind) => events.filter((event) => ['agent.failure', 'agent.recovery'].includes(event.type) && event.data.incident_id !== undefined && (!kind || event.data.kind === kind));
const steps = (events, kind) => incidents(events, kind).filter((event) => event.data.phase === 'recovery_step').map((event) => `${event.data.recovery.step}:${event.data.recovery.result}`);
const planRequests = (agent) => agent.socket.sent.filter(([name]) => name === 'genesis-plan-request').length;

// Puts a goal in an agent's queue the way the operator (or a planner reply) would.
async function seed(a, option_id, source = 'operator') {
    const pushed = await a.runtime.goals.pushShortTerm(a.agent, { title: `Do ${option_id}`.slice(0, 60), option_id }, { reason: 'seeded by the test', source });
    assert.equal(pushed.ok, true, pushed.error);
    a.runtime.executor.noteGoals(pushed.goals.short_term, { source });
    a.runtime.executor.wake();
    return pushed.goals.short_term.at(-1);
}

async function awayTown(options = {}) {
    const t = makeTown({ clock: fakeClock(), recovery: true, ...options });
    await t.start({ available: false });
    await t.host.signal('desktop_leaving');
    return t;
}

test('the starting values of recovery are the decided ones, and the signature is cell, inventory hash and step', () => {
    assert.deepEqual(LADDER, ['repath', 'move_away', 'surface_or_home', 'park_step', 'restart_process', 'needs_operator']);
    assert.equal(WATCHDOG_DEFAULTS.interval_ms, 10 * SECOND);
    assert.equal(WATCHDOG_DEFAULTS.cap_window_ms, 60 * MINUTE);
    assert.deepEqual([...SUPERVISOR_DEFAULTS.restart_delays_ms], [5 * SECOND, 30 * SECOND, 2 * MINUTE, 5 * MINUTE]);
    assert.deepEqual([SUPERVISOR_DEFAULTS.max_restarts, SUPERVISOR_DEFAULTS.restart_window_ms, SUPERVISOR_DEFAULTS.login_attempts], [5, 30 * MINUTE, 2]);
    assert.equal(DEATH_RULES.max_deaths_per_goal, 2);

    const base = { position: { x: 10.2, y: 64, z: -3.9 }, inventory: { oak_log: 3, bread: 2 }, step: 7 };
    const sig = progressSignature(base);
    assert.equal(progressSignature({ ...base, position: { x: 11.9, y: 65.5, z: -2.1 } }), sig, 'a move inside the cell changed the signature');
    assert.notEqual(progressSignature({ ...base, position: { x: 12.1, y: 64, z: -3.9 } }), sig);
    assert.notEqual(progressSignature({ ...base, inventory: { oak_log: 4, bread: 2 } }), sig);
    assert.notEqual(progressSignature({ ...base, step: 8 }), sig);
    assert.equal(inventoryHash({ bread: 2, oak_log: 3 }), inventoryHash({ oak_log: 3, bread: 2, dirt: 0 }), 'the order of the items changed the hash');
    assert.equal(SIGNATURE_DEFAULTS.cell_size, 2);

    // the incident shape, as decided
    const data = incidentData({ incident_id: 'i-1', source: { type: 'agent', name: 'Felix' }, kind: 'nav.stuck', phase: 'recovery_step',
        recovery: { step: 'repath', attempt: 1, max: 3, result: 'ok' }, outcome: 'auto_recovered' });
    assert.deepEqual(data, { incident_id: 'i-1', source: { type: 'agent', name: 'Felix' }, kind: 'nav.stuck', phase: 'recovery_step', is_failure: true,
        recovery: { step: 'repath', attempt: 1, max: 3, result: 'ok' }, outcome: 'auto_recovered', needs_operator: false });
    assert.ok(INCIDENT_PHASES.includes(data.phase) && INCIDENT_OUTCOMES.includes(data.outcome));
});

test('watchdog: a boxed-in agent climbs the ladder one rung at a time, in order, through a restart, and ends with the operator once', async () => {
    const t = await awayTown({ inventories: { Arthur: { oak_log: 5 } }, positions: { Arthur: { x: 30, y: 64, z: 0 } } });
    t.world.boxed = () => true;
    t.world.stall = () => true; // nothing the agent starts gets anywhere
    let arthur = t.agents.Arthur;
    const restarts = [];
    t.world.on_restart = (agent, reason) => { restarts.push({ agent, reason, at: t.clock.now() }); t.kill(agent); }; // the process ends here
    await seed(arthur, 'store_items:shared:oak_log');
    t.run();
    const start = t.clock.now();
    const moves = () => t.world.recoveries.map((move) => move.name);

    // 30 seconds without progress (the first check at 10 s only takes the signature): nothing yet
    await t.clock.advance(35 * SECOND);
    assert.deepEqual(moves(), []);
    assert.deepEqual(incidents(arthur.events, INCIDENT_KINDS.STUCK), []);
    // the fourth check: the incident opens and the first rung is taken, and only the first
    await t.clock.advance(10 * SECOND);
    assert.deepEqual(moves(), ['interrupt']);
    assert.deepEqual(steps(arthur.events, INCIDENT_KINDS.STUCK), ['repath:ok']);
    assert.equal(arthur.runtime.executor.plan().goal.option_id, 'store_items:shared:oak_log', 'a new path search gave the goal up');
    assert.equal(arthur.runtime.executor.plan().steps[0].attempts, 1, 'the try the watchdog stopped was counted as a failed one');
    // one rung every two checks from here on, in order
    await t.clock.advance(20 * SECOND);
    assert.deepEqual(moves(), ['interrupt', 'moveAway']);
    await t.clock.advance(20 * SECOND);
    assert.deepEqual(moves(), ['interrupt', 'moveAway', 'surfaceOrHome']);
    await t.clock.advance(20 * SECOND);
    assert.deepEqual(moves(), ['interrupt', 'moveAway', 'surfaceOrHome', 'interrupt']);
    // rung 4 parked the step: its goal ended as failed with the reason "stuck", with ONE incident, and the agent moved on
    const parked = arthur.eventsOf('agent.state').filter((event) => event.data.state === 'goal_failed');
    assert.deepEqual(parked.map((event) => [event.data.detail.option_id, event.data.detail.reason]), [['store_items:shared:oak_log', 'stuck']]);
    assert.equal(incidents(arthur.events, INCIDENT_KINDS.STEP_PARKED).length, 1);
    assert.equal(planRequests(arthur), 1, 'a parked step asks the planner exactly once'); // step_failed; the repath and the moves asked nothing
    assert.deepEqual(restarts, []);
    // rung 5: the process is restarted, and the incident is in the checkpoint
    await t.clock.advance(20 * SECOND);
    assert.equal(restarts.length, 1);
    assert.equal(Math.round((restarts[0].at - start) / SECOND), 120);
    assert.deepEqual(steps(arthur.events, INCIDENT_KINDS.STUCK), ['repath:ok', 'move_away:failed', 'surface_or_home:failed', 'park_step:ok', 'restart_process:pending']);
    const checkpoint = decodeCheckpoint(t.files.store.get('/checkpoints/Arthur.checkpoint.json')).checkpoint;
    const incident_id = incidents(arthur.events, INCIDENT_KINDS.STUCK)[0].data.incident_id;
    assert.equal(checkpoint.recovery.watchdog.incident.incident_id, incident_id);
    assert.equal(checkpoint.recovery.watchdog.incident.rung, 5);

    // ---- the new process: the same incident goes on, and with still no progress it goes to the operator ----
    const first_events = arthur.events;
    await t.clock.advance(5 * SECOND);
    arthur = await t.join('Arthur', { last_seq: checkpoint.seq });
    t.running.push(arthur.runtime.run());
    assert.deepEqual(steps(arthur.events, INCIDENT_KINDS.STUCK), ['restart_process:ok']);
    await t.clock.advance(25 * SECOND);
    assert.deepEqual(incidents(arthur.events, INCIDENT_KINDS.STUCK).filter((event) => event.data.needs_operator), []);
    await t.clock.advance(10 * SECOND);
    const all = [...first_events, ...arthur.events];
    const stuck = incidents(all, INCIDENT_KINDS.STUCK);
    const operator = stuck.filter((event) => event.data.needs_operator);
    assert.equal(operator.length, 1);
    assert.deepEqual([operator[0].type, operator[0].severity, operator[0].data.phase, operator[0].data.outcome, operator[0].data.recovery.step, operator[0].data.rung],
        ['agent.failure', 'error', 'escalated', 'needs_operator', 'needs_operator', 6]);
    assert.ok(stuck.every((event) => event.data.incident_id === incident_id), 'the incident changed its id on the way');
    assert.deepEqual(stuck.map((event) => `${event.type}:${event.data.phase}`), [
        'agent.failure:detected', 'agent.recovery:recovery_step', 'agent.recovery:recovery_step', 'agent.recovery:recovery_step',
        'agent.recovery:recovery_step', 'agent.recovery:recovery_step', 'agent.recovery:recovery_step', 'agent.failure:escalated',
    ]);
    assert.deepEqual(stuck[0].data.source, { type: 'agent', name: 'Arthur' });

    // nothing more happens, however long the agent stays shut in: the ladder does not loop
    await t.clock.advance(20 * MINUTE);
    assert.deepEqual(moves(), ['interrupt', 'moveAway', 'surfaceOrHome', 'interrupt', 'restartProcess']);
    assert.equal(incidents(arthur.events, INCIDENT_KINDS.STUCK).filter((event) => event.data.needs_operator).length, 1);
    assert.equal(arthur.runtime.watchdog().stats().rung, 6);
    assert.equal(t.model.requests.length, 0);
    assertEventsValid(all);
    await t.stop();
});

test('watchdog: the climbing stops as soon as progress resumes, and the incident ends as auto-recovered', async () => {
    const t = await awayTown({ inventories: { Arthur: { oak_log: 5 } }, positions: { Arthur: { x: 30, y: 64, z: 0 } } });
    // the way is shut until the agent has stepped a few blocks aside
    t.world.stall = (call) => call.agent === 'Arthur' && !t.world.recoveries.some((move) => move.name === 'moveAway');
    const arthur = t.agents.Arthur;
    const goal = await seed(arthur, 'store_items:shared:oak_log');
    t.run();
    await t.clock.advance(65 * SECOND); // rung 1 at 40 s, rung 2 at 60 s
    assert.deepEqual(t.world.recoveries.map((move) => [move.name, move.ok ?? null]), [['interrupt', null], ['moveAway', true]]);
    // the step is tried again from where the agent stands now, and gets through
    await t.clock.advance(5 * MINUTE);
    assert.deepEqual(t.world.recoveries.map((move) => move.name), ['interrupt', 'moveAway'], 'the ladder went on climbing after progress resumed');
    assert.ok(t.world.get(2, 64, 2).contents.oak_log >= 5, 'the goal the agent was stuck on was not carried out');
    const done = arthur.eventsOf('agent.state').find((event) => event.data.state === 'goal_completed' && event.data.detail.goal_id === goal.id);
    assert.ok(done, 'the goal did not complete');
    const stuck = incidents(arthur.events, INCIDENT_KINDS.STUCK);
    assert.deepEqual(stuck.map((event) => [event.type, event.data.phase, event.data.outcome]), [
        ['agent.failure', 'detected', 'pending'], ['agent.recovery', 'recovery_step', 'pending'], ['agent.recovery', 'recovery_step', 'pending'],
        ['agent.recovery', 'resolved', 'auto_recovered'],
    ]);
    assert.deepEqual(stuck.at(-1).data.recovery, { step: 'move_away', attempt: 1, max: 1, result: 'ok' });
    assert.equal(new Set(stuck.map((event) => event.data.incident_id)).size, 1);
    assert.ok(stuck.every((event) => event.data.needs_operator === false));
    assert.equal(arthur.runtime.watchdog().incident(), null);
    assert.equal(arthur.eventsOf('agent.state').filter((event) => event.data.state === 'goal_failed').length, 0);
    assertEventsValid(arthur.events);
    await t.stop();
});

test('watchdog: the hourly cap ends in rung 6 exactly once, and the ladder opens again when the hour has rolled on', async () => {
    const clock = fakeClock();
    const events = [];
    const taken = [];
    let position = 0;
    let moving = false;
    const reporter = createIncidentReporter({ emit: (type, data, opts) => events.push({ type, data, ...opts }), source: { type: 'agent', name: 'Felix' }, clock });
    const dog = createWatchdog({
        clock, reporter, max_climbs_per_hour: 4,
        signature: () => `${position}`,
        actions: { repath: async () => { taken.push('repath'); moving = true; return { ok: true }; } }, // every time, a new path gets the agent going again
    });
    // an agent that gets stuck again every minute: 3 checks standing still, the rung, 3 checks moving
    const check = async () => { if (moving) position++; const result = await dog.tick(); await clock.advance(10 * SECOND); return result.kind; };
    const cycle = async () => {
        const kinds = [];
        for (let i = 0; i < 3 && moving; i++) kinds.push(await check());
        moving = false;
        for (let i = 0; i < 4 && !moving; i++) kinds.push(await check());
        return kinds;
    };
    assert.equal(await check(), 'first');
    for (let i = 0; i < 4; i++) await cycle();
    assert.deepEqual(taken, ['repath', 'repath', 'repath', 'repath']);
    assert.equal(events.filter((event) => event.data.needs_operator).length, 0);

    // the fifth stall within the hour: no rung, the operator instead
    moving = true;
    const fifth = await cycle();
    assert.deepEqual(fifth.filter((kind) => kind === 'needs_operator' || kind === 'climbed'), ['needs_operator']);
    const operator = events.filter((event) => event.data.needs_operator);
    assert.equal(operator.length, 1);
    assert.deepEqual([operator[0].data.reason, operator[0].data.rung, operator[0].data.recovery.step], ['hourly_cap', 6, 'needs_operator']);
    assert.equal(taken.length, 4);

    // the agent keeps getting stuck for the rest of the hour: counted, nothing done, nobody told again
    for (let i = 0; i < 40; i++) {
        moving = true;
        for (let k = 0; k < 3; k++) await check(); // it moves (the first time round, that ends the incident the operator was told about)
        moving = false;
        for (let k = 0; k < 4; k++) await check(); // and stands still again
    }
    assert.equal(taken.length, 4, 'the ladder looped past its hourly cap');
    assert.equal(events.filter((event) => event.data.needs_operator).length, 1, 'the cap told the operator more than once');
    assert.ok(dog.stats().suppressed > 5);
    assert.equal(dog.stats().capped, 1);

    // an hour after the rungs that filled the cap, the ladder is open again
    await clock.advance(61 * MINUTE);
    moving = true;
    await check();
    moving = false;
    for (let i = 0; i < 4 && !moving; i++) await check();
    assert.equal(taken.length, 5);
    assert.equal(events.filter((event) => event.data.needs_operator).length, 1);
});

test('watchdog: a held agent, an agent waiting on the model and an agent sheltering at night are not stuck and never climb', async () => {
    // ---- held by the operator (!stop) ----
    const t = await awayTown({ inventories: { Arthur: { oak_log: 5 } }, positions: { Arthur: { x: 30, y: 64, z: 0 } } });
    t.world.boxed = () => true;
    t.world.stall = () => true;
    const arthur = t.agents.Arthur;
    await seed(arthur, 'store_items:shared:oak_log');
    t.run();
    await t.clock.advance(15 * SECOND);
    await arthur.runtime.hold({ by: 'Soup' });
    t.world.interrupt('Arthur'); // upstream's !stop stops the action
    await t.clock.advance(30 * MINUTE);
    assert.equal(arthur.runtime.watchStatus(), 'held');
    assert.deepEqual(t.world.recoveries, []);
    assert.deepEqual(incidents(arthur.events), []);
    assert.ok(arthur.runtime.watchdog().stats().exempt > 100);
    assert.equal(arthur.runtime.watchdog().stats().climbs, 0);
    // (resumed, the same agent is stuck, and the ladder starts: it was the hold that kept it quiet)
    await arthur.runtime.resume({ by: 'Soup' });
    await t.clock.advance(30 * SECOND);
    assert.deepEqual(t.world.recoveries.map((move) => move.name), ['interrupt']);
    await t.stop();

    // ---- waiting on the model: nothing in hand, a request out, the model there ----
    const w = makeTown({ clock: fakeClock(), recovery: true, runtime: { routine: null } });
    w.model.delay_ms = 85 * SECOND; // a slow model
    await w.start({ available: true });
    w.run();
    const waiting = w.agents.Arthur;
    assert.equal(waiting.runtime.planner.trigger('goal_complete', { outcome: 'completed' }) || waiting.runtime.planner.hasPending(), true);
    await w.clock.advance(80 * SECOND);
    assert.equal(waiting.runtime.watchStatus(), 'waiting_model');
    assert.equal(waiting.runtime.executor.plan(), null);
    assert.ok(waiting.runtime.watchdog().stats().exempt >= 7);
    assert.deepEqual([waiting.runtime.watchdog().stats().stalls, waiting.runtime.watchdog().stats().climbs], [0, 0]);
    assert.deepEqual(w.world.recoveries, []);
    assert.deepEqual(incidents(waiting.events), []);
    await w.stop();

    // ---- sheltering: the routine's Shelter phase, at night, at home ----
    const clock = fakeClock();
    const n = makeTown({ clock, recovery: true, world: campWorld(clock, { start_tick: 14000 }) });
    await n.start({ available: false });
    await n.host.signal('desktop_leaving');
    n.run();
    const sleeper = n.agents.Arthur;
    await n.clock.advance(5 * MINUTE); // 6000 ticks: still night
    assert.equal(sleeper.runtime.routine.phase(), 'Shelter');
    assert.equal(sleeper.runtime.watchStatus(), 'sheltering');
    assert.ok(sleeper.runtime.watchdog().stats().exempt >= 25);
    assert.deepEqual([sleeper.runtime.watchdog().stats().stalls, sleeper.runtime.watchdog().stats().climbs], [0, 0]);
    assert.deepEqual(n.world.recoveries, []);
    assert.deepEqual(incidents(sleeper.events), []);
    await n.stop();
});

test('watchdog: upstream\'s own stuck signal is taken as a stall at the next check, never as a reason to end the process', async () => {
    const clock = fakeClock();
    const events = [];
    const taken = [];
    let status = null;
    const dog = createWatchdog({
        clock, signature: () => 'same', status: () => status,
        reporter: createIncidentReporter({ emit: (type, data) => events.push({ type, data }), source: { type: 'agent', name: 'Mira' }, clock }),
        actions: { repath: async () => { taken.push('repath'); return { ok: true }; } },
    });
    assert.equal((await dog.tick()).kind, 'first');
    dog.nudge('upstream_unstuck');
    assert.equal((await dog.tick()).kind, 'climbed'); // without the signal this check would only have counted to one
    assert.deepEqual(taken, ['repath']);
    assert.equal(events[0].data.upstream, true);
    // the signal changes nothing for an agent that is not stuck by the rules
    const quiet = createWatchdog({ clock, signature: () => 'same', status: () => 'held', reporter: createIncidentReporter({ emit: () => { throw new Error('no event expected'); } }), actions: {} });
    await quiet.tick();
    quiet.nudge();
    assert.equal((await quiet.tick()).kind, 'exempt');
    status = 'idle';
    assert.equal((await dog.tick()).kind, 'exempt');
});

test('supervisor: restarts wait 5 s, 30 s, 2 min and 5 min; the 6th inside 30 minutes stops the agent with one operator incident', async () => {
    const clock = fakeClock();
    const events = [];
    const supervisor = createRestartSupervisor({ clock, emit: (type, data, opts) => events.push({ type, data, ...opts }) });
    const started = [];
    const crash = () => supervisor.exited('Felix', { code: 1, signal: null }, () => { started.push(clock.now()); });
    const t0 = clock.now();
    const waits = [];
    for (let i = 0; i < 5; i++) {
        const crashed_at = clock.now();
        const decision = crash();
        assert.equal(decision.action, 'restart');
        assert.equal(decision.attempt, i + 1);
        await clock.advance(decision.delay_ms - 1);
        assert.equal(started.length, i, 'the process was started before its pause was over');
        await clock.advance(1);
        assert.equal(started.length, i + 1);
        waits.push(started[i] - crashed_at);
        await clock.advance(2 * SECOND); // it runs for a moment, and crashes again
    }
    assert.deepEqual(waits, [5 * SECOND, 30 * SECOND, 2 * MINUTE, 5 * MINUTE, 5 * MINUTE]);
    assert.ok(clock.now() - t0 < 30 * MINUTE);
    assert.equal(events.filter((event) => event.data.needs_operator).length, 0);

    // the sixth crash inside 30 minutes: no restart, one operator-level incident
    const sixth = crash();
    assert.deepEqual([sixth.action, sixth.reason], ['stop', 'restart_limit']);
    await clock.advance(60 * MINUTE);
    assert.equal(started.length, 5, 'a stopped agent was started again');
    const operator = events.filter((event) => event.data.needs_operator);
    assert.equal(operator.length, 1);
    assert.deepEqual([operator[0].type, operator[0].severity, operator[0].data.kind, operator[0].data.phase, operator[0].data.outcome, operator[0].data.reason],
        ['agent.failure', 'error', 'process.exit', 'escalated', 'needs_operator', 'restart_limit']);
    assert.deepEqual(operator[0].data.source, { type: 'agent', name: 'Felix' });
    assert.deepEqual(operator[0].data.recovery, { step: 'restart', attempt: 6, max: 5, result: 'skipped' });
    assert.equal(supervisor.state('Felix').stopped, 'restart_limit');
    // every restart was told, with its number
    assert.deepEqual(events.filter((event) => event.type === 'agent.recovery' && event.data.recovery.result === 'pending').map((event) => event.data.recovery.attempt), [1, 2, 3, 4, 5]);

    // crashes that are more than 30 minutes apart never add up
    const slow = createRestartSupervisor({ clock });
    for (let i = 0; i < 12; i++) {
        const decision = slow.exited('Nova', { code: 1 }, () => {});
        assert.deepEqual([decision.action, decision.delay_ms], ['restart', 5 * SECOND]);
        await clock.advance(31 * MINUTE);
    }
});

test('supervisor: a deliberate stop is left alone, and a restart that was asked for is carried out and never counted as a crash', async () => {
    const clock = fakeClock();
    const events = [];
    const supervisor = createRestartSupervisor({ clock, emit: (type, data, opts) => events.push({ type, data, ...opts }) });
    let started = 0;
    const restart = () => { started++; };

    assert.deepEqual([classifyExit({ code: 0 }), classifyExit({ code: null, signal: 'SIGINT' }), classifyExit({ code: 64 }), classifyExit({ code: 65 }), classifyExit({ code: 66 }), classifyExit({ code: 1 }), classifyExit({ code: 4 })],
        ['stop', 'stop', 'intended', 'server_down', 'login_refused', 'crash', 'crash']);

    // ten restarts somebody asked for, one after the other: every one is carried out
    for (let i = 0; i < 10; i++) {
        const decision = supervisor.exited('Arthur', { code: EXIT_CODES.INTENDED_RESTART }, restart);
        assert.deepEqual([decision.action, decision.counted, decision.delay_ms], ['restart', false, SUPERVISOR_DEFAULTS.intended_delay_ms]);
        await clock.advance(2 * SECOND);
    }
    assert.equal(started, 10);
    assert.equal(supervisor.state('Arthur').restarts_in_window, 0);
    assert.ok(events.length === 10 && events.every((event) => event.type === 'agent.recovery' && event.data.is_failure === false && event.data.outcome === 'expected' && event.severity === 'info'));
    // a crash after them is the FIRST crash: 5 seconds
    assert.equal(supervisor.exited('Arthur', { code: 1 }, restart).delay_ms, 5 * SECOND);

    // a stop: nothing is started, and a restart that was waiting is called off
    assert.equal(supervisor.exited('Arthur', { code: null, signal: 'SIGINT' }, restart).action, 'none');
    supervisor.stopRequested('Arthur');
    assert.equal(supervisor.exited('Arthur', { code: 0 }, restart).action, 'none');
    // an exit with code 0 that nobody asked for is not a stop: upstream ends that way when its spawn handler throws
    const silent = supervisor.exited('Nova', { code: 0 }, () => {});
    assert.deepEqual([silent.action, silent.kind, silent.delay_ms], ['restart', 'crash', 5 * SECOND]);
    supervisor.stopRequested('Nova');
    supervisor.exited('Mira', { code: 1 }, restart);
    assert.equal(supervisor.stopRequested('Mira'), true);
    await clock.advance(10 * MINUTE);
    assert.equal(started, 10);
    assertShapes(events);
});

function assertShapes(events) {
    for (const event of events) {
        const checked = validateEvent({ v: 1, id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', ts: '2026-01-01T00:00:00.000Z', agent: 'supervisor', seq: 1, type: event.type, corr: null, severity: event.severity ?? 'info', data: event.data });
        assert.deepEqual(checked, { ok: true, errors: [] }, JSON.stringify(event.data));
    }
}

test('server down for 10 minutes: every agent waits, reconnects unaided and resumes its checkpointed step; nobody is stopped', async () => {
    const clock = fakeClock();
    const t = makeTown({ clock, agents: NAMES, recovery: true, inventories: Object.fromEntries(NAMES.map((name) => [name, { oak_log: 6, stone_pickaxe: 1 }])) });
    await t.start({ available: false });
    await t.host.signal('desktop_leaving');
    t.world.durations = (command) => (command === 'breakBlockAt' ? 20 * SECOND : 2 * SECOND);
    const events = [];
    const supervisor = createRestartSupervisor({ clock, emit: (type, data, opts) => events.push({ type, data, ...opts }) });
    let server_up = true;
    const attempts = Object.fromEntries(NAMES.map((name) => [name, 0]));
    const logins = [];

    // one agent process: with the server down it ends at once with the "server down" exit code
    function startProcess(name) {
        attempts[name]++;
        if (!server_up) {
            clock.setTimeout(() => supervisor.exited(name, { code: EXIT_CODES.SERVER_DOWN }, () => startProcess(name)), 1 * SECOND);
            return;
        }
        const seq = decodeCheckpoint(t.files.store.get(`/checkpoints/${name}.checkpoint.json`)).checkpoint.seq;
        t.join(name, { last_seq: seq }).then((a) => {
            logins.push({ name, at: clock.now(), resumed: a.started.resumed, plan: a.runtime.executor.plan() });
            supervisor.loggedIn(name);
            t.running.push(a.runtime.run());
        });
    }

    // every agent is in the middle of a goal of several steps (each has its own, so they do not take each other's blocks)
    for (let x = -5; x <= 4; x++) t.world.set(x, 63, 20, 'sand');
    const GOALS = { Arthur: 'gather_blocks:oak_log:8', Mira: 'harvest_replant:field', Felix: 'gather_blocks:stone:8', Nova: 'gather_blocks:sand:8' };
    for (const name of NAMES) await seed(t.agents[name], GOALS[name]);
    t.run();
    await clock.advance(50 * SECOND);
    const before = {};
    for (const name of NAMES) {
        const plan = t.agents[name].runtime.executor.plan();
        assert.equal(plan.goal.option_id, GOALS[name]);
        assert.ok(plan.cursor >= 1 && plan.cursor < plan.steps.length - 1, `${name} is not in the middle of its goal (step ${plan.cursor})`);
        before[name] = { id: plan.id, cursor: plan.cursor, done: t.agents[name].runtime.executor.stats().steps_done };
    }

    // ---- the Minecraft server goes down: every process loses its connection and ends ----
    server_up = false;
    const down_at = clock.now();
    for (const name of NAMES) {
        t.kill(name);
        supervisor.exited(name, { code: exitCodeForDisconnect('maintenance') }, () => startProcess(name));
    }
    await clock.advance(10 * MINUTE);
    for (const name of NAMES) {
        assert.ok(attempts[name] >= 8, `${name} gave up trying (${attempts[name]} attempts)`);
        const state = supervisor.state(name);
        assert.deepEqual([state.server_down, state.stopped, state.restarts_in_window, state.waiting], [true, null, 0, true]);
    }
    assert.equal(events.filter((event) => event.data.needs_operator).length, 0, 'a server that is down was sent to the operator');
    assert.deepEqual(logins, []);
    // the pauses grow and then stay at a minute
    const pauses = events.filter((event) => event.data.source.name === 'Felix' && event.data.phase === 'recovery_step').map((event) => event.data.delay_ms);
    assert.deepEqual(pauses.slice(0, 6), [5 * SECOND, 10 * SECOND, 20 * SECOND, 40 * SECOND, 60 * SECOND, 60 * SECOND]);

    // ---- the server is back ----
    server_up = true;
    await clock.advance(90 * SECOND);
    assert.deepEqual(logins.map((login) => login.name).sort(), [...NAMES].sort(), 'not every agent reconnected on its own');
    for (const login of logins) {
        assert.equal(login.resumed, true, `${login.name} did not resume from its checkpoint`);
        assert.equal(login.plan.id, before[login.name].id, `${login.name} came back with another plan`);
        assert.equal(login.plan.cursor, before[login.name].cursor, `${login.name} came back at another step`);
        assert.ok(login.at - down_at >= 10 * MINUTE);
    }
    // the same goal is finished by the new processes
    await clock.advance(8 * MINUTE);
    for (const name of NAMES) {
        const done = t.agents[name].eventsOf('agent.state').filter((event) => event.data.state === 'goal_completed').map((event) => event.corr);
        assert.ok(done.includes(before[name].id), `${name} did not finish the goal it was on`);
        assert.equal(supervisor.state(name).server_down, false);
    }
    // one incident per agent, opened once and resolved once, never an operator's
    for (const name of NAMES) {
        const mine = events.filter((event) => event.data.source.name === name && event.data.kind === INCIDENT_KINDS.SERVER_DOWN);
        assert.equal(new Set(mine.map((event) => event.data.incident_id)).size, 1);
        assert.equal(mine.filter((event) => event.data.phase === 'detected').length, 1);
        const resolved = mine.filter((event) => event.data.phase === 'resolved');
        assert.equal(resolved.length, 1);
        assert.deepEqual([resolved[0].data.outcome, resolved[0].data.recovery.step, resolved[0].data.recovery.result, resolved[0].data.recovery.max], ['auto_recovered', 'reconnect', 'ok', 0]);
        assert.ok(resolved[0].data.waited_ms >= 10 * MINUTE);
    }
    assert.equal(events.filter((event) => event.data.needs_operator).length, 0);
    assert.equal(t.model.requests.length, 0);
    assertShapes(events);
    await t.stop();
});

test('a refused login reaches the operator after two attempts, and is never retried after that', async () => {
    const clock = fakeClock();
    const events = [];
    const supervisor = createRestartSupervisor({ clock, emit: (type, data, opts) => events.push({ type, data, ...opts }) });
    let attempts = 1; // the attempt that was just refused
    const code = exitCodeForDisconnect('access_denied'); // "You are not white-listed on this server!"
    assert.equal(code, EXIT_CODES.LOGIN_REFUSED);
    const refused = () => supervisor.exited('Nova', { code }, () => { attempts++; clock.setTimeout(refused, 1 * SECOND); });

    const first = refused();
    assert.deepEqual([first.action, first.attempt], ['restart', 1]);
    assert.equal(events.filter((event) => event.data.needs_operator).length, 0);
    await clock.advance(SUPERVISOR_DEFAULTS.login_retry_ms + 2 * SECOND);
    assert.equal(attempts, 2);
    const operator = events.filter((event) => event.data.needs_operator);
    assert.equal(operator.length, 1);
    assert.deepEqual([operator[0].type, operator[0].data.kind, operator[0].data.phase, operator[0].data.outcome, operator[0].data.reason],
        ['agent.failure', 'login.refused', 'escalated', 'needs_operator', 'login_refused']);
    assert.deepEqual(operator[0].data.recovery, { step: 'login', attempt: 2, max: 2, result: 'failed' });
    assert.deepEqual(operator[0].data.source, { type: 'agent', name: 'Nova' });
    await clock.advance(60 * MINUTE);
    assert.equal(attempts, 2, 'a refused login was tried a third time');
    assert.equal(events.filter((event) => event.data.needs_operator).length, 1);
    assert.equal(supervisor.state('Nova').stopped, 'login_refused');

    // the other kinds of refusal count the same; a network fault or a full server is "server down" instead
    assert.deepEqual(['access_denied', 'name_conflict', 'version_mismatch'].map(exitCodeForDisconnect), [66, 66, 66]);
    assert.deepEqual(['network_error', 'maintenance', 'server_full'].map(exitCodeForDisconnect), [65, 65, 65]);
    assert.deepEqual(['behavior', 'other', 'unknown'].map(exitCodeForDisconnect), [1, 1, 1]);
    assertShapes(events);
});

test('a death leads back to the same plan step with zero model requests: respawn, walk home, re-equip from the kits chest, resume', async () => {
    const clock = fakeClock();
    const t = makeTown({ clock, recovery: true, inventories: { Arthur: { stone_axe: 1, stone_pickaxe: 1, bread: 3 } } });
    t.world.get(-2, 64, 2).contents = { stone_axe: 2, stone_pickaxe: 2, bread: 12, torch: 4 }; // the kits chest
    t.world.durations = (command, args, far) => (command === 'breakBlockAt' ? 4 * SECOND + far * 200 : 1 * SECOND + far * 200);
    // the planner chooses to gather logs, once
    t.model.replies.push((request, offered) => ({ thought: 'The hall needs logs.', goals: [{ option_id: offered.find((id) => id === 'gather_blocks:oak_log:8'), title: 'Gather logs', reason: 'for the hall' }] }));
    await t.start({ available: true });
    t.run();
    const arthur = t.agents.Arthur;
    await clock.advance(30 * SECOND);
    const plan = arthur.runtime.executor.plan();
    assert.equal(plan.goal.option_id, 'gather_blocks:oak_log:8');
    assert.equal(plan.source, 'model');
    assert.ok(plan.cursor >= 2 && plan.cursor < 7, `the agent is at step ${plan.cursor}`);
    const model_requests = t.model.requests.length;
    const plan_requests = planRequests(arthur);
    assert.equal(model_requests, 1);
    const checkpoint_before = decodeCheckpoint(t.files.store.get('/checkpoints/Arthur.checkpoint.json')).checkpoint;
    assert.equal(checkpoint_before.plan.id, plan.id);

    // ---- it dies in the wood, and respawns away from home with nothing ----
    arthur.runtime.deathBegan();
    const point = t.world.kill('Arthur');
    t.world.interrupt('Arthur');
    t.world.body('Arthur').position = { x: 20, y: 64, z: 20 };
    await settle();
    assert.equal(arthur.runtime.watchStatus(), 'down');
    assert.equal(await arthur.runtime.died(point), 'restart');
    assert.equal(arthur.runtime.executor.isDetouring(), true);
    assert.equal(arthur.runtime.executor.mainPlan().id, plan.id, 'the goal in hand was given up');
    // while it re-equips, the checkpoint still holds the goal, and the death that is being recovered from
    await clock.advance(3 * SECOND);
    const during = decodeCheckpoint(t.files.store.get('/checkpoints/Arthur.checkpoint.json')).checkpoint;
    assert.deepEqual([during.plan.id, during.plan.cursor, during.plan.steps[plan.cursor].status], [plan.id, plan.cursor, 'pending']);
    assert.equal(during.recovery.death.plan_id, plan.id);

    const detourEnded = () => arthur.eventsOf('agent.state').find((event) => event.data.state === 'detour_ended');
    const firstStepAfter = (ended) => arthur.eventsOf('skill.started').find((event) => arthur.events.indexOf(event) > arthur.events.indexOf(ended));
    for (let i = 0; i < 240 && !(detourEnded() && firstStepAfter(detourEnded())); i++) await clock.advance(500);
    const ended = detourEnded();
    assert.ok(ended, 'the re-equip did not end');
    assert.deepEqual([ended.data.detail.goal_id, ended.data.detail.step], [plan.goal.id, plan.cursor]);
    // what the detour did, in order, all of it from the catalog
    const decided = arthur.eventsOf('agent.decision').map((event) => event.data.args[0]);
    assert.deepEqual(decided.slice(1, 6), ['travel:home', 'travel:chest-kits', 'fetch_items:kits:stone_axe:1', 'fetch_items:kits:stone_pickaxe:1', 'fetch_items:kits:bread:4']);
    assert.deepEqual([t.world.body('Arthur').inventory.stone_axe, t.world.body('Arthur').inventory.stone_pickaxe, t.world.body('Arthur').inventory.bread >= 4], [1, 1, true]);
    // ... and then the SAME step of the SAME plan
    const first_after = firstStepAfter(ended);
    assert.deepEqual([first_after.corr, first_after.data.step, first_after.data.skill], [plan.id, plan.cursor, plan.steps[plan.cursor].command]);
    // not one model request, and not one planning request, between the death and the resume
    assert.equal(t.model.requests.length, model_requests, 'the model was asked because of a death');
    assert.equal(planRequests(arthur), plan_requests, 'a planning request was sent because of a death');
    assert.equal(t.calls.length, 1);

    // the events of the death: recovery steps in the incident shape, no failure, one incident id
    const death = incidents(arthur.events, INCIDENT_KINDS.DEATH);
    assert.deepEqual(death.map((event) => event.type), Array(death.length).fill('agent.recovery'));
    assert.deepEqual(death.map((event) => `${event.data.recovery.step}:${event.data.recovery.result}`),
        ['respawn:ok', 'walk_home:pending', 're_equip:pending', 're_equip:pending', 're_equip:pending', 're_equip:pending', 'resume:ok']);
    assert.deepEqual([death.at(-1).data.phase, death.at(-1).data.outcome, death.at(-1).data.plan_id, death.at(-1).data.plan_step], ['resolved', 'auto_recovered', plan.id, plan.cursor]);
    assert.equal(new Set(death.map((event) => event.data.incident_id)).size, 1);
    assert.equal(arthur.eventsOf('agent.failure').length, 0);

    // the goal is finished afterwards, by the plan it was started with
    await clock.advance(3 * MINUTE);
    const done = arthur.eventsOf('agent.state').find((event) => event.data.state === 'goal_completed' && event.data.detail.goal_id === plan.goal.id);
    assert.equal(done.corr, plan.id);
    assert.ok(t.world.broken.filter((block) => block.name === 'oak_log' && block.by === 'Arthur').length >= 8, 'the logs the goal was after were not all taken');
    assert.equal(decodeCheckpoint(t.files.store.get('/checkpoints/Arthur.checkpoint.json')).checkpoint.recovery ?? null, null);
    assertEventsValid(arthur.events);
    await t.stop();
});

test('deaths agree with the two-deaths rule: a second death on the same goal gives it up, and a restart in the middle of a re-equip finishes it', async () => {
    const clock = fakeClock();
    const t = makeTown({ clock, recovery: true, inventories: { Arthur: { stone_axe: 1, bread: 3 } } });
    t.world.get(-2, 64, 2).contents = { stone_axe: 3, stone_pickaxe: 3, bread: 12 };
    t.world.durations = (command, args, far) => (command === 'breakBlockAt' ? 4 * SECOND + far * 200 : 1 * SECOND + far * 200);
    await t.start({ available: false });
    await t.host.signal('desktop_leaving');
    let arthur = t.agents.Arthur;
    arthur.runtime.routine.modelReturned(); // (the routine's own count of deaths is for model-away periods: not what is looked at here)
    const goal = await seed(arthur, 'gather_blocks:oak_log:8');
    t.run();
    await clock.advance(30 * SECOND);
    const plan = arthur.runtime.executor.plan();
    assert.equal(plan.goal.id, goal.id);

    // the first death: kept. The process ends while the agent walks home.
    arthur.runtime.deathBegan();
    const point = t.world.kill('Arthur');
    t.world.interrupt('Arthur');
    t.world.body('Arthur').position = { x: 20, y: 64, z: 20 };
    await arthur.runtime.died(point);
    await clock.advance(1500);
    const saved = decodeCheckpoint(t.files.store.get('/checkpoints/Arthur.checkpoint.json')).checkpoint;
    assert.equal(saved.recovery.death.count, 1);
    const incident_id = saved.recovery.death.incident_id;
    t.kill('Arthur');
    await clock.advance(5 * SECOND);
    arthur = await t.join('Arthur', { last_seq: saved.seq });
    t.running.push(arthur.runtime.run());
    assert.equal(arthur.started.resumed, true);
    assert.equal(arthur.runtime.executor.isDetouring(), true, 'the re-equip was forgotten over the restart');
    for (let i = 0; i < 240 && arthur.runtime.executor.isDetouring(); i++) await clock.advance(500);
    assert.equal(arthur.runtime.executor.isDetouring(), false);
    assert.equal(arthur.runtime.executor.plan().id, plan.id);
    assert.equal(t.world.body('Arthur').inventory.stone_axe, 1);
    const resolved = incidents(arthur.events, INCIDENT_KINDS.DEATH).at(-1);
    assert.deepEqual([resolved.data.incident_id, resolved.data.phase, resolved.data.plan_id], [incident_id, 'resolved', plan.id]);

    // the second death on the same goal: the goal is given up, as the two-deaths rule has it
    arthur.runtime.deathBegan();
    const again = t.world.kill('Arthur');
    t.world.interrupt('Arthur');
    await arthur.runtime.died(again);
    assert.equal(arthur.runtime.executor.isDetouring(), false);
    assert.equal(arthur.runtime.executor.mainPlan(), null);
    assert.equal(arthur.changes().at(-1).reason, 'abandoned: died');
    assertEventsValid(arthur.events);
    await t.stop();
});

test('model.away and model.available use the incident shape with is_failure false and outcome expected', async () => {
    const clock = fakeClock();
    const published = [];
    let supervisor = null;
    const recovery = await startRecovery({ supervisor: { login_retry_ms: 1000 } }, { event_sink: (event) => published.push(event), clock, setRestartSupervisor: (given) => { supervisor = given; } });
    assert.equal(supervisor, recovery.supervisor);
    assert.equal(supervisor.config.login_retry_ms, 1000);
    const model = { name: 'stub', probe_ok: true, async probe() { return model.probe_ok; }, async chat() { throw new Error('not asked'); } };
    const host = createPlanningHost({ model, clock, onGate: (state, detail) => recovery.onGate(state, detail) });
    await host.start();                         // available
    await host.signal('desktop_leaving');       // away, announced
    await host.signal('desktop_available');     // available again
    model.probe_ok = false;                     // gone without a word: two failed probes
    await clock.advance(40 * SECOND);
    host.stop();

    assert.deepEqual(published.map((event) => [event.type, event.data.kind, event.data.reason]), [
        ['agent.recovery', 'model.available', 'desktop_available'],
        ['agent.failure', 'model.away', 'desktop_leaving'],
        ['agent.recovery', 'model.available', 'desktop_available'],
        ['agent.failure', 'model.away', 'probe_failed'],
    ]);
    for (const event of published) {
        assert.deepEqual([event.agent, event.severity, event.data.is_failure, event.data.outcome, event.data.needs_operator], [RECOVERY_EVENT_AGENT, 'info', false, 'expected', false]);
        assert.deepEqual(event.data.source, { type: 'service', name: 'planner' });
        assert.deepEqual(validateEvent(event), { ok: true, errors: [] });
    }
    // away and the return that ends it are one incident
    assert.equal(published[1].data.incident_id, published[2].data.incident_id);
    assert.notEqual(published[1].data.incident_id, published[3].data.incident_id);

    // an agent that logs in is told to the supervisor, from its own connection only
    const handlers = {};
    recovery.attach({ on: (name, fn) => { handlers[name] = fn; } }, { isAgentSocket: (name) => name === 'Arthur' });
    supervisor.exited('Arthur', { code: EXIT_CODES.SERVER_DOWN }, () => {});
    supervisor.exited('Mira', { code: EXIT_CODES.SERVER_DOWN }, () => {});
    handlers['login-agent']('Arthur');
    handlers['login-agent']('Mira'); // not Mira's connection
    assert.deepEqual([supervisor.state('Arthur').server_down, supervisor.state('Mira').server_down], [false, true]);
    recovery.stop();
});

test('settings: genesis_recovery is optional, takes known values only, and is checked', () => {
    assert.deepEqual(checkSettings({}), []);
    assert.deepEqual(checkSettings({ genesis_recovery: { enabled: true } }), []);
    assert.deepEqual(checkSettings({ genesis_recovery: { enabled: false, watchdog: { stall_checks: 6, stationary_commands: ['smeltItem', 'craftRecipe'] }, supervisor: { reconnect_delays_ms: [1000, 2000] }, death: { max_detour_goals: 4 } } }), []);
    const problems = checkSettings({ genesis_recovery: { enabled: 'yes', laddr: {}, watchdog: { interval: 5, stall_checks: -1 }, supervisor: { restart_delays_ms: [] } } });
    assert.equal(problems.length, 5, problems.join('\n'));
    assert.match(problems.join('\n'), /"genesis_recovery.enabled" must be true or false/);
    assert.match(problems.join('\n'), /"genesis_recovery.laddr" is not a setting/);
    assert.match(problems.join('\n'), /"genesis_recovery.watchdog.interval" is not a setting/);
    assert.match(problems.join('\n'), /"genesis_recovery.watchdog.stall_checks" must be a number, 0 or more/);
    assert.match(problems.join('\n'), /"genesis_recovery.supervisor.restart_delays_ms" must be a list/);
    assert.deepEqual(checkSettings({ genesis_recovery: [] }), ['settings: "genesis_recovery" must be an object']);
});
