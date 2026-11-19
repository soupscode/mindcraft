// The decisions of the last review, each with its test:
//   - !stop holds the executor until the operator resumes it; the hold survives a restart
//   - the chest ledger is ONE ledger, held in the MindServer, with reservations; wanting what
//     another agent has reserved is a contested claim, never a silent failure; a chest that
//     was looked into always beats arithmetic
//   - Genesis switches none of upstream's idle reflexes (modes) off
// (Re-planning and the 20-second grace are in planning.test.js; who counts as the operator,
// and the !stop / !resume commands on upstream's side, are in agent-loop-switch.test.js.)
//
// Everything runs on the fake world and the fake clock; nothing here needs a server.
// Run from the repository root:  node --test genesis/tests/*.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './helpers/stubs.mjs';
import { fakeClock, fakeFiles, fakeGoalStorage, settle } from './helpers/fakes.mjs';
import { makeRig } from './helpers/rig.mjs';
import { makeTown, socketPair } from './helpers/town.mjs';
import { validateEvent } from '../shared/events.js';
import { decodeCheckpoint, checkCheckpoint } from '../store/checkpoint.js';
import { createLedger } from '../catalog/ledger.js';
import { createSharedLedger, SHARED_LEDGER_VERSION } from '../catalog/shared_ledger.js';
import { createLedgerClient } from '../catalog/ledger_client.js';
import { createCatalog } from '../catalog/catalog.js';
import { createZones } from '../catalog/zones.js';
import { WORLD_CONFIG, campWorld } from './helpers/fake-world.mjs';
import { createPlanningHost } from '../planning/host.js';
import { startPlanning } from '../planning/server.js';
import { stubModel } from './helpers/town.mjs';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const kinds = (list) => list.map((outcome) => outcome.kind);
const checkpointOf = (rig, agent = rig.agent) => decodeCheckpoint(rig.files.store.get(`/checkpoints/${agent}.checkpoint.json`)).checkpoint;
function assertEventsValid(events) {
    for (const [index, event] of events.entries()) assert.deepEqual(validateEvent(event), { ok: true, errors: [] }, `event ${index} (${event.type})`);
}

// ---- !stop holds the executor -------------------------------------------------------------

test('hold: the operator\'s stop holds the executor: no retry, no next step, no routine, until it is resumed', async () => {
    const clock = fakeClock();
    let asked_for_work = 0;
    const rig = makeRig({ clock, inventory: { oak_log: 5 }, executor: { chooseWork: async () => { asked_for_work++; return null; } } });
    await rig.executor.start();
    await rig.seed('store_items:shared:oak_log');
    await rig.seed('travel:field');
    assert.equal((await rig.executor.runOnce()).kind, 'goal_started');

    // the operator types !stop while the walk to the chest runs: upstream stops the action (the
    // step comes back interrupted), and the hold was set before that
    rig.world.fail = (call) => {
        if (call.command !== 'goToPosition') return null;
        rig.world.fail = null;
        rig.executor.hold({ by: 'Soup' });
        return { interrupted: true };
    };
    const held = await rig.executor.runOnce();
    assert.equal(held.kind, 'held');
    assert.equal(rig.executor.isHeld(), true);
    assert.equal(rig.executor.holdInfo().by, 'Soup');
    const calls_at_hold = rig.world.calls.length;

    // time passes, the loop keeps turning: nothing is retried, nothing new starts, no routine is asked
    for (let i = 0; i < 20; i++) {
        assert.equal((await rig.executor.runOnce()).kind, 'held');
        await clock.advance(30 * SECOND);
    }
    assert.equal(rig.world.calls.length, calls_at_hold, 'a skill ran while the agent was held');
    assert.equal(asked_for_work, 0, 'the routine was asked for work while the agent was held');
    assert.deepEqual(rig.triggers, [], 'a planning trigger was raised while the agent was held');
    assert.deepEqual((await rig.queue()).map((goal) => goal.option_id), ['store_items:shared:oak_log', 'travel:field'], 'the queue changed during the hold');
    // the step the stop cut short was not a try and not an interruption that counts
    const plan = rig.executor.plan();
    assert.deepEqual([plan.cursor, plan.steps[0].status, plan.steps[0].attempts], [0, 'pending', 0]);
    assert.deepEqual([rig.executor.stats().interruptions, rig.executor.stats().steps_failed, rig.executor.stats().goals_failed, rig.executor.stats().holds], [0, 0, 0, 1]);

    // emitted as agent.state "held"; a held agent is never a failure
    const states = rig.eventsOf('agent.state');
    const event = states.find((e) => e.data.state === 'held');
    assert.equal(event.severity, 'info');
    assert.deepEqual({ ...event.data.detail, at: undefined, goal_id: undefined }, { by: 'Soup', reason: 'operator_stop', at: undefined, goal_id: undefined, option_id: 'store_items:shared:oak_log', step: 0 });
    assert.deepEqual(rig.eventsOf('agent.failure'), []);
    assert.ok(!states.some((e) => ['goal_failed', 'goal_abandoned', 'goal_dropped'].includes(e.data.state)));
    assert.ok(rig.events.every((e) => e.severity !== 'error'));
    assert.equal(await rig.executor.hold({ by: 'Soup' }), false, 'a second stop is not a second hold');

    // the hold is in the checkpoint, with the plan as it stood
    const saved = checkpointOf(rig);
    assert.deepEqual(Object.keys(saved.hold), ['by', 'reason', 'at']);
    assert.deepEqual([saved.hold.by, saved.hold.reason], ['Soup', 'operator_stop']);
    assert.equal(saved.plan.goal.option_id, 'store_items:shared:oak_log');
    assert.deepEqual(checkCheckpoint(saved), []);

    // resume: the agent carries on with the very step it was held at, and finishes its queue
    assert.equal(await rig.executor.resume({ by: 'Soup' }), true);
    assert.equal(await rig.executor.resume({ by: 'Soup' }), false);
    const released = rig.eventsOf('agent.state').find((e) => e.data.state === 'hold_released');
    assert.deepEqual([released.data.detail.by, released.data.detail.held_by, released.data.detail.held_ms], ['Soup', 'Soup', 10 * MINUTE]);
    assert.equal(checkpointOf(rig).hold, null);
    const rest = await rig.drain();
    assert.deepEqual(kinds(rest), ['step_done', 'step_done', 'goal_completed', 'goal_started', 'step_done', 'goal_completed', 'idle']);
    assert.equal(rig.world.body('Arthur').inventory.oak_log, undefined);
    assert.equal(asked_for_work, 1, 'after the resume the routine is asked again');
    assertEventsValid(rig.events);
});

