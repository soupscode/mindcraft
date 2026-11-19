// The building step, part 2: the build template reads prefabs. Stages built in order, a door
// that is two cells and one item, a stone floor set into the ground, cells kept clear, the
// stage's bill in what is asked for, the ladder's lock, and an upgrade in place.
//
// No Minecraft server and no bot: the world is helpers/fake-world.mjs. Nothing here has been
// placed by a real bot (which way a door faces, whether a slab sits as the lower half).
// Run from the repository root:  node --test genesis/tests/*.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { REPO_ROOT } from './helpers/stubs.mjs';
import { fakeClock } from './helpers/fakes.mjs';
import { fakeWorld, WORLD_CONFIG, RECIPES } from './helpers/fake-world.mjs';
import { makeRig } from './helpers/rig.mjs';
import { createZones } from '../catalog/zones.js';
import { createCatalog } from '../catalog/catalog.js';
import { buildBlueprints } from '../catalog/blueprints.js';
import { CRAFT_ITEMS, GATHER_TYPES, CROPS } from '../catalog/defaults.js';
import { generateLadder } from '../build/ladder.js';
import { catalogObtainable, unobtainable, prefabCells, stageBills } from '../build/prefab.js';
import { surveyBuild, prefabOrigin, createVerifier, VERIFY_WAIT_MS } from '../build/verify.js';
import { checkWorldConfig } from '../world/world_config.js';

const PREFABS = buildBlueprints({ root: REPO_ROOT });
const LADDER = generateLadder();
const by_name = Object.fromEntries(LADDER.map((p) => [p.name, p]));
const PLOT_MIN = { x: -40, y: 64, z: 20 };
// one 16 by 16 plot for Arthur, 24 blocks from home (inside his 48)
const plotConfig = (blueprint, more = {}) => ({ ...WORLD_CONFIG, plots: [{ id: 'home-1', owner: 'Arthur', min: [-40, 64, 20], max: [-25, 77, 35], blueprint, ...more }] });
// zones whose plot also says what verified build stands on it (the town file does that: genesis/town)
function zonesWith(blueprint, built = null) {
    const zones = createZones(plotConfig(blueprint));
    const dress = (plot) => (plot ? { ...plot, built } : plot);
    return { ...zones, plots: () => zones.plots().map(dress), plot: (id) => dress(zones.plot(id)) };
}
// a flat world: a grass floor under the plot, nothing on it
function flatWorld(clock) {
    const world = fakeWorld({ clock });
    world.fill([-41, 63, 19], [-24, 63, 36], 'grass_block');
    world.set(2, 64, 2, 'chest', { contents: {} });
    return world;
}
function rigFor({ blueprint = 'shack', built = null, inventory = {}, building = undefined, world = null, clock = fakeClock() } = {}) {
    const rig = makeRig({ clock, world: world ?? flatWorld(clock), zones: zonesWith(blueprint, built), blueprints: PREFABS, inventory, position: { x: -30, y: 64, z: 18 }, more_state: () => (building ? { building } : {}) });
    rig.world.body('Arthur').inventory = { ...inventory };     // (a world handed in already has its Arthur)
    rig.reason = () => { const checked = rig.catalog.check('build_blueprint:home-1', rig.state()); return checked.ok ? null : checked.reason; };
    // builds until the catalog no longer offers the build; returns the placeBlock calls in order
    let begun = false;
    rig.build = async (max_goals = 80) => {
        if (!begun) { begun = true; await rig.executor.start(); }
        for (let i = 0; i < max_goals && rig.reason() === null; i++) { await rig.seed('build_blueprint:home-1'); await rig.drain(); }
        return rig.world.calls.filter((call) => call.command === 'placeBlock');
    };
    rig.survey = (name = blueprint) => surveyBuild({ prefab: PREFABS.get(name), origin: prefabOrigin(PLOT_MIN, PREFABS.get(name)), blockAt: rig.world.view('Arthur').blockAt });
    return rig;
}
const PLENTY = { oak_planks: 400, oak_log: 80, cobblestone: 300, oak_slab: 120, oak_door: 3, chest: 4, torch: 12, glass: 16, crafting_table: 2, furnace: 2, ladder: 8, oak_fence: 20, stone_pickaxe: 1 };

