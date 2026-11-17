// Step 7, the action catalog: the zones, the chest ledger, the eight skill templates and
// the pathing permit that lets a gather step tunnel (never inside a protected zone).
//
// The world is the stand-in of helpers/fake-world.mjs; no bot, no model, no network.
// Run from the repository root:  node --test genesis/tests/*.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeClock } from './helpers/fakes.mjs';
import { campWorld, WORLD_CONFIG, HUT } from './helpers/fake-world.mjs';
import { fakeBot, OPEN, WALLED, pos } from './helpers/fake-pathfinder.mjs';
import { createZones, checkZonesConfig, loadZones, PATROL_RING, ZONES_FILE } from '../catalog/zones.js';
import { createCatalog } from '../catalog/catalog.js';
import { createLedger, parseChestView } from '../catalog/ledger.js';
import { UPSTREAM_OPS, OP_NAMES, LOCAL_OPS, STEP_NAMES, MESSAGE_STEP, classifyFailure, EMPTY_BLOCKS, STATION_RANGE } from '../catalog/ops.js';
import { TEMPLATES, TEMPLATE_NAMES, MESSAGE_TEMPLATES, HANDOFF_TEMPLATES } from '../catalog/templates.js';
import { CATALOG_DEFAULTS } from '../catalog/defaults.js';
import { checkRoutineRanges } from '../routines/routines.js';
import {
    noDigPathingPlugin, withPathingPermit, permitView, noDigView, pathingPermit, CANNOT_BREAK,
} from '../lib/no_dig_pathing.js';
import { readFileSync } from 'node:fs';
import { REPO_ROOT } from './helpers/stubs.mjs';
import path from 'node:path';

const BLUEPRINTS = { get: (name) => (name === 'hut' ? HUT : null) };

function setup({ agent = 'Arthur', inventory = {}, position = { x: 0, y: 64, z: 0 }, config = WORLD_CONFIG, catalog_config = {} } = {}) {
    const clock = fakeClock();
    const world = campWorld(clock);
    world.addAgent(agent, { position, inventory });
    const zones = createZones(config);
    const catalog = createCatalog({ zones, blueprints: BLUEPRINTS, config: catalog_config });
    const ledger = createLedger();
    const state = () => ({ agent, view: world.view(agent), ledger, avoid: [] });
    const ids = () => catalog.offer(state()).map((option) => option.id);
    const reason = (option_id) => { const checked = catalog.check(option_id, state()); return checked.ok ? null : checked.reason; };
    return { clock, world, zones, catalog, ledger, state, ids, reason, body: world.body(agent) };
}

// ---- zones -------------------------------------------------------------------------------

test('zones: the minimal world config is accepted and answers the questions the catalog asks', () => {
    assert.deepEqual(checkZonesConfig(WORLD_CONFIG), []);
    const zones = createZones(WORLD_CONFIG);
    assert.equal(zones.protectedAt({ x: 0, y: 70, z: 0 }), 'camp');
    assert.equal(zones.protectedAt({ x: 0, y: -40, z: 0 }), 'camp', 'a zone given as [x, z] is protected at every height');
    assert.equal(zones.protectedAt({ x: 15, y: 64, z: 0 }), 'field');
    assert.equal(zones.protectedAt({ x: -18, y: 65, z: 14 }), 'plot:plot-1');
    assert.equal(zones.protectedAt({ x: -18, y: 80, z: 14 }), null, 'a plot given as [x, y, z] ends at its height');
    assert.equal(zones.isProtected({ x: -30, y: 64, z: 0 }), false);
    assert.deepEqual(zones.home('Mira'), { x: 0, y: 64, z: 0 });
    assert.equal(zones.range('Felix'), 128);
    assert.equal(zones.inRange('Mira', { x: 32, y: 200, z: 0 }), true, 'height does not count toward the range');
    assert.equal(zones.inRange('Mira', { x: 33, y: 64, z: 0 }), false);
    assert.equal(zones.inRange('Stranger', { x: 0, y: 64, z: 0 }), false, 'an agent the file does not list has no range');
    assert.deepEqual(zones.chest('shared'), { x: 2, y: 64, z: 2 });
    assert.equal(zones.chest('nowhere'), null);
    assert.deepEqual(zones.plotOverlaps('plot-1'), []);
    const ring = zones.patrol('Felix');
    assert.equal(ring.length, PATROL_RING.points);
    assert.ok(ring.every((p) => zones.inRange('Felix', p)));
    assert.deepEqual(zones.places('Mira').filter((p) => p.kind !== 'patrol').map((p) => p.id), ['home', 'camp', 'field', 'chest-shared', 'chest-kits']);
    assert.ok(zones.places('Arthur').some((p) => p.id === 'plot-plot-1'), 'an agent sees its own plot');
});

test('zones: the example world config in the repository is a valid one, with the decided ranges', () => {
    const example = JSON.parse(readFileSync(path.join(REPO_ROOT, 'genesis', 'genesis.world.example.json'), 'utf8'));
    assert.deepEqual(checkZonesConfig(example), []);
    const zones = createZones(example);
    assert.deepEqual(checkRoutineRanges(zones), []);
    assert.ok(zones.plots().length >= 2);
    for (const plot of zones.plots()) assert.deepEqual(zones.plotOverlaps(plot.id), [], `plot ${plot.id} overlaps something`);
    assert.ok(zones.chests().every((chest) => zones.protectedAt(chest.pos) === 'camp'));
    // the real file is the operator's to write: it is not in the repository
    assert.throws(() => readFileSync(path.join(REPO_ROOT, 'genesis', ZONES_FILE)), /ENOENT/);
});

test('zones: a plot that overlaps the camp, the field or another plot says so', () => {
    const zones = createZones({
        ...WORLD_CONFIG,
        plots: [
            { id: 'a', min: [6, 64, 6], max: [10, 66, 10] },       // reaches into the camp
            { id: 'b', min: [30, 64, 30], max: [34, 66, 34] },
            { id: 'c', min: [34, 64, 34], max: [38, 66, 38] },     // shares a corner cell with b
        ],
    });
    assert.deepEqual(zones.plotOverlaps('a'), ['camp']);
    assert.deepEqual(zones.plotOverlaps('b'), ['plot:c']);
    assert.deepEqual(zones.plotOverlaps('nope'), []);
});