test('hold: it survives a restart, and a step that ends well during the hold is kept', async () => {
    const clock = fakeClock();
    const files = fakeFiles();
    const storage = fakeGoalStorage();
    const first = makeRig({ clock, files, storage, inventory: { oak_log: 5 } });
    await first.executor.start();
    await first.seed('store_items:shared:oak_log');
    await first.executor.runOnce(); // goal_started
    // the stop arrives while the walk runs, and the walk ends by itself: what was done is done, the next step waits
    first.world.fail = (call) => { first.world.fail = null; first.executor.hold({ by: 'ADMIN' }); return null; };
    assert.equal((await first.executor.runOnce()).kind, 'step_done');
    assert.equal((await first.executor.runOnce()).kind, 'held');
    assert.deepEqual(first.world.calls.map((call) => call.command), ['goToPosition']);
    first.executor.stop(); // the process dies (a restart, a crash, a reboot)

    const second = makeRig({ clock, files, storage, world: first.world });
    const begun = await second.executor.start();
    assert.equal(begun.held, true);
    assert.equal(begun.resumed, true, 'the plan in hand was lost over the restart');
    assert.equal(second.executor.isHeld(), true);
    assert.deepEqual([second.executor.holdInfo().by, second.executor.holdInfo().reason], ['ADMIN', 'operator_stop']);
    const restored = second.eventsOf('agent.state').find((e) => e.data.state === 'held');
    assert.equal(restored.data.detail.restored, true);
    for (let i = 0; i < 5; i++) {
        assert.equal((await second.executor.runOnce()).kind, 'held');
        await clock.advance(MINUTE);
    }
    assert.deepEqual(second.world.calls.map((call) => call.command), ['goToPosition'], 'the restarted agent did not stay held');
    assert.equal(checkpointOf(second).hold.by, 'ADMIN', 'the periodic checkpoint dropped the hold');
    assert.deepEqual(second.eventsOf('agent.failure'), []);

    await second.executor.resume({ by: 'ADMIN' });
    assert.deepEqual(kinds(await second.drain()), ['step_done', 'goal_completed', 'idle']);
    assert.deepEqual(second.world.calls.map((call) => call.command), ['goToPosition', 'putInChest']);
    // a checkpoint written before the key existed (no "hold") is still a valid one, and means: not held
    const old = { ...checkpointOf(second) };
    delete old.hold;
    assert.deepEqual(checkCheckpoint(old), []);
    assert.match(checkCheckpoint({ ...old, hold: { by: 'Soup' } }).join(), /hold must be \{by, reason, at\} or null/);
    assertEventsValid([...first.events, ...second.events]);
});

