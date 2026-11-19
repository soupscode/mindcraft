// The building step, part 1: the prefab format, the generated ladder of eight prefabs, the
// per-stage material lists, verification cell by cell by block name, the unlock rule, and
// the schematic importer.
//
// No Minecraft server and no bot: the world is a map of block names. Nothing here has been
// placed by a bot or read from a file WorldEdit wrote.
// Run from the repository root:  node --test genesis/tests/*.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { REPO_ROOT } from './helpers/stubs.mjs';
import { fakeClock } from './helpers/fakes.mjs';
import {
    checkPrefab, prefabCells, clearCells, billOf, stageBills, floatingCells, prefabSize, prefabText, prefabHash, partsOf, needsFacing,
    catalogObtainable, unobtainable, filePrefabs, PREFAB_KINDS,
} from '../build/prefab.js';
import { generateLadder, footbridge, inWood } from '../build/ladder.js';
import { surveyBuild, createVerifier, prefabOrigin, remainingBill, shortfall, matches, VERIFY_WAIT_MS } from '../build/verify.js';
import { unlockState, tierFor, ladderView, projectView, homesView, highestVerified, SHARED_BUILDER } from '../build/unlock.js';
import {
    schemToPrefab, readSchematic, buildSchematic, decodeNbt, encodeNbt, nbt, decodeVarints, encodeVarints, parseBlockState, SCHEMATIC_FORMAT_CHECKED,
} from '../build/schematic.js';
import { GATHER_TYPES, CRAFT_ITEMS, CROPS } from '../catalog/defaults.js';
import { fileBlueprints } from '../catalog/blueprints.js';

const LADDER = generateLadder();
const by_name = Object.fromEntries(LADDER.map((p) => [p.name, p]));
// the catalog as it is now, and as it was before the recipes of the plan's step B2 (main at 72191cb had the
// doors already; slab, fence and ladder were still to come)
const LATER_RECIPES = /(_slab|_fence|^ladder)$/;
const TODAY = catalogObtainable({ gather_types: GATHER_TYPES, craft_items: CRAFT_ITEMS, crops: CROPS });
const BEFORE_RECIPES = catalogObtainable({ gather_types: GATHER_TYPES, craft_items: CRAFT_ITEMS.filter(([item]) => !LATER_RECIPES.test(item)), crops: CROPS });
const WITH_RECIPES = catalogObtainable({ gather_types: GATHER_TYPES, craft_items: [...CRAFT_ITEMS, ['oak_door', 1], ['oak_slab', 1], ['oak_fence', 1], ['ladder', 1]], crops: CROPS });

// The plan's table (section 3.3): tier, kind, x by z by y, cells, bill.
const PLAN = {
    lean_to: [0, 'home', [5, 3, 3], 34, { oak_planks: 33, chest: 1 }],
    shack: [1, 'home', [5, 5, 4], 75, { oak_planks: 59, oak_log: 12, oak_door: 1, chest: 1, torch: 1 }],
    cabin: [2, 'home', [7, 7, 5], 174, { cobblestone: 49, oak_planks: 54, oak_slab: 49, oak_log: 12, glass: 4, oak_door: 1, chest: 1, crafting_table: 1, torch: 2 }],
    cottage: [3, 'home', [9, 7, 6], 244, { cobblestone: 86, oak_planks: 65, oak_slab: 63, oak_log: 16, glass: 6, oak_door: 1, chest: 1, furnace: 1, crafting_table: 1, torch: 3 }],
    house: [4, 'home', [11, 9, 8], 490, { cobblestone: 130, oak_planks: 209, oak_slab: 99, oak_log: 24, glass: 12, ladder: 4, oak_door: 1, chest: 2, furnace: 1, crafting_table: 1, torch: 6 }],
    storehouse: [3, 'shared', [9, 7, 5], 220, { cobblestone: 133, oak_planks: 63, oak_log: 12, chest: 6, oak_door: 1, torch: 4 }],
    hall: [4, 'shared', [15, 11, 7], 602, { cobblestone: 237, oak_planks: 267, oak_log: 70, glass: 12, oak_door: 2, chest: 2, furnace: 1, crafting_table: 1, torch: 8 }],
    footbridge: [1, 'bridge', [3, 9, 2], 45, { oak_planks: 27, oak_fence: 14, oak_log: 4 }],
};

// A world that is a map of block names. Everything not set is air; unloaded(pos) makes a cell unknown.
function blockWorld() {
    const blocks = new Map();
    const gone = new Set();
    const key = (p) => `${p.x},${p.y},${p.z}`;
    return {
        set(p, name) { blocks.set(key(p), name); },
        unload(p) { gone.add(key(p)); },
        blockAt: (p) => (gone.has(key(p)) ? null : { name: blocks.get(key(p)) ?? 'air' }),
        // puts every cell of the prefab where it belongs (or only the cells of the first `stages` stages)
        build(prefab, origin, stages = Infinity) {
            for (const cell of prefabCells(prefab)) if (cell.stage < stages) blocks.set(key({ x: origin.x + cell.x, y: origin.y + cell.y, z: origin.z + cell.z }), cell.want);
        },
    };
}

// ---- the ladder --------------------------------------------------------------------------------

test('ladder: eight prefabs with the sizes, cell counts and bills of the plan, and every one holds', () => {
    assert.deepEqual(LADDER.map((p) => p.name), ['lean_to', 'shack', 'footbridge', 'cabin', 'cottage', 'storehouse', 'house', 'hall']);
    for (const prefab of LADDER) {
        const [tier, kind, [x, z, y], cells, bill] = PLAN[prefab.name];
        assert.deepEqual([prefab.tier, prefab.kind, prefab.by, prefab.v], [tier, kind, 'Generated', 1], prefab.name);
        assert.deepEqual(prefabSize(prefab), { x, y, z }, `${prefab.name}: size`);
        assert.deepEqual(prefab.size, { x, y, z });
        assert.equal(billOf(prefab).cells, cells, `${prefab.name}: cells`);
        assert.deepEqual(billOf(prefab).materials, bill, `${prefab.name}: bill`);
        assert.deepEqual(prefab.materials, bill);
        assert.deepEqual(checkPrefab(prefab), [], prefab.name);
        assert.equal(floatingCells(prefab).length, 0, `${prefab.name}: no cell is placed against nothing, stage by stage`);
        assert.ok(PREFAB_KINDS.includes(prefab.kind));
    }
    assert.equal(generateLadder().map(prefabText).join(''), LADDER.map(prefabText).join(''), 'the generator gives the same files every time');
});

