// Step 9, the role routines and what an agent does while the model is silent.
//
// The four agents run their real runtime (executor, planner client, routine) against the
// stand-in world, with the real broker in its host and the gate AWAY: nothing here reaches
// the model stub, and the stub counts to prove it.
// Run from the repository root:  node --test genesis/tests/*.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeClock, settle } from './helpers/fakes.mjs';
import { makeTown } from './helpers/town.mjs';
import { WORLD_CONFIG } from './helpers/fake-world.mjs';
import { ROUTINES, routineFor, checkRoutineRanges, KIT_STOCK } from '../routines/routines.js';
import { createRoutine, ROUTINE_RULES, SHELTER } from '../routines/engine.js';
import { createZones } from '../catalog/zones.js';
import { createCatalog } from '../catalog/catalog.js';
import { createLedger } from '../catalog/ledger.js';
import { UPSTREAM_OPS } from '../catalog/ops.js';
import { validateEvent } from '../shared/events.js';
import { decodeCheckpoint } from '../store/checkpoint.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const KITS = {
    Arthur: { wooden_axe: 1, wooden_pickaxe: 1, bread: 4, crafting_table: 1, furnace: 1 }, // a table and a furnace to tempt upstream into placing them
    Mira: { wooden_hoe: 1, bread: 4 },
    Felix: { wooden_sword: 1, bread: 4 },
    Nova: { bread: 2 },
};
const NAMES = ['Arthur', 'Mira', 'Felix', 'Nova'];
const walking = (command, args, far) => (command === 'goToPosition' ? 500 + far * 250 : command === 'breakBlockAt' ? 1500 + far * 250 : 1000);

// A town whose model is away: the launcher said desktop_leaving.
async function awayTown(options = {}) {
    const t = makeTown({ clock: fakeClock(), inventories: KITS, ...options });
    await t.start({ available: false });
    await t.host.signal('desktop_leaving');
    t.world.durations = walking;
    return t;
}

const decisions = (agent) => agent.eventsOf('agent.decision').map((event) => event.data.args[0]);

test('the four routines are the decided ones: names, phases and ranges', () => {
    const table = Object.fromEntries(Object.entries(ROUTINES).map(([agent, routine]) => [agent, [routine.name, routine.phases.map((phase) => phase.name).join(', '), routine.range]]));
    assert.deepEqual(table, {
        Arthur: ['Site upkeep', 'Kit check, Gather, Craft, Stockpile, Shelter', 48],
        Mira: ['Field round', 'Kit check, Harvest, Bake, Stock, Shelter', 32],
        Felix: ['Ring patrol', 'Kit check, Patrol, Forage, Return, Unload, Shelter', 128],
        Nova: ['Stock round', 'Stocktake, Haul, Supply, Kits, Shelter', 32],
    });
    assert.deepEqual({ ...ROUTINE_RULES, idle_ms: 0, parked_idle_ms: 0, dusk_margin_ticks: 0, walk_ticks_per_block: 0 },
        { min_health: 10, min_food: 8, min_free_slots: 3, max_deaths: 2, avoid_radius: 24, idle_ms: 0, parked_idle_ms: 0, dusk_margin_ticks: 0, walk_ticks_per_block: 0 });
    assert.equal(routineFor('Stranger'), null);
    assert.deepEqual({ ...KIT_STOCK }, { bread: 8, torch: 8 });
    // the world config must give each agent the range its routine was decided for
    assert.deepEqual(checkRoutineRanges(createZones(WORLD_CONFIG)), []);
    const other = createZones({ ...WORLD_CONFIG, agents: { Arthur: { home: [0, 64, 0], range: 64 }, Mira: WORLD_CONFIG.agents.Mira, Felix: WORLD_CONFIG.agents.Felix } });
    assert.deepEqual(checkRoutineRanges(other), [
        'world config: agents.Arthur.range is 64, the routine "Site upkeep" was decided for 48 blocks',
        'world config: agents.Nova is missing (home and range)',
    ]);
});