test('hold: a held agent sends no planning request and starts no routine; resumed, it plans and works again', async () => {
    const t = makeTown({ clock: fakeClock(), agents: ['Arthur'], inventories: { Arthur: { oak_log: 6, wooden_axe: 1, bread: 4 } } });
    await t.start({ available: true });
    await settle();
    const arthur = t.agents.Arthur;
    await Promise.all(arthur.pending_results);
    t.world.durations = () => 10 * SECOND;
    t.run();
    await t.clock.advance(15 * SECOND);
    const requests = () => arthur.socket.sent.filter(([event]) => event === 'genesis-plan-request').length;

    assert.equal(await arthur.runtime.hold({ by: 'Soup' }), true);
    await t.clock.advance(5 * SECOND); // the step that was running ends
    const sent = requests();
    const calls = t.world.calls.length;
    const decisions = arthur.eventsOf('agent.decision').length;
    // everything that would normally make the agent ask: the operator speaks, another agent asks, a death, the gate
    assert.equal(arthur.runtime.operatorMessage('Soup', 'are you there?'), false);
    assert.equal(arthur.runtime.agentRequest('Mira', 'bread please'), false);
    await t.host.signal('desktop_leaving');
    await t.host.signal('desktop_available');
    await t.clock.advance(30 * MINUTE);
    assert.equal(requests(), sent, 'a planning request left a held agent');
    assert.equal(t.world.calls.length, calls, 'a held agent ran a skill');
    assert.equal(arthur.eventsOf('agent.decision').length, decisions, 'a held agent started a goal (the routine?)');
    assert.ok(arthur.runtime.planner.stats().on_hold >= 2);
    assert.equal(arthur.runtime.stats().held, true);
    assert.deepEqual(arthur.eventsOf('agent.failure'), [], 'a held agent was treated as a failure');
    assert.equal(decodeCheckpoint(t.files.store.get('/checkpoints/Arthur.checkpoint.json')).checkpoint.hold.by, 'Soup');

    assert.equal(await arthur.runtime.resume({ by: 'Soup' }), true);
    await t.clock.advance(5 * MINUTE);
    assert.ok(t.world.calls.length > calls, 'the resumed agent did not go back to work');
    assert.ok(requests() > sent, 'the resumed agent never asked the planner again');
    assert.deepEqual(arthur.eventsOf('agent.state').filter((e) => ['held', 'hold_released'].includes(e.data.state)).map((e) => e.data.state), ['held', 'hold_released']);
    assertEventsValid(arthur.events);
    await t.stop();
});

// ---- one shared chest ledger --------------------------------------------------------------

test('shared ledger: a chest that was looked into always beats arithmetic', () => {
    const clock = fakeClock(1000);
    const ledger = createSharedLedger({ clock });
    // Mira looked into the chest at t=100 and saw 10 bread
    assert.deepEqual(ledger.apply('Mira', { kind: 'observe', chest: 'shared', contents: { bread: 10, air: 0 }, at: 100 }), { chest: 'shared' });
    assert.deepEqual(ledger.view('shared'), { items: { bread: 10 }, seen_at: 100, seen_by: 'Mira' });
    // puts and takes after the look are worked out on top of it
    ledger.apply('Nova', { kind: 'remove', chest: 'shared', item: 'bread', n: 4, at: 150 });
    ledger.apply('Arthur', { kind: 'add', chest: 'shared', item: 'oak_log', n: 12, at: 160 });
    assert.deepEqual(ledger.view('shared').items, { bread: 6, oak_log: 12 });

    // Felix looks at t=200 and sees 9 bread: the look wins over 10 - 4, and the 12 logs he did not see are gone too
    ledger.apply('Felix', { kind: 'observe', chest: 'shared', contents: { bread: 9 }, at: 200 });
    assert.deepEqual(ledger.view('shared'), { items: { bread: 9 }, seen_at: 200, seen_by: 'Felix' });
    // a take that happened BEFORE that look arrives late: the look already shows its result, it is not subtracted again
    assert.equal(ledger.apply('Nova', { kind: 'remove', chest: 'shared', item: 'bread', n: 2, at: 180 }), null);
    assert.deepEqual(ledger.view('shared').items, { bread: 9 });
    // a take AFTER the look counts, even when it arrived before the look did
    const racing = createSharedLedger({ clock });
    racing.apply('Mira', { kind: 'observe', chest: 'kits', contents: { torch: 8 }, at: 10 });
    racing.apply('Nova', { kind: 'remove', chest: 'kits', item: 'torch', n: 3, at: 60 });   // arrives first, happened later
    racing.apply('Felix', { kind: 'observe', chest: 'kits', contents: { torch: 8 }, at: 50 }); // arrives second, happened earlier
    assert.deepEqual(racing.view('kits'), { items: { torch: 5 }, seen_at: 50, seen_by: 'Felix' });
    // a look older than the look the ledger has changes nothing
    assert.equal(racing.apply('Arthur', { kind: 'observe', chest: 'kits', contents: { torch: 64 }, at: 20 }), null);
    assert.deepEqual(racing.view('kits').items, { torch: 5 });
    // "there was none of it": that item is zero from then on, whatever the sums said
    ledger.apply('Arthur', { kind: 'add', chest: 'shared', item: 'coal', n: 5, at: 210 });
    ledger.apply('Mira', { kind: 'zero', chest: 'shared', item: 'coal', at: 220 });
    assert.deepEqual(ledger.view('shared').items, { bread: 9 });
    assert.deepEqual([ledger.stats().arithmetic_overruled, racing.stats().stale_observations], [1, 1]);
    // nonsense is refused and changes nothing
    for (const op of [null, { kind: 'observe', chest: '../x', contents: {} }, { kind: 'add', chest: 'shared', item: 'Bread!', n: 1 }, { kind: 'remove', chest: 'shared', item: 'bread', n: -3 }, { kind: 'steal', chest: 'shared', item: 'bread', n: 1 }]) {
        assert.equal(ledger.apply('Mira', op), null);
    }
    assert.deepEqual(ledger.view('shared').items, { bread: 9 });

    // the file form: what was observed and what came after it; reservations are not kept
    ledger.reserve('Mira', { chest: 'shared', item: 'bread', count: 4 });
    const copy = createSharedLedger({ clock });
    assert.equal(copy.restore(JSON.parse(JSON.stringify(ledger.save()))), 1);
    assert.deepEqual(copy.view('shared'), ledger.view('shared'));
    assert.deepEqual(copy.reservations(), []);
    assert.equal(copy.restore({ v: 99, chests: {} }), 0);
    // many puts and takes are folded into the observation they follow, and the sum stays right
    const busy = createSharedLedger({ clock, max_deltas: 10 });
    busy.apply('Nova', { kind: 'observe', chest: 'shared', contents: { cobblestone: 0 }, at: 0 });
    for (let i = 1; i <= 50; i++) busy.apply('Arthur', { kind: 'add', chest: 'shared', item: 'cobblestone', n: 2, at: i });
    assert.deepEqual(busy.view('shared').items, { cobblestone: 100 });
    assert.ok(busy.save().chests.shared.deltas.length <= 10);
});