test('ladder: the files in genesis/prefabs are what the generator gives, and load as blueprints', () => {
    const dir = path.join(REPO_ROOT, 'genesis', 'prefabs');
    const prefabs = filePrefabs([dir]);
    assert.deepEqual(prefabs.names(), LADDER.map((p) => p.name).sort());
    for (const prefab of LADDER) {
        assert.equal(readFileSync(path.join(dir, `${prefab.name}.json`), 'utf8'), prefabText(prefab), `${prefab.name}.json is stale: node genesis/tools/make_prefabs.js`);
        const loaded = prefabs.get(prefab.name);
        assert.deepEqual(loaded.blocks, prefab.blocks);
        assert.deepEqual(loaded.materials, prefab.materials);
        assert.equal(loaded.cells, PLAN[prefab.name][3]);
        assert.equal(prefabHash(loaded), prefabHash(prefab));
        assert.ok(Array.isArray(loaded.blocks) && typeof loaded.name === 'string', 'the shape genesis/catalog/blueprints.js gives');
    }
    assert.equal(prefabs.get('no_such_prefab'), null);
    assert.equal(prefabs.get('../settings'), null);
});

test('ladder: every name is an exact Minecraft 1.21.6 block name that is also the item\'s name', (t) => {
    let data;
    try {
        data = createRequire(path.join(REPO_ROOT, 'package.json'))('minecraft-data')(JSON.parse(readFileSync(path.join(REPO_ROOT, 'genesis', 'settings.json'), 'utf8')).minecraft_version);
    } catch (err) {
        t.skip(`minecraft-data is not installed (${err.code ?? err.message}): the names were not checked against the game data`);
        return;
    }
    const used = new Set();
    for (const prefab of [...LADDER, inWood(by_name.cabin, 'birch'), inWood(by_name.footbridge, 'spruce'), footbridge(15)]) for (const cell of prefabCells(prefab)) used.add(cell.want);
    assert.ok(used.size >= 12);
    for (const name of used) {
        assert.ok(data.blocksByName[name], `${name} is not a block in ${data.version.minecraftVersion}`);
        assert.ok(data.itemsByName[name], `${name} is not an item in ${data.version.minecraftVersion}`);
    }
    assert.equal(data.version.minecraftVersion, '1.21.6');
    assert.ok(!data.blocksByName.planks && !data.blocksByName.log && !data.blocksByName.door, 'the generic names the shipped blueprints use are not block names');
});

test('ladder: without the slab, fence and ladder recipes four prefabs wait; the doors main already has open the rest', () => {
    const blocked = Object.fromEntries(LADDER.map((p) => [p.name, unobtainable(p, BEFORE_RECIPES)]));
    assert.deepEqual(blocked, {
        lean_to: [], shack: [], footbridge: ['oak_fence'], cabin: ['oak_slab'], cottage: ['oak_slab'],
        storehouse: [], house: ['ladder', 'oak_slab'], hall: [],
    });
    assert.ok(BEFORE_RECIPES('glass'), 'glass: sand is gathered and smelted');
    assert.ok(BEFORE_RECIPES('oak_door') && BEFORE_RECIPES('birch_door') && BEFORE_RECIPES('spruce_door'), 'the door recipes are on main');
    for (const prefab of LADDER) assert.deepEqual(unobtainable(prefab, WITH_RECIPES), [], `${prefab.name} with the recipes`);
    // the recipes are in: with the catalog as it is now every prefab of the ladder can be built
    for (const prefab of LADDER) assert.deepEqual(unobtainable(prefab, TODAY), [], `${prefab.name} today`);
    assert.match(checkPrefab(by_name.cabin, { obtainable: BEFORE_RECIPES }).join(), /not buildable yet: the catalog cannot obtain oak_slab/);
    assert.deepEqual(checkPrefab(by_name.lean_to, { obtainable: BEFORE_RECIPES }), []);
    assert.deepEqual(checkPrefab(by_name.shack, { obtainable: BEFORE_RECIPES }), []);
});

test('ladder: the shipped small_wood_house blueprint is reported as not buildable (it uses generic names)', () => {
    const shipped = fileBlueprints(path.join(REPO_ROOT, 'src', 'agent', 'npc', 'construction')).get('small_wood_house');
    assert.ok(shipped, 'the blueprint upstream ships');
    const missing = unobtainable({ ...shipped, stages: undefined }, WITH_RECIPES);
    assert.ok(missing.includes('planks') && missing.includes('log'), `not obtainable: ${missing.join(', ')}`);
    assert.equal(unlockState({ prefab: { ...shipped, kind: 'home', tier: 1 }, builder: 'Arthur', obtainable: WITH_RECIPES }).state, 'not_buildable');
});

