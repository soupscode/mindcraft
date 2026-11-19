// What the second stage of the live run showed, and what was decided after it:
//   - on its routine an agent FLEES hostile mobs; on a goal the planner or the operator chose, upstream's behaviour stays
//   - the planner is told the time of day in plain words (a world stopped at time 1993 was planned for as if night came)
//   - a goal that could not be started any more is not a failure, and what just failed is not offered again
//   - a blueprint's "planks" and "log" are families: oak_planks, birch_log, ... count
//   - from empty hands the way to a first build leads through offered options only
//   - every planner call is recorded by default, and the status shows the last hour's count
//
// Stand-ins: the model, the world, the clock, the sockets (helpers/town.mjs). No bot, no server, no network.
// Run from the repository root:  node --test genesis/tests/*.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fakeClock, settle } from './helpers/fakes.mjs';
import { makeTown } from './helpers/town.mjs';
import { campWorld, WORLD_CONFIG } from './helpers/fake-world.mjs';
import { REPO_ROOT } from './helpers/stubs.mjs';
import { createZones } from '../catalog/zones.js';
import { createCatalog } from '../catalog/catalog.js';
import { createLedger } from '../catalog/ledger.js';
import { fileBlueprints } from '../catalog/blueprints.js';
import { isMember, memberHeld, ITEM_FAMILIES } from '../catalog/templates.js';
import { buildPlanContext, describeDaytime, describeTrigger } from '../planning/context.js';
import { PLANNER_CLIENT_DEFAULTS } from '../planning/agent_planner.js';
import { threatModes, installThreatModes, THREAT_MODES } from '../lib/threat_modes.js';
import { createBotView } from '../adapters/bot_world.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const read = (...parts) => readFileSync(path.join(REPO_ROOT, ...parts), 'utf8');
const promptOf = (request) => request.messages.map((message) => message.content).join('\n');
const goal = (option_id) => ({ option_id, title: `Do ${option_id}`.slice(0, 60), reason: 'the test chose it' });
const reply = (...ids) => ({ thought: 'One thing after the other.', goals: ids.map((id) => goal(id)) });

async function town(options = {}, { available = true } = {}) {
    const t = makeTown({ clock: fakeClock(), ...options });
    await t.start({ available });
    await settle();
    return t;
}

// ---- 4. the time of day, in plain words ------------------------------------------------------

test('time of day: at time 1993 the planner is told it is morning with most of the day ahead; a stopped clock is said to be stopped', () => {
    // what the live run's context said at time 1993: "Day, 8 min of light left." (true, and read as "night is near")
    assert.equal(describeDaytime({ light: 12000 - 1993, time_of_day: 1993 }), 'It is morning: plenty of daylight, dusk in about 8 min (a whole day of light lasts 10 min).');
    assert.equal(describeDaytime({ light: 12000 - 1993, time_of_day: 1993, stopped: true }), 'It is morning and the time does not move in this world: it will not get dark.');
    assert.equal(describeDaytime({ light: 6000, time_of_day: 6000 }), 'It is midday: plenty of daylight, dusk in about 5 min (a whole day of light lasts 10 min).');
    assert.equal(describeDaytime({ light: 2400, time_of_day: 9600 }), 'It is afternoon: dusk in about 2 min (a whole day of light lasts 10 min).');
    assert.equal(describeDaytime({ light: 600, time_of_day: 11400 }), 'It is dusk: dark in about 1 min.');
    assert.equal(describeDaytime({ light: 0, time_of_day: 18000 }), 'It is night: morning in about 5 min.');
    assert.equal(describeDaytime({ light: 0, time_of_day: 18000, stopped: true }), 'It is night and the time does not move in this world: it stays night.');
    // a view that only knows the light that is left (older stand-ins) still gets a true sentence
    assert.equal(describeDaytime({ light: 10007 }), 'It is morning: plenty of daylight, dusk in about 8 min (a whole day of light lasts 10 min).');

    // the bot's own clock, as mineflayer keeps it (lib/plugins/time.js: timeOfDay, doDaylightCycle)
    const bot = { time: { timeOfDay: 1993, doDaylightCycle: false, day: 0, isDay: true }, entity: { position: { x: 0, y: 64, z: 0 } }, health: 20, food: 20, inventory: { emptySlotCount: () => 36, items: () => [] }, game: { dimension: 'overworld' } };
    const view = createBotView(bot, { world: { getInventoryCounts: () => ({}) }, mc: {}, pf: {}, Vec3: function Vec3(x, y, z) { Object.assign(this, { x, y, z }); } });
    assert.deepEqual([view.timeOfDay(), view.daylightStopped(), view.dayTicksLeft()], [1993, true, 10007]);
    const context = buildPlanContext({ agent: 'Arthur', role: 'builder', trigger: { kind: 'model_returned' }, view, options: [] }).context;
    assert.match(context, /It is morning and the time does not move in this world: it will not get dark\./);
    assert.doesNotMatch(context, /min of light left|Night/);
    bot.time.doDaylightCycle = true;
    assert.match(buildPlanContext({ agent: 'Arthur', view, options: [] }).context, /It is morning: plenty of daylight, dusk in about 8 min \(a whole day of light lasts 10 min\)\./);
});