test('zones: a broken world config is reported, never thrown at the caller of the loader', async () => {
    const problems = checkZonesConfig({
        v: 3, camp: { min: [0, 0], max: [-1, 5] }, plots: [{ id: 'bad id', min: [0, 0], max: [1, 1] }, { id: 'p', min: [0, 0, 0], max: [1, 1, 1] }, { id: 'p', min: [0, 0, 0], max: [1, 1, 1] }],
        chests: { shared: [1, 2] }, agents: { Arthur: { home: [0, 64], range: 0 } },
    });
    for (const expected of ['"v" must be 1', 'camp: min is larger than max', 'field must be', 'plots[0].id', 'plots[0] needs a height', 'plots[2].id "p" is used twice',
        'chests.shared must be [x, y, z]', 'agents.Arthur.home', 'agents.Arthur.range']) {
        assert.ok(problems.some((problem) => problem.includes(expected)), `no problem mentions: ${expected}\n${problems.join('\n')}`);
    }
    assert.deepEqual(checkZonesConfig(null), ['the world config must be a JSON object']);
    assert.throws(() => createZones({ v: 1 }), /world config/);

    const good = await loadZones({ read: async (file) => (file === ZONES_FILE ? JSON.stringify(WORLD_CONFIG) : null) });
    assert.equal(good.ok, true);
    assert.equal(good.zones.range('Arthur'), 48);
    assert.match((await loadZones({ read: async () => null })).problems[0], /does not exist/);
    assert.match((await loadZones({ read: async () => '{ not json' })).problems[0], /is not JSON/);
    assert.match((await loadZones({ read: async () => { throw new Error('EACCES'); } })).problems[0], /cannot be read \(EACCES\)/);
    assert.match((await loadZones({ read: async () => '{"v":1}' })).problems.join('\n'), /camp must be/);
});

// ---- the ledger and the failure names ----------------------------------------------------

test('ledger: remembers what was seen in a chest, and survives a snapshot', () => {
    const ledger = createLedger();
    assert.equal(ledger.known('shared'), false);
    ledger.set('shared', { oak_log: 12, bread: 3, nothing: 0 }, 5000);
    ledger.add('shared', 'bread', 2);
    ledger.remove('shared', 'oak_log', 12);
    ledger.add('kits', 'torch', 4);
    assert.deepEqual(ledger.stock('shared'), { bread: 5 });
    assert.equal(ledger.count('kits', 'torch'), 4);
    assert.equal(ledger.seen_at('shared'), 5000);
    const copy = createLedger();
    copy.restore(JSON.parse(JSON.stringify(ledger.snapshot())));
    assert.deepEqual(copy.snapshot(), ledger.snapshot());
    copy.zero('shared', 'bread');
    assert.equal(copy.count('shared', 'bread'), 0);
});

test('ledger: reads what upstream viewChest logs', () => {
    assert.deepEqual(parseChestView('Action output:\nYou have reached at 2, 64, 2.\nThe chest contains:\n12 oak_log\n3 bread\n5 oak_log\n'), { oak_log: 17, bread: 3 });
    assert.deepEqual(parseChestView('Action output:\nThe chest is empty.\n'), {});
    assert.equal(parseChestView('Could not find a chest nearby.'), null);
});

test('ops: every step command is an upstream skill that exists at the line the table names', () => {
    const source = readFileSync(path.join(REPO_ROOT, 'src/agent/library/skills.js'), 'utf8').split('\n');
    for (const [name, op] of Object.entries(UPSTREAM_OPS)) {
        assert.equal(op.file, 'src/agent/library/skills.js');
        assert.match(source[op.line - 1], new RegExp(`^export async function ${name}\\(bot`), `${name} is not at line ${op.line}`);
    }
    assert.match(source[707], /const empty_blocks = \['air', 'water', 'lava', 'grass', 'short_grass', 'tall_grass', 'snow', 'dead_bush', 'fern'\];/);
    assert.deepEqual([...EMPTY_BLOCKS], ['air', 'water', 'lava', 'grass', 'short_grass', 'tall_grass', 'snow', 'dead_bush', 'fern']);
    assert.match(source[55], /const craftingTableRange = 16;/);
    assert.match(source[161], /const furnaceRange = 16;/);
    assert.equal(STATION_RANGE, 16);
    // every template only names commands of the table, and only build_blueprint may place a block
    assert.deepEqual(OP_NAMES.filter((name) => UPSTREAM_OPS[name].places_blocks), ['placeBlock']);
    // one step is not an upstream skill: the message of an ask_agent or offer_agent goal, which Genesis's own code sends
    assert.deepEqual(Object.keys(LOCAL_OPS), ['relayMessage']);
    assert.equal(MESSAGE_STEP, 'relayMessage');
    assert.ok(!OP_NAMES.includes('relayMessage') && !Object.hasOwn(UPSTREAM_OPS, 'relayMessage'), 'the bot\'s step runner must never be handed the message step');
    assert.deepEqual([...STEP_NAMES], [...OP_NAMES, 'relayMessage']);
    assert.equal(classifyFailure('relayMessage', { ok: false, output: 'message_rejected: rate_limit' }), 'message_rejected');
});

test('ops: a failed skill gets a name from what upstream logged', () => {
    const failed = (output, more = {}) => ({ ok: false, interrupted: false, timedout: false, output, ...more });
    assert.equal(classifyFailure('goToPosition', failed('no_safe_path: there is no way to the goal without breaking blocks. Not digging.')), 'no_safe_path');
    assert.equal(classifyFailure('goToPosition', failed('Unable to reach 1, 2, 3, you are 9 blocks away.')), 'not_reached');
    assert.equal(classifyFailure('breakBlockAt', failed("Don't have right tools to break stone.")), 'wrong_tool');
    assert.equal(classifyFailure('takeFromChest', failed('Could not find any bread in the chest.')), 'ledger_stale');
    assert.equal(classifyFailure('putInChest', failed('Could not find a chest nearby.')), 'no_chest');
    assert.equal(classifyFailure('craftRecipe', failed('Crafting bread requires a crafting table.')), 'no_table_near');
    assert.equal(classifyFailure('craftRecipe', failed('You do not have the resources to craft a bread. It requires: wheat: 3.')), 'missing_ingredients');
    assert.equal(classifyFailure('smeltItem', failed('You have no fuel to smelt raw_iron, you need coal, charcoal, or wood.')), 'no_fuel');
    assert.equal(classifyFailure('smeltItem', failed('There is no furnace nearby and you have no furnace.')), 'no_furnace_near');
    assert.equal(classifyFailure('tillAndSow', failed('No wheat_seeds to plant.')), 'no_seed');
    assert.equal(classifyFailure('placeBlock', failed('Cannot place oak_planks at (1, 2, 3): block in the way.')), 'cell_occupied');
    assert.equal(classifyFailure('placeBlock', failed('!!Code threw exception!!\nError: boom')), 'skill_error');
    assert.equal(classifyFailure('placeBlock', failed('', { interrupted: true })), 'interrupted');
    assert.equal(classifyFailure('placeBlock', failed('', { interrupted: true, timedout: true })), 'timed_out');
    assert.equal(classifyFailure('pickupNearbyItems', failed('')), 'pickupNearbyItems_failed');
    assert.equal(classifyFailure('newAction', failed('')), 'unknown_command');
});

// ---- the catalog -------------------------------------------------------------------------

