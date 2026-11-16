// Step 7, the executor: goals are carried out from the skill templates, step by step,
// with no model anywhere, and survive a hard kill.
//
// Everything is in memory: the world is helpers/fake-world.mjs, the clock only moves when a
// test says so, files and the goal storage are fakes. The event emitter, the goal store and
// the checkpoint store are the real ones.
// Run from the repository root:  node --test genesis/tests/*.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeClock, fakeFiles, fakeGoalStorage, settle } from './helpers/fakes.mjs';
import { campWorld, WORLD_CONFIG } from './helpers/fake-world.mjs';
import { makeRig } from './helpers/rig.mjs';
import { validateEvent } from '../shared/events.js';
import { checkCheckpoint, decodeCheckpoint, CHECKPOINT_INTERVAL_MS } from '../store/checkpoint.js';
import { EXECUTOR_DEFAULTS } from '../executor/executor.js';
import { createScaffoldTracker } from '../executor/scaffold.js';
import { createZones } from '../catalog/zones.js';

// A model that only counts: nothing in this file may ever reach it.
const stub_model = { requests: 0, chat() { stub_model.requests++; throw new Error('the executor called the model'); } };

async function started(options = {}) {
    const rig = makeRig({ clock: fakeClock(), ...options });
    await rig.executor.start();
    return rig;
}

const kinds = (outcomes) => outcomes.map((outcome) => outcome.kind);
const checkpointOf = (rig) => decodeCheckpoint(rig.files.store.get('/checkpoints/Arthur.checkpoint.json')).checkpoint;

function assertEventsValid(rig) {
    assert.ok(rig.events.length > 0);
    rig.events.forEach((event, index) => {
        assert.deepEqual(validateEvent(event), { ok: true, errors: [] }, `event ${index} (${event.type})`);
        if (index > 0) assert.equal(event.seq, rig.events[index - 1].seq + 1, 'seq has a gap');
    });
}

test('the decided numbers are the defaults', () => {
    assert.equal(EXECUTOR_DEFAULTS.max_attempts, 3);
    assert.equal(EXECUTOR_DEFAULTS.checkpoint_interval_ms, 30000);
    assert.equal(CHECKPOINT_INTERVAL_MS, 30000);
    assert.ok(EXECUTOR_DEFAULTS.step_gap_ms > 20, 'steps must start further apart than upstream\'s fast-action-loop limit');
});