// ---- 5. a goal that cannot be carried out ---------------------------------------------------

const ask = (agent, trigger = { kind: 'goal_complete', detail: {} }) => {
    let answer = null;
    agent.runtime.planner.onContextRequest({ trigger }, (got) => { answer = got; });
    return { ...answer, ids: (answer.options ?? []).map((option) => option.id) };
};

test('store_items is offered only for what is held now; a goal of a reply that can no longer be started is left out, and is not a failure', async () => {
    const t = await town({ agents: ['Arthur'], inventories: { Arthur: { oak_log: 4 } } }, { available: false });
    const arthur = t.agents.Arthur;
    const body = t.world.body('Arthur');
    assert.ok(ask(arthur).ids.includes('store_items:shared:oak_log'));

    // what the live run showed: the call went out while the agent held the items; its routine stored them while the
    // model was thinking; the reply then named a goal that could not be started any more
    delete body.inventory.oak_log;
    assert.ok(!ask(arthur).ids.some((id) => id.startsWith('store_items:')), 'storing is offered for something that is not held');
    const outcome = await arthur.runtime.onPlanResult({ ok: true, call_id: 'call-1', reply: { thought: 'Tidy up, then look at the field.', goals: [goal('store_items:shared:oak_log'), goal('travel:field')] } });
    assert.deepEqual(outcome.added.map((queued) => queued.option_id), ['travel:field'], 'a goal that cannot be started was queued');
    assert.deepEqual(outcome.stale.map((left) => [left.option_id, left.reason]), [['store_items:shared:oak_log', 'not_held']]);
    assert.equal(arthur.runtime.planner.stats().stale, 1);
    const said = arthur.eventsOf('agent.state').filter((event) => event.data.state === 'goal_not_started');
    assert.deepEqual(said.map((event) => event.data.detail), [{ option_id: 'store_items:shared:oak_log', reason: 'not_held', source: 'planner', call_id: 'call-1' }]);
    assert.ok(arthur.changes().every((change) => !change.after.some((queued) => queued.option_id === 'store_items:shared:oak_log')), 'the goal went through the queue');
    await arthur.runtime.executor.runOnce();
    await arthur.runtime.executor.runOnce();
    assert.equal(arthur.eventsOf('skill.result').every((event) => event.data.ok), true);

    // it is not offered again for ten minutes, even when the routine has made the items again: the model is told why
    body.inventory.oak_log = 6;
    const next = ask(arthur);
    assert.ok(!next.ids.includes('store_items:shared:oak_log'), 'what could not be started a moment ago is offered again');
    assert.match(next.context, /^Not offered again until something changes: Do store_items:shared:oak_log \(could not be started: not_held\)\.$/m);
    await t.clock.advance(PLANNER_CLIENT_DEFAULTS.failed_memory_ms + SECOND);
    const later = ask(arthur);
    assert.ok(later.ids.includes('store_items:shared:oak_log'));
    assert.doesNotMatch(later.context, /Not offered again/);
    await t.stop();
});