test('homes: every tier has the chest at the same cell of the plot, the door on the same side, and a clear place for a bed', () => {
    const homes = LADDER.filter((p) => p.kind === 'home');
    assert.deepEqual(homes.map((p) => [p.name, p.upgrade_of ?? null]), [['lean_to', null], ['shack', 'lean_to'], ['cabin', 'shack'], ['cottage', 'cabin'], ['house', 'cottage']]);
    for (const prefab of homes) {
        const [x, y, z] = prefab.keeps[0].at;
        assert.equal(prefab.blocks[y][z][x], 'chest');
        // on the plot: the prefab's corner sits `below` layers under the plot's floor
        assert.deepEqual([x, y - prefab.below, z], [1, 0, 1], `${prefab.name}: the personal chest is one in from the corner, on the floor`);
        for (const [bx, byy, bz] of [prefab.bed.head, prefab.bed.foot]) {
            assert.equal(prefab.blocks[byy][bz][bx], 'air', `${prefab.name}: the bed place is clear`);
            assert.equal(byy - prefab.below, 0, 'on the floor');
            assert.equal(prefab.blocks[byy + 1][bz][bx], 'air', 'with room above it');
        }
        assert.equal(Math.abs(prefab.bed.head[0] - prefab.bed.foot[0]) + Math.abs(prefab.bed.head[2] - prefab.bed.foot[2]), 1, 'two cells side by side');
        if (prefab.name !== 'lean_to') {
            const doors = prefabCells(prefab).filter((c) => c.want === 'oak_door');
            assert.ok(doors.length === 2 && doors.every((c) => c.z === prefab.size.z - 1), `${prefab.name}: the door is on the far z side`);
        }
    }
    assert.ok(LADDER.filter((p) => p.kind !== 'home').every((p) => !p.bed), 'only homes have a bed place');
});

test('ladder: the footbridge comes in lengths 5 to 15, and every prefab in birch and spruce', () => {
    for (let length = 5; length <= 15; length++) {
        const bridge = footbridge(length);
        assert.deepEqual(checkPrefab(bridge), []);
        assert.deepEqual(prefabSize(bridge), { x: 3, y: 2, z: length });
        assert.deepEqual(bridge.materials, { oak_planks: 3 * length, oak_fence: 2 * length - 4, oak_log: 4 });
    }
    assert.throws(() => footbridge(4), /5 to 15 long/);
    assert.throws(() => footbridge(16), /5 to 15 long/);
    const birch = inWood(by_name.cabin, 'birch');
    assert.deepEqual(checkPrefab(birch), []);
    assert.deepEqual(birch.materials, { cobblestone: 49, birch_planks: 54, birch_slab: 49, birch_log: 12, glass: 4, birch_door: 1, chest: 1, crafting_table: 1, torch: 2 });
    assert.deepEqual([birch.name, birch.upgrade_of, partsOf('birch_door', birch.parts)], ['cabin_birch', 'shack_birch', 2]);
    assert.equal(inWood(by_name.cabin, 'oak'), by_name.cabin);
    assert.throws(() => inWood(by_name.cabin, 'mahogany'), /oak, birch or spruce/);
});

// ---- the format's rules ---------------------------------------------------------------------------

test('prefab format: what does not hold is refused, with the reason', () => {
    const base = () => JSON.parse(JSON.stringify(by_name.shack));
    const problems = (change) => { const p = base(); change(p); return checkPrefab(p).join(' | '); };
    assert.match(problems((p) => { p.name = 'my shack'; }), /name must match/);
    assert.match(problems((p) => { p.kind = 'castle'; }), /kind must be one of/);
    assert.match(problems((p) => { p.by = 'Somebody'; }), /by must be one of/);
    assert.match(problems((p) => { p.materials.oak_planks = 58; }), /materials do not match the blocks/);
    assert.match(problems((p) => { p.size.x = 6; }), /size says/);
    assert.match(problems((p) => { p.blocks[2][2][2] = 'oak_planks'; }), /1 cells would be placed against nothing in build order \(first: oak_planks at 2,2,2\)/);
    assert.match(problems((p) => { p.blocks[1].pop(); }), /every layer must have the same number of rows/);
    assert.match(problems((p) => { p.blocks[0][0][0] = 'Oak Planks'; }), /is not a block name/);
    assert.match(problems((p) => { p.blocks[0][0][0] = 7; }), /every cell must be a block name/);
    assert.match(problems((p) => { p.stages = [{ name: 'Walls', y: [0, 1] }]; }), /cells belong to no stage/);
    assert.match(problems((p) => { p.keeps[0].at = [2, 0, 2]; }), /keeps names chest/);
    assert.match(problems((p) => { p.bed.head = [0, 0, 0]; }), /bed place .* is not a clear cell/);
    assert.match(problems((p) => { p.below = 9; }), /below must be/);
    // nothing the bot cannot place the right way round, in a generated prefab
    for (const block of ['red_bed', 'oak_stairs', 'wall_torch']) {
        assert.match(problems((p) => { p.blocks[0][1][2] = block; p.materials = undefined; }), new RegExp(`${block} is not allowed in a generated prefab`));
        assert.equal(needsFacing(block), true);
    }
    // a torch stands on something
    assert.match(problems((p) => { p.blocks[1][1][2] = 'torch'; p.materials = undefined; }), /the torch at 2,1,1 stands on nothing/);
    assert.equal(checkPrefab(null)[0], 'a prefab must be an object');
    assert.match(checkPrefab({ ...base(), blocks: [] }).join(), /blocks must be a list of layers/);
    assert.equal(clearCells(by_name.lean_to).length, 11, 'the inside of the lean-to is kept clear: 3 by 2, two high, less the chest');
    assert.deepEqual([partsOf('oak_door'), partsOf('white_bed'), partsOf('chest'), partsOf('chest', { chest: 2 })], [2, 2, 1, 2]);
});

test('materials per stage: built in order, a door is two cells and one item, and the stages add up to the bill', () => {
    // the Storehouse panel of the Town mock-up: Foundation 63, Walls 82, Roof 63, Fittings 12
    assert.deepEqual(stageBills(by_name.storehouse), [
        { name: 'Foundation', index: 0, cells: 63, materials: { cobblestone: 63 } },
        { name: 'Walls', index: 1, cells: 82, materials: { cobblestone: 70, oak_log: 12 } },
        { name: 'Roof', index: 2, cells: 63, materials: { oak_planks: 63 } },
        { name: 'Fittings', index: 3, cells: 12, materials: { chest: 6, oak_door: 1, torch: 4 } },
    ]);
    assert.deepEqual(stageBills(by_name.lean_to).map((s) => [s.name, s.cells]), [['Walls', 18], ['Roof', 15], ['Fittings', 1]]);
    assert.deepEqual(stageBills(by_name.footbridge).map((s) => [s.name, s.materials]), [['Deck', { oak_planks: 27 }], ['Rails', { oak_fence: 14, oak_log: 4 }]]);
    for (const prefab of LADDER) {
        const stages = stageBills(prefab);
        assert.equal(stages.reduce((n, s) => n + s.cells, 0), billOf(prefab).cells, prefab.name);
        const sum = {};
        for (const stage of stages) for (const [item, n] of Object.entries(stage.materials)) sum[item] = (sum[item] ?? 0) + n;
        assert.deepEqual(sum, prefab.materials, `${prefab.name}: the stage bills add up`);
        // build order is stage by stage, then bottom up
        const cells = prefabCells(prefab);
        for (let i = 1; i < cells.length; i++) assert.ok(cells[i].stage > cells[i - 1].stage || (cells[i].stage === cells[i - 1].stage && cells[i].y >= cells[i - 1].y));
    }
});