test('catalog: the nine templates, each with a progress measure and named failure reasons', () => {
    // the eight of the first catalog, and sow_field (decided: the starter field is left bare, the agents sow it)
    assert.deepEqual([...TEMPLATE_NAMES], ['travel', 'gather_blocks', 'craft_item', 'store_items', 'fetch_items', 'harvest_replant', 'sow_field', 'build_blueprint', 'smelt_item']);
    const { catalog } = setup();
    const units = Object.fromEntries(catalog.skills().map((skill) => [skill.name, skill.progress_unit]));
    assert.deepEqual(units, {
        travel: 'blocks covered', gather_blocks: 'items gained', craft_item: 'items made', store_items: 'items stored',
        fetch_items: 'items taken', harvest_replant: 'plots replanted', sow_field: 'cells sown', build_blueprint: 'matching cells', smelt_item: 'items smelted',
    });
    for (const skill of catalog.skills()) {
        assert.ok(skill.failures.length >= 3, `${skill.name} names too few failure reasons`);
        assert.ok(skill.failures.every((reason) => /^[a-z_]+$/.test(reason)));
        assert.ok(skill.failures.includes('no_safe_path'));
    }
    for (const template of TEMPLATES) {
        for (const fn of ['id', 'parse', 'candidates', 'check', 'title', 'describe', 'steps', 'baseline', 'before', 'after', 'progress']) {
            assert.equal(typeof template[fn], 'function', `${template.name}.${fn}`);
        }
    }
});

test('catalog: offer() holds only what can run now, with stable ids that lead back to skill and arguments', () => {
    const h = setup({ inventory: { oak_log: 3, wooden_pickaxe: 1, oak_planks: 20, raw_iron: 4, coal: 2 } });
    h.ledger.set('kits', { bread: 5 });
    const options = h.catalog.offer(h.state());
    assert.deepEqual(options.map((option) => option.id), [
        'travel:field', 'travel:chest-shared', 'travel:chest-kits', 'travel:plot-plot-1', 'travel:ring-2',
        'gather_blocks:stone:8', 'gather_blocks:oak_log:8',
        'craft_item:oak_planks:4', 'craft_item:stick:2', 'craft_item:crafting_table:1',
        'store_items:shared:oak_planks', 'store_items:shared:raw_iron',
        'fetch_items:kits:bread:5', 'harvest_replant:field', 'build_blueprint:plot-1', 'smelt_item:raw_iron:4',
    ]);
    assert.deepEqual(h.catalog.offer(h.state()), options, 'the same world gives the same options');
    assert.ok(options.length <= CATALOG_DEFAULTS.max_options);
    for (const option of options) {
        assert.ok(option.title.length > 0 && option.title.length <= 60, option.title);
        assert.equal(typeof option.description, 'string');
        assert.deepEqual(h.catalog.resolve(option.id), { skill: option.skill, args: option.args });
        assert.equal(h.catalog.check(option.id, h.state()).ok, true);
        const plan = h.catalog.plan(option, h.state());
        assert.ok(plan.steps.length > 0);
        assert.ok(plan.steps.every((step) => OP_NAMES.includes(step.command) && Array.isArray(step.args)));
    }
    // tools are kept, not stored away
    assert.ok(!options.some((option) => option.id === 'store_items:shared:wooden_pickaxe'));
    // ids that are not of this catalog lead nowhere
    for (const bad of ['dance:now', 'gather_blocks:oak_log', 'gather_blocks:oak_log:0', 'gather_blocks:oak_log:8:extra', 'travel:', 'craft_item:Stick:1', '', null, 42]) {
        assert.equal(h.catalog.resolve(bad), null, `resolved ${bad}`);
        assert.deepEqual(h.catalog.check(bad, h.state()), { ok: false, reason: 'unknown_option' });
    }
});

test('catalog: an option whose preconditions fail is not offered, and check() says why', () => {
    // nothing held, nothing known about the chests, standing at home in the camp
    const h = setup();
    assert.deepEqual(h.ids(), ['travel:field', 'travel:chest-shared', 'travel:chest-kits', 'travel:plot-plot-1', 'travel:ring-2',
        'gather_blocks:oak_log:8', 'harvest_replant:field']);
    assert.equal(h.reason('travel:home'), 'already_there');
    // a chest is worth walking to (even from next to it) until the ledger knows what is in it
    h.ledger.set('shared', { oak_log: 3 }, 1000);
    assert.equal(h.catalog.check('travel:chest-shared', { ...h.state(), now: 1000 + 60 * 1000 }).reason, 'ledger_fresh');
    assert.equal(h.catalog.check('travel:chest-shared', { ...h.state(), now: 1000 + 6 * 60 * 1000 }).ok, true);
    h.ledger.restore({});
    assert.equal(h.reason('travel:mars'), 'unknown_place');
    assert.equal(h.reason('gather_blocks:stone:8'), 'wrong_tool');
    assert.equal(h.reason('gather_blocks:iron_ore:8'), 'none_nearby');
    assert.equal(h.reason('gather_blocks:obsidian:8'), 'unknown_type');
    assert.equal(h.reason('craft_item:stick:2'), 'missing_ingredients');
    assert.equal(h.reason('craft_item:elytra:1'), 'no_recipe');
    assert.equal(h.reason('store_items:shared:oak_log'), 'not_held');
    assert.equal(h.reason('store_items:attic:oak_log'), 'not_held');
    assert.equal(h.reason('fetch_items:kits:bread:4'), 'ledger_empty');
    assert.equal(h.reason('build_blueprint:plot-1'), 'missing_materials');
    assert.equal(h.reason('build_blueprint:plot-9'), 'plot_not_registered');
    assert.equal(h.reason('smelt_item:raw_iron:4'), 'not_held');
});

test('travel: needs a dig-free path that stays inside the range', () => {
    const h = setup({ agent: 'Mira' });
    assert.equal(h.reason('travel:field'), null);
    h.world.blocked = (from, to) => to.x > 10;      // the field is walled in
    assert.equal(h.reason('travel:field'), 'no_safe_path');
    assert.ok(!h.ids().includes('travel:field'));
    h.world.blocked = () => false;

    // a destination outside the range is never offered (Mira may be 32 blocks from home)
    const far = createCatalog({ zones: createZones({ ...WORLD_CONFIG, chests: { ...WORLD_CONFIG.chests, far: [60, 64, 0] } }) });
    assert.deepEqual(far.check('travel:chest-far', h.state()), { ok: false, reason: 'out_of_range' });

    // the path itself may not leave the range either
    const view = h.world.view('Mira');
    const detour = { ...view, pathTo: () => ({ status: 'ok', nodes: [{ x: 0, y: 64, z: 0 }, { x: 0, y: 64, z: 40 }, { x: 16, y: 64, z: 0 }] }) };
    assert.deepEqual(h.catalog.check('travel:field', { ...h.state(), view: detour }), { ok: false, reason: 'path_leaves_range' });
    // a search that could not finish is not proof of a path, unless it was getting there without digging
    const unknown = { ...view, pathTo: () => ({ status: 'unknown' }) };
    assert.deepEqual(h.catalog.check('travel:field', { ...h.state(), view: unknown }), { ok: false, reason: 'path_unknown' });
    const partial = { ...view, pathTo: () => ({ status: 'partial', nodes: [{ x: 4, y: 64, z: 0 }] }) };
    assert.equal(h.catalog.check('travel:field', { ...h.state(), view: partial }).ok, true);

    // an agent that respawned outside its range may walk home
    h.body.position = { x: 60, y: 64, z: 0 };
    assert.equal(h.reason('travel:home'), null);
    // nothing is aimed into an area to avoid, except the camp: the way home is always open
    const avoid = [{ x: 14, y: 64, z: 3, radius: 24 }];
    assert.deepEqual(h.catalog.check('travel:field', { ...h.state(), avoid }), { ok: false, reason: 'avoid_area' });
    assert.equal(h.catalog.check('travel:home', { ...h.state(), avoid }).ok, true);
});