test('a seeded goal completes with zero model requests, and every event carries the decision id', async () => {
    const rig = await started({ inventory: { oak_log: 2 } });
    const goal = await rig.seed('gather_blocks:oak_log:4', { title: 'Gather four logs' });
    const done = await rig.drain();
    assert.deepEqual(kinds(done), ['goal_started', 'step_done', 'step_done', 'step_done', 'step_done', 'step_done', 'goal_completed', 'idle']);

    assert.equal(stub_model.requests, 0);
    assert.equal(rig.world.body('Arthur').inventory.oak_log, 6);
    assert.deepEqual(await rig.queue(), []);
    assert.deepEqual(rig.triggers, [{ kind: 'goal_complete', detail: { outcome: 'completed', option_id: 'gather_blocks:oak_log:4' } }]);
    assert.deepEqual(rig.world.calls.map((call) => call.command), ['breakBlockAt', 'breakBlockAt', 'breakBlockAt', 'breakBlockAt', 'pickupNearbyItems']);
    assert.ok(rig.world.broken.every((block) => !rig.zones.isProtected(block)), 'a block in a protected zone was broken');

    assertEventsValid(rig);
    const [decision] = rig.eventsOf('agent.decision');
    assert.equal(rig.eventsOf('agent.decision').length, 1);
    assert.equal(decision.data.summary, 'Gather four logs');
    assert.equal(decision.data.trigger, 'operator');
    assert.equal(decision.data.command, 'gather_blocks');
    assert.deepEqual(decision.data.steps, ['breakBlockAt', 'breakBlockAt', 'breakBlockAt', 'breakBlockAt', 'pickupNearbyItems']);
    assert.equal(decision.data.steps_from, 'template');
    const decision_id = decision.data.decision_id;
    assert.equal(decision.corr, decision_id);
    const types = ['skill.started', 'skill.progress', 'skill.result'];
    for (const type of types) {
        assert.equal(rig.eventsOf(type).length, 5, type);
        assert.ok(rig.eventsOf(type).every((event) => event.corr === decision_id), `${type} without the decision id`);
    }
    assert.deepEqual(rig.eventsOf('skill.result').map((event) => [event.data.skill, event.data.ok]),
        [['breakBlockAt', true], ['breakBlockAt', true], ['breakBlockAt', true], ['breakBlockAt', true], ['pickupNearbyItems', true]]);
    // progress is the template's measure: items gained
    assert.deepEqual(rig.eventsOf('skill.progress').at(-1).data, { skill: 'gather_blocks', done: 4, total: 4, unit: 'items gained', step: 4 });
    assert.deepEqual(rig.eventsOf('agent.state').map((event) => event.data.state), ['goal_started', 'goal_completed']);
    assert.ok(rig.eventsOf('agent.state').every((event) => event.corr === decision_id));

    // the goal store recorded how the goal came and went, each with a reason and a source
    assert.deepEqual(rig.storage.changes.map((change) => [change.source, change.reason, change.after.length]),
        [['operator', 'seeded by the test (operator)', 1], ['executor', 'completed', 0]]);
    const changed = rig.eventsOf('goal.changed');
    assert.equal(changed.length, 2);
    assert.equal(changed[1].corr, decision_id);
    assert.equal(changed[1].data.before[0].id, goal.id);

    // a checkpoint was written at every step boundary; the last one has no plan left
    assert.ok(rig.checkpoints.stats().written >= 12);
    const checkpoint = checkpointOf(rig);
    assert.deepEqual(checkCheckpoint(checkpoint), []);
    assert.equal(checkpoint.plan, null);
    assert.equal(checkpoint.seq, rig.events.at(-1).seq);
});

test('a queued goal whose preconditions no longer hold is dropped with a reason', async () => {
    const rig = await started({ inventory: { oak_log: 5, wheat: 3 } });
    await rig.seed('store_items:shared:oak_log');
    await rig.seed('craft_item:bread:1');
    await rig.seed('gather_blocks:oak_log:4');
    // while the first goal runs the world changes: the logs are stored (so nothing is wrong
    // with goal 1), the wheat is gone, and night falls
    const done = [await rig.executor.runOnce(), await rig.executor.runOnce(), await rig.executor.runOnce(), await rig.executor.runOnce()];
    assert.deepEqual(kinds(done), ['goal_started', 'step_done', 'step_done', 'goal_completed']);
    delete rig.world.body('Arthur').inventory.wheat;
    await rig.clock.advance(12 * 60 * 1000); // 14400 ticks later: night
    assert.equal(rig.world.view('Arthur').dayTicksLeft(), 0);

    const rest = await rig.drain();
    assert.deepEqual(rest.map((outcome) => [outcome.kind, outcome.reason]), [
        ['goal_dropped', 'missing_ingredients'], ['goal_dropped', 'night'], ['idle', undefined],
    ]);
    assert.deepEqual(await rig.queue(), []);
    assert.deepEqual(rig.storage.changes.slice(-2).map((change) => [change.source, change.reason]), [
        ['executor', 'dropped before starting: missing_ingredients'], ['executor', 'dropped before starting: night'],
    ]);
    const dropped = rig.eventsOf('agent.state').filter((event) => event.data.state === 'goal_dropped');
    assert.deepEqual(dropped.map((event) => event.data.detail.reason), ['missing_ingredients', 'night']);
    // no skill ran for a dropped goal
    assert.deepEqual(rig.world.calls.map((call) => call.command), ['goToPosition', 'putInChest']);
    assert.equal(rig.eventsOf('agent.decision').length, 1);
    // decided at the last review: finishing ANY goal asks the planner, also with goals still queued (goal 1);
    // a drop asks once the queue has run empty
    assert.deepEqual(rig.triggers.map((trigger) => [trigger.kind, trigger.detail.outcome]), [['goal_complete', 'completed'], ['goal_complete', 'dropped']]);
    assertEventsValid(rig);
});