// ---- verification ------------------------------------------------------------------------------------

test('verification: cell by cell, by block name; a wrong, missing, foreign or unloaded cell stops it', () => {
    const prefab = by_name.cabin;
    const plot_min = { x: 100, y: 64, z: -40 };
    const origin = prefabOrigin(plot_min, prefab);
    assert.deepEqual(origin, { x: 100, y: 63, z: -40 }, 'the stone floor lies in the ground: one layer under the plot\'s floor');
    assert.deepEqual(prefabOrigin(plot_min, by_name.shack), plot_min);

    const world = blockWorld();
    const empty = surveyBuild({ prefab, origin, blockAt: world.blockAt });
    assert.deepEqual([empty.total, empty.matching, empty.complete, empty.stage], [174, 0, false, 'Foundation']);

    world.build(prefab, origin, 2);       // foundation and walls
    const half = surveyBuild({ prefab, origin, blockAt: world.blockAt });
    assert.deepEqual(half.stages.map((s) => [s.name, s.matching, s.total]), [['Foundation', 49, 49], ['Walls', 66, 66], ['Roof', 0, 49], ['Fittings', 0, 10]]);
    assert.deepEqual([half.stage, half.complete, half.matching], ['Roof', false, 115]);
    assert.deepEqual(remainingBill(prefab, half), { chest: 1, crafting_table: 1, glass: 4, oak_door: 1, oak_slab: 49, torch: 2 });
    assert.deepEqual(remainingBill(prefab, half, 'Roof'), { oak_slab: 49 });
    assert.deepEqual(shortfall({ oak_slab: 49, torch: 2 }, { oak_slab: 40, torch: 8 }), { oak_slab: 9 });

    world.build(prefab, origin);
    const done = surveyBuild({ prefab, origin, blockAt: world.blockAt });
    assert.deepEqual([done.matching, done.complete, done.stage, done.wrong.length], [174, true, null, 0]);

    // one cell with another block: named with what it wants and what it has
    const wall = { x: origin.x, y: origin.y + 2, z: origin.z + 2 };
    world.set(wall, 'birch_planks');
    const wrong = surveyBuild({ prefab, origin, blockAt: world.blockAt });
    assert.deepEqual([wrong.complete, wrong.wrong.length, wrong.wrong[0].want, wrong.wrong[0].have], [false, 1, 'oak_planks', 'birch_planks']);
    world.set(wall, 'oak_planks');
    // something left standing where the inside must be clear
    const inside = { x: origin.x + 3, y: origin.y + 2, z: origin.z + 3 };
    world.set(inside, 'dirt');
    const blocked = surveyBuild({ prefab, origin, blockAt: world.blockAt });
    assert.deepEqual([blocked.complete, blocked.blocked.length, blocked.blocked[0].have, blocked.matching], [false, 1, 'dirt', 174]);
    world.set(inside, 'air');
    // a cell that is not loaded is not assumed to be right
    world.unload({ x: origin.x + 6, y: origin.y + 4, z: origin.z + 6 });
    assert.deepEqual([surveyBuild({ prefab, origin, blockAt: world.blockAt }).complete, surveyBuild({ prefab, origin, blockAt: world.blockAt }).unloaded], [false, 1]);

    // names only: a torch the bot put on the side of a block is a wall_torch, and is accepted; nothing else is
    assert.deepEqual([matches('torch', 'wall_torch'), matches('torch', 'torch'), matches('oak_planks', 'birch_planks'), matches('oak_slab', 'oak_planks'), matches('dirt', 'grass_block')], [true, true, false, false, true]);
});

test('verification: finished means every cell matched twice, at least 60 seconds apart, with no scaffold left', async () => {
    const clock = fakeClock();
    const verifier = createVerifier({ clock });
    const prefab = by_name.lean_to;
    const origin = { x: 0, y: 64, z: 0 };
    const world = blockWorld();
    const survey = () => surveyBuild({ prefab, origin, blockAt: world.blockAt });
    assert.equal(verifier.check('b1', survey()).state, 'not_finished');
    world.build(prefab, origin);
    assert.equal(verifier.check('b1', survey(), { scaffold: 2 }).state, 'not_finished', 'scaffold blocks still stand');
    assert.match(verifier.check('b1', survey(), { scaffold: 2 }).reason, /2 scaffold blocks still stand/);
    assert.equal(verifier.check('b1', survey()).state, 'first_pass');
    await clock.advance(VERIFY_WAIT_MS - 1000);
    assert.equal(verifier.check('b1', survey()).state, 'waiting');
    // a block breaks in between: the first pass no longer counts
    world.set({ x: 0, y: 64, z: 0 }, 'air');
    await clock.advance(2000);
    const broken = verifier.check('b1', survey());
    assert.deepEqual([broken.state, broken.reason], ['not_finished', '1 cells do not match (first: wants oak_planks, has air)']);
    world.set({ x: 0, y: 64, z: 0 }, 'oak_planks');
    assert.equal(verifier.check('b1', survey()).state, 'first_pass');
    await clock.advance(VERIFY_WAIT_MS);
    const verified = verifier.check('b1', survey());
    assert.deepEqual([verified.state, verified.verified_at], ['verified', clock.now()]);
    assert.equal(verifier.check('b2', survey()).state, 'first_pass', 'each build is checked on its own');
    assert.equal(VERIFY_WAIT_MS, 60000);
});