test('gather_blocks: needs a matching block outside protected zones, the right tool, 3 free slots and daylight', () => {
    const h = setup({ inventory: { wooden_pickaxe: 1 } });
    assert.equal(h.reason('gather_blocks:oak_log:8'), null);
    assert.equal(h.reason('gather_blocks:stone:8'), null);

    // the steps go for the blocks outside the camp only: the tree inside it (6, y, 6) is not a target
    const option = h.catalog.check('gather_blocks:oak_log:8', h.state()).option;
    const steps = h.catalog.plan(option, h.state()).steps;
    assert.equal(steps.length, 9);
    assert.equal(steps[8].command, 'pickupNearbyItems');
    for (const step of steps.slice(0, 8)) {
        assert.equal(step.command, 'breakBlockAt');
        assert.equal(h.zones.isProtected({ x: step.args[0], y: step.args[1], z: step.args[2] }), false);
    }

    // night
    const night = fakeClock();
    const dark = campWorld(night, { start_tick: 13000 });
    dark.addAgent('Arthur', { position: { x: 0, y: 64, z: 0 } });
    assert.deepEqual(h.catalog.check('gather_blocks:oak_log:8', { agent: 'Arthur', view: dark.view('Arthur'), ledger: h.ledger }), { ok: false, reason: 'night' });

    // fewer than 3 free slots
    for (let i = 0; i < 34; i++) h.body.inventory[`junk_${i}`] = 1;
    assert.equal(h.world.view('Arthur').freeSlots(), 1);
    assert.equal(h.reason('gather_blocks:oak_log:8'), 'inventory_full');
});

test('gather_blocks: gathering inside a protected zone is refused, at every level', () => {
    const h = setup({ inventory: { wooden_pickaxe: 1 } });
    // only the tree inside the camp is left
    for (const block of [...h.world.blocks.values()]) {
        if (block.name === 'oak_log' && !h.zones.isProtected(block)) h.world.set(block.x, block.y, block.z, 'air');
    }
    assert.equal(h.world.view('Arthur').findBlocks(['oak_log'], 32, 10).length, 3, 'the camp tree is there to be found');
    assert.ok(!h.ids().includes('gather_blocks:oak_log:8'), 'the option was offered');
    assert.equal(h.reason('gather_blocks:oak_log:8'), 'protected_zone');

    // a step that names a block in the camp (a plan read back from a checkpoint) is refused before any skill runs
    const refused = h.catalog.before('gather_blocks:oak_log:8', { command: 'breakBlockAt', args: [6, 64, 6] }, h.state());
    assert.deepEqual(refused, { fail: 'protected_zone' });
    // the same in the field and on a plot
    assert.deepEqual(h.catalog.before('gather_blocks:dirt:8', { command: 'breakBlockAt', args: [15, 63, 0] }, h.state()), { fail: 'protected_zone' });
    assert.deepEqual(h.catalog.before('gather_blocks:dirt:8', { command: 'breakBlockAt', args: [-18, 64, 14] }, h.state()), { fail: 'protected_zone' });
    // and a block outside the range
    assert.deepEqual(h.catalog.before('gather_blocks:oak_log:8', { command: 'breakBlockAt', args: [90, 64, 0] }, h.state()), { fail: 'out_of_range' });
    // an allowed block may be tunnelled to; a block that is gone is skipped
    h.world.set(-30, 60, 0, 'oak_log');
    assert.deepEqual(h.catalog.before('gather_blocks:oak_log:8', { command: 'breakBlockAt', args: [-30, 60, 0] }, h.state()), { permit: { dig: true } });
    assert.deepEqual(h.catalog.before('gather_blocks:oak_log:8', { command: 'breakBlockAt', args: [-31, 60, 0] }, h.state()), { skip: 'block_gone' });
});

test('craft_item: craftable now, and a crafting table within 16 blocks when the recipe needs one', () => {
    const h = setup({ inventory: { wheat: 6, crafting_table: 1 } });
    assert.equal(h.reason('craft_item:bread:1'), null, 'the camp table is 5 blocks away');
    h.body.position = { x: 30, y: 64, z: 0 };
    assert.equal(h.reason('craft_item:bread:1'), 'no_table_near', 'the table the agent carries does not count: it would be placed');
    assert.deepEqual(h.catalog.before('craft_item:bread:1', { command: 'craftRecipe', args: ['bread', 1] }, h.state()), { fail: 'no_table_near' });
    h.body.inventory = { oak_log: 1 };
    assert.equal(h.reason('craft_item:oak_planks:4'), null, 'a recipe without a table can be made anywhere');
});

test('store_items and fetch_items: the item is held, the ledger shows stock, a slot is free, the chest is reachable', () => {
    const h = setup({ inventory: { oak_log: 12 } });
    assert.equal(h.reason('store_items:shared:oak_log'), null);
    assert.equal(h.reason('store_items:attic:oak_log'), 'unknown_chest');
    h.body.position = { x: 20, y: 64, z: 20 };
    h.world.blocked = () => true;
    assert.equal(h.reason('store_items:shared:oak_log'), 'chest_unreachable');
    h.world.blocked = () => false;

    assert.equal(h.reason('fetch_items:kits:bread:4'), 'ledger_empty');
    h.ledger.set('kits', { bread: 2 });
    assert.equal(h.reason('fetch_items:kits:bread:4'), null);
    for (let i = 0; i < 35; i++) h.body.inventory[`junk_${i}`] = 1;
    assert.equal(h.world.view('Arthur').freeSlots(), 0);
    assert.equal(h.reason('fetch_items:kits:bread:4'), 'inventory_full');

    // upstream's chest skills use the nearest chest, whichever it is: the step is refused when that is not the registered one
    h.world.set(20, 64, 21, 'chest', { contents: {} });
    assert.deepEqual(h.catalog.before('store_items:shared:oak_log', { command: 'putInChest', args: ['oak_log', -1] }, h.state()), { fail: 'wrong_chest' });
});