test('a later goal of a reply whose turn comes too late is dropped at its start: said as "not started", never as failed', async () => {
    const t = await town({ agents: ['Arthur'], inventories: { Arthur: { oak_log: 4 } } }, { available: false });
    const arthur = t.agents.Arthur;
    // both can be started when the reply arrives; the first uses up what the second is about
    const outcome = await arthur.runtime.onPlanResult({ ok: true, call_id: 'call-1', reply: { thought: 'Planks, then store the logs.', goals: [goal('craft_item:oak_planks:4'), goal('store_items:shared:oak_log')] } });
    assert.deepEqual(outcome.added.map((queued) => queued.option_id), ['craft_item:oak_planks:4', 'store_items:shared:oak_log']);
    for (let i = 0; i < 6 && (await arthur.queue()).length > 0; i++) await arthur.runtime.executor.runOnce();
    assert.deepEqual(t.world.body('Arthur').inventory, { oak_planks: 16 });
    const dropped = arthur.eventsOf('agent.state').filter((event) => event.data.state === 'goal_dropped');
    assert.deepEqual(dropped.map((event) => [event.data.detail.option_id, event.data.detail.reason]), [['store_items:shared:oak_log', 'not_held']]);
    assert.deepEqual(arthur.runtime.executor.lastOutcome().outcome, 'dropped');
    assert.ok(arthur.changes().some((change) => change.reason === 'dropped before starting: not_held'));
    assert.ok(arthur.eventsOf('skill.result').every((event) => event.data.ok), 'a skill was run for a goal that could not be started');
    assert.equal(arthur.eventsOf('incident').length, 0);
    // what the planner is told: not started, and why. Nowhere "failed".
    const told = ask(arthur, { kind: 'goal_complete', detail: { outcome: 'dropped', reason: 'not_held', option_id: 'store_items:shared:oak_log' } });
    assert.match(told.context, /^Asked because: a goal ended \(store_items:shared:oak_log, not started\)\.$/m);
    assert.match(told.context, /^Last goal: Do store_items:shared:oak_log: not started, it was no longer possible \(not_held\)\.$/m);
    assert.match(told.context, /^Not offered again until something changes: Do store_items:shared:oak_log \(could not be started: not_held\)\.$/m);
    assert.doesNotMatch(told.context, /failed|dropped/);
    assert.equal(describeTrigger({ kind: 'goal_complete', detail: { outcome: 'failed', option_id: 'travel:field' } }), 'a goal ended (travel:field, failed).');
    await t.stop();
});

test('an option that just failed for a reason that has not changed is not offered in the next call, and the model is told what failed and why', async () => {
    const t = await town({ agents: ['Arthur'], inventories: { Arthur: { oak_log: 5, oak_planks: 3 } } }, { available: false });
    const arthur = t.agents.Arthur;
    const body = t.world.body('Arthur');
    body.position = { x: 20, y: 64, z: 20 };
    assert.deepEqual(ask(arthur).ids.filter((id) => id.startsWith('store_items:')), ['store_items:shared:oak_log', 'store_items:shared:oak_planks']);

    // the walk to the chest fails three times: the goal is parked as failed
    t.world.fail = (call) => (call.command === 'goToPosition' ? { output: 'no_safe_path: there is no way to the goal without breaking blocks. Not digging.' } : null);
    const pushed = await arthur.runtime.goals.pushShortTerm('Arthur', { title: 'Store the logs', option_id: 'store_items:shared:oak_log' }, { reason: 'the operator asked', source: 'operator' });
    arthur.runtime.executor.noteGoals(pushed.goals.short_term, { source: 'operator' });
    for (let i = 0; i < 4; i++) await arthur.runtime.executor.runOnce();
    assert.equal(arthur.runtime.executor.lastOutcome().outcome, 'failed');
    t.world.fail = null;
    assert.deepEqual(arthur.runtime.planner.recentFailures(), ['store_items:shared:oak_log']);

    // the next call: that option is gone, the other store option is still there, and one line says what failed and why
    const next = ask(arthur);
    assert.deepEqual(next.ids.filter((id) => id.startsWith('store_items:')), ['store_items:shared:oak_planks']);
    assert.match(next.context, /^Not offered again until something changes: Store the logs \(failed: no_safe_path\)\.$/m);
    assert.equal(arthur.runtime.planner.stats().withheld, 1);
    // gathering more does not bring it back (the reason was the way there, not the items) ...
    body.inventory.oak_log = 9;
    assert.ok(!ask(arthur).ids.includes('store_items:shared:oak_log'));
    // ... standing somewhere else does: what the reason depends on has changed
    body.position = { x: 0, y: 64, z: 0 };
    const moved = ask(arthur);
    assert.ok(moved.ids.includes('store_items:shared:oak_log'));
    assert.doesNotMatch(moved.context, /Not offered again/);

    // a reason about items is forgotten when the count of that item changes, or after ten minutes
    arthur.runtime.planner.noteFailure('store_items:shared:oak_planks', 'chest_full', 'Store oak_planks in the shared chest');
    assert.ok(!ask(arthur).ids.includes('store_items:shared:oak_planks'));
    body.position = { x: 30, y: 64, z: 30 };
    assert.ok(!ask(arthur).ids.includes('store_items:shared:oak_planks'), 'a reason about items was forgotten because the agent moved');
    body.inventory.oak_planks = 7;
    assert.ok(ask(arthur).ids.includes('store_items:shared:oak_planks'));
    arthur.runtime.planner.noteFailure('store_items:shared:oak_planks', 'chest_full', 'Store oak_planks in the shared chest');
    await t.clock.advance(PLANNER_CLIENT_DEFAULTS.failed_memory_ms + SECOND);
    assert.ok(ask(arthur).ids.includes('store_items:shared:oak_planks'));
    // a goal of the routine that fails is the routine's business: nothing is withheld from the planner for it
    assert.match(read('genesis', 'agent', 'runtime.js'), /end\.source !== 'routine'\) planner\.noteFailure/);
    await t.stop();
});