// ---- the unlock rule -----------------------------------------------------------------------------------

const verified = (builder, prefab, day = 1) => ({ builder, prefab, tier: by_name[prefab].tier, plot: `${builder.toLowerCase()}-1`, verified_at: 1000, verified_day: day });
const rule = (prefab, builder, builds, stock) => unlockState({ prefab: by_name[prefab], builder, builds, stock, ladder: LADDER, obtainable: WITH_RECIPES });
const PLENTY = { oak_planks: 999, oak_log: 999, cobblestone: 999, oak_slab: 999, chest: 9, torch: 9, oak_door: 9, glass: 99, oak_fence: 99, ladder: 9, furnace: 9, crafting_table: 9 };

test('unlock: tiers 0 and 1 are open to everyone once the town holds the whole first stage of materials', () => {
    // the lean-to's first stage is its walls: 18 planks
    assert.deepEqual(rule('lean_to', 'Mira', [], { oak_planks: 18 }), { state: 'open', code: 'open', reason: 'Materials ready', needs: null, short: null, stage: 'Walls' });
    const short = rule('lean_to', 'Mira', [], { oak_planks: 17 });
    assert.deepEqual([short.state, short.code, short.reason, short.short], ['locked', 'town_short', 'Short 1 oak_planks', { oak_planks: 1 }]);
    assert.equal(rule('lean_to', 'Mira', [], {}).reason, 'Short 18 oak_planks');
    // the shack's first stage: 12 logs for the corners and the planks of the walls, not the roof and not the door
    assert.deepEqual(stageBills(by_name.shack)[0].materials, { oak_log: 12, oak_planks: 34 });
    assert.equal(rule('shack', 'Felix', [], { oak_log: 12, oak_planks: 34 }).state, 'open', 'no earlier build is needed for tier 1');
    assert.equal(rule('shack', 'Felix', [], { oak_log: 12, oak_planks: 20 }).reason, 'Short 14 oak_planks');
    assert.equal(rule('shack', 'Felix', [], { oak_planks: 20 }).reason, 'Short 14 oak_planks and 1 more');
});

test('unlock: a bigger tier needs a verified build of the tier below, of any kind; shared and bridge prefabs are Arthur\'s', () => {
    assert.deepEqual([rule('cabin', 'Mira', [], PLENTY).state, rule('cabin', 'Mira', [], PLENTY).reason, rule('cabin', 'Mira', [], PLENTY).needs], ['locked', 'Needs Shack', 'shack']);
    assert.equal(rule('cabin', 'Mira', [verified('Mira', 'lean_to')], PLENTY).reason, 'Needs Shack', 'a tier 0 build does not open tier 2');
    assert.equal(rule('cabin', 'Mira', [verified('Nova', 'shack')], PLENTY).state, 'locked', 'somebody else\'s build does not count');
    assert.equal(rule('cabin', 'Mira', [{ ...verified('Mira', 'shack'), verified_at: null }], PLENTY).state, 'locked', 'a build that is not verified does not count');
    assert.equal(rule('cabin', 'Mira', [verified('Mira', 'shack')], PLENTY).state, 'open');
    assert.equal(rule('cabin', 'Arthur', [verified('Arthur', 'footbridge')], PLENTY).state, 'open', 'any kind: a footbridge is a tier 1 build');
    // the plan's example: the Storehouse opens to Arthur once his Cabin is verified, the Hall once the Storehouse or a Cottage is
    assert.equal(rule('storehouse', 'Arthur', [verified('Arthur', 'shack')], PLENTY).reason, 'Needs Cabin');
    assert.equal(rule('storehouse', 'Arthur', [verified('Arthur', 'cabin')], PLENTY).state, 'open');
    assert.equal(rule('hall', 'Arthur', [verified('Arthur', 'cabin')], PLENTY).reason, 'Needs Storehouse');
    assert.equal(rule('house', 'Arthur', [verified('Arthur', 'cabin')], PLENTY).reason, 'Needs Cottage');
    assert.equal(rule('hall', 'Arthur', [verified('Arthur', 'storehouse')], PLENTY).state, 'open');
    assert.equal(rule('hall', 'Arthur', [verified('Arthur', 'cottage')], PLENTY).state, 'open');
    assert.equal(rule('hall', 'Arthur', [verified('Arthur', 'storehouse')], { ...PLENTY, cobblestone: 100 }).reason, 'Short 65 cobblestone', 'the Hall\'s foundation is 165 cobblestone');
    // everyone builds their own home; Arthur also builds the shared and large projects
    assert.deepEqual([rule('storehouse', 'Mira', [verified('Mira', 'cabin')], PLENTY).state, rule('storehouse', 'Mira', [verified('Mira', 'cabin')], PLENTY).code], ['locked', 'not_yours']);
    assert.equal(rule('footbridge', 'Felix', [], PLENTY).code, 'not_yours');
    assert.equal(rule('footbridge', 'Arthur', [], PLENTY).state, 'open');
    assert.equal(SHARED_BUILDER, 'Arthur');
    assert.equal(highestVerified([verified('Arthur', 'cabin'), verified('Arthur', 'shack'), verified('Mira', 'house')], 'Arthur'), 2);
    // a block the catalog cannot get comes before everything else
    const before = unlockState({ prefab: by_name.house, builder: 'Mira', builds: [verified('Mira', 'cottage')], stock: PLENTY, ladder: LADDER, obtainable: BEFORE_RECIPES });
    assert.deepEqual([before.state, before.reason], ['not_buildable', 'Not buildable yet: ladder, oak_slab']);
});