test('a step that fails three times ends the goal with a named reason and triggers one planning request', async () => {
    const rig = await started({ inventory: { oak_log: 5 } });
    // the chest looked reachable when the goal was chosen; the walk itself finds no way without digging
    rig.world.body('Arthur').position = { x: 20, y: 64, z: 20 };
    rig.world.fail = (call) => (call.command === 'goToPosition'
        ? { output: 'no_safe_path: there is no way to the goal without breaking blocks. Not digging.' } : null);
    const executor = rig.executor;
    await rig.seed('store_items:shared:oak_log');
    await rig.seed('craft_item:oak_planks:4');

    const done = [];
    for (let i = 0; i < 4; i++) done.push(await executor.runOnce());
    assert.deepEqual(done.map((outcome) => [outcome.kind, outcome.reason, outcome.attempts]), [
        ['goal_started', undefined, undefined],
        ['step_retry', 'no_safe_path', 1],
        ['step_retry', 'no_safe_path', 2],
        ['goal_failed', 'no_safe_path', undefined],
    ]);
    assert.ok(done[1].wait_ms >= 1000, 'a failed step is not retried at once');
    assert.equal(rig.world.calls.filter((call) => call.command === 'goToPosition').length, 3);
    assert.equal(rig.world.calls.filter((call) => call.command === 'putInChest').length, 0, 'the step after the failed one ran');

    // the goal ended with the named reason, recorded with source "executor"
    const change = rig.storage.changes.at(-1);
    assert.equal(change.source, 'executor');
    assert.equal(change.reason, 'failed: no_safe_path (goToPosition, step 1 of 2, 3 attempts)');
    assert.deepEqual((await rig.queue()).map((goal) => goal.option_id), ['craft_item:oak_planks:4']);
    const failed = rig.eventsOf('agent.state').find((event) => event.data.state === 'goal_failed');
    assert.equal(failed.severity, 'warn');
    assert.deepEqual({ ...failed.data.detail, goal_id: undefined },
        { goal_id: undefined, option_id: 'store_items:shared:oak_log', reason: 'no_safe_path', step: 0, command: 'goToPosition', attempts: 3 });
    assert.deepEqual(rig.eventsOf('skill.result').map((event) => [event.data.ok, event.severity]), [[false, 'warn'], [false, 'warn'], [false, 'warn']]);

    // exactly one planning request, and the agent carries on with what is queued
    assert.deepEqual(rig.triggers, [{ kind: 'step_failed', detail: { reason: 'no_safe_path', option_id: 'store_items:shared:oak_log', command: 'goToPosition' } }]);
    const rest = [];
    for (let i = 0; i < 4; i++) rest.push(await executor.runOnce());
    assert.deepEqual(kinds(rest), ['goal_started', 'step_done', 'goal_completed', 'idle']);
    assert.equal(rig.triggers.filter((trigger) => trigger.kind === 'step_failed').length, 1);
    assertEventsValid(rig);
});