// ---- 5c. a family matches its members -------------------------------------------------------

// upstream's shipped house (src/agent/npc/construction/small_wood_house.json): 5 by 4 by 7, "planks" and "log"
const UPSTREAM_BLUEPRINTS = fileBlueprints(path.join(REPO_ROOT, 'src', 'agent', 'npc', 'construction'));
const HOUSE_CONFIG = { ...WORLD_CONFIG, plots: [{ id: 'plot-1', owner: 'Arthur', min: [-20, 64, 12], max: [-16, 67, 18], blueprint: 'small_wood_house' }] };

function catalogSetup({ inventory = {}, config = HOUSE_CONFIG, blueprints = UPSTREAM_BLUEPRINTS } = {}) {
    const clock = fakeClock();
    const world = campWorld(clock);
    world.addAgent('Arthur', { position: { x: 0, y: 64, z: 0 }, inventory });
    const zones = createZones(config);
    const catalog = createCatalog({ zones, blueprints });
    const ledger = createLedger();
    const state = () => ({ agent: 'Arthur', view: world.view('Arthur'), ledger, avoid: [] });
    return { world, zones, catalog, state, offer: () => catalog.offer(state()), reason: (id) => { const checked = catalog.check(id, state()); return checked.ok ? null : checked.reason; } };
}