test('town view data: the ladder, the project panel and the homes, in the shape the approved mock-up shows', () => {
    const builds = [verified('Arthur', 'lean_to', 3), verified('Arthur', 'shack', 12), verified('Arthur', 'cabin', 33), verified('Mira', 'lean_to', 2), verified('Mira', 'shack', 12), verified('Felix', 'lean_to', 4)];
    const stock = { cobblestone: 200, oak_planks: 60, oak_log: 20, oak_slab: 0, torch: 8, oak_door: 1 };
    const active = [{ prefab: 'storehouse', builder: 'Arthur', cells_matching: 117, cells_total: 220 }];
    const stall = { v: 1, name: 'market_stall', title: 'Market stall', kind: 'shared', tier: 1, by: 'Operator', blocks: [[['oak_planks', 'oak_planks']], [['oak_fence', 'stone_bricks']]] };
    const view = ladderView({ prefabs: [...LADDER, stall], builds, stock, active, obtainable: WITH_RECIPES });
    const rows = Object.fromEntries(view.generated.list.map((e) => [e.name, [e.tier, e.state, e.detail]]));
    assert.deepEqual(rows, {
        lean_to: [0, 'Open', 'Built 3'], shack: [1, 'Open', 'Built 2'], footbridge: [1, 'Open', 'Built 0'], cabin: [2, 'Open', 'Built 1'],
        cottage: [3, 'Open', 'Built 0'], storehouse: [3, 'Building', '117 / 220'], house: [4, 'Locked', 'Needs Cottage'], hall: [4, 'Locked', 'Needs Storehouse'],
    });
    assert.deepEqual([view.generated.open, view.generated.building, view.generated.locked], [5, 1, 2]);
    assert.deepEqual(view.generated.list.find((e) => e.name === 'cabin'), { ...view.generated.list.find((e) => e.name === 'cabin'), title: 'Cabin', kind: 'home', by: 'Generated', size: { x: 7, y: 5, z: 7 }, cells: 174 });
    assert.deepEqual(view.operator.list.map((e) => [e.title, e.state, e.detail, e.by]), [['Market stall', 'Not buildable', 'Not buildable yet: stone_bricks', 'Operator']]);

    // Arthur's project: the Storehouse with its foundation and most of its walls standing
    const prefab = by_name.storehouse;
    const origin = prefabOrigin({ x: 0, y: 64, z: 0 }, prefab);
    const world = blockWorld();
    world.build(prefab, origin, 1);
    const walls = prefabCells(prefab).filter((c) => c.stage === 1).slice(0, 54);
    for (const c of walls) world.set({ x: origin.x + c.x, y: origin.y + c.y, z: origin.z + c.z }, c.want);
    const survey = surveyBuild({ prefab, origin, blockAt: world.blockAt });
    const project = projectView({ prefab, build: { build_id: 'b7', plot: 'town-6', builder: 'Arthur' }, survey, stock: { cobblestone: 16, oak_planks: 40, oak_log: 12, torch: 8, oak_door: 1 },
        asked: { cobblestone: 'Felix', oak_planks: 'Nova' }, next: { title: 'Hall', state: 'Locked', detail: 'Needs Storehouse' } });
    assert.deepEqual([project.title, project.kind, project.tier, project.plot, project.state, project.check], ['Storehouse', 'shared', 3, 'town-6', 'Building', 'By name']);
    assert.deepEqual(project.size, { x: 9, y: 5, z: 7 });
    assert.deepEqual(project.cells, { done: 117, total: 220 });
    assert.deepEqual(project.stages.map((s) => [s.name, s.done, s.total]), [['Foundation', 63, 63], ['Walls', 54, 82], ['Roof', 0, 63], ['Fittings', 0, 12]]);
    const material = Object.fromEntries(project.materials.map((m) => [m.item, [m.need, m.have, m.short, m.state]]));
    assert.deepEqual(material.oak_planks, [63, 40, 23, 'Asked Nova']);
    assert.deepEqual(material.chest, [6, 0, 6, 'Short']);
    assert.deepEqual(material.torch, [4, 8, 0, 'Ready']);
    assert.deepEqual(material.oak_door, [1, 1, 0, 'Ready']);
    assert.equal(material.cobblestone[3], material.cobblestone[2] > 0 ? 'Asked Felix' : 'Ready');
    assert.deepEqual([project.verified, project.next.detail], [null, 'Needs Storehouse']);

    const homes = homesView({ agents: ['Arthur', 'Mira', 'Felix', 'Nova'], roles: { Arthur: 'Builder' }, plots: { Nova: 'nova-1' }, builds, prefabs: LADDER, stock,
        active: [{ prefab: 'cabin', builder: 'Mira', cells_matching: 66, cells_total: 174 }], obtainable: WITH_RECIPES });
    assert.deepEqual(homes.map((h) => [h.agent, h.home?.title ?? null, h.home?.tier ?? null, h.home?.verified_day ?? null, h.next.title, h.next.state, h.next.detail]), [
        ['Arthur', 'Cabin', 2, 33, 'Cottage', 'Open', 'Materials ready'],
        ['Mira', 'Shack', 1, 12, 'Cabin', 'Building', '66 / 174'],
        ['Felix', 'Lean-to', 0, 4, 'Shack', 'Open', 'Materials ready'],
        ['Nova', null, null, null, 'Lean-to', 'Open', 'Materials ready'],
    ]);
    assert.deepEqual([homes[0].role, homes[0].plot, homes[3].plot], ['Builder', 'arthur-1', 'nova-1']);
    assert.deepEqual([homes[0].home.chest, homes[0].home.bed], [{ block: 'chest', at: [1, 1, 1] }, { head: [1, 1, 2], foot: [1, 1, 3] }], 'where the agent\'s own chest and bed are');
});