test('after a hard kill in the middle of a step the executor resumes the same step, and seq continues', async () => {
    const clock = fakeClock();
    const files = fakeFiles();
    const storage = fakeGoalStorage();
    const world = campWorld(clock);
    const first = makeRig({ clock, world, files, storage, inventory: { oak_log: 2 } });
    await first.executor.start();
    const goal = await first.seed('gather_blocks:oak_log:4');

    // the third block is being broken when the process dies: the skill never returns
    world.hang = (call) => call.command === 'breakBlockAt' && world.calls.filter((c) => c.command === 'breakBlockAt').length === 3;
    assert.deepEqual(kinds([await first.executor.runOnce(), await first.executor.runOnce(), await first.executor.runOnce()]),
        ['goal_started', 'step_done', 'step_done']);
    first.executor.runOnce(); // never settles
    await settle();
    const dying_step = world.calls.at(-1);
    assert.equal(dying_step.command, 'breakBlockAt');
    const seq_at_kill = first.events.at(-1).seq;
    const on_disk = decodeCheckpoint(files.store.get('/checkpoints/Arthur.checkpoint.json')).checkpoint;
    assert.equal(on_disk.plan.cursor, 2);
    assert.deepEqual(on_disk.plan.steps.map((step) => step.status), ['done', 'done', 'active', 'pending', 'pending']);
    assert.equal(on_disk.seq, seq_at_kill, 'the checkpoint is older than the last event before the kill');
    // (the first rig is dropped here, with its promise still pending: that is the kill)

    // ---- the agent process starts again: same files, same goal storage, nothing else ----
    world.hang = null;
    const checkpoint_seq = on_disk.seq;
    const second = makeRig({ clock, world, files, storage, last_seq: checkpoint_seq });
    const start = await second.executor.start();
    assert.equal(start.resumed, true);
    assert.equal(start.checkpoint.seq, checkpoint_seq);
    assert.equal(stub_model.requests, 0, 'the restart asked the model something');

    const plan = second.executor.plan();
    assert.equal(plan.goal.id, goal.id);
    assert.equal(plan.cursor, 2);
    const next = await second.executor.runOnce();
    assert.deepEqual([next.kind, next.step], ['step_done', 2]);
    const resumed_call = world.calls.at(-1);
    assert.deepEqual([resumed_call.command, resumed_call.args], [dying_step.command, dying_step.args], 'another step was run after the restart');
    assert.equal(second.executor.plan().steps[2].attempts, 2);

    // seq goes on from the checkpoint, it does not start again at 1
    assert.equal(second.events[0].seq, checkpoint_seq + 1);
    assert.deepEqual(second.events[0].data.state, 'resumed');
    assert.deepEqual(second.events[0].data.detail, { goal_id: goal.id, option_id: 'gather_blocks:oak_log:4', step: 2, command: 'breakBlockAt', attempts: 1, from: 'file' });
    assert.equal(second.events[0].corr, plan.id, 'the resumed work lost its decision id');
    assert.equal(second.eventsOf('agent.decision').length, 0, 'the goal was decided a second time');

    assert.deepEqual(kinds(await second.drain()), ['step_done', 'step_done', 'goal_completed', 'idle']);
    assert.equal(world.body('Arthur').inventory.oak_log, 6);
    assert.equal(world.calls.filter((call) => call.command === 'breakBlockAt').length, 5, 'four blocks, one of them started twice');
    assertEventsValid(second);
    assert.equal(second.executor.stats().resumed, 1);
});

test('a start without a checkpoint, or with one whose goal is gone, begins clean', async () => {
    const clock = fakeClock();
    const files = fakeFiles();
    const fresh = makeRig({ clock, files });
    const first = await fresh.executor.start();
    assert.deepEqual([first.resumed, first.checkpoint], [false, null]);
    await fresh.seed('gather_blocks:oak_log:2');
    await fresh.executor.runOnce();
    await fresh.executor.runOnce();
    assert.equal(checkpointOf(fresh).plan.cursor, 1);

    // the goal store lost the goal (a reset): the plan in the checkpoint is not resumed
    const again = makeRig({ clock, world: fresh.world, files, storage: fakeGoalStorage() });
    const second = await again.executor.start();
    assert.equal(second.resumed, false);
    assert.equal(again.executor.plan(), null);
    assert.deepEqual(kinds(await again.drain()), ['idle']);

    // a damaged file is reported by the store and is not a reason to stop
    files.store.set('/checkpoints/Arthur.checkpoint.json', '{"sha256":"0","checkpoint":{}}');
    const broken = makeRig({ clock, world: fresh.world, files, storage: fresh.storage });
    assert.equal((await broken.executor.start()).resumed, false);
});

test('a checkpoint is also written every 30 seconds while a long step runs', async () => {
    const rig = await started();
    rig.world.durations = (command) => (command === 'breakBlockAt' ? 100 * 1000 : 0);
    await rig.seed('gather_blocks:oak_log:1');
    await rig.executor.runOnce();
    const before = rig.checkpoints.stats().written;
    const step = rig.executor.runOnce();
    await rig.clock.advance(95 * 1000);
    assert.equal(rig.checkpoints.stats().written - before, 1 + 3, 'one at the step boundary, then one every 30 seconds');
    assert.equal(checkpointOf(rig).plan.steps[0].status, 'active');
    // progress is measured while the step runs
    assert.ok(rig.eventsOf('skill.progress').length >= 15);
    await rig.clock.advance(10 * 1000);
    assert.equal((await step).kind, 'step_done');
    rig.executor.stop();
    assertEventsValid(rig);
});