test('shared ledger: reservations, and a contested claim that names the item, the count, the holder and the asker', async () => {
    const clock = fakeClock(0);
    const ledger = createSharedLedger({ clock });
    ledger.apply('Nova', { kind: 'observe', chest: 'shared', contents: { bread: 8, torch: 3 }, at: 0 });
    assert.deepEqual(ledger.reserve('Mira', { chest: 'shared', item: 'bread', count: 6 }), { ok: true, count: 6 });
    // what is left over may still be reserved by someone else, but not more than that
    assert.deepEqual(ledger.reserve('Nova', { chest: 'shared', item: 'bread', count: 4 }), { ok: true, count: 2 });
    // everything is spoken for: the third agent is told who holds it
    const refused = ledger.reserve('Arthur', { chest: 'shared', item: 'bread', count: 4 });
    assert.deepEqual(refused, { ok: false, code: 'contested', claim: { chest: 'shared', item: 'bread', count: 4, holder: 'Mira', held: 6, asker: 'Arthur', in_chest: 8 } });
    // nothing of that item at all is not a contest
    assert.deepEqual(ledger.reserve('Arthur', { chest: 'shared', item: 'cake', count: 1 }), { ok: false, code: 'empty' });
    assert.deepEqual(ledger.reserve('Arthur', { chest: 'shared', item: 'torch', count: 9 }), { ok: true, count: 3 });
    // asking again replaces the agent's own reservation; releasing frees it
    assert.deepEqual(ledger.reserve('Mira', { chest: 'shared', item: 'bread', count: 2 }), { ok: true, count: 2 });
    assert.deepEqual(ledger.reserve('Arthur', { chest: 'shared', item: 'bread', count: 4 }), { ok: true, count: 4 });
    assert.equal(ledger.release('Arthur', { chest: 'shared', item: 'bread' }), true);
    assert.equal(ledger.release('Arthur', { chest: 'shared', item: 'bread' }), false);
    // a reservation nobody released (a crash) lapses
    assert.equal(ledger.reservations().length, 3);
    await clock.advance(11 * MINUTE);
    assert.deepEqual(ledger.reservations(), []);
    assert.deepEqual(ledger.reserve('Arthur', { chest: 'shared', item: 'bread', count: 8 }), { ok: true, count: 8 });
    assert.equal(ledger.stats().contested, 1);

    // the plain ledger (one process, the catalog tests) has the same reservations
    const plain = createLedger();
    plain.set('shared', { bread: 8 }, 0);
    assert.deepEqual(plain.reserve('shared', 'bread', 8, 'Mira', 0), { ok: true, count: 8 });
    assert.equal(plain.available('shared', 'bread', 'Arthur', 1), 0);
    assert.equal(plain.available('shared', 'bread', 'Mira', 1), 8);
    assert.equal(plain.reserve('shared', 'bread', 1, 'Arthur', 1).claim.holder, 'Mira');
});