test('tier by size: an operator\'s prefab is placed on the ladder by its cells and footprint', () => {
    const box = (x, z, y) => ({ v: 1, name: 'box', kind: 'shared', tier: 0, by: 'Operator', blocks: Array.from({ length: y }, () => Array.from({ length: z }, () => Array(x).fill('cobblestone'))) });
    assert.equal(tierFor(box(3, 3, 3), LADDER), 0, '27 cells: no bigger than a lean-to');
    assert.equal(tierFor(box(5, 4, 2), LADDER), 1, '40 cells: over the lean-to\'s 34');
    assert.equal(tierFor(box(6, 3, 5), LADDER), 2, '90 cells: over the shack\'s 75');
    assert.equal(tierFor(box(7, 7, 4), LADDER), 3, '196 cells');
    assert.equal(tierFor(box(7, 7, 8), LADDER), 4, '392 cells');
    assert.equal(tierFor(box(12, 2, 1), LADDER), 4, '24 cells, but 12 long: too long for a tier 3 footprint');
    assert.equal(tierFor(box(16, 16, 4), LADDER), 5, 'bigger than everything generated: one above the top');
});

// ---- the schematic importer ---------------------------------------------------------------------------------

const AIR = 'minecraft:air';
const SAVED = [   // blocks[y][z][x], as WorldEdit names them; an empty layer on top and an empty column at the side
    [[AIR, 'minecraft:cobblestone', 'minecraft:cobblestone', 'minecraft:cobblestone'], [AIR, 'minecraft:cobblestone', 'minecraft:chest[facing=north,type=single,waterlogged=false]', 'minecraft:cobblestone']],
    [[AIR, 'minecraft:oak_stairs[facing=east,half=bottom,shape=straight,waterlogged=false]', AIR, 'minecraft:stone_bricks'], [AIR, 'minecraft:oak_planks', 'minecraft:wall_torch[facing=south]', 'minecraft:oak_planks']],
    [[AIR, 'minecraft:oak_slab[type=bottom,waterlogged=false]', 'minecraft:oak_slab[type=bottom,waterlogged=false]', 'minecraft:oak_slab[type=bottom,waterlogged=false]'], [AIR, 'minecraft:oak_slab[type=top,waterlogged=false]', 'minecraft:oak_slab[type=bottom,waterlogged=false]', 'minecraft:water[level=0]']],
    [[AIR, AIR, AIR, AIR], [AIR, AIR, AIR, AIR]],
];
const EXPECTED_BLOCKS = [
    [['cobblestone', 'cobblestone', 'cobblestone'], ['cobblestone', 'chest', 'cobblestone']],
    [['oak_stairs', '', 'stone_bricks'], ['oak_planks', 'wall_torch', 'oak_planks']],
    [['oak_slab', 'oak_slab', 'oak_slab'], ['oak_slab', 'oak_slab', 'water']],
];

test('schematic importer (format unchecked against a real WorldEdit file): a version 2 and a version 3 file convert to the expected prefab', () => {
    assert.equal(SCHEMATIC_FORMAT_CHECKED, false, 'no file saved by WorldEdit has been read with this');
    for (const version of [2, 3]) {
        const file = buildSchematic({ blocks: SAVED, version, block_entities: [{ pos: [2, 0, 1], id: 'minecraft:chest' }] });
        assert.deepEqual([file[0], file[1]], [0x1f, 0x8b], 'gzip-compressed, like a real one');
        const read = readSchematic(file);
        assert.deepEqual([read.version, read.width, read.height, read.length, read.data.length, read.block_entities.length], [version, 4, 4, 2, 32, 1]);

        const { prefab, report } = schemToPrefab(file, { name: 'stall', title: 'Market stall', source_file: 'stall.schem', obtainable: WITH_RECIPES, ladder: LADDER, now: Date.parse('2026-11-17T00:00:00Z') });
        assert.deepEqual(prefab.blocks, EXPECTED_BLOCKS, `version ${version}`);
        assert.deepEqual([prefab.name, prefab.title, prefab.by, prefab.kind, prefab.v], ['stall', 'Market stall', 'Operator', 'shared', 1]);
        assert.deepEqual(prefab.size, { x: 3, y: 3, z: 2 });
        // the bill is in items: the wall torch is a torch
        assert.deepEqual(prefab.materials, { chest: 1, cobblestone: 5, oak_planks: 2, oak_slab: 5, oak_stairs: 1, stone_bricks: 1, torch: 1, water: 1 });
        assert.deepEqual(prefab.source, { file: 'stall.schem', sha256: prefab.source.sha256, converted_at: '2026-11-17T00:00:00.000Z', schematic_version: version, format_checked: false });
        assert.match(prefab.source.sha256, /^[0-9a-f]{64}$/);
        assert.equal(prefab.tier, 0, '17 cells: placed on the ladder by size');
        // what it could not carry over is reported, never guessed
        assert.deepEqual(report.unobtainable, { oak_stairs: 1, stone_bricks: 1, water: 1 });
        assert.deepEqual(report.no_item, ['wall_torch', 'water']);
        assert.deepEqual(report.dropped_states, { chest: ['facing', 'type', 'waterlogged'], oak_slab: ['type', 'waterlogged'], oak_stairs: ['facing', 'half', 'shape', 'waterlogged'], wall_torch: ['facing'], water: ['level'] });
        assert.deepEqual([report.block_entities, report.trimmed_layers, report.cells, report.too_big, report.buildable, report.format_checked], [1, 1, 17, false, false, false]);
        assert.deepEqual(report.needs_facing, ['oak_stairs', 'wall_torch']);
        assert.deepEqual(report.problems, []);
        assert.equal(unlockState({ prefab, builder: 'Arthur', obtainable: WITH_RECIPES, ladder: LADDER, stock: PLENTY }).state, 'not_buildable');

        // the operator's own substitutes make it buildable; nothing is substituted unasked
        const swapped = schemToPrefab(file, { name: 'stall', obtainable: WITH_RECIPES, ladder: LADDER, substitute: { oak_stairs: 'oak_planks', stone_bricks: 'cobblestone', water: 'glass' } });
        assert.deepEqual(swapped.report.unobtainable, {});
        assert.deepEqual(swapped.report.substituted, { oak_stairs: 'oak_planks', stone_bricks: 'cobblestone', water: 'glass' });
        assert.equal(swapped.report.buildable, true);
        assert.equal(schemToPrefab(file, { name: 'stall', air: 'clear' }).prefab.blocks[1][0][1], 'air', 'asked for: air in the schematic keeps the cell clear');
    }
});