test('an interrupted step is run again and does not count as a failure, until it is interrupted too often', async () => {
    const rig = await started({ inventory: { oak_log: 5 } });
    let interrupts = 2;
    rig.world.fail = (call) => (call.command === 'putInChest' && interrupts-- > 0 ? { interrupted: true } : null);
    await rig.seed('store_items:shared:oak_log');
    const done = await rig.drain();
    assert.deepEqual(kinds(done), ['goal_started', 'step_done', 'step_interrupted', 'step_interrupted', 'step_done', 'goal_completed', 'idle']);
    assert.equal(rig.world.body('Arthur').inventory.oak_log, undefined);
    assert.deepEqual(rig.triggers.map((trigger) => trigger.kind), ['reflex_interrupt', 'goal_complete'], 'one trigger for the interruptions of a goal');
    assert.equal(rig.ledger.count('shared', 'oak_log'), 5, 'the ledger did not learn what was stored');

    // interrupted without end: that is a failure after all
    rig.world.body('Arthur').inventory.oak_log = 3;
    rig.world.fail = (call) => (call.command === 'putInChest' ? { interrupted: true } : null);
    await rig.seed('store_items:shared:oak_log');
    const more = await rig.drain();
    assert.equal(more.at(-2).kind, 'goal_failed');
    assert.equal(more.at(-2).reason, 'interrupted');
    assert.equal(more.filter((outcome) => outcome.kind === 'step_interrupted').length, EXECUTOR_DEFAULTS.max_interruptions);
});

test('scaffold left in a home zone keeps the step from completing', async () => {
    const zones = createZones(WORLD_CONFIG);
    const tracker = createScaffoldTracker({ zones });
    tracker.begin([{ x: 1, y: 65, z: 1 }]);
    assert.equal(tracker.placed({ x: 1, y: 65, z: 1 }), false, 'a cell the step places on purpose is not scaffolding');
    assert.equal(tracker.placed({ x: -40, y: 64, z: 0 }), false, 'scaffolding outside the zones may stay');
    assert.equal(tracker.placed({ x: 3, y: 65, z: 3 }), true);
    assert.deepEqual(tracker.snapshot(), [[3, 65, 3]]);

    // walking to the shared chest, the agent pillars up inside the camp and leaves the block there
    const rig = await started({ inventory: { oak_log: 5 }, position: { x: 30, y: 64, z: 30 } });
    rig.world.scaffold = (call) => (call.command === 'goToPosition' ? [{ x: 5, y: 65, z: 5, name: 'dirt', sticky: true }] : []);
    await rig.seed('store_items:shared:oak_log');
    const done = await rig.drain();
    assert.deepEqual(done.map((outcome) => [outcome.kind, outcome.reason]), [
        ['goal_started', undefined],
        ['step_retry', 'scaffold_left_in_zone'], ['step_retry', 'scaffold_left_in_zone'], ['goal_failed', 'scaffold_left_in_zone'],
        ['scaffold_pending', undefined],
    ]);
    assert.equal(rig.world.get(5, 65, 5).name, 'dirt');
    assert.equal(rig.world.calls.filter((call) => call.command === 'putInChest').length, 0, 'the goal went on past a step that was not done');
    assert.equal(rig.world.body('Arthur').inventory.oak_log, 5);
    assert.ok(rig.world.calls.some((call) => call.command === 'breakBlockAt' && call.cleanup && call.args.join() === '5,65,5'), 'the agent never tried to remove its scaffold');
    assert.equal(checkpointOf(rig).places.scaffold.length, 1, 'the checkpoint forgot the scaffold');
    assert.equal(rig.storage.changes.at(-1).reason, 'failed: scaffold_left_in_zone (goToPosition, step 1 of 2, 3 attempts)');

    // nothing else starts while the block stands; once it can be removed, the agent removes it and goes on
    await rig.seed('craft_item:oak_planks:1');
    assert.deepEqual(kinds(await rig.drain()), ['scaffold_pending']);
    rig.world.scaffold = null;
    rig.world.get(5, 65, 5).sticky = false;
    assert.deepEqual(kinds(await rig.drain()), ['goal_started', 'step_done', 'goal_completed', 'idle']);
    assert.equal(rig.world.get(5, 65, 5), null);
    assert.equal(rig.executor.stats().scaffold_tracked, 0);
});