test('recipes: slab, fence and ladder in oak, birch and spruce are craft options, and exist in the game data', (t) => {
    const items = CRAFT_ITEMS.map(([item]) => item);
    for (const item of ['oak_slab', 'birch_slab', 'spruce_slab', 'oak_fence', 'birch_fence', 'spruce_fence', 'ladder', 'oak_door', 'birch_door', 'spruce_door']) assert.ok(items.includes(item), `${item} is not a craft option`);
    assert.equal(new Set(items).size, items.length, 'an item is listed twice');
    // with them every prefab of the ladder is buildable from what the catalog can get
    const today = catalogObtainable({ gather_types: GATHER_TYPES, craft_items: CRAFT_ITEMS, crops: CROPS });
    for (const prefab of LADDER) assert.deepEqual(unobtainable(prefab, today), [], prefab.name);
    const catalog = createCatalog({ zones: createZones(WORLD_CONFIG), blueprints: PREFABS });
    assert.deepEqual([catalog.obtainable('glass'), catalog.obtainable('oak_slab'), catalog.obtainable('oak_stairs')], [true, true, false]);
    assert.deepEqual(catalog.resolve('craft_item:oak_fence:1'), { skill: 'craft_item', args: { item: 'oak_fence', count: 1 } });
    // the fake world's recipes are the game's: what one making uses and gives
    let data;
    try {
        data = createRequire(path.join(REPO_ROOT, 'package.json'))('minecraft-data')(JSON.parse(readFileSync(path.join(REPO_ROOT, 'genesis', 'settings.json'), 'utf8')).minecraft_version);
    } catch (err) { t.diagnostic(`minecraft-data is not installed (${err.code ?? err.message}): the recipes were not checked against the game data`); return; }
    for (const [item, makes] of [['oak_slab', 6], ['birch_slab', 6], ['spruce_slab', 6], ['oak_fence', 3], ['birch_fence', 3], ['spruce_fence', 3], ['ladder', 3], ['oak_door', 3]]) {
        const recipes = data.recipes[data.itemsByName[item].id];
        assert.ok(Array.isArray(recipes) && recipes.length > 0, `${item} has no recipe in ${data.version.minecraftVersion}`);
        assert.equal(recipes[0].result.count, makes, item);
        if (RECIPES[item]) assert.equal(RECIPES[item].makes, makes, `the fake world's ${item}`);
    }
});

test('blueprint source: the eight prefab files, and the example\'s builder plot names the lean-to', () => {
    assert.deepEqual(PREFABS.names(), ['cabin', 'cottage', 'footbridge', 'hall', 'house', 'lean_to', 'shack', 'storehouse']);
    assert.equal(PREFABS.get('small_wood_house'), null, 'upstream\'s construction files are no longer what a plot may name');
    const example = JSON.parse(readFileSync(path.join(REPO_ROOT, 'genesis', 'genesis.world.example.json'), 'utf8'));
    assert.deepEqual(example.plots.map((plot) => [plot.id, plot.blueprint]), [['arthur-1', 'lean_to'], ['mira-1', null], ['felix-1', null], ['nova-1', null], ['spare-1', null]]);
    assert.deepEqual(checkWorldConfig(example, { blueprints: PREFABS }), []);
    // every home tier up to the cottage fits a 16 by 16 plot of the example's height; the stone floor lies under the plot
    for (const name of ['lean_to', 'shack', 'cabin', 'cottage', 'house']) {
        const config = JSON.parse(JSON.stringify(example));
        config.plots[0].blueprint = name;
        assert.deepEqual(checkWorldConfig(config, { blueprints: PREFABS }).map((p) => p.code), [], name);
    }
});