test('schematic importer: a file it cannot read is refused with the reason, and a structure too big for any plot is reported', () => {
    const good = buildSchematic({ blocks: SAVED, version: 3, compress: false });
    assert.throws(() => readSchematic(good.subarray(0, good.length - 20)), /ends early/);
    assert.throws(() => readSchematic(Buffer.from([1, 2, 3])), /must start with a compound/);
    assert.throws(() => readSchematic(encodeNbt(nbt.compound({ Version: nbt.int(1), Width: nbt.short(1), Height: nbt.short(1), Length: nbt.short(1) }), 'Schematic')), /version 1 is not supported/);
    const short_data = encodeNbt(nbt.compound({ Version: nbt.int(2), Width: nbt.short(2), Height: nbt.short(1), Length: nbt.short(1), Palette: nbt.compound({ 'minecraft:stone': nbt.int(0) }), BlockData: nbt.bytes([0]) }), 'Schematic');
    assert.throws(() => readSchematic(short_data), /holds 1 blocks, the size says 2/);
    const bad_index = encodeNbt(nbt.compound({ Version: nbt.int(2), Width: nbt.short(1), Height: nbt.short(1), Length: nbt.short(1), Palette: nbt.compound({ 'minecraft:stone': nbt.int(0) }), BlockData: nbt.bytes([5]) }), 'Schematic');
    assert.throws(() => readSchematic(bad_index), /palette entry 5, which does not exist/);
    assert.throws(() => schemToPrefab(buildSchematic({ blocks: [[[AIR]]] }), { name: 'nothing' }), /holds no blocks/);
    assert.throws(() => schemToPrefab(good, { name: 'bad name' }), /prefab name must match/);

    const wide = buildSchematic({ blocks: [[Array(40).fill('minecraft:cobblestone')]] });
    const big = schemToPrefab(wide, { name: 'wall', obtainable: WITH_RECIPES, ladder: LADDER });
    assert.deepEqual([big.report.too_big, big.report.buildable, big.prefab.tier], [true, false, 5]);
    // a floating part is counted, not hidden
    const floating = schemToPrefab(buildSchematic({ blocks: [[['minecraft:cobblestone', AIR, AIR]], [[AIR, AIR, AIR]], [[AIR, AIR, 'minecraft:cobblestone']]] }), { name: 'float', obtainable: WITH_RECIPES, ladder: LADDER });
    assert.deepEqual([floating.report.floating, floating.report.buildable], [1, false]);
    // more than 127 palette entries: indices that take two varint bytes
    const many = Array.from({ length: 200 }, (_, i) => `minecraft:block_${i}`);
    assert.deepEqual(readSchematic(buildSchematic({ blocks: [[many]] })).data, many.map((_, i) => i));
});

test('schematic importer: NBT and varints read back what was written, and the installed NBT library reads the same', (t) => {
    const tree = nbt.compound({
        Version: nbt.int(3), Small: nbt.byte(-5), Wide: nbt.short(-300), Big: nbt.long(1234567890123n), Name: nbt.string('Markt-Stand ä'),
        Data: nbt.bytes([1, 128, 255]), Offset: nbt.ints([-1, 0, 7]), List: nbt.list('compound', [nbt.compound({ Id: nbt.string('minecraft:chest') })]), Empty: nbt.list('compound', []),
        Inner: nbt.compound({ Palette: nbt.compound({ 'minecraft:air': nbt.int(0) }) }),
    });
    const bytes = encodeNbt(tree, 'Schematic');
    const { name, value } = decodeNbt(bytes);
    assert.equal(name, 'Schematic');
    assert.deepEqual({ ...value, Data: [...value.Data] }, {
        Version: 3, Small: -5, Wide: -300, Big: 1234567890123n, Name: 'Markt-Stand ä', Data: [1, 128, 255], Offset: [-1, 0, 7],
        List: [{ Id: 'minecraft:chest' }], Empty: [], Inner: { Palette: { 'minecraft:air': 0 } },
    });
    for (const values of [[0], [1, 127, 128, 255, 300, 16384, 2097151], Array.from({ length: 500 }, (_, i) => i * 7)]) assert.deepEqual(decodeVarints(encodeVarints(values), values.length), values);
    assert.deepEqual([...encodeVarints([300])], [0xac, 0x02]);
    assert.throws(() => decodeVarints(Buffer.from([0x80])), /middle of a varint/);
    assert.deepEqual(parseBlockState('minecraft:oak_stairs[facing=north,half=bottom]'), { namespace: 'minecraft', name: 'oak_stairs', states: { facing: 'north', half: 'bottom' } });
    assert.deepEqual(parseBlockState('stone'), { namespace: 'minecraft', name: 'stone', states: {} });
    assert.throws(() => parseBlockState('Not A Block'), /not a block state/);

    // an independent reader: prismarine-nbt, which mineflayer brings along
    let library;
    try { library = createRequire(path.join(REPO_ROOT, 'package.json'))('prismarine-nbt'); } catch (err) {
        t.diagnostic(`prismarine-nbt is not installed (${err.code ?? err.message}): the NBT writer was only checked against this file's own reader`);
        return;
    }
    const parsed = library.simplify(library.parseUncompressed(buildSchematic({ blocks: SAVED, version: 3, compress: false }), 'big'));
    assert.deepEqual([parsed.Schematic.Version, parsed.Schematic.Width, parsed.Schematic.Height, parsed.Schematic.Length], [3, 4, 4, 2]);
    assert.equal(Object.keys(parsed.Schematic.Blocks.Palette).length, readSchematic(buildSchematic({ blocks: SAVED })).palette.length);
    assert.equal(parsed.Schematic.Blocks.Data.length, 32);
    const v2 = library.simplify(library.parseUncompressed(buildSchematic({ blocks: SAVED, version: 2, compress: false }), 'big'));
    assert.deepEqual([v2.Version, v2.BlockData.length, v2.PaletteMax], [2, 32, Object.keys(v2.Palette).length]);
});