test('with the gate AWAY for 8 hours every agent keeps choosing work, never leaves its range, and no routine step places a block', async () => {
    const t = await awayTown({ agents: NAMES });
    t.world.regrow_ms = 6 * MINUTE;
    // a second chest further out, so the merchant has something to haul
    t.run();
    const chosen_by_hour = Object.fromEntries(NAMES.map((name) => [name, []]));
    for (let hour = 0; hour < 8; hour++) {
        const before = Object.fromEntries(NAMES.map((name) => [name, t.agents[name].eventsOf('agent.decision').length]));
        await t.clock.advance(HOUR);
        for (const name of NAMES) chosen_by_hour[name].push(t.agents[name].eventsOf('agent.decision').length - before[name]);
    }

    assert.equal(t.model.requests.length, 0, 'a request reached the model');
    assert.equal(t.calls.length, 0);
    for (const name of NAMES) {
        const agent = t.agents[name];
        // work in every one of the eight hours
        assert.ok(chosen_by_hour[name].every((count) => count >= 3), `${name} chose ${JSON.stringify(chosen_by_hour[name])} goals per hour`);
        // every choice is the routine's, recorded as such, and is a catalog skill
        const made = agent.eventsOf('agent.decision');
        assert.ok(made.every((event) => event.data.trigger === 'routine'));
        const skills = new Set(made.map((event) => event.data.command));
        assert.ok(!skills.has('build_blueprint'), `${name} built from its routine`);
        assert.ok([...skills].every((skill) => ['travel', 'gather_blocks', 'craft_item', 'store_items', 'fetch_items', 'harvest_replant', 'smelt_item'].includes(skill)));
        const added = agent.changes().filter((change) => change.after.length > change.before.length);
        assert.equal(added.length, made.length);
        assert.ok(added.every((change) => change.source === 'routine' && new RegExp(`^routine ${ROUTINES[name].name}, `).test(change.reason)), 'a routine choice without source routine');
        // the range holds for every place the agent ever stood
        const furthest = Math.max(...t.world.trail.filter((spot) => spot.agent === name).map((spot) => t.zones.distanceFromHome(name, spot)));
        assert.ok(furthest <= ROUTINES[name].range + 1, `${name} was ${furthest.toFixed(1)} blocks from home, its range is ${ROUTINES[name].range}`);
        // one request waits at the broker, and it was sent once
        assert.equal(agent.socket.sent.filter(([event]) => event === 'genesis-plan-request').length, 1);
        assert.equal(agent.runtime.stats().routine.incidents, 0);
        for (const event of agent.events) assert.deepEqual(validateEvent(event).errors, []);
        assert.ok(agent.events.every((event, index) => index === 0 || event.seq === agent.events[index - 1].seq + 1));
    }
    // each agent did its own kind of work
    assert.ok(decisions(t.agents.Arthur).filter((id) => id.startsWith('gather_blocks:')).length >= 20);
    assert.ok(decisions(t.agents.Mira).filter((id) => id === 'harvest_replant:field').length >= 20);
    assert.ok(new Set(decisions(t.agents.Felix).filter((id) => id.startsWith('travel:ring-'))).size === 16, 'Felix did not walk the whole ring');
    assert.ok(decisions(t.agents.Nova).filter((id) => id.startsWith('store_items:kits:')).length >= 1, 'Nova never restocked the kit chest');

    // no block was placed by anyone: not on purpose, not as scaffolding, not a table or furnace put down by upstream
    assert.deepEqual(t.world.placed, []);
    const routine_calls = t.world.calls.filter((call) => !call.cleanup);
    assert.ok(routine_calls.length > 2000);
    assert.ok(routine_calls.every((call) => !UPSTREAM_OPS[call.command].places_blocks), 'a routine step called a skill that places blocks');
    assert.ok(routine_calls.every((call) => call.permit?.no_place === true), 'a routine step was allowed to place blocks while walking');
    // nothing inside a protected zone was broken, except mature wheat by the harvest
    const in_zones = t.world.broken.filter((block) => t.zones.isProtected(block));
    assert.ok(in_zones.length > 100 && in_zones.every((block) => block.name === 'wheat' && block.by === 'Mira' && t.zones.protectedAt(block) === 'field'));
    await t.stop();
});