test('build: a shack goes up stage by stage, the door is one item for two cells, and the finished build verifies by name', async () => {
    const rig = rigFor({ blueprint: 'shack', inventory: { oak_planks: 59, oak_log: 12, oak_door: 1, chest: 1, torch: 1 } });
    assert.equal(rig.reason(), null);
    assert.match(rig.catalog.check('build_blueprint:home-1', rig.state()).option.description, /Build 12 more cells of shack on plot home-1 \(\d+\/\d+ done, stage Walls\)/);
    const placed = await rig.build();
    // in build order: every cell of a stage before the first of the next
    const stage_of = new Map(prefabCells(by_name.shack).map((c) => [`${PLOT_MIN.x + c.x},${PLOT_MIN.y + c.y},${PLOT_MIN.z + c.z}`, c.stage]));
    const order = placed.map((call) => stage_of.get(call.args.slice(1).join(',')));
    assert.deepEqual([...order].sort((a, b) => a - b), order, 'a cell of a later stage was placed before an earlier stage was done');
    assert.deepEqual([...new Set(order)], [0, 1, 2]);
    // one door item, placed once, at the lower cell: the upper half came with it
    const doors = placed.filter((call) => call.args[0] === 'oak_door');
    assert.equal(doors.length, 1);
    assert.equal(placed.length, 74, '75 cells, 74 placements');
    assert.deepEqual(rig.world.body('Arthur').inventory, {}, 'the bill is exactly what the build used');
    assert.equal(rig.reason(), 'already_built');
    const survey = rig.survey();
    assert.deepEqual([survey.complete, survey.matching, survey.total], [true, 75, 75]);
    // verified: twice, 60 seconds apart
    const verifier = createVerifier({ clock: rig.clock });
    assert.equal(verifier.check('b1', rig.survey()).state, 'first_pass');
    await rig.clock.advance(VERIFY_WAIT_MS);
    assert.equal(verifier.check('b1', rig.survey()).state, 'verified');
    // every placement was inside the plot, and the inside is clear
    assert.ok(placed.every((call) => rig.zones.protectedAt({ x: call.args[1], y: call.args[2], z: call.args[3] }) === 'plot:home-1'));
});

test('build: with materials for part of a stage the goal does what it can, and the later stage waits for the earlier', async () => {
    const rig = rigFor({ blueprint: 'shack', inventory: { oak_planks: 20, oak_door: 1, chest: 1, torch: 1 } });
    await rig.build();
    // planks go into the walls only; the roof (stage 2) is not started while the walls lack their logs, nor are the fittings
    const s = rig.catalog.buildSurvey('home-1', rig.state());
    // (the Walls stage: 46 cells to place and the 25 cells of the inside that are kept clear, which are clear already)
    assert.deepEqual([s.stage, s.stages.map((stage) => [stage.name, stage.matching, stage.total])], ['Walls', [['Walls', 20 + 25, 71], ['Roof', 0, 25], ['Fittings', 0, 4]]], 'only wall cells were placed');
    assert.deepEqual(s.stage_bill, { oak_log: 12, oak_planks: 14 });
    assert.equal(rig.reason(), 'missing_materials');
    assert.deepEqual(rig.world.body('Arthur').inventory, { oak_door: 1, chest: 1, torch: 1 }, 'door, chest and torch are kept for the last stage');
    // what the build needs of what the agent carries: the whole remaining bill (the message desk asks)
    assert.equal(rig.catalog.needOf('build_blueprint:home-1', 'oak_door', rig.state()), 1);
    assert.equal(rig.catalog.needOf('build_blueprint:home-1', 'oak_planks', rig.state()), 59 - 20);
});

test('build: what is asked of other agents is the bill of the stage the build is at, exactly the shortfall', () => {
    const talk = { open: 0, max_open: 2, sent: 0, max_sent: 10, spare: () => 0, waiting: () => false, repeated: () => false };
    const rig = rigFor({ blueprint: 'cabin', inventory: { cobblestone: 44, oak_planks: 3 } });
    const state = { ...rig.state(), talk };
    const asks = rig.catalog.candidates('ask_agent', state).filter((args) => args.to === 'Mira').map((args) => `${args.item}:${args.count}`);
    // the foundation is 49 cobblestone: 5 short. The walls' planks, the roof's slabs and the fittings are not asked for yet
    assert.equal(asks[0], 'cobblestone:5');
    assert.ok(!asks.slice(0, 1).some((ask) => /oak_slab|oak_door|glass/.test(ask)));
    const described = rig.catalog.option('ask_agent', { to: 'Mira', item: 'cobblestone', count: 5 }, state).option.description;
    assert.match(described, /Ask Mira for 5 cobblestone \(for plot home-1\)/);
    // with the foundation's stone in hand nothing of it is asked for; the next thing asked is still the foundation's, not the roof's
    const full = rigFor({ blueprint: 'cabin', inventory: { cobblestone: 49 } });
    assert.ok(!full.catalog.candidates('ask_agent', { ...full.state(), talk }).some((args) => args.item === 'cobblestone' && args.count > 4));
});