test('item families: a blueprint\'s "planks" and "log" are met by oak_planks, birch_log and every other member, wherever an item is matched', () => {
    // upstream's own rule (blockSatisfied, src/agent/npc/utils.js) and its families (MATCHING_WOOD_BLOCKS, src/utils/mcdata.js)
    assert.match(read('src', 'agent', 'npc', 'utils.js'), /mc\.MATCHING_WOOD_BLOCKS\.includes\(target_name\)\) \{\s*return block\.name\.endsWith\(target_name\);/);
    const upstream = /export const MATCHING_WOOD_BLOCKS = \[([^\]]+)\]/.exec(read('src', 'utils', 'mcdata.js'))[1].match(/'[a-z_]+'/g).map((name) => name.slice(1, -1));
    assert.deepEqual(Object.keys(ITEM_FAMILIES), [...upstream, 'bed']);
    const house = UPSTREAM_BLUEPRINTS.get('small_wood_house').blocks.flat(2);
    assert.deepEqual([house.filter((name) => name === 'planks').length, house.filter((name) => name === 'log').length], [55, 8], 'upstream\'s house no longer names the families');

    assert.deepEqual(['oak_planks', 'birch_planks', 'planks', 'oak_log', 'stick', 'oak_plank'].map((name) => isMember('planks', name)), [true, true, true, false, false, false]);
    assert.deepEqual(['birch_log', 'stripped_oak_log', 'oak_planks', 'logs'].map((name) => isMember('log', name)), [true, true, false, false]);
    assert.deepEqual([isMember('door', 'oak_door'), isMember('door', 'oak_trapdoor'), isMember('fence', 'oak_fence_gate'), isMember('stone', 'cobblestone'), isMember('bed', 'red_bed')], [true, false, false, false, true]);
    assert.equal(memberHeld({ oak_planks: 3, birch_planks: 9, birch_log: 2 }, 'planks'), 'birch_planks', 'the member held most stands for the family');
    assert.equal(memberHeld({ oak_planks: 3 }, 'log'), null);
    assert.equal(memberHeld({ torch: 2 }, 'torch'), 'torch');

    // before: missing_materials whatever the agent held (the names were compared as text). Seen on the live run.
    const none = catalogSetup({ inventory: {} });
    assert.equal(none.reason('build_blueprint:plot-1'), 'missing_materials');
    const h = catalogSetup({ inventory: { birch_planks: 12, birch_log: 2 } });
    assert.equal(h.reason('build_blueprint:plot-1'), null);
    assert.ok(h.offer().some((option) => option.id === 'build_blueprint:plot-1'));
    const steps = h.catalog.plan(h.catalog.check('build_blueprint:plot-1', h.state()).option, h.state()).steps.filter((step) => step.command === 'placeBlock');
    assert.ok(steps.length > 0 && steps.every((step) => ['birch_planks', 'birch_log'].includes(step.args[0])), 'a family name was handed to placeBlock');
    assert.ok(steps.some((step) => step.args[0] === 'birch_planks'));
    // (one batch of cells at a time, lowest layer first: with only logs in hand, the "log" cells are what is placed)
    const logs = catalogSetup({ inventory: { birch_log: 3 } });
    const log_steps = logs.catalog.plan(logs.catalog.check('build_blueprint:plot-1', logs.state()).option, logs.state()).steps.filter((step) => step.command === 'placeBlock');
    assert.ok(log_steps.length > 0 && log_steps.every((step) => step.args[0] === 'birch_log'));
    // a cell that holds another member of the family already matches: it is not built again
    const [item, x, y, z] = steps.find((step) => step.args[0] === 'birch_planks').args;
    h.world.set(x, y, z, 'spruce_planks');
    assert.deepEqual(h.catalog.before('build_blueprint:plot-1', { command: 'placeBlock', args: [item, x, y, z] }, h.state()), { skip: 'already_matches' });
    // what the build is short of is asked for by a member the catalog knows, and what is held of the family counts
    const asks = none.catalog.offer({ ...none.state(), talk: { open: 0, max_open: 3, sent: 0, max_sent: 6, spare: () => 0, waiting: () => false, repeated: () => false } }).filter((option) => option.skill === 'ask_agent').map((option) => option.id);
    assert.ok(asks.some((id) => /^ask_agent:[A-Za-z]+:oak_planks:8$/.test(id)), asks.join(' '));
    assert.ok(!asks.some((id) => /:planks:|:log:/.test(id)), 'a family name was asked for');
});

// ---- 6. from empty hands to a first build ---------------------------------------------------