test('a breached bound sends the agent straight to Shelter', async () => {
    const t = await awayTown({ agents: ['Arthur'] });
    const arthur = t.agents.Arthur;
    const body = t.world.body('Arthur');
    const routine = arthur.runtime.routine;
    t.run();
    await t.clock.advance(20 * SECOND);
    assert.equal(routine.phase(), 'Gather');
    assert.ok(t.zones.distanceFromHome('Arthur', body.position) > 15, 'the agent is out gathering');

    // health drops below 10: the next choice is the way home, and nothing else until it is better
    body.health = 9;
    await t.clock.advance(2 * MINUTE);
    assert.equal(routine.phase(), SHELTER);
    const after = decisions(arthur);
    assert.equal(after.at(-1), 'travel:home');
    assert.ok(t.zones.distanceFromHome('Arthur', body.position) <= 4);
    const count = after.length;
    await t.clock.advance(5 * MINUTE);
    assert.equal(decisions(arthur).length, count, 'the agent worked on while a bound was breached');
    assert.equal(routine.phase(), SHELTER);
    assert.ok(arthur.changes().at(-2).reason.includes('going home (health)'));

    // healed: the round starts again
    body.health = 20;
    await t.clock.advance(1 * MINUTE);
    assert.ok(decisions(arthur).length > count);
    assert.notEqual(routine.phase(), SHELTER);
    await t.stop();

    // each bound on its own, on the routine alone
    const zones = createZones(WORLD_CONFIG);
    const catalog = createCatalog({ zones });
    const clock = fakeClock();
    const world = (await import('./helpers/fake-world.mjs')).campWorld(clock);
    world.addAgent('Mira', { position: { x: 15, y: 64, z: 0 }, inventory: { wooden_hoe: 1, bread: 4 } });
    const mira = world.body('Mira');
    const ledger = createLedger();
    const state = () => ({ agent: 'Mira', view: world.view('Mira'), ledger, avoid: [] });
    const fresh = () => {
        Object.assign(mira, { health: 20, food: 20, inventory: { wooden_hoe: 1, bread: 4 }, position: { x: 15, y: 64, z: 0 } });
        return createRoutine({ agent: 'Mira', definition: ROUTINES.Mira, catalog, zones, clock });
    };
    assert.equal(fresh().next(state()).goal.option_id, 'harvest_replant:field', 'with every bound holding, the farmer farms');
    mira.food = 7;
    let routine2 = fresh();
    mira.food = 7;
    assert.deepEqual([routine2.next(state()).goal.option_id, routine2.phase()], ['travel:home', SHELTER]);
    routine2 = fresh();
    for (let i = 0; i < 34; i++) mira.inventory[`junk_${String(i).padStart(2, '0')}`] = 1; // 0 free slots
    const full = routine2.next(state());
    assert.deepEqual([full.goal.option_id, routine2.phase()], ['store_items:shared:junk_00', SHELTER], 'a full inventory is emptied into the shared chest');
    assert.match(full.reason, /the inventory is full/);
    routine2 = fresh();
    await clock.advance(9 * MINUTE); // dusk is near: less light than the margin and the walk home need
    assert.ok(world.view('Mira').dayTicksLeft() > 0);
    assert.deepEqual([routine2.next(state()).goal.option_id, routine2.phase()], ['travel:home', SHELTER]);
    // at home, at night: nothing to do but wait
    mira.position = { x: 0, y: 64, z: 0 };
    await clock.advance(2 * MINUTE);
    const waiting = routine2.next(state());
    assert.equal(waiting.goal, undefined);
    assert.match(waiting.why, /sheltering \(daylight\)/);
});