test('scaffold the agent can remove is removed by the agent, and then the step counts', async () => {
    const rig = await started({ inventory: { oak_log: 5 }, position: { x: 30, y: 64, z: 30 } });
    rig.world.scaffold = (call) => (call.command === 'goToPosition' ? [{ x: 5, y: 65, z: 5 }, { x: 40, y: 65, z: 40 }] : []);
    await rig.seed('store_items:shared:oak_log');
    assert.deepEqual(kinds(await rig.drain()), ['goal_started', 'step_done', 'step_done', 'goal_completed', 'idle']);
    assert.equal(rig.world.get(5, 65, 5), null, 'the block in the camp is still there');
    assert.equal(rig.world.get(40, 65, 40).name, 'dirt', 'scaffolding outside the zones may stay');
    assert.deepEqual(rig.world.broken.map((block) => [block.x, block.y, block.z, block.by]), [[5, 65, 5, 'Arthur']]);
    const cleanup = rig.eventsOf('skill.started').filter((event) => event.data.cleanup === 'scaffold');
    assert.equal(cleanup.length, 1);
    assertEventsValid(rig);
});

test('placing a block never breaks an occupied cell, and a build only touches its plot', async () => {
    const rig = await started({ inventory: { oak_planks: 64 } });
    await rig.seed('build_blueprint:plot-1');
    assert.equal((await rig.executor.runOnce()).kind, 'goal_started');
    // someone puts a chest where the next cell goes, after the plan was made
    const target = rig.executor.plan().steps[0].args;
    rig.world.set(target[1], target[2], target[3], 'chest', { contents: { diamond: 3 } });
    const outcome = await rig.executor.runOnce();
    assert.deepEqual([outcome.kind, outcome.reason], ['goal_failed', 'cell_occupied']);
    assert.equal(rig.world.get(target[1], target[2], target[3]).name, 'chest');
    assert.deepEqual(rig.world.broken, []);
    assert.deepEqual(rig.world.calls, [], 'placeBlock was called for an occupied cell');
    assert.equal(rig.executor.plan(), null);

    // with the chest gone the build goes on; every block placed is inside the plot
    rig.world.set(target[1], target[2], target[3], 'air');
    await rig.seed('build_blueprint:plot-1');
    const done = await rig.drain();
    assert.equal(done.at(-2).kind, 'goal_completed');
    assert.equal(rig.world.placed.length, 12);
    assert.ok(rig.world.placed.every((block) => rig.zones.protectedAt(block) === 'plot:plot-1' && block.how === 'skill'));
    assert.deepEqual(rig.world.broken, []);
    assert.equal(rig.executor.stats().scaffold_tracked, 0, 'cells of the blueprint were taken for scaffolding');
    assert.deepEqual(rig.eventsOf('skill.progress').at(-1).data, { skill: 'build_blueprint', done: 14, total: 18, unit: 'matching cells', step: 11 });
});

test('only a gather step gets the permit to tunnel; every other walk is without one', async () => {
    const rig = await started({ inventory: { oak_log: 3, wheat: 3 } });
    await rig.seed('gather_blocks:oak_log:2');
    await rig.seed('store_items:shared:oak_log');
    await rig.seed('harvest_replant:field');
    await rig.drain();
    for (const call of rig.world.calls) {
        const gather_break = call.command === 'breakBlockAt' && !rig.zones.isProtected({ x: call.args[0], y: call.args[1], z: call.args[2] });
        assert.equal(Boolean(call.permit?.dig), gather_break, `${call.command} ${call.args}`);
        if (call.permit?.dig) {
            assert.equal(call.permit.dig({ x: 0, y: 64, z: 0 }), true, 'the permit lets a path dig in the camp');
            assert.equal(call.permit.dig({ x: 15, y: 63, z: 0 }), true, 'the permit lets a path dig in the field');
            assert.equal(call.permit.dig({ x: -40, y: 60, z: 0 }), false);
        }
    }
    // the harvest broke mature wheat in the field only, and sowed every plot again
    const harvested = rig.world.broken.filter((block) => block.name === 'wheat');
    assert.equal(harvested.length, 12);
    assert.ok(rig.world.broken.every((block) => block.name === 'wheat' || !rig.zones.isProtected(block)));
    assert.deepEqual(rig.eventsOf('skill.progress').at(-1).data, { skill: 'harvest_replant', done: 12, total: 12, unit: 'plots replanted', step: 35 });
    assert.equal(rig.world.placed.length, 0);
});