test('shared ledger: the catalog does not fail silently when another agent holds the items', async () => {
    const clock = fakeClock();
    const zones = createZones(WORLD_CONFIG);
    const world = campWorld(clock);
    world.addAgent('Arthur', { position: { x: 0, y: 64, z: 0 }, inventory: {} });
    const claims = [];
    const catalog = createCatalog({ zones, onContested: (claim) => claims.push(claim) });
    const ledger = createLedger();
    ledger.set('shared', { bread: 8, oak_log: 20 }, clock.now());
    const state = () => ({ agent: 'Arthur', view: world.view('Arthur'), ledger, avoid: [], now: clock.now() });
    const ids = () => catalog.offer(state()).map((option) => option.id);

    assert.ok(ids().includes('fetch_items:shared:bread:8'));
    // Mira sets out for all the bread
    assert.equal(ledger.reserve('shared', 'bread', 8, 'Mira', clock.now()).ok, true);
    // it is no longer put forward to Arthur (looking at what could be offered is not wanting it: no claim yet)
    assert.ok(!ids().some((id) => id.startsWith('fetch_items:shared:bread')), 'reserved items were offered');
    assert.ok(ids().includes('fetch_items:shared:oak_log:8'), 'items nobody reserved are still offered');
    assert.deepEqual(claims, []);
    // Arthur wants it anyway (a queued goal about to start, a routine asking): refused BY NAME, and the claim is reported
    assert.deepEqual(catalog.check('fetch_items:shared:bread:4', state()), { ok: false, reason: 'contested_claim' });
    assert.deepEqual(claims, [{ chest: 'shared', item: 'bread', count: 4, holder: 'Mira', held: 8, asker: 'Arthur', in_chest: 8 }]);
    assert.deepEqual(catalog.option('fetch_items', { chest: 'shared', item: 'bread', count: 2 }, state()), { ok: false, reason: 'contested_claim' });
    assert.equal(claims.length, 2);
    assert.ok(catalog.skills().find((skill) => skill.name === 'fetch_items').failures.includes('contested_claim'));
    // part of it is free: Arthur is offered what is left, and takes no more than that
    ledger.reserve('shared', 'bread', 5, 'Mira', clock.now());
    assert.ok(ids().includes('fetch_items:shared:bread:3'));

    // a goal that was started and then loses the items (Mira was quicker): the step fails with the named reason
    ledger.release('shared', 'bread', 'Mira');
    const option = catalog.check('fetch_items:shared:bread:8', state()).option;
    const plan = catalog.plan(option, state());
    assert.equal(catalog.before(option.id, plan.steps[0], state()), null);
    assert.deepEqual(ledger.reservations().map((held) => [held.holder, held.item, held.count]), [['Arthur', 'bread', 8]], 'setting out did not reserve the items');
    ledger.release('shared', 'bread', 'Arthur');           // (as if the MindServer had said: Mira was first)
    ledger.reserve('shared', 'bread', 8, 'Mira', clock.now());
    claims.length = 0;
    assert.deepEqual(catalog.before(option.id, plan.steps[1], state()), { fail: 'contested_claim' });
    assert.deepEqual(claims.map((claim) => [claim.item, claim.count, claim.holder, claim.asker]), [['bread', 8, 'Mira', 'Arthur']]);
    // when a goal ends, however it ends, what it had reserved is free again
    ledger.release('shared', 'bread', 'Mira');
    catalog.before(option.id, plan.steps[0], state());
    assert.equal(ledger.reservations().length, 1);
    assert.equal(catalog.release(option.id, state()), true);
    assert.deepEqual(ledger.reservations(), []);
    assert.equal(catalog.release('travel:home', state()), false, 'a skill that reserves nothing has nothing to release');
    // the hook can be set later (the agent runtime does), and a hook that throws disturbs nothing
    catalog.setContestedHook(() => { throw new Error('listener broke'); });
    ledger.reserve('shared', 'bread', 8, 'Mira', clock.now());
    assert.deepEqual(catalog.check('fetch_items:shared:bread:4', state()), { ok: false, reason: 'contested_claim' });
});