test('harvest_replant: only mature crops in the field, checked again at every crop', () => {
    const h = setup({ agent: 'Mira', position: { x: 10, y: 64, z: 0 } });
    assert.equal(h.reason('harvest_replant:field'), null);
    const steps = h.catalog.plan(h.catalog.check('harvest_replant:field', h.state()).option, h.state()).steps;
    assert.equal(steps.length, 3 * CATALOG_DEFAULTS.harvest_batch);
    assert.deepEqual(steps.slice(0, 3).map((step) => step.command), ['breakBlockAt', 'pickupNearbyItems', 'tillAndSow']);
    assert.deepEqual(steps[2].args, [steps[0].args[0], steps[0].args[1] - 1, steps[0].args[2], 'wheat_seeds']);

    // a crop that is not mature is skipped, never broken; one outside the field is refused
    h.world.set(13, 64, 0, 'wheat', { age: 3 });
    assert.deepEqual(h.catalog.before('harvest_replant:field', { command: 'breakBlockAt', args: [13, 64, 0] }, h.state()), { skip: 'crop_not_mature' });
    assert.deepEqual(h.catalog.before('harvest_replant:field', { command: 'tillAndSow', args: [13, 63, 0, 'wheat_seeds'] }, h.state()), { skip: 'plot_not_cleared' });
    assert.deepEqual(h.catalog.before('harvest_replant:field', { command: 'breakBlockAt', args: [30, 64, 0] }, h.state()), { fail: 'outside_field' });
    assert.equal(h.catalog.before('harvest_replant:field', { command: 'breakBlockAt', args: [14, 64, 0] }, h.state()), null);

    // no mature crop at all: not offered
    for (const block of [...h.world.blocks.values()]) if (block.name === 'wheat') h.world.set(block.x, block.y, block.z, 'wheat', { age: 2 });
    assert.equal(h.reason('harvest_replant:field'), 'no_mature_crop');
    assert.ok(!h.ids().includes('harvest_replant:field'));
    // wheat growing outside the field does not count
    h.world.set(30, 64, 0, 'wheat', { age: 7 });
    assert.equal(h.reason('harvest_replant:field'), 'no_mature_crop');
});

test('sow_field: offered when the field has unsown farmland and the agent holds seeds, and it sows with upstream\'s tillAndSow', async () => {
    // the field as the bootstrap leaves it (decided): tilled farmland, nothing on it
    const bare = (h) => { for (const block of [...h.world.blocks.values()]) if (block.name === 'wheat') h.world.set(block.x, block.y, block.z, 'air'); };
    const h = setup({ agent: 'Mira', position: { x: 10, y: 64, z: 0 }, inventory: { wheat_seeds: 20, stone_hoe: 1 } });
    // nothing to sow while every cell carries a crop
    assert.equal(h.reason('sow_field:wheat_seeds'), 'no_bare_farmland');
    assert.ok(!h.ids().includes('sow_field:wheat_seeds'));
    bare(h);
    assert.equal(h.reason('sow_field:wheat_seeds'), null);
    assert.ok(h.ids().includes('sow_field:wheat_seeds'));
    assert.ok(!h.ids().includes('harvest_replant:field'), 'there is nothing to harvest on a bare field');
    assert.deepEqual(h.catalog.resolve('sow_field:wheat_seeds'), { skill: 'sow_field', args: { seed: 'wheat_seeds' } });
    const option = h.catalog.check('sow_field:wheat_seeds', h.state()).option;
    assert.equal(option.description, 'Sow 16 of the 49 bare cells of the field with wheat_seeds');

    // the steps: one call of the skill harvest_replant sows back with, per bare cell, nearest first, a batch at a time
    const plan = h.catalog.plan(option, h.state());
    assert.equal(plan.steps.length, CATALOG_DEFAULTS.sow_batch);
    assert.equal(CATALOG_DEFAULTS.sow_batch, 16);
    assert.ok(plan.steps.every((step) => step.command === 'tillAndSow' && step.args[1] === 63 && step.args[3] === 'wheat_seeds'));
    assert.equal(UPSTREAM_OPS.tillAndSow.line, 1589);
    assert.deepEqual(plan.steps[0].args, [13, 63, 0, 'wheat_seeds'], 'the nearest bare cell comes first');
    assert.ok(plan.steps.every((step) => h.zones.protectedAt({ x: step.args[0], y: step.args[1], z: step.args[2] }) === 'field'));
    // no more steps than seeds held
    h.body.inventory.wheat_seeds = 5;
    assert.equal(h.catalog.plan(option, h.state()).steps.length, 5);

    // carried out: the seeds go into the ground, the cells carry wheat at age 0, and progress counts the cells
    const ops = h.world.ops('Mira');
    const running = { steps: h.catalog.plan(option, h.state()).steps.map((step) => ({ ...step, status: 'pending' })) };
    for (const step of running.steps) {
        assert.equal(h.catalog.before('sow_field:wheat_seeds', step, h.state()), null);
        const result = await ops.run(step.command, step.args);
        assert.equal(result.ok, true, result.output);
        step.status = 'done';
    }
    assert.equal(h.body.inventory.wheat_seeds, undefined);
    assert.deepEqual(h.world.get(13, 64, 0), { name: 'wheat', x: 13, y: 64, z: 0, age: 0, planted_at: h.clock.now() });
    assert.equal([...h.world.blocks.values()].filter((block) => block.name === 'wheat').length, 5);
    assert.deepEqual(h.catalog.progress('sow_field:wheat_seeds', h.state(), {}, running), { done: 5, total: 5, unit: 'cells sown' });
    assert.deepEqual(h.world.placed, [], 'sowing is not placing a block');
    assert.deepEqual(h.world.broken, []);

    // without seeds: not offered, and the reason says so (the routine fetches seeds on it)
    assert.equal(h.reason('sow_field:wheat_seeds'), 'no_seed');
    assert.ok(!h.ids().some((id) => id.startsWith('sow_field:')));
    // each kind of seed held is a candidate; something that is not a seed never is
    h.body.inventory = { carrot: 3, beetroot_seeds: 2, oak_log: 9 };
    assert.deepEqual(h.catalog.candidates('sow_field', h.state()), [{ seed: 'carrot' }, { seed: 'beetroot_seeds' }]);
    assert.equal(h.reason('sow_field:oak_log'), 'unknown_seed');
    assert.equal(h.catalog.resolve('sow_field'), null);

    // the guard before every cell: only farmland of the field that is still bare is ever handed to upstream,
    // which would break whatever stands on other soil and till it (skills.js 1622-1645)
    h.body.inventory = { wheat_seeds: 4 };
    const step = (x, y, z) => ({ command: 'tillAndSow', args: [x, y, z, 'wheat_seeds'] });
    assert.deepEqual(h.catalog.before('sow_field:wheat_seeds', step(13, 63, 0), h.state()), { skip: 'already_sown' });
    assert.equal(h.catalog.before('sow_field:wheat_seeds', step(19, 63, 3), h.state()), null);
    assert.deepEqual(h.catalog.before('sow_field:wheat_seeds', step(30, 63, 0), h.state()), { fail: 'outside_field' });
    h.world.set(19, 63, 2, 'dirt');                              // farmland that was trampled back to dirt
    assert.deepEqual(h.catalog.before('sow_field:wheat_seeds', step(19, 63, 2), h.state()), { skip: 'not_farmland' });
    h.body.inventory = {};
    assert.deepEqual(h.catalog.before('sow_field:wheat_seeds', step(19, 63, 3), h.state()), { skip: 'no_seed' });
    // farmland outside the field does not count, and farmland out of the agent's range is never aimed at
    const far = setup({ agent: 'Mira', position: { x: 10, y: 64, z: 0 }, inventory: { wheat_seeds: 4 } });
    far.world.set(30, 63, 0, 'farmland');
    assert.equal(far.reason('sow_field:wheat_seeds'), 'no_bare_farmland');
});