test('build: a cabin\'s stone floor is set into the ground under the plot, and that layer is the plot\'s', async () => {
    const rig = rigFor({ blueprint: 'cabin', inventory: { ...PLENTY } });
    const placed = await rig.build();
    const floor = placed.filter((call) => call.args[0] === 'cobblestone');
    assert.equal(floor.length, 49);
    assert.ok(floor.every((call) => call.args[2] === 63), 'the foundation lies one layer under the plot\'s floor');
    // the grass that lay there was cleared by the build (ground, never something built)
    assert.equal(rig.world.broken.filter((b) => b.name === 'grass_block' && b.y === 63).length, 49);
    assert.equal(rig.zones.protectedAt({ x: -40, y: 63, z: 20 }), 'plot:home-1', 'nobody mines a foundation away');
    assert.equal(rig.zones.protectedAt({ x: -40, y: 62, z: 20 }), null);
    assert.deepEqual([rig.survey('cabin').complete, rig.survey('cabin').total], [true, 174]);
    // 174 cells; the door is two of them
    assert.equal(placed.length, 173);
});

test('build: a foreign block stops the build and the verification, the ground and a stray torch do not', async () => {
    const clock = fakeClock();
    const world = flatWorld(clock);
    world.set(-40, 64, 20, 'dirt');             // ground where a wall goes: cleared
    world.set(-38, 64, 21, 'torch');            // the idle torch reflex left one inside: cleared
    const rig = rigFor({ blueprint: 'lean_to', inventory: { oak_planks: 33, chest: 1 }, world, clock });
    assert.equal(rig.reason(), null);
    world.set(-37, 65, 21, 'cobblestone');      // somebody built something inside
    assert.equal(rig.reason(), 'plot_not_natural');
    assert.deepEqual(rig.catalog.before('build_blueprint:home-1', { command: 'breakBlockAt', args: [-37, 65, 21] }, rig.state()), { fail: 'plot_not_natural' });
    assert.equal(rig.survey('lean_to').blocked.length, 2, 'the verification sees the torch and the stone where the inside must be clear');
    world.set(-37, 65, 21, 'air');
    await rig.build();
    assert.equal(rig.survey('lean_to').complete, true);
    assert.ok(rig.world.broken.some((b) => b.name === 'dirt') && rig.world.broken.some((b) => b.name === 'torch'));
    // a step outside the plot, or under its floor, is refused whatever the plan says
    assert.deepEqual(rig.catalog.before('build_blueprint:home-1', { command: 'placeBlock', args: ['oak_planks', -41, 64, 20] }, rig.state()), { fail: 'outside_plot' });
    assert.deepEqual(rig.catalog.before('build_blueprint:home-1', { command: 'placeBlock', args: ['oak_planks', -40, 63, 20] }, rig.state()), { fail: 'outside_plot' }, 'the lean-to has no layer in the ground');
});

test('ladder: a build may start once its tier is earned and the town holds the whole first stage; a started build goes on', async () => {
    const builds = [];
    const started = new Set();
    const building = { builds, ladder: LADDER, started: (plot, prefab) => started.has(`${plot}|${prefab}`) };
    // the shack's first stage: 12 logs and 34 planks. The builder carries part, the shared chest's ledger has the rest
    const rig = rigFor({ blueprint: 'shack', inventory: { oak_planks: 20, oak_log: 12 }, building });
    assert.equal(rig.reason(), 'town_short');
    assert.equal(rig.catalog.buildSurvey('home-1', rig.state()).lock.unlock.reason, 'Short 14 oak_planks');
    assert.ok(!rig.catalog.offer(rig.state()).some((option) => option.skill === 'build_blueprint'), 'a locked build is not offered');
    rig.ledger.set('shared', { oak_planks: 14 }, 0);
    assert.equal(rig.reason(), null, 'the shared chest and the builder together hold the first stage');
    // once started it goes on whatever the town holds
    started.add('home-1|shack');
    rig.ledger.set('shared', {}, 0);
    assert.equal(rig.reason(), null);

    // tier 2 needs a verified tier 1 build of the builder's own
    const cabin = rigFor({ blueprint: 'cabin', inventory: { ...PLENTY }, building });
    assert.equal(cabin.reason(), 'tier_locked');
    assert.equal(cabin.catalog.buildSurvey('home-1', cabin.state()).lock.unlock.reason, 'Needs Shack');
    builds.push({ builder: 'Mira', prefab: 'shack', tier: 1, verified_at: 5 });
    assert.equal(cabin.reason(), 'tier_locked', 'somebody else\'s shack does not count');
    builds.push({ builder: 'Arthur', prefab: 'shack', tier: 1, verified_at: 5 });
    assert.equal(cabin.reason(), null);
    // shared and bridge prefabs are Arthur's
    const mira = makeRig({ agent: 'Mira', clock: fakeClock(), world: flatWorld(fakeClock()), blueprints: PREFABS, inventory: { ...PLENTY }, position: { x: -30, y: 64, z: 18 },
        config: { ...WORLD_CONFIG, plots: [{ id: 'home-1', owner: null, min: [-28, 64, 2], max: [-13, 77, 17], blueprint: 'footbridge' }] }, more_state: () => ({ building }) });
    assert.equal(mira.catalog.check('build_blueprint:home-1', mira.state()).reason, 'not_your_build');
    // without the town's builds (a test rig, an older caller) there is no ladder to ask
    assert.equal(rigFor({ blueprint: 'cabin', inventory: { ...PLENTY } }).reason(), null);
});