test('when the model returns the routine finishes its current step, saves its phase and yields', async () => {
    const t = await awayTown({ agents: ['Arthur'] });
    const arthur = t.agents.Arthur;
    t.world.durations = (command, args, far) => (command === 'breakBlockAt' ? 30 * SECOND : walking(command, args, far));
    t.run();
    await t.clock.advance(70 * SECOND);
    // the routine is in the middle of a gather: the third block is being broken
    const plan = arthur.runtime.executor.plan();
    assert.equal(plan.source, 'routine');
    assert.equal(plan.goal.option_id, 'gather_blocks:oak_log:8');
    assert.deepEqual(plan.steps.slice(0, 4).map((step) => step.status), ['done', 'done', 'active', 'pending']);
    const phase = arthur.runtime.routine.phase();
    assert.equal(phase, 'Gather');
    const breaks_before = t.world.broken.length;

    // the desktop comes back
    t.model.probe_ok = true;
    t.model.delay_ms = 40 * SECOND; // the reply comes after the step in hand has ended
    await t.host.signal('desktop_available');
    await settle();
    assert.equal(arthur.runtime.planner.gate(), 'AVAILABLE');
    assert.equal(arthur.runtime.executor.plan().steps[2].status, 'active', 'the step in hand was cut');
    await t.clock.advance(45 * SECOND);

    // the step that was running ended normally, and no further step of the routine goal was started
    const results = arthur.eventsOf('skill.result');
    assert.ok(results.every((event) => event.data.ok && !event.data.interrupted));
    assert.equal(t.world.broken.length, breaks_before + 1, 'the routine went on to its next step after the model returned');
    const yielded = arthur.eventsOf('agent.state').find((event) => event.data.state === 'routine_yielded');
    assert.deepEqual(yielded.data.detail, { goal_id: plan.goal.id, option_id: 'gather_blocks:oak_log:8', reason: 'the model is back', step: 3 });
    const gave_way = arthur.changes().find((change) => change.reason === 'routine yields: the model is back');
    assert.equal(gave_way.source, 'routine');
    assert.deepEqual(gave_way.before.map((g) => g.id), [plan.goal.id]);
    // the phase is kept, in the routine and in the checkpoint
    assert.equal(arthur.runtime.routine.phase(), phase);
    const checkpoint = decodeCheckpoint(t.files.store.get('/checkpoints/Arthur.checkpoint.json')).checkpoint;
    assert.deepEqual(checkpoint.routine, { name: 'Site upkeep', phase: 'Gather' });
    // back to planning: the request that waited went out, and its goal is what the agent does now
    assert.equal(t.model.requests.length, 1);
    assert.match(t.model.requests[0].messages[1].content, /Was on the routine "Site upkeep", phase Gather\./);
    const planned = arthur.eventsOf('agent.decision').at(-1);
    assert.equal(planned.data.trigger, 'planner');
    assert.equal(planned.data.call_id, t.calls[0].call_id);
    assert.equal(arthur.runtime.stats().routine.yields, 1);

    // a restart keeps the phase too
    await t.stop();
    const again = await t.join('Arthur', { last_seq: checkpoint.seq });
    assert.equal(again.runtime.routine.phase(), 'Gather');
});