test('first build: from an empty inventory the offered options alone lead to the build (gather, then craft, each labelled as being for the build)', async () => {
    // what must be true for build_blueprint to be offered (genesis/catalog/templates.js, build_blueprint.check):
    // a registered plot, the agent's own (or nobody's), that overlaps no zone and lies in the agent's range, with a
    // blueprint that fits; every cell loaded; nothing built in the way; work left; and AT LEAST ONE material in hand
    const t = await town({ agents: ['Arthur'], config: HOUSE_CONFIG, blueprints: UPSTREAM_BLUEPRINTS, inventories: { Arthur: {} } }, { available: false });
    const arthur = t.agents.Arthur;
    const body = t.world.body('Arthur');
    t.world.regrow_ms = 30 * SECOND;
    const chosen = [];
    let build_placed = 0;
    const placedInPlot = () => t.world.placed.filter((block) => block.by === 'Arthur' && t.zones.protectedAt(block) === 'plot:plot-1');
    for (let round = 0; round < 12 && build_placed < 20; round++) {
        const offered = ask(arthur);
        const options = offered.options;
        const build = options.find((option) => option.id === 'build_blueprint:plot-1');
        // the model's part, played by the test: the build when it is offered; else what the context says is for the build
        // (crafting before gathering more), and nothing that is not on the list
        const labelled = options.filter((option) => option.description.startsWith('For your build: '));
        const pick = build ?? labelled.find((option) => option.id.startsWith('craft_item:')) ?? labelled.find((option) => option.id.startsWith('gather_blocks:')) ?? null;
        assert.ok(pick, `round ${round}: neither the build nor anything leading to it is offered (carrying ${JSON.stringify(body.inventory)}): ${options.map((option) => option.id).join(' ')}`);
        chosen.push(pick.id);
        const outcome = await arthur.runtime.onPlanResult({ ok: true, call_id: `call-${round}`, reply: reply(pick.id) });
        assert.deepEqual(outcome.added.map((queued) => queued.option_id), [pick.id]);
        for (let i = 0; i < 400 && (await arthur.queue()).length > 0; i++) await arthur.runtime.executor.runOnce();
        assert.equal((await arthur.queue()).length, 0, `${pick.id} did not end`);
        await t.clock.advance(40 * SECOND);
        build_placed = placedInPlot().length;
    }
    // empty hands -> logs (for the build) -> the build is offered as soon as one material is held
    assert.equal(chosen[0], 'gather_blocks:oak_log:8');
    assert.ok(chosen.indexOf('build_blueprint:plot-1') > 0, chosen.join(' -> '));
    assert.ok(chosen.includes('craft_item:oak_planks:4'), `planks were never crafted for the build: ${chosen.join(' -> ')}`);
    const placed = placedInPlot();
    assert.ok(placed.some((block) => block.name === 'oak_log') && placed.some((block) => block.name === 'oak_planks'), 'the house\'s "log" and "planks" cells were not built with what the agent held');
    assert.ok(placed.length >= 20, `${placed.length} blocks of the house stand`);
    assert.ok(arthur.eventsOf('skill.result').every((event) => event.data.ok), 'a step failed on the way');
    console.log(`    from empty hands to the house: ${chosen.join(' -> ')}; ${placed.length} blocks placed`);
    await t.stop();
});

// ---- 1. hostile mobs: fled from on the routine, upstream's behaviour on a planner goal ------

// upstream's two threat modes as its update loop runs them (src/agent/modes.js 147-176: cowardice first, within 16
// blocks; then self_defense, within 8), with upstream's defaults (profiles/defaults/_default.json)
function upstreamModes({ cowardice = false, self_defense = true } = {}) {
    const on = { cowardice, self_defense, unstuck: true, torch_placing: true };
    const did = [];
    const switched = [];
    return {
        did, switched,
        isOn: (name) => on[name],
        setOn: (name, value) => { on[name] = value; switched.push([name, value]); },
        // a hostile mob at this distance, with a clear path to it
        hostileAt(distance) {
            if (on.cowardice && distance <= 16) { did.push('flee'); return 'flee'; }
            if (on.self_defense && distance <= 8) { did.push('attack'); return 'attack'; }
            return null;
        },
    };
}