test('abandon and a replaced queue: the goal in hand is given up, the step that runs is not cut', async () => {
    const rig = await started({ inventory: { oak_log: 5 } });
    const goal = await rig.seed('gather_blocks:oak_log:4');
    await rig.executor.runOnce();
    await rig.executor.runOnce();
    // a new plan replaces the queue (what a planner reply does)
    const replaced = await rig.goals.setShortTerm('Arthur', [{ title: 'Store the logs', option_id: 'store_items:shared:oak_log' }],
        { reason: 'the planner chose again', source: 'planner', call_id: 'call-1' });
    rig.executor.noteGoals(replaced.goals.short_term, { source: 'planner', call_id: 'call-1' });
    const done = await rig.drain();
    assert.deepEqual(kinds(done), ['goal_abandoned', 'goal_started', 'step_done', 'step_done', 'goal_completed', 'idle']);
    assert.equal(done[0].goal_id, goal.id);
    const decision = rig.eventsOf('agent.decision').at(-1);
    assert.equal(decision.data.trigger, 'planner');
    assert.equal(decision.data.call_id, 'call-1');
    assert.equal(rig.storage.changes.at(-1).call_id, 'call-1', 'the completion lost the planner call it belongs to');

    // abandon(): the agent died
    await rig.seed('gather_blocks:oak_log:4');
    await rig.executor.runOnce();
    assert.equal(await rig.executor.abandon('died'), true);
    assert.equal(rig.executor.plan(), null);
    assert.deepEqual(await rig.queue(), []);
    assert.equal(rig.storage.changes.at(-1).reason, 'abandoned: died');
    assert.equal(await rig.executor.abandon('died'), false);
    assertEventsValid(rig);
});

test('a goal store that cannot be written does not make the agent do a finished goal again', async () => {
    const rig = await started({ inventory: { oak_log: 5 } });
    await rig.seed('store_items:shared:oak_log');
    await rig.executor.runOnce();
    await rig.executor.runOnce();
    await rig.executor.runOnce();
    rig.storage.failing = true; // the store goes down right before the goal is taken off the queue
    assert.equal((await rig.executor.runOnce()).kind, 'goal_completed');
    assert.equal((await rig.queue()).length, 1, 'only what is stored counts');
    assert.deepEqual(kinds([await rig.executor.runOnce(), await rig.executor.runOnce()]), ['idle', 'idle']);
    assert.equal(rig.world.calls.length, 2, 'the goal was carried out a second time');
    rig.storage.failing = false;
    await rig.executor.runOnce();
    assert.deepEqual(await rig.queue(), []);
});

test('run() keeps working on the clock until stop()', async () => {
    const rig = await started({ inventory: { oak_log: 5 } });
    rig.world.durations = () => 2000;
    const running = rig.executor.run();
    await rig.clock.advance(20 * 1000);
    assert.equal(rig.world.calls.length, 0);
    await rig.seed('store_items:shared:oak_log');
    rig.executor.wake();
    await rig.clock.advance(20 * 1000);
    assert.deepEqual(await rig.queue(), []);
    assert.equal(rig.world.calls.length, 2);
    // steps never start closer together than the gap
    const starts = rig.eventsOf('skill.started').map((event) => Date.parse(event.ts));
    assert.ok(starts[1] - starts[0] >= EXECUTOR_DEFAULTS.step_gap_ms);
    rig.executor.stop();
    await running;
    assert.equal(rig.clock.pending(), 0, 'a timer was left behind');
});