test('shared ledger: one ledger for all agents, in the MindServer; what one agent sees, every agent knows', async () => {
    const t = makeTown({ clock: fakeClock(), agents: ['Arthur', 'Mira'], inventories: { Arthur: { bread: 4 }, Mira: { bread: 4 } } });
    await t.start({ available: false });
    await settle();
    const { Arthur: arthur, Mira: mira } = t.agents;
    t.world.set(2, 64, 2, 'chest', { contents: { bread: 8, oak_log: 12 } });

    // Arthur walks to the shared chest and looks into it
    const step = async (a, times) => { const done = []; for (let i = 0; i < times; i++) done.push((await a.runtime.executor.runOnce()).kind); return done; };
    await arthur.runtime.goals.setShortTerm('Arthur', [{ title: 'Look into the shared chest', option_id: 'travel:chest-shared' }], { reason: 'seeded', source: 'operator' });
    assert.deepEqual(await step(arthur, 4), ['goal_started', 'step_done', 'step_done', 'goal_completed']);
    assert.deepEqual(arthur.ledger.stock('shared'), { bread: 8, oak_log: 12 });
    // Mira never went near it, and knows: it is the same ledger
    assert.deepEqual(mira.ledger.stock('shared'), { bread: 8, oak_log: 12 });
    assert.equal(mira.ledger.known('shared'), true);
    assert.deepEqual(t.host.ledger.view('shared').items, { bread: 8, oak_log: 12 });
    assert.equal(t.host.ledger.view('shared').seen_by, 'Arthur');
    assert.ok(createCatalog({ zones: t.zones }).offer(mira.runtime.state()).some((option) => option.id === 'fetch_items:shared:oak_log:8'), 'Mira is not offered what Arthur saw');
    // the ledger is not in any agent's checkpoint any more
    await mira.runtime.executor.saveNow();
    for (const name of ['Arthur', 'Mira']) {
        const checkpoint = decodeCheckpoint(t.files.store.get(`/checkpoints/${name}.checkpoint.json`)).checkpoint;
        assert.equal(Object.hasOwn(checkpoint.places, 'ledger'), false, `${name}'s checkpoint still carries a ledger`);
    }

    // Mira sets out to fetch the bread: reserved in the MindServer, and Arthur's copy knows it
    await mira.runtime.goals.setShortTerm('Mira', [{ title: 'Fetch bread', option_id: 'fetch_items:shared:bread:8' }], { reason: 'seeded', source: 'operator' });
    assert.deepEqual(await step(mira, 2), ['goal_started', 'step_done']); // she has walked to the chest
    assert.deepEqual(t.host.ledger.reservations().map((held) => [held.holder, held.chest, held.item, held.count]), [['Mira', 'shared', 'bread', 8]]);
    assert.equal(arthur.ledger.available('shared', 'bread'), 0);
    assert.equal(arthur.ledger.count('shared', 'bread'), 8);

    // Arthur wants bread too: a contested claim, as an event and at the hook the request to Mira will be sent from
    const wanted = await arthur.runtime.goals.setShortTerm('Arthur', [{ title: 'Fetch bread', option_id: 'fetch_items:shared:bread:4' }], { reason: 'seeded', source: 'operator' });
    assert.deepEqual(await step(arthur, 1), ['goal_dropped']);
    const claim_events = arthur.eventsOf('agent.state').filter((event) => event.data.state === 'contested_claim');
    assert.equal(claim_events.length, 1);
    assert.deepEqual(claim_events[0].data.detail, { chest: 'shared', item: 'bread', count: 4, holder: 'Mira', asker: 'Arthur', held: 8, in_chest: 8 });
    assert.equal(claim_events[0].agent, 'Arthur');
    assert.deepEqual(arthur.claims.map((claim) => [claim.item, claim.count, claim.holder, claim.asker]), [['bread', 4, 'Mira', 'Arthur']]);
    assert.equal(typeof arthur.claims[0].at, 'number');
    // the goal did not vanish without a word: it was dropped with the named reason
    const dropped = arthur.eventsOf('agent.state').find((event) => event.data.state === 'goal_dropped' && event.data.detail.goal_id === wanted.goals.short_term[0].id);
    assert.equal(dropped.data.detail.reason, 'contested_claim');
    assert.ok(arthur.changes().some((change) => change.reason === 'dropped before starting: contested_claim'));
    // asked again within the minute (a routine asks every round): counted, not reported again
    assert.equal(createCatalog({ zones: t.zones, onContested: () => {} }).check('fetch_items:shared:bread:4', arthur.runtime.state()).reason, 'contested_claim');
    await arthur.runtime.goals.setShortTerm('Arthur', [{ title: 'Fetch bread', option_id: 'fetch_items:shared:bread:2' }], { reason: 'seeded', source: 'operator' });
    await step(arthur, 1);
    assert.equal(arthur.eventsOf('agent.state').filter((event) => event.data.state === 'contested_claim').length, 1);
    assert.deepEqual([arthur.runtime.stats().contested_claims, arthur.runtime.stats().contested_repeats], [1, 1]);
    // nothing was sent to Mira: the request itself is a later step
    assert.ok(!mira.eventsOf('agent.message').length && !arthur.eventsOf('agent.message').length);

    // Mira takes the bread: the count goes down for everybody and the reservation is gone
    assert.deepEqual(await step(mira, 2), ['step_done', 'goal_completed']);
    assert.equal(t.world.body('Mira').inventory.bread, 12);
    assert.deepEqual(t.host.ledger.reservations(), []);
    assert.equal(arthur.ledger.count('shared', 'bread'), 0);
    assert.deepEqual(arthur.ledger.stock('shared'), { oak_log: 12 });
    assertEventsValid([...arthur.events, ...mira.events]);
    await t.stop();
});