test('deaths: the first sends the agent home for a kit and marks the place; the second parks it and opens one incident', async () => {
    const t = await awayTown({ agents: ['Arthur'] });
    const arthur = t.agents.Arthur;
    const routine = arthur.runtime.routine;
    t.world.get(-2, 64, 2).contents = { stone_axe: 1, stone_pickaxe: 1, bread: 6 }; // the kit chest
    t.world.regrow_ms = 3 * MINUTE;
    t.run();
    await t.clock.advance(15 * SECOND);
    assert.equal(arthur.runtime.executor.plan().goal.option_id, 'gather_blocks:oak_log:8');

    // ---- the first death, in the wood ----
    const first_death = t.world.kill('Arthur'); // respawned at home, with nothing
    assert.ok(Math.abs(first_death.x + 25) <= 3, 'the agent died in the wood');
    assert.equal(await arthur.runtime.died(first_death), 'restart');
    assert.equal(arthur.runtime.executor.plan(), null, 'the goal in hand was not given up');
    assert.equal(arthur.changes().at(-1).reason, 'abandoned: died');
    assert.deepEqual(routine.avoid(), [{ ...first_death, radius: 24 }]);
    assert.equal(routine.phase(), 'Kit check');
    const before = decisions(arthur).length;
    const calls_at_death = t.world.calls.length;
    await t.clock.advance(4 * MINUTE);
    const after_first = decisions(arthur).slice(before);
    // it looks into the kit chest, takes a kit, and goes back to work
    assert.deepEqual(after_first.slice(0, 4), ['travel:chest-kits', 'fetch_items:kits:stone_axe:1', 'fetch_items:kits:stone_pickaxe:1', 'fetch_items:kits:bread:4']);
    assert.ok(t.world.body('Arthur').inventory.stone_axe === 1);
    // the wood where it died is inside the 24 blocks to avoid: the logs there are left alone, it gathers stone instead
    assert.ok(!after_first.includes('gather_blocks:oak_log:8'), 'the agent went back to where it died');
    assert.ok(after_first.includes('gather_blocks:stone:8'));
    const broken_after = t.world.broken.filter((block) => block.name === 'oak_log').length;
    // (the camp itself is never avoided: home and the kit chest are there)
    const since_death = t.world.trail.slice(-(t.world.calls.length - calls_at_death));
    assert.ok(since_death.length >= 20);
    assert.ok(since_death.every((spot) => t.zones.protectedAt(spot) === 'camp' || Math.hypot(spot.x - first_death.x, spot.z - first_death.z) > 24),
        'the agent walked into the area to avoid');
    assert.equal(arthur.eventsOf('agent.failure').length, 0, 'one death is not an incident');

    // ---- the second death in the same away period ----
    const second_death = t.world.kill('Arthur');
    t.world.body('Arthur').position = { x: 30, y: 64, z: 30 }; // respawned away from home
    assert.equal(await arthur.runtime.died(second_death), 'parked');
    assert.equal(routine.isParked(), true);
    const parked_from = decisions(arthur).length;
    await t.clock.advance(30 * MINUTE);
    assert.deepEqual(decisions(arthur).slice(parked_from), ['travel:home'], 'a parked agent did something other than walk home');
    assert.ok(t.zones.distanceFromHome('Arthur', t.world.body('Arthur').position) <= 4);
    assert.equal(t.world.broken.filter((block) => block.name === 'oak_log').length, broken_after);
    // exactly one incident-level event
    const incidents = arthur.eventsOf('agent.failure');
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].severity, 'error');
    assert.equal(incidents[0].data.kind, 'incident');
    assert.equal(incidents[0].data.error, 'parked_after_second_death');
    assert.equal(incidents[0].data.deaths, 2);
    assert.deepEqual(validateEvent(incidents[0]), { ok: true, errors: [] });
    // a third death changes nothing and opens nothing new
    assert.equal(await arthur.runtime.died(t.world.kill('Arthur')), 'parked');
    await t.clock.advance(10 * MINUTE);
    assert.equal(arthur.eventsOf('agent.failure').length, 1);
    assert.equal(t.model.requests.length, 0);

    // ---- the model returns: the away period is over, the agent is no longer parked ----
    t.model.probe_ok = true;
    await t.host.signal('desktop_available');
    await t.clock.advance(1 * MINUTE);
    assert.equal(routine.isParked(), false);
    assert.equal(routine.deaths(), 0);
    assert.deepEqual(routine.avoid(), []);
    assert.equal(t.model.requests.length, 1);
    await t.stop();
});

test('no routine choice can place a block: the catalog is the only source, and building is never asked for', () => {
    const zones = createZones(WORLD_CONFIG);
    const asked = [];
    // a catalog that says yes to everything, to see everything a routine would ever ask for
    const yes = {
        config: {},
        option(skill, args) { asked.push(skill); return { ok: true, option: { id: `${skill}:${JSON.stringify(args)}`, skill, args, title: skill, description: skill } }; },
        candidates(skill) {
            asked.push(skill);
            return { store_items: [{ chest: 'shared', item: 'dirt' }, { chest: 'kits', item: 'dirt' }], fetch_items: [{ chest: 'far', item: 'dirt', count: 1 }] }[skill] ?? [];
        },
    };
    const clock = fakeClock();
    const ledger = createLedger();
    ledger.set('shared', { bread: 20, torch: 20 }, 0);
    const view = {
        position: () => ({ x: 20, y: 64, z: 20 }), health: () => 20, food: () => 20, freeSlots: () => 30, dayTicksLeft: () => 9000,
        inventory: () => ({ oak_log: 9, wheat: 9, dirt: 5 }),
    };
    for (const [agent, definition] of Object.entries(ROUTINES)) {
        const routine = createRoutine({ agent, definition, catalog: yes, zones, clock });
        const seen = new Set();
        for (let i = 0; i < 200; i++) {
            const choice = routine.next({ agent, view, ledger, avoid: [] });
            if (choice.goal) { seen.add(choice.routine.phase); routine.goalEnded({ option_id: choice.goal.option_id, outcome: 'completed' }); }
        }
        assert.ok(seen.size >= 3, `${agent} only ever worked in ${[...seen]}`);
    }
    assert.ok(asked.length > 500);
    assert.ok(!asked.includes('build_blueprint'), 'a routine asked to build');
    assert.deepEqual([...new Set(asked)].sort(), ['craft_item', 'fetch_items', 'gather_blocks', 'harvest_replant', 'store_items', 'travel']);
});