test('upgrade in place: a lean-to becomes a shack on the same plot; the chest is never broken, what is taken down goes into the new build', async () => {
    const clock = fakeClock();
    const world = flatWorld(clock);
    const first = rigFor({ blueprint: 'lean_to', inventory: { oak_planks: 33, chest: 1 }, world, clock });
    await first.build();
    assert.equal(first.survey('lean_to').complete, true);
    world.get(-39, 64, 21).contents = { bread: 3 };       // the owner's things are in the chest

    // not marked as the owner's verified build: the standing lean-to is foreign to a shack
    const unmarked = rigFor({ blueprint: 'shack', inventory: {}, world, clock });
    assert.equal(unmarked.reason(), 'plot_not_natural');

    // the shack's bill is 59 planks, 12 logs, a door, a chest and a torch. The lean-to gives back the planks that are in the way
    const rig = rigFor({ blueprint: 'shack', built: 'lean_to', inventory: { oak_planks: 40, oak_log: 12, oak_door: 1, torch: 1 }, world, clock });
    assert.equal(rig.reason(), null);
    const before = rig.catalog.buildSurvey('home-1', rig.state());
    assert.ok(before.matching > 18, 'what already stands where the shack wants it counts as built');
    world.calls.length = 0;
    world.broken.length = 0;
    await rig.build();
    assert.deepEqual([rig.survey('shack').complete, rig.reason()], [true, 'already_built'], JSON.stringify([rig.catalog.buildSurvey('home-1', rig.state()), world.body('Arthur').inventory]));
    // the chest: never broken, never placed again, its contents untouched
    assert.equal(world.broken.filter((b) => b.name === 'chest').length, 0);
    assert.equal(world.calls.filter((call) => call.command === 'placeBlock' && call.args[0] === 'chest').length, 0);
    assert.deepEqual(world.get(-39, 64, 21).contents, { bread: 3 });
    // only the builder's own earlier work was taken down, and it was picked up again
    assert.ok(world.broken.length > 0 && world.broken.every((b) => b.name === 'oak_planks' && b.command === 'breakBlockAt'));
    assert.ok(world.calls.some((call) => call.command === 'pickupNearbyItems'));
    const used = 40 - (world.body('Arthur').inventory.oak_planks ?? 0);
    assert.ok(used < 59 - 18, `the recovered planks reduced the bill (${used} new planks used)`);
    // a foreign block still blocks an upgrade
    const again = rigFor({ blueprint: 'cabin', built: 'shack', inventory: { ...PLENTY }, world, clock });
    assert.equal(again.reason(), null);
    world.set(-37, 65, 22, 'cobblestone');
    assert.equal(again.reason(), 'plot_not_natural');
});

test('upgrade in place: every home tier upgrades to the next with the chest kept, and the result verifies', async () => {
    const clock = fakeClock();
    const world = flatWorld(clock);
    const homes = ['lean_to', 'shack', 'cabin', 'cottage'];
    let built = null;
    for (const name of homes) {
        const rig = rigFor({ blueprint: name, built, inventory: { ...PLENTY, chest: built ? 0 : 1 }, world, clock });
        world.broken.length = 0;
        await rig.build(120);
        assert.equal(rig.survey(name).complete, true, `${built ?? 'bare ground'} -> ${name}: ${JSON.stringify(rig.survey(name).wrong.slice(0, 2).map((w) => [w.want, w.have]))} ${rig.reason()}`);
        assert.equal(world.broken.filter((b) => b.name === 'chest').length, 0, `${name}: the chest was broken`);
        built = name;
    }
    assert.equal(stageBills(by_name.cottage).length, 4);
});