test('ask_agent and offer_agent: offered to the planner only while every precondition holds', () => {
    assert.deepEqual(MESSAGE_TEMPLATES.map((template) => template.name), ['ask_agent', 'offer_agent']);
    assert.ok(!TEMPLATE_NAMES.includes('ask_agent') && !TEMPLATE_NAMES.includes('offer_agent'), 'the messages are not skill templates');
    assert.deepEqual(HANDOFF_TEMPLATES.map((template) => template.name), ['give_items']);
    assert.deepEqual([CATALOG_DEFAULTS.per_skill.ask_agent, CATALOG_DEFAULTS.per_skill.offer_agent, CATALOG_DEFAULTS.ask_count, CATALOG_DEFAULTS.offer_count, CATALOG_DEFAULTS.ask_any_count], [3, 1, 8, 8, 4]);
    for (const template of MESSAGE_TEMPLATES) {
        for (const fn of ['id', 'parse', 'candidates', 'check', 'title', 'describe', 'steps', 'baseline', 'before', 'after', 'progress']) assert.equal(typeof template[fn], 'function', `${template.name}.${fn}`);
        assert.ok(template.failures.every((reason) => /^[a-z_]+$/.test(reason)));
    }
    // the message desk's view, as genesis/relay/desk.js gives it (talk())
    const talk = (over = {}) => ({ open: 0, max_open: 2, sent: 0, max_sent: 6, spare: (item) => ({ oak_log: 10, bread: 1 }[item] ?? 0), waiting: () => false, repeated: () => false, ...over });
    // Arthur: his plot wants oak planks (the hut), he holds none; he carries logs he can spare, and tools he cannot
    const h = setup({ inventory: { oak_log: 10, stone_axe: 1, bread: 5, torch: 3 } });
    const state = (desk = talk()) => ({ ...h.state(), talk: desk });
    const ids = (desk) => h.catalog.offer(state(desk)).map((option) => option.id).filter((id) => /^(ask|offer)_agent:/.test(id));
    const reason = (id, desk) => { const checked = h.catalog.check(id, state(desk)); return checked.ok ? null : checked.reason; };

    // without a message desk nothing of the kind exists
    assert.deepEqual(h.catalog.offer(h.state()).map((option) => option.id).filter((id) => /^(ask|offer)_agent:/.test(id)), []);
    assert.equal(h.catalog.check('ask_agent:Mira:oak_planks:8', h.state()).reason, 'no_messaging');
    // with one: two agents to ask for what the build is short of, one offer of what is held most beyond the reserve
    // (decided: anything the catalog knows may be asked for: the third ask is for something else the agent has none of)
    assert.deepEqual(ids(), ['ask_agent:Mira:oak_planks:8', 'ask_agent:Felix:oak_planks:8', 'ask_agent:Mira:birch_log:4', 'offer_agent:Mira:oak_log:8']);
    assert.equal(h.catalog.check('ask_agent:Felix:bread:2', state()).ok, true, 'something the catalog knows could not be asked for');
    assert.equal(h.catalog.check('ask_agent:Felix:diamond_block:2', state()).reason, 'unknown_item');
    const options = h.catalog.offer(state());
    assert.equal(options.at(-1).id, 'offer_agent:Mira:oak_log:8', 'the messages come after the work');
    assert.equal(options.find((option) => option.id === 'ask_agent:Mira:oak_planks:8').description, 'Ask Mira for 8 oak_planks (for plot plot-1): Mira may say no');
    assert.equal(options.find((option) => option.id === 'offer_agent:Mira:oak_log:8').description, 'Offer 8 of your 10 oak_log to Mira: handed over if Mira says yes');
    assert.deepEqual(h.catalog.resolve('ask_agent:Mira:oak_planks:8'), { skill: 'ask_agent', args: { to: 'Mira', item: 'oak_planks', count: 8 } });
    // the goal is one step, and it is not a skill of the bot
    const plan = h.catalog.plan(h.catalog.check('ask_agent:Mira:oak_planks:8', state()).option, state());
    assert.deepEqual(plan.steps, [{ command: 'relayMessage', args: ['request', 'Mira', 'oak_planks', 8] }]);
    assert.deepEqual(h.catalog.plan(h.catalog.check('offer_agent:Mira:oak_log:8', state()).option, state()).steps, [{ command: 'relayMessage', args: ['offer', 'Mira', 'oak_log', 8] }]);
    assert.deepEqual(h.catalog.progress('ask_agent:Mira:oak_planks:8', state(), {}, { steps: [{ command: 'relayMessage', status: 'done' }] }), { done: 1, total: 1, unit: 'messages sent' });

    // the other agent exists and is not the sender
    assert.equal(reason('ask_agent:Arthur:oak_planks:8'), 'self_message');
    assert.equal(reason('offer_agent:Arthur:oak_log:4'), 'self_message');
    assert.equal(reason('ask_agent:Herobrine:oak_planks:8'), 'unknown_agent');
    assert.equal(reason('offer_agent:Herobrine:oak_log:4'), 'unknown_agent');
    // an open conversation slot, and message budget
    for (const id of ['ask_agent:Mira:oak_planks:8', 'offer_agent:Mira:oak_log:8']) {
        assert.equal(reason(id), null);
        assert.equal(reason(id, talk({ open: 2 })), 'no_conversation_slot');
        assert.equal(reason(id, talk({ sent: 6 })), 'message_budget_spent');
        assert.equal(reason(id, talk({ waiting: (type, to, item) => to === 'Mira' && (item === 'oak_planks' || item === 'oak_log') })), 'already_waiting');
        assert.equal(reason(id, talk({ repeated: (type, to, item, count) => count === 8 })), 'repeat_blocked');
    }
    assert.deepEqual(ids(talk({ open: 2 })), []);
    assert.deepEqual(ids(talk({ sent: 6 })), []);
    assert.deepEqual(ids(talk({ waiting: (type, to) => to === 'Mira' })), ['ask_agent:Felix:oak_planks:8', 'ask_agent:Nova:oak_planks:8', 'ask_agent:Felix:spruce_log:4', 'offer_agent:Felix:oak_log:8']);
    // for an ask: the item is something the catalog knows (what it gathers, crafts, sows or harvests)
    for (const item of ['oak_planks', 'cobblestone', 'coal', 'wheat_seeds', 'wheat', 'bread', 'torch']) assert.equal(reason(`ask_agent:Mira:${item}:4`), null, item);
    for (const item of ['diamond_block', 'netherite_sword', 'command_block']) assert.equal(reason(`ask_agent:Mira:${item}:4`), 'unknown_item', item);
    // for an offer: the items are held beyond the agent's own reserve
    assert.equal(reason('offer_agent:Mira:oak_log:10'), null);
    assert.equal(reason('offer_agent:Mira:oak_log:11'), 'not_spare');
    assert.equal(reason('offer_agent:Mira:bread:1'), null);
    assert.equal(reason('offer_agent:Mira:bread:2'), 'not_spare');
    assert.equal(reason('offer_agent:Mira:stone_axe:1'), 'not_spare');
    assert.equal(reason('offer_agent:Mira:torch:1'), 'not_spare');
    // ids that are not of this shape lead nowhere
    for (const id of ['ask_agent:Mira:oak_planks', 'ask_agent:Mira:oak_planks:0', 'ask_agent:Mira:oak_planks:65', 'ask_agent:M:oak_planks:8', 'offer_agent:Mira:Oak Log:8']) assert.equal(h.catalog.resolve(id), null, id);

    // what is asked for is what the agent's own work is short of and no chest has: with planks in the shared chest it is a fetch, not an ask
    h.ledger.set('shared', { oak_planks: 20 });
    // (what a chest has is never asked for: the asks left are for other things the catalog knows)
    assert.deepEqual(ids().filter((id) => id.startsWith('ask_agent:')), ['ask_agent:Mira:birch_log:4', 'ask_agent:Felix:spruce_log:4', 'ask_agent:Nova:cobblestone:4']);
    assert.ok(!ids().some((id) => id.includes(':oak_planks:')));
    assert.ok(h.catalog.offer(state()).some((option) => option.id.startsWith('fetch_items:shared:oak_planks:')));
    h.ledger.set('shared', {});
    // an agent that holds what its plot wants does not ask for it (only for other things it has none of)
    h.body.inventory.oak_planks = 64;
    assert.deepEqual(ids().filter((id) => id.startsWith('ask_agent:')), ['ask_agent:Mira:birch_log:4', 'ask_agent:Felix:spruce_log:4', 'ask_agent:Nova:cobblestone:4']);
    delete h.body.inventory.oak_planks;
    // seeds for a bare field are asked for by whoever the field is for (here: nobody in particular), while it holds none
    for (const block of [...h.world.blocks.values()]) if (block.name === 'wheat') h.world.set(block.x, block.y, block.z, 'air');
    h.body.inventory.oak_planks = 64;
    h.body.position = { x: 10, y: 64, z: 0 };
    assert.deepEqual(ids().filter((id) => id.startsWith('ask_agent:')), ['ask_agent:Mira:wheat_seeds:8', 'ask_agent:Felix:wheat_seeds:8', 'ask_agent:Mira:birch_log:4']);
    h.body.inventory.wheat_seeds = 2;
    assert.ok(!ids().some((id) => id.includes(':wheat_seeds:')), 'seeds were asked for although the agent holds some');
    assert.equal(createZones({ ...WORLD_CONFIG, field: { ...WORLD_CONFIG.field, owner: 'Mira' } }).fieldOwner(), 'Mira');
    assert.equal(h.zones.fieldOwner(), null);

    // a long list of work never pushes the messages off the offer: their places are kept free, and the offer stays within its size
    const busy = setup({ inventory: { oak_log: 30, wooden_pickaxe: 1, oak_planks: 2, raw_iron: 8, coal: 4, wheat: 9, cobblestone: 20, stick: 4 } });
    busy.ledger.set('kits', { bread: 9, torch: 20 });
    busy.ledger.set('shared', { sand: 64, gravel: 3 });
    const crowded = busy.catalog.offer({ ...busy.state(), talk: talk({ spare: (item) => (item === 'oak_log' ? 30 : 0) }) }).map((option) => option.id);
    assert.equal(busy.catalog.offer(busy.state()).length, CATALOG_DEFAULTS.max_options, 'the test world does not fill the offer');
    assert.equal(crowded.length, CATALOG_DEFAULTS.max_options);
    assert.deepEqual(crowded.slice(-4), ['ask_agent:Mira:oak_planks:8', 'ask_agent:Felix:oak_planks:8', 'ask_agent:Mira:birch_log:4', 'offer_agent:Mira:oak_log:8']);
});