test('shared ledger: an agent\'s copy takes the MindServer\'s word, also when it lost a race for a reservation', async () => {
    const clock = fakeClock();
    const sent = [];
    const lost = [];
    const client = createLedgerClient({ agent: 'Arthur', clock, send: (event, ...args) => sent.push([event, ...args]), onLost: (claim) => lost.push(claim) });
    client.onUpdate({ chests: { shared: { items: { bread: 8 }, seen_at: 5, seen_by: 'Nova' } }, reservations: [] });
    assert.deepEqual([client.count('shared', 'bread'), client.known('shared'), client.seen_at('shared')], [8, true, 5]);

    // the copy grants at once (no step waits for the socket) and asks the MindServer
    assert.deepEqual(client.reserve('shared', 'bread', 8), { ok: true, count: 8 });
    const [event, message, ack] = sent.at(-1);
    assert.deepEqual([event, message], ['genesis-ledger-reserve', { agent: 'Arthur', chest: 'shared', item: 'bread', count: 8 }]);
    // the MindServer answers: Mira was first
    const claim = { chest: 'shared', item: 'bread', count: 8, holder: 'Mira', held: 8, asker: 'Arthur', in_chest: 8 };
    ack({ ok: false, code: 'contested', claim, reservations: [{ chest: 'shared', item: 'bread', count: 8, holder: 'Mira', at: 0, expires_at: clock.now() + 600000 }] });
    assert.deepEqual(lost, [claim]);
    assert.equal(client.available('shared', 'bread'), 0);
    assert.deepEqual(client.reserve('shared', 'bread', 8), { ok: false, code: 'contested', claim });
    assert.equal(client.stats().reservations_lost, 1);

    // what the agent sees and does goes to the MindServer as it happens
    sent.length = 0;
    client.set('kits', { torch: 8 }, 77);
    client.add('kits', 'bread', 3);
    client.remove('kits', 'torch', 2);
    client.zero('kits', 'bread');
    assert.deepEqual(sent.map(([name, payload]) => [name, payload.op.kind]), [['genesis-ledger-op', 'observe'], ['genesis-ledger-op', 'add'], ['genesis-ledger-op', 'remove'], ['genesis-ledger-op', 'zero']]);
    assert.deepEqual(sent[0][1], { agent: 'Arthur', op: { kind: 'observe', chest: 'kits', contents: { torch: 8 }, at: 77 } });
    assert.deepEqual(client.stock('kits'), { torch: 6 });
    // not connected: the copy works on with what it knows, and takes the MindServer's ledger with the next sync
    const offline = createLedgerClient({ agent: 'Mira', clock, send: () => { throw new Error('not connected'); } });
    offline.set('shared', { wheat: 9 }, 1);
    assert.equal(offline.count('shared', 'wheat'), 9);
    assert.equal(await offline.sync(), false);
    assert.ok(offline.stats().send_failed >= 2);

    // only an agent's own connection may write to the ledger in its name
    const host = createPlanningHost({ model: stubModel(clock), clock });
    const { client: socket, server } = socketPair();
    host.attach(server, { isAgentSocket: (name) => name === 'Arthur' });
    socket.emit('genesis-ledger-op', { agent: 'Mira', op: { kind: 'observe', chest: 'shared', contents: { diamond: 64 }, at: 1 } });
    socket.emit('genesis-ledger-reserve', { agent: 'Mira', chest: 'shared', item: 'bread', count: 1 }, () => { throw new Error('answered a stranger'); });
    assert.deepEqual(host.ledger.snapshot().chests, {});
    assert.equal(host.stats().refused_sender, 2);
    socket.emit('genesis-ledger-op', { agent: 'Arthur', op: { kind: 'observe', chest: 'shared', contents: { bread: 2 }, at: 1 } });
    let synced = null;
    socket.emit('genesis-ledger-sync', 'Arthur', (answer) => { synced = answer; });
    assert.deepEqual(synced, { ok: true, ledger: { v: SHARED_LEDGER_VERSION, chests: { shared: { items: { bread: 2 }, seen_at: 1, seen_by: 'Arthur' } }, reservations: [] } });
    // a process that is gone holds nothing
    socket.emit('genesis-ledger-reserve', { agent: 'Arthur', chest: 'shared', item: 'bread', count: 2 }, () => {});
    assert.equal(host.ledger.reservations().length, 1);
    server.fire('disconnect');
    assert.deepEqual(host.ledger.reservations(), []);
    host.stop();
});