test('hostile mobs: what upstream\'s two modes do is what this relies on, and only those two are switched', () => {
    const modes = read('src', 'agent', 'modes.js');
    assert.match(modes, /name: 'cowardice',[\s\S]{0,400}?mc\.isHostile\(entity\), 16\);[\s\S]{0,300}?await skills\.avoidEnemies\(agent\.bot, 24\);/);
    assert.match(modes, /name: 'self_defense',[\s\S]{0,400}?mc\.isHostile\(entity\), 8\);[\s\S]{0,300}?await skills\.defendSelf\(agent\.bot, 8\);/);
    assert.ok(modes.indexOf("name: 'cowardice'") < modes.indexOf("name: 'self_defense'"), 'upstream no longer asks cowardice first');
    assert.match(modes, /setOn\(mode_name, on\) \{\s*modes_map\[mode_name\]\.on = on;\s*\}\s*isOn\(mode_name\) \{\s*return modes_map\[mode_name\]\.on;/);
    // a mob behind the closed fence is no clear path (no door or gate is opened by that search): the agent in the camp stays
    assert.match(read('src', 'agent', 'library', 'world.js'), /export async function isClearPath[\s\S]{0,500}?movements\.canOpenDoors = false;/);
    const defaults = JSON.parse(read('profiles', 'defaults', '_default.json')).modes;
    assert.deepEqual([defaults.cowardice, defaults.self_defense], [false, true]);
    assert.deepEqual([...THREAT_MODES], ['cowardice', 'self_defense']);

    const upstream = { cowardice: false, self_defense: true };
    // on a goal the planner or the operator chose: exactly what the profile has
    assert.deepEqual(threatModes({ on_routine: false, home_distance: 5, range: 48, upstream }), upstream);
    assert.deepEqual(threatModes({ on_routine: false, upstream: { cowardice: true, self_defense: false } }), { cowardice: true, self_defense: false });
    // on the routine: flee, never fight
    assert.deepEqual(threatModes({ on_routine: true, home_distance: 5, range: 48, upstream }), { cowardice: true, self_defense: false });
    assert.deepEqual(threatModes({ on_routine: true, home_distance: 48, range: 48, upstream }), { cowardice: true, self_defense: false });
    // further from home than its range: fleeing stops (the walk home is not cut short again and again); what reaches the agent is met as the profile has it
    assert.deepEqual(threatModes({ on_routine: true, home_distance: 49, range: 48, upstream }), { cowardice: false, self_defense: true });
});

test('hostile mobs: on a routine goal the agent flees and does not attack; on a planner goal upstream decides; the switch follows the model leaving and returning', async () => {
    const t = await town({ agents: ['Arthur'], inventories: { Arthur: { wooden_axe: 1, bread: 4 } } }, { available: false });
    const arthur = t.agents.Arthur;
    const body = t.world.body('Arthur');
    t.world.durations = (command) => (command === 'breakBlockAt' ? 20 * SECOND : 2 * SECOND);
    const modes = upstreamModes();
    const bot = { modes, once: () => {} };
    const threat = installThreatModes(bot, {
        onRoutine: () => arthur.runtime.onRoutine(), timers: t.clock,
        homeDistance: () => t.zones.distanceFromHome('Arthur', body.position), range: t.zones.range('Arthur'),
    });
    assert.deepEqual(threat.upstream, { cowardice: false, self_defense: true }, 'what the profile had was not remembered');

    // the model is away: the agent works from its routine
    t.run();
    await t.clock.advance(70 * SECOND);
    assert.equal(arthur.runtime.executor.plan().source, 'routine');
    assert.equal(arthur.runtime.onRoutine(), true);
    assert.deepEqual(threat.current(), { cowardice: true, self_defense: false });
    // a hostile within range: it flees, and nothing is attacked, however near the mob is
    assert.deepEqual([modes.hostileAt(12), modes.hostileAt(6), modes.hostileAt(2)], ['flee', 'flee', 'flee']);
    assert.ok(!modes.did.includes('attack'));
    assert.deepEqual([modes.isOn('unstuck'), modes.isOn('torch_placing')], [true, true], 'an idle reflex was switched');

    // it fled further than its range: fleeing stops until it is back inside (the routine walks it home)
    const stood = { ...body.position };
    body.position = { x: 60, y: 64, z: 0 };
    await t.clock.advance(1 * SECOND);
    assert.deepEqual(threat.current(), { cowardice: false, self_defense: true });
    body.position = stood;
    await t.clock.advance(1 * SECOND);
    assert.deepEqual(threat.current(), { cowardice: true, self_defense: false });

    // the model returns and chooses a goal: from then on upstream's own behaviour, unchanged
    modes.did.length = 0;
    t.model.probe_ok = true;
    t.model.replies.push((request, ids) => reply(ids.find((id) => id.startsWith('gather_blocks:')) ?? ids[0]));
    await t.host.signal('desktop_available');
    await t.clock.advance(60 * SECOND);
    const plan = arthur.runtime.executor.plan();
    assert.equal(plan?.source, 'model', 'the planner\'s goal is not in hand'); // (the plan's source is "model" or "routine")
    assert.equal(arthur.runtime.onRoutine(), false);
    assert.deepEqual(threat.current(), { cowardice: false, self_defense: true });
    assert.deepEqual([modes.hostileAt(12), modes.hostileAt(6)], [null, 'attack'], 'upstream\'s behaviour on a planner goal was changed');

    // the model leaves: once the planner's goals are done the agent is on its routine again, and flees again
    modes.did.length = 0;
    await t.host.signal('desktop_leaving');
    await t.clock.advance(6 * MINUTE);
    assert.equal(arthur.runtime.planner.modelAvailable(), false);
    assert.equal(arthur.runtime.onRoutine(), true);
    assert.deepEqual(threat.current(), { cowardice: true, self_defense: false });
    assert.equal(modes.hostileAt(6), 'flee');
    assert.ok(!modes.did.includes('attack'));
    // every switch was one of the two threat modes
    assert.ok(modes.switched.length >= 6 && modes.switched.every(([name]) => THREAT_MODES.includes(name)));
    assert.equal(threat.stats().errors, 0);

    // an agent whose profile already has cowardice on keeps it on a planner goal: the profile is put back, not a default
    const timid = upstreamModes({ cowardice: true, self_defense: false });
    let routine = false;
    const other = installThreatModes({ modes: timid, once: () => {} }, { onRoutine: () => routine, timers: t.clock });
    assert.deepEqual(other.current(), { cowardice: true, self_defense: false });
    assert.equal(timid.switched.length, 0);
    routine = true;
    other.look();
    assert.deepEqual(other.current(), { cowardice: true, self_defense: false });
    threat.stop();
    other.stop();
    await t.stop();
});