test('build_blueprint: only on a registered plot that overlaps no zone and holds only natural blocks where it differs', () => {
    const h = setup({ inventory: { oak_planks: 64 } });
    assert.equal(h.reason('build_blueprint:plot-1'), null);
    assert.equal(h.reason('build_blueprint:meadow'), 'plot_not_registered');

    // natural ground in the way is cleared by its own step, then the cell is placed
    h.world.set(-20, 64, 12, 'dirt');
    let steps = h.catalog.plan(h.catalog.check('build_blueprint:plot-1', h.state()).option, h.state()).steps;
    assert.deepEqual(steps.slice(0, 2), [{ command: 'breakBlockAt', args: [-20, 64, 12] }, { command: 'placeBlock', args: ['oak_planks', -20, 64, 12] }]);
    assert.ok(steps.every((step) => { const [x, y, z] = step.command === 'placeBlock' ? step.args.slice(1) : step.args; return h.zones.protectedAt({ x, y, z }) === 'plot:plot-1'; }));

    // something that was built there and does not match: the plot is not offered
    h.world.set(-19, 64, 12, 'cobblestone');
    assert.equal(h.reason('build_blueprint:plot-1'), 'plot_not_natural');
    assert.ok(!h.ids().includes('build_blueprint:plot-1'));
    h.world.set(-19, 64, 12, 'air');

    // a cell that already matches is left alone; an occupied cell is never handed to placeBlock
    h.world.set(-20, 64, 12, 'oak_planks');
    assert.deepEqual(h.catalog.before('build_blueprint:plot-1', { command: 'placeBlock', args: ['oak_planks', -20, 64, 12] }, h.state()), { skip: 'already_matches' });
    h.world.set(-18, 64, 12, 'chest');
    assert.deepEqual(h.catalog.before('build_blueprint:plot-1', { command: 'placeBlock', args: ['oak_planks', -18, 64, 12] }, h.state()), { fail: 'cell_occupied' });
    assert.deepEqual(h.catalog.before('build_blueprint:plot-1', { command: 'breakBlockAt', args: [-18, 64, 12] }, h.state()), { fail: 'plot_not_natural' });
    h.world.set(-18, 64, 12, 'air');
    // a cell outside the plot is never built on
    assert.deepEqual(h.catalog.before('build_blueprint:plot-1', { command: 'placeBlock', args: ['oak_planks', -15, 64, 12] }, h.state()), { fail: 'outside_plot' });
    assert.deepEqual(h.catalog.before('build_blueprint:plot-1', { command: 'placeBlock', args: ['oak_planks', -19, 64, 12] }, h.state()), { intend: [{ x: -19, y: 64, z: 12 }] });

    // someone else's plot, a plot that reaches into the camp, a plot without a plan, a blueprint that does not fit
    const zones = createZones({
        ...WORLD_CONFIG,
        plots: [
            { id: 'miras', owner: 'Mira', min: [-20, 64, 12], max: [-16, 67, 16], blueprint: 'hut' },
            { id: 'in-camp', owner: 'Arthur', min: [6, 64, 6], max: [10, 67, 10], blueprint: 'hut' },
            { id: 'empty', owner: 'Arthur', min: [-30, 64, 20], max: [-26, 67, 24] },
            { id: 'small', owner: 'Arthur', min: [-30, 64, 30], max: [-29, 67, 31], blueprint: 'hut' },
        ],
    });
    const other = createCatalog({ zones, blueprints: BLUEPRINTS });
    const why = (id) => other.check(id, h.state()).reason;
    assert.equal(why('build_blueprint:miras'), 'not_your_plot');
    assert.equal(why('build_blueprint:in-camp'), 'plot_overlaps_zone');
    assert.equal(why('build_blueprint:empty'), 'no_blueprint');
    assert.equal(why('build_blueprint:small'), 'blueprint_too_big');
    assert.deepEqual(other.offer(h.state()).filter((option) => option.skill === 'build_blueprint'), []);
});