test('shared ledger: it is kept in one file by the MindServer process, and a damaged file starts an empty ledger', async () => {
    const clock = fakeClock();
    const files = fakeFiles();
    const file = '/data/genesis_ledger/chest_ledger.json';
    const warnings = [];
    const start = () => startPlanning({ model: { url: 'http://10.0.0.5:11434', model: 'm' }, ledger_file: file }, {
        setSocketExtension: () => {}, clock, files, createModel: () => stubModel(clock), warn: (line) => warnings.push(JSON.parse(line)),
    });
    const first = await start();
    first.ledger.apply('Nova', { kind: 'observe', chest: 'shared', contents: { bread: 8 }, at: clock.now() });
    first.ledger.apply('Mira', { kind: 'add', chest: 'shared', item: 'wheat', n: 30, at: clock.now() + 1 });
    assert.equal(files.store.has(file), false, 'written at once: every put and take would hit the disk');
    await clock.advance(3 * SECOND);
    assert.deepEqual(files.log.slice(-2), [['write', `${file}.tmp`], ['rename', `${file}.tmp`, file]], 'the ledger file is not written atomically');
    const saved = JSON.parse(files.store.get(file));
    assert.deepEqual([saved.v, saved.chests.shared.base, saved.chests.shared.deltas.length], [1, { bread: 8 }, 1]);
    first.stop();

    // the MindServer starts again: the ledger is back, for every agent
    const second = await start();
    assert.deepEqual(second.ledger.view('shared').items, { bread: 8, wheat: 30 });
    second.stop();
    // one file for all agents, and no per-agent ledger anywhere
    assert.deepEqual([...files.store.keys()], [file]);

    // a damaged file: reported once, and the ledger starts empty (it fills again as the agents look into the chests)
    files.store.set(file, '{"v":1,"chests":{"shared":');
    const third = await start();
    assert.deepEqual(third.ledger.snapshot().chests, {});
    assert.deepEqual(warnings.map((warning) => warning.event), ['genesis_chest_ledger']);
    assert.match(warnings[0].message, /the file is damaged/);
    third.stop();
    // a disk that cannot be written never stops the ledger
    const fourth = await start();
    files.fail_write = new Error('ENOSPC');
    fourth.ledger.apply('Nova', { kind: 'observe', chest: 'kits', contents: { torch: 8 }, at: clock.now() });
    await clock.advance(3 * SECOND);
    assert.deepEqual(fourth.ledger.view('kits').items, { torch: 8 });
    assert.equal(fourth.ledger_file.stats().save_failures, 1);
    await fourth.ledger_file.flush();
    fourth.stop();
});

// ---- upstream's idle reflexes stay on -----------------------------------------------------

test('modes: Genesis switches none of upstream\'s modes (the idle reflexes) off', () => {
    const genesis = path.join(REPO_ROOT, 'genesis');
    // the profiles and the settings name no mode and no base profile: upstream's own defaults apply, untouched
    const settings = JSON.parse(readFileSync(path.join(genesis, 'settings.json'), 'utf8'));
    assert.equal(Object.hasOwn(settings, 'base_profile'), false, 'the Genesis settings choose a base profile');
    assert.equal(Object.hasOwn(settings, 'modes'), false);
    assert.ok(!settings.blocked_actions.includes('!setMode'));
    for (const profile_path of settings.profiles) {
        const profile = JSON.parse(readFileSync(path.join(REPO_ROOT, profile_path), 'utf8'));
        assert.equal(Object.hasOwn(profile, 'modes'), false, `${profile_path} sets modes`);
        assert.equal(Object.hasOwn(profile, 'base_profile'), false);
    }
    // what upstream's default profile switches on is what a Genesis agent runs with
    const defaults = JSON.parse(readFileSync(path.join(REPO_ROOT, 'profiles', 'defaults', '_default.json'), 'utf8')).modes;
    for (const mode of ['self_preservation', 'unstuck', 'self_defense', 'item_collecting', 'torch_placing', 'elbow_room', 'idle_staring']) {
        assert.equal(defaults[mode], true, `upstream's default for ${mode} changed`);
    }
    // no Genesis code switches a mode off, pauses one, or sends the command that does
    const sources = [];
    const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === 'tests' || entry.name === 'node_modules') continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (/\.(js|mjs|json)$/.test(entry.name)) sources.push(full);
        }
    };
    walk(genesis);
    assert.ok(sources.length > 40);
    // one exception, decided after the first run: genesis/lib/threat_modes.js switches the two THREAT modes
    // (cowardice, self_defense) while an agent is on its routine, and nothing else
    const threat_file = path.join(genesis, 'lib', 'threat_modes.js');
    for (const file of sources) {
        const text = readFileSync(file, 'utf8');
        for (const forbidden of [/modes\s*\.\s*setOn\s*\(/, /modes\s*\.\s*pause\s*\(/, /modes\s*\.\s*unPauseAll\s*\(/, /!setMode/, /skills\s*\.\s*stay\s*\(/]) {
            if (file === threat_file && String(forbidden) === String(/modes\s*\.\s*setOn\s*\(/)) continue;
            assert.ok(!forbidden.test(text), `${path.relative(REPO_ROOT, file)} touches upstream's modes (${forbidden})`);
        }
    }
    const threat = readFileSync(threat_file, 'utf8');
    assert.equal(threat.match(/modes\s*\.\s*setOn\s*\(/g).length, 1, 'threat_modes.js switches modes in more than one place');
    assert.match(threat, /export const THREAT_MODES = Object\.freeze\(\['cowardice', 'self_defense'\]\);/);
    assert.match(threat, /for \(const name of THREAT_MODES\) \{\s*if \(want\[name\] !== now\[name\]\) \{ modes\.setOn\(name, want\[name\]\);/);
});