// ---- 7. planner calls are recorded by default ------------------------------------------------

test('call records: the agents get the database address by default, up.sh checks it, and the status shows the last hour\'s count', () => {
    // compose builds the address from the one password the env file must hold; nothing else has to be set
    const compose = read('genesis', 'compose.agents.yaml');
    assert.match(compose, /GENESIS_DATABASE_URL: "\$\{GENESIS_AGENTS_DATABASE_URL:-\$\{GENESIS_POSTGRES_PASSWORD:\+postgres:\/\/genesis:\$\{GENESIS_POSTGRES_PASSWORD\}@postgres:5432\/genesis\}\}"/);
    const up = read('genesis', 'up.sh');
    assert.match(up, /dc agents run --rm --no-deps -T agents sh -c 'test -n "\$GENESIS_DATABASE_URL"' > \/dev\/null 2>&1 \\\n\s+\|\| check_failed "the agents' container is given GENESIS_DATABASE_URL/);
    assert.doesNotMatch(up, /echo[^\n]*\$GENESIS_DATABASE_URL/, 'the address (it holds the password) is printed');
    const status = read('genesis', 'status.sh');
    assert.match(status, /echo "Planner calls:    \$\(dc dashboard exec -T postgres psql -U genesis -d genesis -tAc "SELECT count\(\*\) \|\| ' recorded in the last hour' FROM planner_calls WHERE recorded_at > now\(\) - interval '1 hour'"/);
    // the table and the column the status reads are the ones the agents write
    assert.match(read('genesis', 'store', 'migrations', '001_planner_calls.sql'), /CREATE TABLE IF NOT EXISTS planner_calls \([\s\S]*recorded_at\s+timestamptz NOT NULL DEFAULT now\(\)/);
});

// ---- 10. the plugins' versions do not float -------------------------------------------------

test('plugins: every Modrinth entry names its exact version, and none can be changed from the env file', () => {
    const compose = read('genesis', 'compose.minecraft.yaml');
    const block = /MODRINTH_PROJECTS: \|\n((?:\s{8}\S.*\n)+)/.exec(compose)[1];
    const entries = block.trim().split('\n').map((line) => line.trim());
    assert.deepEqual(entries, ['worldedit:7.4.6', 'skinsrestorer:15.12.6']);
    for (const entry of entries) assert.match(entry, /^[a-z0-9-]+:\d+\.\d+\.\d+$/, `${entry} does not name an exact version`);
    assert.doesNotMatch(block, /\$\{|latest|beta|alpha/);
    // nothing else of that image picks a version on its own
    assert.doesNotMatch(compose, /^\s+(MODRINTH_DEFAULT_VERSION_TYPE|MODRINTH_ALLOWED_VERSION_TYPE|PLUGINS|SPIGET_RESOURCES|MODRINTH_MODPACK):/m);
    assert.match(compose, /^\s+VERSION: "1\.21\.6"$/m);
});