test('smelt_item: fuel and input are held and a furnace is reachable', () => {
    const h = setup({ inventory: { raw_iron: 4 } });
    assert.equal(h.reason('smelt_item:raw_iron:4'), 'no_fuel');
    h.body.inventory.oak_planks = 2;
    assert.equal(h.reason('smelt_item:raw_iron:4'), 'not_enough_fuel', '2 planks smelt 3 items');
    h.body.inventory.coal = 1;
    assert.equal(h.reason('smelt_item:raw_iron:4'), null);
    assert.equal(h.reason('smelt_item:raw_iron:5'), 'not_held');
    assert.equal(h.reason('smelt_item:coal:1'), 'not_smeltable');
    h.world.blocked = (from, to) => to.x < 0;
    h.body.position = { x: 20, y: 64, z: 10 };
    assert.equal(h.reason('smelt_item:raw_iron:4'), 'furnace_unreachable');
    h.world.blocked = () => false;
    h.body.position = { x: 40, y: 64, z: 0 };
    assert.equal(h.reason('smelt_item:raw_iron:4'), 'no_furnace');
    // a furnace the agent carries does not count: the step is refused rather than let upstream place it
    h.body.inventory.furnace = 1;
    assert.deepEqual(h.catalog.before('smelt_item:raw_iron:4', { command: 'smeltItem', args: ['raw_iron', 4] }, h.state()), { fail: 'no_furnace_near' });
});

// ---- the pathing permit ------------------------------------------------------------------

test('permit: without one no search may dig; a gather permit digs, but never where the zones forbid it', async () => {
    const zones = createZones(WORLD_CONFIG);
    const forbid = (position) => zones.isProtected(position);
    const movements = { canDig: true, exclusionAreasBreak: [() => 7], countScaffoldingItems: () => 12, allow1by1towers: true, digCost: 1 };

    const view = permitView(movements, { dig_forbidden: forbid, no_place: false });
    assert.equal(view.canDig, true);
    assert.equal(view.digCost, 1, 'every other setting is read from the original');
    const weigh = (position) => view.exclusionAreasBreak.reduce((sum, area) => sum + area({ position }), 0);
    assert.ok(weigh(pos(0, 64, 0)) >= CANNOT_BREAK, 'a block in the camp can be broken');
    assert.ok(weigh(pos(15, 63, 0)) >= CANNOT_BREAK, 'a block in the field can be broken');
    assert.ok(weigh(pos(-18, 65, 14)) >= CANNOT_BREAK, 'a block on a plot can be broken');
    assert.equal(weigh(pos(-40, 60, 0)), 7, 'outside the zones only the caller\'s own areas count');
    assert.equal(view.countScaffoldingItems(), 12);
    assert.deepEqual(movements.exclusionAreasBreak.length, 1, 'the caller\'s Movements object is left alone');
    // a zone check that throws must close, not open
    const broken = permitView(movements, { dig_forbidden: () => { throw new Error('zones gone'); }, no_place: false });
    assert.ok(broken.exclusionAreasBreak.at(-1)({ position: pos(-40, 60, 0) }) >= CANNOT_BREAK);

    // a routine walks without placing anything, and still cannot dig
    const walking = permitView(movements, { dig_forbidden: null, no_place: true });
    assert.equal(walking.canDig, false);
    assert.equal(walking.countScaffoldingItems(), 0);
    assert.equal(walking.allow1by1towers, false);
    assert.equal(permitView(movements, { dig_forbidden: null, no_place: false }), noDigView(movements));

    // on a guarded bot: digging only while the permit is on, and it is taken away whatever happens
    const bot = fakeBot(WALLED);
    noDigPathingPlugin(bot);
    assert.equal(bot.pathfinder.getPathTo({ canDig: true }, {}, 100).status, 'noPath');
    const found = await withPathingPermit(bot, { dig: forbid }, async () => {
        assert.ok(pathingPermit(bot));
        return bot.pathfinder.getPathTo({ canDig: true }, {}, 100);
    });
    assert.equal(found.status, 'success');
    assert.equal(pathingPermit(bot), null);
    assert.deepEqual(bot.searches.map((search) => search.can_dig), [false, true]);
    await assert.rejects(withPathingPermit(bot, { dig: forbid }, async () => { throw new Error('skill failed'); }), /skill failed/);
    assert.equal(pathingPermit(bot), null);
    assert.equal(bot.pathfinder.getPathTo({ canDig: true }, {}, 100).status, 'noPath');
    const open = fakeBot(OPEN);
    noDigPathingPlugin(open);
    await withPathingPermit(open, { no_place: true }, async () => open.pathfinder.getPathTo({ canDig: true }, {}, 100));
    assert.deepEqual(open.searches.map((search) => search.can_dig), [false]);
});
