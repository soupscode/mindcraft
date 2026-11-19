// World setup: the world file ("v": 2), the bootstrap that applies it over RCON and checks
// what it placed, the manifest that records it all as the operator's, the full reset, and
// the launcher's gate in front of planning.
//
// Nothing here talks to a Minecraft server: the bootstrap runs against the in-memory
// stand-in of helpers/fake-rcon.mjs. The reset runs on real files in a temporary folder.
// Run from the repository root:  node --test genesis/tests/*.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from './helpers/stubs.mjs';
import { fakeFiles, fakeClock, recordingPool } from './helpers/fakes.mjs';
import { fakeMinecraft } from './helpers/fake-rcon.mjs';
import { exampleWorld, bootstrappedWorld } from './helpers/bootstrapped.mjs';
import { WORLD_CONFIG } from './helpers/fake-world.mjs';
import { createZones, checkZonesConfig } from '../catalog/zones.js';
import { fileBlueprints, blueprintSize } from '../catalog/blueprints.js';
import {
    checkWorldConfig, worldHash, WORLD_PROBLEMS, DECIDED_RANGES, DECIDED_RULES, DECIDED_BORDER_SIZE, PLOT_SIZE, borderBox, seedText,
} from '../world/world_config.js';
import { buildBootstrapPlan, campStrip, serverSettingsText, GAME_RULES_USED, CAMP_LEVELLING, FILL_LIMIT, COMMANDS_USED } from '../world/plan.js';
import { runBootstrap, reportLines, parseItems, parseItemCompound, readContainer, ANSWERS } from '../world/bootstrap.js';
import { OPERATOR, MANIFEST_KIND, checkManifest, parseManifest, manifestPaths, RESET_MARKER_FILE, SERVER_SETTINGS_FILE } from '../world/manifest.js';
import { planReset, runReset, resetFiles, resetLines, RESET_FLAG, RESET_TABLES } from '../world/reset.js';
import { checkBootstrap, checkWorld } from '../lib/config.js';
import { ROUTINES } from '../routines/routines.js';

const BLUEPRINTS = fileBlueprints(path.join(REPO_ROOT, 'src', 'agent', 'npc', 'construction'));
const MANIFEST = '/data/genesis_world/bootstrap.manifest.json';
const codes = (config) => checkWorldConfig(config, { blueprints: BLUEPRINTS }).map((problem) => problem.code);
const changed = (config, edit) => { const copy = JSON.parse(JSON.stringify(config)); edit(copy); return copy; };

// ---- the world file -----------------------------------------------------------------------

test('world file: the shipped example is valid, and the zones read it like the minimal shape', () => {
    const config = exampleWorld();
    assert.deepEqual(checkWorldConfig(config, { blueprints: BLUEPRINTS }), []);
    assert.equal(config.v, 2);
    // decided: the ranges, the rules, the border, 16 by 16 plots, a 9 by 9 field
    assert.deepEqual(DECIDED_RANGES, { Arthur: 48, Mira: 32, Felix: 128, Nova: 32 });
    for (const [agent, range] of Object.entries(DECIDED_RANGES)) assert.equal(config.agents[agent].range, range);
    assert.deepEqual(config.rules, { difficulty: 'easy', keep_inventory: false, mob_griefing: false, fire_spread: false, raids: false, nether: false, end: false });
    assert.deepEqual(config.rules, { ...DECIDED_RULES });
    assert.equal(config.border.size, 512);
    assert.equal(DECIDED_BORDER_SIZE, 512);
    assert.deepEqual(borderBox(config.border), { min: { x: -256, z: -256 }, max: { x: 255, z: 255 } });
    for (const plot of config.plots) {
        assert.equal(plot.max[0] - plot.min[0] + 1, PLOT_SIZE);
        assert.equal(plot.max[2] - plot.min[2] + 1, PLOT_SIZE);
    }
    assert.equal(config.field.max[0] - config.field.min[0] + 1, 9);
    assert.equal(config.camp.beds.length, 4);

    // the same file feeds the zones (camp, field, plots, chests, homes and ranges), unchanged
    assert.deepEqual(checkZonesConfig(config), []);
    const zones = createZones(config);
    assert.equal(zones.range('Felix'), 128);
    assert.equal(zones.protectedAt({ x: 20, y: 64, z: 0 }), 'field');
    assert.equal(zones.protectedAt({ x: -30, y: 70, z: 20 }), 'plot:arthur-1');
    assert.deepEqual(zones.chest('kits'), { x: 8, y: 64, z: 4 });
    for (const plot of config.plots) assert.deepEqual(zones.plotOverlaps(plot.id), []);
    // the minimal "v": 1 shape still loads as zones, but cannot be bootstrapped
    assert.deepEqual(checkZonesConfig(WORLD_CONFIG), []);
    assert.deepEqual(codes(WORLD_CONFIG), ['wrong_version']);
});

test('world file: the largest shipped blueprint is 11 by 14 and fits a 16 by 16 plot', () => {
    const sizes = BLUEPRINTS.names().map((name) => ({ name, ...blueprintSize(BLUEPRINTS.get(name)) }));
    assert.ok(sizes.length >= 4, 'the shipped blueprints were not found');
    const largest = sizes.reduce((a, b) => (a.x * a.z >= b.x * b.z ? a : b));
    assert.deepEqual([largest.x, largest.z], [11, 14]);
    for (const size of sizes) assert.ok(size.x <= PLOT_SIZE && size.z <= PLOT_SIZE, `${size.name} does not fit a plot`);
    // every plot of the example is high enough for every shipped blueprint
    for (const name of BLUEPRINTS.names()) {
        const config = changed(exampleWorld(), (c) => { c.plots[0].blueprint = name; });
        assert.deepEqual(codes(config), [], `${name} does not fit the example's plot`);
    }
});

test('world file: each kind of invalid file is rejected with a named reason', () => {
    const base = exampleWorld();
    const cases = [
        // overlaps: a plot on the camp, on the field, on another plot; the camp on the field
        ['zone_overlap', (c) => { c.plots[4] = { ...c.plots[4], min: [-20, 64, -20], max: [-5, 77, -5] }; }, /plot spare-1 overlaps the camp/],
        ['zone_overlap', (c) => { c.plots[2] = { ...c.plots[2], min: [20, 64, 0], max: [35, 77, 15] }; }, /plot felix-1 overlaps the field/],
        ['zone_overlap', (c) => { c.plots[4] = { ...c.plots[4], min: [-30, 64, 20], max: [-15, 77, 35] }; }, /plot arthur-1 overlaps plot spare-1/],
        ['zone_overlap', (c) => { c.field.min = [10, -4]; c.field.max = [18, 4]; c.field.water = [[14, 0]]; }, /the camp and the field overlap/],
        // a plot that is too small for its blueprint (14 layers do not fit under a height of 8)
        ['plot_too_small_for_blueprint', (c) => { c.plots[0].blueprint = 'large_house'; c.plots[0].max[1] = 71; }, /plot arthur-1 is 16 by 16 and 8 high, the blueprint "large_house" needs 11 by 14 and 14 high/],
        ['plot_wrong_size', (c) => { c.plots[1].max = [7, 77, 25]; }, /plot mira-1 is 12 by 12, plots are 16 by 16/],
        ['unknown_blueprint', (c) => { c.plots[0].blueprint = 'castle'; }, /no blueprint named "castle"/],
        // a wrong range: not the one the routine was decided for; and a plot outside its owner's range
        ['wrong_range', (c) => { c.agents.Arthur.range = 64; }, /agents\.Arthur\.range is 64, the routine "Site upkeep" was decided for 48 blocks/],
        ['outside_owner_range', (c) => { c.plots[1] = { ...c.plots[1], min: [40, 64, 40], max: [55, 77, 55] }; }, /plot mira-1 reaches \d+ blocks from Mira's home, outside the range of 32/],
        ['outside_owner_range', (c) => { c.agents.Nova.home = [-20, 64, -20]; }, /chests\.kits is \d+ blocks from Nova's home/],
        ['missing_agent', (c) => { delete c.agents.Felix; c.plots[2].owner = null; }, /agents\.Felix is missing/],
        ['unknown_owner', (c) => { c.plots[4].owner = 'Bob'; }, /owner Bob is not under "agents"/],
        // outside the world border (512 wide around 0, 0: -256 to 255)
        ['outside_border', (c) => { c.plots[4] = { ...c.plots[4], min: [245, 64, 0], max: [260, 77, 15] }; }, /plot spare-1 lies outside the world border/],
        ['outside_border', (c) => { c.border.center = [200, 0]; }, /lies outside the world border/],
        // the decided rules
        ['rule_not_as_decided', (c) => { c.rules.keep_inventory = true; }, /rules\.keep_inventory is true, decided is false/],
        ['rule_not_as_decided', (c) => { c.rules.difficulty = 'peaceful'; }, /decided is "easy"/],
        ['rule_not_as_decided', (c) => { c.border.size = 1024; }, /border\.size is 1024, decided is 512/],
        // the camp's blocks
        ['field_wrong_size', (c) => { c.field.max = [26, 4]; }, /the field is 11 by 9/],
        ['outside_camp', (c) => { c.camp.furnace = [14, 64, 0]; }, /camp\.furnace at \[14, 64, 0\] is outside the camp/],
        ['bad_double_chest', (c) => { c.camp.shared_chest_second_half = [-2, 64, -5]; }, /must be right beside chests\.shared/],
        ['blocks_collide', (c) => { c.camp.crafting_table = [...c.camp.furnace]; }, /are both at/],
        ['chests_too_close', (c) => { c.chests.kits = [2, 64, -6]; }, /an agent can take one for the other/],
        ['water_on_field_edge', (c) => { c.field.water = [[16, 0]]; }, /on the edge of the field/],
        ['field_not_watered', (c) => { c.field.water = [[17, -3]]; }, /more than 4 blocks from water/],
        ['outside_build_height', (c) => { c.plots[0].max[1] = 400; }, /leaves the build height/],
        ['bad_kit', (c) => { c.kits[0].count = 4; }, /stone_axe does not stack/],
        ['bad_kit', (c) => { c.kits = Array.from({ length: 28 }, () => ({ item: 'bread', count: 1 })); }, /a chest holds 27/],
        // decided: the field is left bare, and the kit holds the seeds the agents sow it with
        ['rule_not_as_decided', (c) => { c.field.crop = 'wheat'; }, /field\.crop is "wheat", decided is a bare field \(null\)/],
        ['kit_without_seeds', (c) => { c.kits = c.kits.filter((stack) => stack.item !== 'wheat_seeds'); }, /"kits" holds no seeds/],
        // the bootstrap levels the camp: its blocks stand on the floor, the layer under the home point
        ['off_camp_floor', (c) => { c.camp.furnace = [-6, 65, 4]; }, /camp\.furnace at \[-6, 65, 4\] does not stand on the camp's floor: its y must be 64/],
        // the shape
        ['bad_shape', (c) => { c.seed = 'my favourite seed'; }, /"seed" must be a whole number/],
        ['bad_shape', (c) => { c.camp.beds.pop(); }, /camp\.beds must list 4 beds/],
        ['bad_shape', (c) => { delete c.rules.raids; }, /rules\.raids is missing/],
        ['bad_shape', (c) => { delete c.camp; }, /camp must be/],
    ];
    for (const [code, edit, message] of cases) {
        const problems = checkWorldConfig(changed(base, edit), { blueprints: BLUEPRINTS });
        const hit = problems.find((problem) => problem.code === code && message.test(problem.message));
        assert.ok(hit, `expected ${code} matching ${message}, got ${JSON.stringify(problems)}`);
        assert.ok(problems.every((problem) => WORLD_PROBLEMS.includes(problem.code)));
    }
    for (const problem of checkWorldConfig(null)) assert.equal(problem.code, 'bad_shape');
    // the hash follows the content, not the spacing or the order of the keys
    const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(base).reverse())));
    assert.equal(worldHash(reordered), worldHash(base));
    assert.notEqual(worldHash(changed(base, (c) => { c.kits[4].count = 17; })), worldHash(base));
    assert.equal(seedText(42), '42');
    assert.equal(seedText('-9223372036854775808'), '-9223372036854775808');
    assert.equal(seedText('9223372036854775808'), null, 'larger than a 64-bit seed');
});

// ---- the plan -----------------------------------------------------------------------------

test('plan: the starter camp is exactly what was decided, and the rules are the decided ones', () => {
    const config = exampleWorld();
    const plan = buildBootstrapPlan(config);
    const by_purpose = {};
    for (const block of plan.blocks) by_purpose[block.purpose.replace(/ \d+ \((foot|head)\)$/, '').replace(/ \(half \d of 2\)$/, '')] = (by_purpose[block.purpose.replace(/ \d+ \((foot|head)\)$/, '').replace(/ \(half \d of 2\)$/, '')] ?? 0) + 1;
    assert.deepEqual(by_purpose, {
        'shared chest': 2,                  // one double chest
        'kits chest': 1,
        'crafting table': 1,
        furnace: 1,
        bed: 8,                             // four beds, two blocks each
        "dirt under the field's water": 1,
        'water of the field': 1,
        'farmland of the field': 80,        // 9 by 9, less the water
        'cleared above the farmland': 80,   // decided: the field is left bare, nothing is sown
        // decided after the first night: the camp is lit (a torch every 8 blocks: no cell further than 8 from one) and fenced, a gate in each side
        'camp fence': 92,
        ...Object.fromEntries([1, 2, 3, 4].map((n) => [`camp gate ${n} of 4`, 1])),
        ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [`camp torch ${n} of 9`, 1])),
    });
    assert.ok(!plan.blocks.some((block) => /wheat|carrots|potatoes|beetroots/.test(block.place)), 'the bootstrap sows a crop');
    assert.equal(config.field.crop, null);
    // a double chest: both halves face the same way, one is "left" and one "right";
    // the left half is joined to the block clockwise of its facing (south -> west)
    const [half_1, half_2] = plan.blocks.filter((block) => block.id.startsWith('chest.shared'));
    assert.deepEqual([half_1.pos, half_1.place], [[-2, 64, -6], 'minecraft:chest[facing=south,type=right]']);
    assert.deepEqual([half_2.pos, half_2.place], [[-1, 64, -6], 'minecraft:chest[facing=south,type=left]']);
    // a bed: the head lies in the direction it faces
    const bed = plan.blocks.filter((block) => block.id.startsWith('bed.1'));
    assert.deepEqual(bed.map((b) => [b.pos, b.place]), [
        [[4, 64, -10], 'minecraft:red_bed[facing=north,part=foot,occupied=false]'],
        [[4, 64, -11], 'minecraft:red_bed[facing=north,part=head,occupied=false]'],
    ]);
    // what the game changes by itself is checked loosely; what the agents change is placed once
    assert.equal(plan.blocks.find((b) => b.id === 'furnace').expect, 'minecraft:furnace[facing=south]');
    assert.equal(plan.blocks.find((b) => b.id.startsWith('field.farmland')).expect, 'minecraft:farmland');
    assert.ok(plan.blocks.filter((b) => b.once).every((b) => b.id.startsWith('field.clear') && b.place === 'minecraft:air'));
    assert.equal(plan.blocks.filter((b) => b.once).length, 80);
    // no houses: the bootstrap builds nothing on a plot
    const zones = createZones(config);
    assert.ok(plan.blocks.every((b) => !String(zones.protectedAt({ x: b.pos[0], y: b.pos[1], z: b.pos[2] })).startsWith('plot:')));
    assert.ok(plan.blocks.every((b) => ['camp', 'field'].includes(zones.protectedAt({ x: b.pos[0], y: b.pos[1], z: b.pos[2] }))), 'a block is placed outside the camp and the field');

    assert.deepEqual(plan.rules.map((rule) => rule.set), [
        'difficulty easy', 'gamerule keepInventory false', 'gamerule mobGriefing false', 'gamerule doFireTick false',
        'gamerule disableRaids true', 'worldborder set 512', 'worldborder center 0 0', 'setworldspawn 0 64 0', 'time set day',
    ]);
    for (const name of GAME_RULES_USED) assert.ok(plan.rules.some((rule) => rule.set.startsWith(`gamerule ${name} `)));
    // the Nether, the End and the seed are server settings: listed for the operator, never sent
    assert.deepEqual(plan.server_settings.map((s) => `${s.file}: ${s.key}=${s.value}`), [
        'server.properties: level-seed=20261116', 'server.properties: difficulty=easy',
        'server.properties: allow-nether=false', 'server.properties: spawn-protection=0', 'bukkit.yml: settings.allow-end=false', 'bukkit.yml: settings.connection-throttle=-1',
    ]);
    const text = serverSettingsText(plan);
    // the camp is at the world spawn: with spawn protection on, agents (never operators) could not use it
    for (const line of ['level-seed=20261116', 'allow-nether=false', 'spawn-protection=0', 'difficulty=easy', 'settings:', '  allow-end: false']) assert.ok(text.split('\n').includes(line), line);
    // the kit: one stack per slot, as the file lists them
    assert.deepEqual(plan.items.map((item) => [item.slot, item.item, item.count]), [
        [0, 'minecraft:stone_axe', 1], [1, 'minecraft:stone_pickaxe', 1], [2, 'minecraft:stone_hoe', 1], [3, 'minecraft:stone_sword', 1],
        [4, 'minecraft:bread', 16], [5, 'minecraft:torch', 16], [6, 'minecraft:wheat_seeds', 64], [7, 'minecraft:wheat_seeds', 16],
    ]);
    assert.equal(plan.items.filter((item) => item.item === 'minecraft:wheat_seeds').reduce((n, item) => n + item.count, 0), 80, 'one seed for every cell of the field');

    // decided: the camp, the field AND every plot are levelled before the camp is placed. Everything up to
    // 24 layers above a zone's floor is cleared with ONE fill command, then its floor is laid with one more
    assert.deepEqual({ ...CAMP_LEVELLING }, { floor_block: 'grass_block', floor_accepts: ['grass_block', 'dirt'], clear_height: 24 });
    assert.deepEqual(plan.zones.map((zone) => zone.id), ['camp', 'field', 'plot.arthur-1', 'plot.mira-1', 'plot.felix-1', 'plot.nova-1', 'plot.spare-1']);
    assert.ok(plan.zones.every((zone) => zone.y === 63));
    // the zones first, then the strip one block outside the camp's fence (four runs; nothing of it lies in the field or a plot here)
    const strip_ids = ['north', 'south', 'west', 'east'].flatMap((side) => [`camp.strip.${side}.clear`, `camp.strip.${side}.floor`]);
    assert.deepEqual(plan.areas.map((area) => area.id), [...plan.zones.flatMap((zone) => [`${zone.id}.clear`, `${zone.id}.floor`]), ...strip_ids]);
    assert.deepEqual(plan.strip, { y: 63, segments: [{ id: 'north', side: 'north', min: [-13, -13], max: [13, -13] }, { id: 'south', side: 'south', min: [-13, 13], max: [13, 13] },
        { id: 'west', side: 'west', min: [-13, -12], max: [-13, 12] }, { id: 'east', side: 'east', min: [13, -12], max: [13, 12] }], left_out: [] });
    assert.deepEqual(plan.areas.find((area) => area.id === 'camp.strip.west.floor'), { id: 'camp.strip.west.floor', zone: 'camp.strip.west', kind: 'floor', strip: true, min: [-13, 63, -12], max: [-13, 63, 12],
        block: 'minecraft:grass_block', purpose: 'strip outside the fence (west) floor (layer 63)' });
    assert.deepEqual(plan.areas[0], { id: 'camp.clear', zone: 'camp', kind: 'clear', min: [-12, 64, -12], max: [12, 87, 12], block: 'minecraft:air', purpose: 'camp cleared (layers 64 to 87)' });
    assert.deepEqual(plan.areas[1], { id: 'camp.floor', zone: 'camp', kind: 'floor', min: [-12, 63, -12], max: [12, 63, 12], block: 'minecraft:grass_block', purpose: 'camp floor (layer 63)' });
    assert.deepEqual(plan.areas[3], { id: 'field.floor', zone: 'field', kind: 'floor', min: [16, 63, -4], max: [24, 63, 4], block: 'minecraft:grass_block', purpose: 'field floor (layer 63)' });
    assert.deepEqual(plan.areas[4], { id: 'plot.arthur-1.clear', zone: 'plot.arthur-1', kind: 'clear', min: [-34, 64, 14], max: [-19, 87, 29], block: 'minecraft:air', purpose: 'plot arthur-1 cleared (layers 64 to 87)' });
    assert.deepEqual(plan.floor, { y: 63, min: [-12, -12], max: [12, 12], accepts: ['minecraft:grass_block', 'minecraft:dirt'] });
    // the floors that are checked: the camp's in every run, a plot's in the run that levelled it; the field's cells are checked as blocks
    assert.deepEqual(plan.floors.map((floor) => [floor.id, floor.every_run]), [['camp.floor', true], ...config.plots.map((plot) => [`plot.${plot.id}.floor`, false])]);
    const volume = (area) => (area.max[0] - area.min[0] + 1) * (area.max[1] - area.min[1] + 1) * (area.max[2] - area.min[2] + 1);
    assert.ok(plan.areas.every((area) => volume(area) <= FILL_LIMIT));
    assert.equal(plan.areas.filter((area) => area.kind === 'floor').reduce((n, area) => n + volume(area), 0), 625 + 81 + 5 * 256 + 104, 'the levelled site is 1,986 columns, and the 104 of the strip outside the fence');
    assert.equal(plan.areas.reduce((n, area) => n + volume(area), 0), (1986 + 104) * 25, '52,250 cells in all');
    assert.equal(FILL_LIMIT, 32768);
    // every block of the camp stands above the floor and inside what is cleared
    for (const block of plan.blocks.filter((b) => zones.protectedAt({ x: b.pos[0], y: b.pos[1], z: b.pos[2] }) === 'camp')) assert.equal(block.pos[1], 64);
    // a camp too large for one fill command is cut into slabs and runs of layers, none over the limit
    const huge = buildBootstrapPlan(changed(config, (c) => { c.camp.min = [-100, -100]; c.camp.max = [100, 100]; }));
    assert.ok(huge.areas.length > 14);
    assert.ok(huge.areas.every((area) => volume(area) <= FILL_LIMIT));
    assert.equal(huge.areas.filter((area) => area.kind === 'floor' && area.zone === 'camp').reduce((n, area) => n + volume(area), 0), 201 * 201);
    assert.equal(huge.areas.filter((area) => area.kind === 'clear' && area.zone === 'camp').reduce((n, area) => n + volume(area), 0), 201 * 201 * 24);
    assert.equal(new Set(huge.areas.map((area) => area.id)).size, huge.areas.length);
});

test('answers: what the server says is read tolerantly, and an answer that is not understood is null', () => {
    assert.equal(ANSWERS.seed('Seed: [20261116]'), '20261116');
    assert.equal(ANSWERS.seed('Seed: [-42]'), '-42');
    assert.equal(ANSWERS.seed('Unknown command'), null);
    assert.equal(ANSWERS.difficulty('The difficulty is Easy'), 'easy');
    assert.equal(ANSWERS.gamerule('Gamerule mobGriefing is currently set to: false'), 'false');
    assert.equal(ANSWERS.gamerule('Incorrect argument for command'), null);
    assert.equal(ANSWERS.worldborder('The world border is currently 512 block(s) wide'), '512');
    assert.equal(ANSWERS.worldborder('The world border is currently 59999968.0 block(s) wide'), '59999968');
    assert.deepEqual([...parseItems('8, 64, 4 has the following block data: [{Slot: 0b, count: 1, id: "minecraft:stone_axe"}, {Slot: 4b, components: {"minecraft:custom_name": "a, b", "minecraft:lore": [{id: "x"}]}, count: 16, id: "minecraft:bread"}]')], [
        [0, { item: 'minecraft:stone_axe', count: 1 }], [4, { item: 'minecraft:bread', count: 16 }],
    ]);
    assert.equal(parseItems('Found no elements matching Items').size, 0);
    assert.equal(parseItems('8, 64, 4 has the following block data: []').size, 0);
    assert.equal(parseItems('The target block is not a block entity'), null);
    assert.equal(ANSWERS.fill('Successfully filled 625 block(s)'), 625);
    assert.equal(ANSWERS.fill('Successfully filled 1 block'), 1);
    assert.equal(ANSWERS.fill('No blocks were filled'), 0);
    assert.equal(ANSWERS.fill('That position is not loaded'), null);
    assert.equal(ANSWERS.fill('Too many blocks in the specified area (maximum 32768, specified 40401)'), null);
});

// ---- the bootstrap ------------------------------------------------------------------------

async function bootstrap(config = exampleWorld(), { server = fakeMinecraft({ seed: seedText(config.seed) }), files = fakeFiles(), clock = fakeClock() } = {}) {
    // (the stand-in of these tests has no WorldEdit: the game's own fill command levels. WorldEdit: genesis/tests/site.test.js)
    const result = await runBootstrap({ config, rcon: server, files, clock, manifest_file: MANIFEST, world_file: 'genesis/genesis.world.json', blueprints: BLUEPRINTS, worldedit: false, sleep: async () => {} });
    return { config, server, files, clock, result };
}

// What a new world has where the camp will be: a tree, a hillock, a pit in the ground, grass on part of the floor layer.
function wildServer(seed = '20261116') {
    const server = fakeMinecraft({ seed });
    const put = (x, y, z, name) => server.blocks.set(`${x},${y},${z}`, { name, states: {} });
    for (let y = 64; y <= 69; y++) put(3, y, 3, 'oak_log');                               // 6 logs
    for (const [x, z] of [[2, 3], [4, 3], [3, 2], [3, 4]]) put(x, 69, z, 'oak_leaves');     // 4 leaves
    for (let x = -10; x <= -8; x++) for (let z = 5; z <= 7; z++) put(x, 64, z, 'stone');    // a 3 by 3 hillock: 9 blocks
    put(0, 90, 0, 'oak_leaves');                                                            // above what is cleared: stays
    for (let x = -12; x <= 12; x++) for (let z = -12; z <= 0; z++) put(x, 63, z, 'grass_block'); // 325 of the 625 floor cells are grass already
    put(5, 63, 5, 'stone');                                                                 // stone in the floor layer: replaced
    put(-13, 64, 0, 'oak_log');                                                             // in the strip one block outside the fence: cleared with it
    put(-14, 64, 0, 'oak_log');                                                             // two blocks outside: stays
    return server;
}

test('bootstrap: against the stand-in server it levels the camp, places it, sets the rules, fills the kit and verifies every block', async () => {
    const { server, files, result } = await bootstrap(exampleWorld(), { server: wildServer() });
    assert.equal(result.ok, true, result.problems.join('; '));
    assert.equal(result.stage, 'done');
    // cleared: 6 logs, 4 leaves, 9 stone. floored: the 300 cells of the camp that were not grass yet (one of them stone),
    // and (the stand-in's world is empty there) every cell of the field and of the five plots: 81 + 5 * 256
    // the strip one block outside the fence: its one log cleared, its 104 cells (27 + 27 + 25 + 25) floored
    assert.deepEqual(result.placed, { blocks: 200, items: 8, rules: 8, cleared: 19 + 1, floored: 300 + 81 + 1280 + 104 });

    // decided: the site is cleared and floored BEFORE the camp is placed, with ONE fill per box, and a box
    // the survey found nothing to change in gets no fill at all (only the camp has anything above its floor)
    const fills = server.log.filter((command) => command.startsWith('fill '));
    assert.deepEqual(fills, [
        'fill -12 64 -12 12 87 12 minecraft:air', 'fill -12 63 -12 12 63 12 minecraft:grass_block', 'fill 16 63 -4 24 63 4 minecraft:grass_block',
        'fill -34 63 14 -19 63 29 minecraft:grass_block', 'fill -4 63 14 11 63 29 minecraft:grass_block', 'fill 30 63 14 45 63 29 minecraft:grass_block',
        'fill -12 63 -30 3 63 -15 minecraft:grass_block', 'fill -34 63 -30 -19 63 -15 minecraft:grass_block',
        // the strip one block outside the fence, after the zones: north, south, west (with the log above it), east
        'fill -13 63 -13 13 63 -13 minecraft:grass_block', 'fill -13 63 13 13 63 13 minecraft:grass_block',
        'fill -13 64 -12 -13 87 12 minecraft:air', 'fill -13 63 -12 -13 63 12 minecraft:grass_block', 'fill 13 63 -12 13 63 12 minecraft:grass_block',
    ]);
    assert.ok(server.log.lastIndexOf(fills.at(-1)) < server.log.findIndex((command) => command.startsWith('setblock ')), 'the camp was placed before the ground was levelled');
    assert.ok(server.log.indexOf('setworldspawn 0 64 0') < server.log.indexOf(fills[0]), 'the spawn point (whose chunks stay loaded) is set before the camp is levelled');
    // every box is counted before it is filled (what is not air), and a box that is as it should be gets no fill
    const reads = server.log.filter((command) => command.startsWith('execute if blocks '));
    for (const fill of fills) {
        const [, x1, y1, z1, x2, y2, z2] = fill.split(' ');
        const count = `execute if blocks ${x1} ${y1} ${z1} ${x2} ${y2} ${z2} ${x1} ${y1} ${z1} masked`;
        assert.ok(server.log.indexOf(count) >= 0 && server.log.indexOf(count) < server.log.indexOf(fill), `${fill} was not counted first`);
    }
    assert.ok(server.log.includes('execute if blocks -34 64 -30 -19 87 -15 -34 64 -30 masked'), 'the air above the last plot was not looked at');
    // with no player online the site's chunks are force-loaded for the run, and given back at the end
    assert.equal(server.log.filter((command) => command.startsWith('forceload ')).join('; '), 'forceload add -48 -32 47 31; forceload remove -48 -32 47 31');
    assert.ok(server.log.indexOf('forceload add -48 -32 47 31') < server.log.indexOf(reads[0]));
    assert.equal(server.log.at(-1), 'forceload remove -48 -32 47 31');
    assert.equal(server.forced.size, 0);
    for (let x = -12; x <= 12; x++) for (let z = -12; z <= 12; z++) assert.equal(server.blockAt(x, 63, z).name, 'grass_block', `the floor at ${x}, ${z}`);
    let above = 0;
    for (let x = -12; x <= 12; x++) for (let y = 64; y <= 87; y++) for (let z = -12; z <= 12; z++) if (server.blockAt(x, y, z).name !== 'air') above++;
    assert.equal(above, 13 + 105, 'above the floor only the camp stands: its 13 blocks, 9 torches, 92 fences and 4 gates');
    assert.equal(server.blockAt(0, 90, 0).name, 'oak_leaves', 'above the cleared layers nothing is touched');
    assert.equal(server.blockAt(-13, 64, 0).name, 'air', 'the strip one block outside the fence is cleared');
    assert.equal(server.blockAt(-14, 64, 0).name, 'oak_log', 'outside the strip nothing is touched');
    for (const [x, z] of [[-13, -13], [13, 13], [-13, 5], [13, -5], [0, -13], [0, 13]]) assert.equal(server.blockAt(x, 63, z).name, 'grass_block', `the strip's floor at ${x}, ${z}`);
    assert.equal(server.blockAt(-14, 63, 0).name, 'air', 'the strip is one block wide');
    // the floors are verified in the check step, after everything was placed: the camp's and every plot's, whole
    // boxes at a time (a floor that is one kind of block throughout is settled by a count, a comparison and one cell)
    const last_item = server.log.findLastIndex((command) => command.startsWith('item replace '));
    for (const box of ['-12 63 -12 12 63 12 -12 63 -12', '-34 63 14 -19 63 29 -34 63 14', '-34 63 -30 -19 63 -15 -34 63 -30']) {
        assert.ok(server.log.lastIndexOf(`execute if blocks ${box} masked`) > last_item, `the floor ${box} was not checked after the camp was placed`);
    }

    // the camp stands
    const at = (x, y, z) => server.blockAt(x, y, z);
    assert.deepEqual(at(-2, 64, -6), { name: 'chest', states: { facing: 'south', type: 'right' } });
    assert.deepEqual(at(-1, 64, -6), { name: 'chest', states: { facing: 'south', type: 'left' } });
    assert.equal(at(8, 64, 4).name, 'chest');
    assert.equal(at(-6, 64, 2).name, 'crafting_table');
    assert.equal(at(-6, 64, 4).name, 'furnace');
    for (const [x, color] of [[4, 'red'], [6, 'green'], [8, 'blue'], [10, 'yellow']]) {
        assert.deepEqual([at(x, 64, -10).name, at(x, 64, -10).states.part, at(x, 64, -11).states.part], [`${color}_bed`, 'foot', 'head']);
    }
    let farmland = 0;
    let sown = 0;
    for (let x = 16; x <= 24; x++) {
        for (let z = -4; z <= 4; z++) {
            if (at(x, 63, z).name === 'farmland') farmland++;
            if (at(x, 64, z).name !== 'air') sown++;
        }
    }
    // decided: the field is left bare. Tilled farmland with its water, and nothing on it
    assert.deepEqual([farmland, sown, at(20, 63, 0).name, at(20, 62, 0).name], [80, 0, 'water', 'dirt']);
    assert.equal(server.blocks.size, 625 + 200 + 1280 + 104 + 2, 'something else was placed'); // the camp's floor, the camp and the field, the plots' floors, the strip's floor, and the two blocks left outside
    assert.deepEqual([...server.containers.get('8,64,4')].map(([slot, stack]) => [slot, stack.item, stack.count]), [
        [0, 'minecraft:stone_axe', 1], [1, 'minecraft:stone_pickaxe', 1], [2, 'minecraft:stone_hoe', 1], [3, 'minecraft:stone_sword', 1],
        [4, 'minecraft:bread', 16], [5, 'minecraft:torch', 16], [6, 'minecraft:wheat_seeds', 64], [7, 'minecraft:wheat_seeds', 16],
    ]);
    // the rules
    assert.equal(server.difficulty, 'easy');
    assert.deepEqual(server.gamerules, { keepInventory: 'false', mobGriefing: 'false', doFireTick: 'false', disableRaids: 'true' });
    assert.deepEqual([server.border, server.border_center, server.spawn], [512, [0, 0], [0, 64, 0]]);

    // every block was looked at before it was placed, and checked again afterwards
    const log = server.log;
    // (a block of the camp is looked at once more, before the levelling: is a camp standing here already?)
    for (const [x, y, z, times] of [[-2, 64, -6, 3], [4, 64, -11, 3], [20, 63, 0, 2], [16, 63, -4, 2]]) {
        const looks = log.map((command, index) => (command.startsWith(`execute if block ${x} ${y} ${z} `) ? index : -1)).filter((index) => index >= 0);
        const set = log.findIndex((command) => command.startsWith(`setblock ${x} ${y} ${z} `));
        assert.equal(looks.length, times, `${x} ${y} ${z} was not looked at ${times} times`);
        assert.ok(looks.at(-2) < set && set < looks.at(-1), 'the block was not checked after it was placed');
        if (times === 3) assert.ok(looks[0] < log.findIndex((command) => command.startsWith('fill ')), 'the camp was not looked for before the levelling');
    }
    // the layer above the farmland is the agents' from the first run on: looked at, found clear, never set
    assert.equal(log.some((command) => command.startsWith('setblock 16 64 -4 ')), false);
    assert.equal(log[0], 'seed', 'the seed is asked for before anything is touched');
    // only commands the plan knows went out, and nothing that edits a server file or deletes anything
    const verbs = new Set(log.map((command) => command.split(' ').slice(0, command.startsWith('execute') ? 3 : command.startsWith('item') || command.startsWith('data') ? 3 : 1).join(' ')));
    assert.deepEqual([...verbs].sort(), ['data get block', 'difficulty', 'execute if block', 'execute if blocks', 'fill', 'forceload', 'gamerule', 'item replace block', 'seed', 'setblock', 'setworldspawn', 'time', 'worldborder']);
    assert.ok(!log.some((command) => /^(op|stop|save-off|kill|clone|give|tp|gamemode)\b/.test(command)));
    // fill is only ever used for the levelling: a zone's box above its floor with air, and its floor with the floor block
    assert.ok(fills.every((command) => /^fill -?\d+ \d+ -?\d+ -?\d+ \d+ -?\d+ minecraft:(air|grass_block)$/.test(command)));
    for (const used of ['execute if blocks', 'forceload add', 'forceload remove']) assert.ok(COMMANDS_USED.some((entry) => entry.command.startsWith(used)), used);
    assert.ok(COMMANDS_USED.some((entry) => entry.command.startsWith('fill ')));

    // next to the manifest: the settings only the operator can set, reported as "operator must set"
    const required = files.store.get(manifestPaths(MANIFEST).server_settings);
    assert.match(required, /allow-nether=false/);
    assert.match(required, /allow-end: false/);
    assert.match(required, /level-seed=20261116/);
    assert.ok(manifestPaths(MANIFEST).server_settings.endsWith(`/genesis_world/${SERVER_SETTINGS_FILE}`));
    assert.deepEqual(result.operator_must_set, [
        'server.properties: level-seed=20261116', 'server.properties: difficulty=easy',
        'server.properties: allow-nether=false', 'server.properties: spawn-protection=0', 'bukkit.yml: settings.allow-end=false', 'bukkit.yml: settings.connection-throttle=-1',
    ]);
    const report = reportLines(result, { manifest_file: MANIFEST }).join('\n');
    assert.match(report, /Bootstrap PASSED/);
    assert.match(report, /Levelled the site \(camp, field, plots, and the strip one block outside the fence\) with the game's fill command: 20 blocks cleared, 1765 floor blocks placed \(counts per area and by kind of block are in the manifest\)\./);
    assert.equal(report.split('\n').filter((line) => line.includes('operator must set: ')).length, 6);
});

test('manifest: every placed block and item is listed as the Operator\'s, with every rule that favours the agents', async () => {
    const { config, server, files, result } = await bootstrap(exampleWorld(), { server: wildServer() });
    const manifest = parseManifest(files.store.get(MANIFEST));
    assert.deepEqual(manifest, JSON.parse(JSON.stringify(result.manifest)));
    assert.equal(manifest.kind, MANIFEST_KIND);
    assert.equal(manifest.attributed_to, 'Operator');
    assert.equal(OPERATOR, 'Operator');
    assert.equal(manifest.world_sha256, worldHash(config));
    assert.equal(manifest.seed, '20261116');
    assert.equal(manifest.verified, true);

    // one record per block the server was told to set, at the same place, and nothing else
    const set = server.log.filter((command) => command.startsWith('setblock ')).map((command) => command.split(' ').slice(1, 5).join(' '));
    assert.equal(set.length, 200);
    assert.deepEqual(manifest.blocks.filter((record) => record.placed).map((record) => `${record.pos.join(' ')} ${record.block}`).sort(), [...set].sort());
    assert.equal(manifest.blocks.length, 280);
    // the 80 cells above the farmland were clear already: recorded as looked at, not as placed
    assert.equal(manifest.blocks.filter((record) => !record.placed && record.id.startsWith('field.clear')).length, 80);
    const items = server.log.filter((command) => command.startsWith('item replace '));
    assert.equal(manifest.items.length, items.length);
    // the levelling: one record per box, and for every box that changed one fill command, with how many blocks the server changed
    const fills = server.log.filter((command) => command.startsWith('fill '));
    assert.equal(manifest.areas.length, 22);
    assert.deepEqual(manifest.areas.filter((record) => record.changed > 0).map((record) => `fill ${record.min.join(' ')} ${record.max.join(' ')} ${record.block}`), fills);
    assert.deepEqual(manifest.areas.filter((record) => record.changed > 0).map((record) => [record.id, record.kind, record.changed, record.placed, record.status]), [
        ['camp.clear', 'clear', 19, true, 'filled'],                                          // the tree and the hillock
        ['camp.floor', 'floor', 300, true, 'filled'],
        ['field.floor', 'floor', 81, true, 'filled'],
        ...['arthur-1', 'mira-1', 'felix-1', 'nova-1', 'spare-1'].map((id) => [`plot.${id}.floor`, 'floor', 256, true, 'filled']),
        // the strip one block outside the fence: four runs, recorded like every other box
        ['camp.strip.north.floor', 'floor', 27, true, 'filled'],
        ['camp.strip.south.floor', 'floor', 27, true, 'filled'],
        ['camp.strip.west.clear', 'clear', 1, true, 'filled'],                                // the log right outside the fence
        ['camp.strip.west.floor', 'floor', 25, true, 'filled'],
        ['camp.strip.east.floor', 'floor', 25, true, 'filled'],
    ]);
    assert.ok(manifest.areas.filter((record) => record.changed === 0).every((record) => record.placed === false && record.status === 'nothing to change'));
    assert.equal(manifest.areas.reduce((n, record) => n + record.changed, 0), result.placed.cleared + result.placed.floored);
    assert.deepEqual([manifest.runs[0].blocks_cleared, manifest.runs[0].floor_blocks_placed], [20, 1765]);
    // decided: the record is COUNTS per area: what was not air before, what was laid, how many blocks changed, and how
    const area = (id) => manifest.areas.find((record) => record.id === id);
    assert.deepEqual([area('camp.clear').cells, area('camp.clear').before, area('camp.clear').laid, area('camp.clear').method],
        [15000, { not_air: 19, by_type: null }, { block: 'minecraft:air', count: 19 }, 'vanilla']);
    assert.deepEqual([area('camp.floor').cells, area('camp.floor').before, area('camp.floor').laid], [625, { not_air: 326, by_type: null }, { block: 'minecraft:grass_block', count: 300 }]);
    assert.deepEqual([area('field.clear').before, area('field.clear').laid, area('field.clear').status], [{ not_air: 0, by_type: null }, { block: 'minecraft:air', count: 0 }, 'nothing to change']);
    assert.ok(manifest.areas.every((record) => !('changes' in record)), 'the record lists single blocks again');
    assert.deepEqual(manifest.levelling, { method: 'vanilla', version: null, why: 'WorldEdit was switched off for this run (--no-worldedit)' });
    assert.deepEqual(result.warnings, []);
    // how the site was chosen is recorded: here the coordinates were given by hand
    assert.deepEqual([manifest.site.method, manifest.site.by, manifest.site.home], ['manual', 'Operator', [0, 64, 0]]);
    for (const record of [...manifest.areas, ...manifest.blocks, ...manifest.items, ...manifest.rules]) {
        assert.equal(record.by, 'Operator');
        assert.equal(record.run, 1);
    }
    // never agent work: no agent's name appears anywhere in the manifest
    const text = JSON.stringify(manifest);
    for (const agent of Object.keys(ROUTINES)) assert.ok(!text.includes(agent), `${agent} appears in the manifest`);

    // the rules: each with whether it favours the agents and why; the server settings as "operator must set"
    const rule = (id) => manifest.rules.find((entry) => entry.id === id);
    assert.deepEqual(manifest.rules.map((entry) => [entry.id, entry.status, entry.favours_agents]), [
        ['difficulty', 'set', true], ['keepInventory', 'already set', false], ['mobGriefing', 'set', true], ['doFireTick', 'set', true],
        ['disableRaids', 'set', true], ['worldborder.size', 'set', false], ['worldborder.center', 'set, cannot be read back', false],
        ['worldspawn', 'set, cannot be read back', true], ['time.first_morning', 'set, once', true],
        ['server.properties:level-seed', 'operator must set', false], ['server.properties:difficulty', 'operator must set', true],
        ['server.properties:allow-nether', 'operator must set', false], ['server.properties:spawn-protection', 'operator must set', false],
        ['bukkit.yml:settings.allow-end', 'operator must set', false], ['bukkit.yml:settings.connection-throttle', 'operator must set', false],
    ]);
    assert.match(rule('mobGriefing').why, /cannot destroy or take blocks/);
    const favours = manifest.favours_agents.join('\n');
    for (const expected of [/The camp, the field and every plot were levelled by the operator before anything was placed: 24 layers above the floor were cleared and the floor was laid with grass block\. What stood there before and what was laid is counted in this manifest, area by area/,
        /starter camp was built by the operator/, /kits chest was filled once by the operator with 1 stone_axe.*64 wheat_seeds, 16 wheat_seeds/,
        /field is Operator-built and was left bare: the operator tilled and watered it and sowed nothing\. Every crop on it is agent-planted/,
        /Easy difficulty/, /No mob griefing/, /No fire spread/, /No raids/, /world spawn is the home point/]) assert.match(favours, expected);
    assert.ok(!/sown once by the operator/.test(favours), 'the operator sowed nothing');
    assert.ok(!/keepInventory/.test(favours), 'keepInventory off does not favour the agents');
    assert.deepEqual(checkManifest(manifest, config), []);
    // a manifest that credits anything to someone else is not accepted
    const forged = JSON.parse(text);
    forged.blocks[3].by = 'Arthur';
    assert.match(checkManifest(forged, config).join('\n'), /attributes something to someone other than "Operator"/);
    const forged_floor = JSON.parse(text);
    forged_floor.areas.at(-1).by = 'Arthur';
    assert.match(checkManifest(forged_floor, config).join('\n'), /attributes something to someone other than "Operator"/);
    // a manifest from before the bootstrap levelled the camp does not let planning start
    const old = JSON.parse(text);
    delete old.areas;
    assert.match(checkManifest(old, config).join('\n'), /has no record of the levelled camp/);
});

test('bootstrap: a second run on a bootstrapped world issues no placing commands, changes nothing and passes', async () => {
    const first = await bootstrap(exampleWorld(), { server: wildServer() });
    const blocks_before = JSON.stringify([...first.server.blocks]);
    const manifest_before = parseManifest(first.files.store.get(MANIFEST));
    first.server.log.length = 0;
    // the agents have been at work: a tool was taken from the kit, Mira sowed wheat and it grew, a torch
    // stands in the camp, and the grass under the crafting table turned to dirt by itself
    first.server.containers.get('8,64,4').delete(0);
    first.server.blocks.set('16,64,-4', { name: 'wheat', states: { age: '7' } });
    first.server.blocks.set('17,64,-4', { name: 'wheat', states: { age: '2' } });
    first.server.blocks.set('-6,64,4', { name: 'furnace', states: { facing: 'south', lit: 'true' } });
    first.server.blocks.set('2,64,2', { name: 'torch', states: {} });
    first.server.blocks.set('-6,63,2', { name: 'dirt', states: {} });
    await first.clock.advance(60 * 60 * 1000);

    const second = await bootstrap(first.config, first);
    assert.equal(second.result.ok, true, second.result.problems.join('; '));
    assert.deepEqual(second.result.placed, { blocks: 0, items: 0, rules: 0, cleared: 0, floored: 0 });
    assert.deepEqual(first.server.changing(), [], 'the second run sent a command that changes the world');
    assert.ok(second.result.commands.every((entry) => entry.changes === false));
    assert.equal(first.server.log.some((command) => command.startsWith('fill ')), false, 'the camp was levelled a second time');
    assert.deepEqual(second.result.warnings, []);
    // what the agents changed stays as they left it: nothing is refilled, cleared again or reset
    assert.equal(first.server.containers.get('8,64,4').has(0), false, 'the kit was refilled');
    assert.equal(first.server.blocks.get('17,64,-4').name, 'wheat', 'what an agent sowed was cleared away');
    assert.equal(first.server.blocks.get('16,64,-4').states.age, '7');
    assert.equal(first.server.blocks.get('2,64,2').name, 'torch', 'the torch in the camp was cleared away');
    // the camp's floor is verified again in every run: all 625 cells, grass or (under a full block) dirt.
    // The plots are their owners' since the first run: their floors are not looked at again
    assert.ok(first.server.log.includes('execute if blocks -12 63 -12 12 63 12 -12 63 -12 masked'));
    assert.ok(first.server.log.includes('execute if block -6 63 2 minecraft:dirt'));
    assert.equal(first.server.log.some((command) => command.startsWith('execute if blocks -34 63 14 ')), false, 'a plot was checked again');
    // nothing is levelled again, and WorldEdit is not even asked for
    assert.equal(first.server.log.some((command) => /worldedit|^\//.test(command)), false);
    assert.deepEqual(parseManifest(first.files.store.get(MANIFEST)).areas, manifest_before.areas);
    // the record of who placed what is carried over unchanged, and the run is noted
    const manifest = parseManifest(first.files.store.get(MANIFEST));
    assert.deepEqual(manifest.blocks, manifest_before.blocks);
    assert.deepEqual(manifest.items, manifest_before.items);
    assert.deepEqual(manifest.rules.filter((rule) => rule.kind !== 'server_setting'), manifest_before.rules.filter((rule) => rule.kind !== 'server_setting'));
    assert.deepEqual(manifest.runs.map((run) => [run.run, run.blocks_placed, run.items_placed, run.blocks_cleared, run.floor_blocks_placed, run.result]), [[1, 200, 8, 20, 1765, 'ok'], [2, 0, 0, 0, 0, 'ok']]);
    assert.equal(manifest.verified, true);
    assert.notEqual(JSON.stringify([...first.server.blocks]), blocks_before); // only by what the test did as "the agents"

    // a block of the camp that went missing is put back by the operator, and recorded as a new placement
    first.server.blocks.delete('-6,64,2');
    first.server.log.length = 0;
    const third = await bootstrap(first.config, first);
    assert.equal(third.result.ok, true);
    assert.deepEqual(first.server.changing(), ['setblock -6 64 2 minecraft:crafting_table']);
    const record = parseManifest(first.files.store.get(MANIFEST)).blocks.find((entry) => entry.id === 'crafting_table');
    assert.deepEqual([record.by, record.placed, record.run], ['Operator', true, 3]);

    // a hole in the camp's floor fails the check, with its position, and the manifest lets nothing start
    first.server.blocks.delete('7,63,-3');
    first.server.log.length = 0;
    const holed = await bootstrap(first.config, first);
    assert.deepEqual([holed.result.ok, holed.result.stage, holed.result.failed.id, holed.result.failed.pos], [false, 'check', 'camp.floor', [7, 63, -3]]);
    assert.match(holed.result.problems[0], /floor check failed at 7, 63, -3: the camp floor should be minecraft:grass_block or minecraft:dirt, the server says it is air/);
    assert.deepEqual(first.server.changing(), [], 'a check never repairs: the floor is the operator\'s to put right');
    assert.equal(parseManifest(first.files.store.get(MANIFEST)).verified, false);
});

// Found on the first real server (Paper 1.21.6): the answer to "data get block <pos> Items" for the
// kits chest came back cut off, and the bootstrap, which had filled the chest correctly, failed its own check.
test('kit check: a container list the server cuts off is read one stack at a time, as on the real server', async () => {
    // the real answer, word for word
    const cut_off = '276, 68, -14 has the following block data: [{Slot: 0b, id: "minecraft:stone_axe", count: 1}, {Slot: 1b, id: "...';
    assert.equal(parseItems(cut_off), null);
    assert.deepEqual(parseItemCompound('{Slot: 0b, id: "minecraft:stone_axe", count: 1}'), { slot: 0, item: 'minecraft:stone_axe', count: 1 });
    assert.equal(parseItemCompound('{Slot: 1b, id: "...'), null);

    // a server that answers like that one: eight stacks do not fit in one answer
    const kit = ['stone_axe', 'stone_pickaxe', 'stone_hoe', 'stone_sword', 'bread', 'torch', 'wheat_seeds', 'wheat_seeds'];
    const answers = (stacks, limit = 70) => {
        const sent = [];
        const print = (name, slot) => `{Slot: ${slot}b, id: "minecraft:${name}", count: ${slot + 1}}`;
        const reply = (data) => `276, 68, -14 has the following block data: ${data.length > limit ? `${data.slice(0, limit - 3)}...` : data}`;
        const send = async (command) => {
            sent.push(command);
            const path = command.split(' ')[6];
            const element = /^Items\[(\d+)\](?:\.(Slot|id|count))?$/.exec(path);
            if (path === 'Items') return reply(`[${stacks.map(print).join(', ')}]`);
            const index = Number(element[1]);
            if (index >= stacks.length) return `Found no elements matching ${path}`;
            if (element[2] === 'Slot') return reply(`${index}b`);
            if (element[2] === 'id') return reply(`"minecraft:${stacks[index]}"`);
            if (element[2] === 'count') return reply(`${index + 1}`);
            return reply(print(stacks[index], index));
        };
        return { send, sent };
    };
    const real = answers(kit);
    const read = await readContainer(real.send, [276, 68, -14]);
    assert.equal(read.not_loaded, false);
    assert.deepEqual([...read.slots].map(([slot, stack]) => [slot, stack.item, stack.count]), kit.map((name, slot) => [slot, `minecraft:${name}`, slot + 1]));
    assert.deepEqual(real.sent.slice(0, 2), ['data get block 276 68 -14 Items', 'data get block 276 68 -14 Items[0]']);
    assert.equal(real.sent.at(-1), 'data get block 276 68 -14 Items[8]', 'it stops at the first element the server does not have');

    // a list that fits is still one command
    const short = answers(['bread']);
    assert.equal((await readContainer(short.send, [276, 68, -14])).slots.get(0).item, 'minecraft:bread');
    assert.equal(short.sent.length, 1);

    // a single stack that is itself cut off is read field by field
    const narrow = answers(kit, 40);
    const fields = await readContainer(narrow.send, [276, 68, -14]);
    assert.deepEqual(fields.slots.get(1), { item: 'minecraft:stone_pickaxe', count: 2 });
    assert.ok(narrow.sent.includes('data get block 276 68 -14 Items[1].id'));

    // an area that is not loaded is named as that, never as a wrong item
    const away = await readContainer(async () => 'That position is not loaded', [276, 68, -14]);
    assert.deepEqual([away.slots, away.not_loaded], [null, true]);
    // and an answer nobody understands stays "not understood"
    const odd = await readContainer(async () => 'The target block is not a block entity', [276, 68, -14]);
    assert.deepEqual([odd.slots, odd.not_loaded], [null, false]);
});

test('kit check: the bootstrap passes on a server that cuts the kit list off, and says so when the area is not loaded', async () => {
    const config = exampleWorld();
    const server = fakeMinecraft({ seed: seedText(config.seed) });
    assert.ok(server.data_reply_limit < 200, 'the stand-in cuts long answers off, as the real server does');
    const first = await bootstrap(config, { server });
    assert.equal(first.result.ok, true, first.result.problems.join('; '));
    assert.ok(first.result.commands.some((entry) => /^data get block .* Items\[0\]$/.test(entry.command)), 'the stacks were read one at a time');

    // the same world again: the kit is recognised, nothing is put into the chest a second time
    const again = await bootstrap(config, { server, files: first.files });
    assert.equal(again.result.ok, true, again.result.problems.join('; '));
    assert.equal(again.result.commands.filter((entry) => entry.command.startsWith('item replace')).length, 0);

    // a fresh world whose kits chest cannot be read because nobody is near
    const far = fakeMinecraft({ seed: seedText(config.seed) });
    far.unloaded = () => true;
    const stopped = await bootstrap(config, { server: far });
    assert.equal(stopped.result.ok, false);
    // (one named failure for every command that meets it: the answer is never read as "the chest is empty" or "the item is missing")
    assert.match(stopped.result.problems[0], /^the area is NOT LOADED: the server answered "That position is not loaded" to "data get block 8 64 4 Items"/);
    assert.equal(stopped.result.failed.id, 'not_loaded');
});

test('bootstrap: levelling never runs over a camp that stands, and a fill the server does not take stops the run', async () => {
    // the manifest is lost, the camp stands, an agent's torch stands in it
    const first = await bootstrap(exampleWorld(), { server: wildServer() });
    first.server.blocks.set('2,64,2', { name: 'torch', states: {} });
    first.server.log.length = 0;
    const again = await bootstrap(first.config, { server: first.server });   // new files: no manifest
    assert.equal(again.result.ok, true, again.result.problems.join('; '));
    assert.equal(first.server.log.some((command) => command.startsWith('fill ')), false, 'a standing camp was cleared');
    assert.equal(first.server.blocks.get('2,64,2').name, 'torch');
    assert.equal(first.server.containers.get('8,64,4').size, 8, 'the kits chest was wiped');
    assert.match(again.result.warnings.join('\n'), /The site was NOT levelled: the manifest has no record of the levelling, but the shared chest \(half 1 of 2\) already stands at -2, 64, -6/);
    const areas = parseManifest(again.files.store.get(MANIFEST)).areas;
    assert.equal(areas.length, 22);
    // the camp, the field and the plots are refused; the strip outside the fence holds nothing of the camp: it is looked at, and was level already
    assert.ok(areas.every((record) => record.changed === 0 && record.placed === false && record.by === 'Operator'
        && record.status === (record.zone.startsWith('camp.strip.') ? 'nothing to change' : 'not levelled: the camp was already standing')));
    // (the two rules that cannot be read back are set again when no manifest says they were)
    assert.deepEqual(again.result.placed, { blocks: 0, items: 0, rules: 2, cleared: 0, floored: 0 });

    // the server refuses a fill (the chunks are not loaded): the run stops there, nothing of the camp is placed
    const unloaded = wildServer();
    unloaded.refuse = (command) => command.startsWith('fill ') && command.endsWith('minecraft:grass_block');
    const stopped = await bootstrap(exampleWorld(), { server: unloaded });
    // "That position is not loaded" is its own failure (seen on the real server with no player online): the area
    // is not loaded, which is never read as "nothing changed" or "the block does not match"
    assert.deepEqual([stopped.result.ok, stopped.result.stage, stopped.result.failed.id], [false, 'level', 'not_loaded']);
    assert.match(stopped.result.problems[0], /^the area is NOT LOADED: the server answered "That position is not loaded" to "fill -12 63 -12 12 63 12 minecraft:grass_block"\. No block was read as missing or wrong because of it/);
    assert.equal(unloaded.log.at(-1), 'forceload remove -48 -32 47 31', 'the chunks were not given back after the failure');
    assert.equal(unloaded.log.some((command) => command.startsWith('setblock ')), false);
    const partial = parseManifest(stopped.files.store.get(MANIFEST));
    assert.equal(partial.verified, false);
    assert.deepEqual(partial.areas.map((record) => [record.id, record.changed]), [['camp.clear', 19]], 'what was cleared is recorded');
    // run again once the server takes it: only the floor is still to do
    unloaded.refuse = () => false;
    unloaded.log.length = 0;
    const resumed = await bootstrap(exampleWorld(), { server: unloaded, files: stopped.files, clock: stopped.clock });
    assert.equal(resumed.result.ok, true, resumed.result.problems.join('; '));
    assert.equal(unloaded.log.filter((command) => command.startsWith('fill ')).join('; ').startsWith('fill -12 63 -12 12 63 12 minecraft:grass_block; fill 16 63 -4 24 63 4 minecraft:grass_block'), true);
    assert.equal(unloaded.log.some((command) => command.startsWith('fill -12 64 -12 ')), false, 'what was cleared was cleared again');
    // (the strip outside the fence was not reached before the stop: its log and its floor are done now)
    assert.deepEqual(resumed.result.placed, { blocks: 200, items: 8, rules: 0, cleared: 1, floored: 1765 });
});

test('bootstrap: a failed block check stops with the block\'s position, and the manifest does not let planning start', async () => {
    const config = exampleWorld();
    const server = fakeMinecraft({ seed: '20261116' });
    // the server puts something else where the furnace should be (a plugin, a protection, a typo in a block name)
    server.break_after.set('-6,64,4', { name: 'stone', states: {} });
    const { files, result } = await bootstrap(config, { server });
    assert.equal(result.ok, false);
    assert.equal(result.stage, 'check');
    assert.deepEqual(result.failed.pos, [-6, 64, 4]);
    assert.equal(result.failed.id, 'furnace');
    assert.match(result.problems[0], /block check failed at -6, 64, 4: furnace should be minecraft:furnace\[facing=south\], the server says "Test failed"/);
    assert.match(reportLines(result).join('\n'), /FAILED at stage "check"[\s\S]*Failed position: -6, 64, 4/);
    // it stopped there: no block after the furnace was checked
    // (only the chunks force-loaded for the run are given back after it)
    const checks = server.log.slice(server.log.lastIndexOf('execute if block -6 64 4 minecraft:furnace[facing=south]') + 1);
    assert.deepEqual(checks, ['forceload remove -48 -32 47 31']);
    // what was placed is still recorded, but the manifest is not verified
    const manifest = parseManifest(files.store.get(MANIFEST));
    assert.equal(manifest.verified, false);
    assert.equal(manifest.blocks.length, 280);
    assert.match(checkManifest(manifest, config).join('\n'), /did not pass its checks/);
    assert.match(manifest.runs[0].result, /block check failed at -6, 64, 4/);

    // a kit slot that does not hold what was put in stops it too, with the chest's position
    const stingy = fakeMinecraft({ seed: '20261116' });
    stingy.refuse = (command) => command.startsWith('item replace') && command.includes('container.4 ');
    const short = await bootstrap(config, { server: stingy });
    assert.equal(short.result.ok, false);
    assert.deepEqual(short.result.failed.pos, [8, 64, 4]);
    assert.match(short.result.problems[0], /slot 4 of the kits chest should hold 16 minecraft:bread, it holds nothing/);

    // a rule the server does not take
    const stubborn = fakeMinecraft({ seed: '20261116' });
    stubborn.refuse = (command) => command === 'gamerule mobGriefing false';
    const ruled = await bootstrap(config, { server: stubborn });
    assert.deepEqual([ruled.result.ok, ruled.result.stage, ruled.result.failed.id], [false, 'rules', 'mobGriefing']);
    assert.equal(stubborn.log.some((command) => command.startsWith('setblock')), false, 'blocks were placed although a rule could not be set');
});

test('bootstrap: nothing is sent for an invalid world file, and nothing is placed in a world from another seed', async () => {
    const bad = changed(exampleWorld(), (c) => { c.agents.Arthur.range = 64; });
    const invalid = await bootstrap(bad);
    assert.equal(invalid.result.ok, false);
    assert.equal(invalid.result.stage, 'validate');
    assert.match(invalid.result.problems[0], /\[wrong_range\]$/);
    assert.deepEqual(invalid.server.log, []);
    assert.equal(invalid.files.store.size, 0);

    const other_world = await bootstrap(exampleWorld(), { server: fakeMinecraft({ seed: '999' }) });
    assert.equal(other_world.result.ok, false);
    assert.equal(other_world.result.stage, 'seed');
    assert.match(other_world.result.problems[0], /generated from seed 999, the world file says 20261116/);
    assert.deepEqual(other_world.server.log, ['seed']);
    assert.equal(other_world.files.store.size, 0, 'a manifest was written for a world that was never touched');

    // the server goes away half way: reported, never thrown
    const flaky = fakeMinecraft({ seed: '20261116' });
    const real_send = flaky.send;
    flaky.send = async (command) => { if (flaky.log.length >= 40) flaky.down = true; return real_send(command); };
    const cut = await bootstrap(exampleWorld(), { server: flaky });
    assert.equal(cut.result.ok, false);
    assert.match(cut.result.problems[0], /the server could not be asked \(RCON: the connection was closed\)/);
    assert.equal(parseManifest(cut.files.store.get(MANIFEST)).verified, false);
});

test('bootstrap: when the world file changes, the old manifest no longer counts until the bootstrap ran again', async () => {
    const first = await bootstrap();
    const manifest = parseManifest(first.files.store.get(MANIFEST));
    // the operator registers another plot: the hash changes
    const config = changed(first.config, (c) => { c.plots.push({ id: 'spare-2', owner: null, min: [30, 64, -30], max: [45, 77, -15], blueprint: null }); });
    assert.deepEqual(checkWorldConfig(config, { blueprints: BLUEPRINTS }), []);
    assert.match(checkManifest(manifest, config).join('\n'), /hash does not match/);
    first.server.log.length = 0;
    const again = await bootstrap(config, first);
    assert.equal(again.result.ok, true);
    assert.deepEqual(first.server.changing(), [], 'a new plot needs nothing placed');
    assert.deepEqual(checkManifest(parseManifest(first.files.store.get(MANIFEST)), config), []);
});

// ---- the full reset -----------------------------------------------------------------------

// A Genesis installation on the real disk: what a reset may remove, and what it must keep.
function installation() {
    const root = mkdtempSync(path.join(tmpdir(), 'genesis-reset-'));
    const file = (relative, text = '{}') => {
        const full = path.join(root, relative);
        mkdirSync(path.dirname(full), { recursive: true });
        writeFileSync(full, text);
        return full;
    };
    const names = ['Arthur', 'Mira', 'Felix', 'Nova'];
    const wiped = [];
    const kept = [];
    for (const name of names) {
        wiped.push(file(`bots/${name}/memory.json`), file(`bots/${name}/histories/2026-11-16.json`), file(`bots/genesis_checkpoints/${name}.checkpoint.json`));
        kept.push(file(`bots/${name}/last_profile.json`), file(`bots/${name}/logs/conversation.txt`, 'log'), file(`genesis/profiles/${name.toLowerCase()}.json`, JSON.stringify({ name })));
    }
    wiped.push(file('bots/Arthur/histories/2026-11-15.json'), file('bots/genesis_checkpoints/Nova.checkpoint.json.tmp'), file('bots/genesis_ledger/chest_ledger.json'));
    kept.push(
        file('genesis/settings.json'), file('genesis/genesis.world.json', JSON.stringify(exampleWorld())),
        file('src/agent/npc/construction/small_wood_house.json'), file('bots/genesis_incidents/2026-11-16-parked.json'),
        file('bots/genesis_world/bootstrap.manifest.json'), file('bots/genesis_world/server-settings.required.txt', 'x'),
        file('bots/genesis_checkpoints/README.txt', 'not a checkpoint'), file('bots/Bob/memory.json'), file('bots/execTemplate.js', '//'),
        file('minecraft-server/world/level.dat', 'the world'), file('minecraft-server/server.properties', 'level-seed=20261116'),
    );
    const inputs = {
        agents: names, memory_dir: 'bots', checkpoint_dir: 'bots/genesis_checkpoints', ledger_file: 'bots/genesis_ledger/chest_ledger.json',
        manifest_file: 'bots/genesis_world/bootstrap.manifest.json', cwd: root,
        protect: ['genesis', 'src', 'genesis/settings.json', 'genesis/genesis.world.json'],
    };
    const everything = () => {
        const out = [];
        const walk = (dir) => { for (const name of readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, name.name); if (name.isDirectory()) walk(full); else out.push(full); } };
        walk(root);
        return out.sort();
    };
    return { root, wiped: wiped.sort(), kept: kept.sort(), inputs, everything, file };
}

test('reset: without the flag it is a dry run that lists exactly what would go and removes nothing', async () => {
    const home = installation();
    const before = home.everything();
    const outcome = await runReset({ ...home.inputs, database: true }, { confirmed: false, files: await resetFiles(), pool: recordingPool() });
    assert.equal(outcome.dry_run, true);
    assert.deepEqual(home.everything(), before, 'the dry run removed or wrote something');
    assert.deepEqual(outcome.removed, []);
    assert.equal(outcome.marker_written, false);
    // the list is exact: the files a real reset removes, and no other
    assert.deepEqual(outcome.plan.remove.map((entry) => entry.path).sort(), home.wiped);
    assert.deepEqual(outcome.plan.database, ['DELETE FROM agent_goals', 'DELETE FROM goal_changes', 'DELETE FROM agent_checkpoints']);
    assert.deepEqual([...RESET_TABLES], ['agent_goals', 'goal_changes', 'agent_checkpoints']);
    const lines = resetLines(outcome).join('\n');
    assert.match(lines, /^DRY RUN\./);
    for (const gone of home.wiped) assert.ok(lines.includes(gone), `${gone} is not listed`);
    assert.match(lines, /Nothing was removed\. To do it, stop the agents and run again with --yes-wipe-everything/);
    assert.match(lines, /THE MINECRAFT WORLD FOLDER: this script never touches it/);
    assert.equal(RESET_FLAG, '--yes-wipe-everything');

    // the script itself: no flag, or any other flag, removes nothing
    const settings_file = home.file('genesis/settings.json', JSON.stringify({
        profiles: ['Arthur', 'Mira', 'Felix', 'Nova'].map((name) => path.join(home.root, 'genesis', 'profiles', `${name.toLowerCase()}.json`)),
        genesis_planning: { checkpoint_dir: path.join(home.root, 'bots/genesis_checkpoints'), ledger_file: path.join(home.root, 'bots/genesis_ledger/chest_ledger.json'),
            manifest_file: path.join(home.root, 'bots/genesis_world/bootstrap.manifest.json'), world_file: path.join(home.root, 'genesis/genesis.world.json') },
    }));
    for (const args of [[], ['--yes'], ['--wipe'], ['-y'], ['--yes-wipe-everything=no']]) {
        const child = spawnSync(process.execPath, ['genesis/world/reset.js', '--settings', settings_file, ...args], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 30000 });
        assert.equal(child.status, 0, child.stderr);
        assert.match(child.stdout, /DRY RUN/);
        assert.deepEqual(home.everything(), before, `"${args.join(' ')}" removed something`);
    }
});

test('reset: with the flag it removes only the listed Genesis data, writes the marker, and keeps everything else', async () => {
    const home = installation();
    const pool = recordingPool();
    const clock = fakeClock();
    const outcome = await runReset({ ...home.inputs, database: true }, { confirmed: true, files: await resetFiles(), pool, clock, seed: '20261116' });
    assert.equal(outcome.ok, true, JSON.stringify(outcome.failed));
    assert.deepEqual([...outcome.removed].sort(), home.wiped);
    const marker = path.join(home.root, 'bots', 'genesis_world', RESET_MARKER_FILE);
    assert.deepEqual(home.everything(), [...home.kept, marker].sort(), 'something else was removed, or something that should go is still there');
    // identity, config, seed, blueprints, incidents: all still there, and so is the Minecraft world
    for (const kept of home.kept) assert.ok(existsSync(kept), `${kept} was removed`);
    assert.equal(readFileSync(path.join(home.root, 'minecraft-server/world/level.dat'), 'utf8'), 'the world');
    assert.equal(JSON.parse(readFileSync(path.join(home.root, 'genesis/genesis.world.json'), 'utf8')).seed, '20261116');
    // goals: the tables, by name, and nothing else in the database (the call records stay)
    assert.deepEqual(pool.queries.map((query) => query.text), ['DELETE FROM agent_goals', 'DELETE FROM goal_changes', 'DELETE FROM agent_checkpoints']);
    // the marker tells the operator what only the operator may do
    const text = readFileSync(marker, 'utf8');
    assert.match(text, /THE WORLD MUST BE REGENERATED/);
    assert.match(text, /Delete the world folder of the server/);
    assert.match(text, /level-seed=20261116/);
    assert.match(text, /node genesis\/world\/bootstrap\.js/);
    assert.match(resetLines(outcome).join('\n'), /the Minecraft world folder must now be deleted by you and regenerated from the same seed/);

    // while the marker is there the old manifest lets nothing start; the next bootstrap files it away and removes the marker
    const files = (await import('../store/node_files.js')).nodeFiles();
    const manifest_file = path.join(home.root, 'bots/genesis_world/bootstrap.manifest.json');
    const config = exampleWorld();
    const done = await runBootstrap({ config, rcon: fakeMinecraft({ seed: '20261116' }), files, clock, manifest_file });
    assert.equal(done.ok, true, done.problems.join('; '));
    assert.equal(done.placed.blocks, 200, 'after a reset nothing an older manifest says is carried over');
    assert.equal(done.placed.floored, 625 + 81 + 1280 + 104, 'after a reset the site of the new world is levelled (with the strip outside the fence)');
    assert.equal(existsSync(marker), false, 'the marker is still there after a bootstrap that passed');
    assert.equal(readdirSync(path.dirname(manifest_file)).filter((name) => name.startsWith('bootstrap.manifest.before-reset-')).length, 1);

    // a database that cannot be reached: the reset says it is not complete
    const again = installation();
    const no_db = await runReset({ ...again.inputs, database: true }, { confirmed: true, files: await resetFiles(), pool: null });
    assert.equal(no_db.ok, false);
    assert.equal(no_db.failed.length, 3);
    assert.match(resetLines(no_db).join('\n'), /THE RESET IS NOT COMPLETE/);
    // without a database nothing is asked of one
    const plain = await runReset(installation().inputs, { confirmed: true, files: await resetFiles(), pool });
    assert.equal(plain.ok, true);
    assert.equal(pool.queries.length, 3);
});

test('reset: it never leaves the folders it was given, follows no link, and refuses a folder that holds what must be kept', async () => {
    const files = await resetFiles();
    // a link in place of a history file, and a link in place of a whole folder: neither is followed or removed
    const home = installation();
    const outside = home.file('elsewhere/precious.json', 'precious');
    symlinkSync(outside, path.join(home.root, 'bots/Arthur/histories/link.json'));
    mkdirSync(path.join(home.root, 'elsewhere/dir'), { recursive: true });
    writeFileSync(path.join(home.root, 'elsewhere/dir/memory.json'), 'precious too');
    const { rmSync } = await import('node:fs');
    rmSync(path.join(home.root, 'bots/Mira'), { recursive: true });
    symlinkSync(path.join(home.root, 'elsewhere/dir'), path.join(home.root, 'bots/Mira'));
    const outcome = await runReset(home.inputs, { confirmed: true, files });
    assert.equal(readFileSync(outside, 'utf8'), 'precious');
    assert.equal(readFileSync(path.join(home.root, 'elsewhere/dir/memory.json'), 'utf8'), 'precious too');
    assert.ok(existsSync(path.join(home.root, 'bots/Arthur/histories/link.json')));
    assert.ok(outcome.plan.skipped.some((skipped) => skipped.path.endsWith('link.json') && /a link/.test(skipped.why)));
    assert.ok(outcome.plan.skipped.some((skipped) => skipped.path.endsWith(path.join('bots', 'Mira')) && /a link/.test(skipped.why)));
    assert.ok(outcome.removed.every((removed) => removed.startsWith(path.join(home.root, 'bots') + path.sep)));

    // folders that hold what a reset must keep, or names that are not names: the whole reset is refused
    const refusals = [
        [{ checkpoint_dir: 'genesis/profiles' }, /holds, or lies inside/],
        [{ memory_dir: 'genesis' }, /holds, or lies inside/],
        [{ ledger_file: 'genesis/genesis.world.json' }, /holds, or lies inside/],
        [{ checkpoint_dir: '.' }, /is the working folder or lies above it/],
        [{ checkpoint_dir: '..' }, /is the working folder or lies above it/],
        [{ agents: ['Arthur', '../../etc'] }, /is not an agent name/],
        [{ agents: [] }, /no agents are listed/],
        [{ checkpoint_dir: '' }, /checkpoint_dir is not given/],
    ];
    for (const [override, reason] of refusals) {
        const safe = installation();
        const before = safe.everything();
        const refused = await runReset({ ...safe.inputs, ...override }, { confirmed: true, files });
        assert.equal(refused.plan.ok, false, JSON.stringify(override));
        assert.match(refused.plan.refused.join('\n'), reason);
        assert.deepEqual(safe.everything(), before, `a refused reset removed something (${JSON.stringify(override)})`);
        assert.match(resetLines(refused).join('\n'), /RESET REFUSED\. Nothing was removed\./);
    }
    // the plan alone never needs more than a look: it writes and removes nothing
    const calls = [];
    const watching = { kind: async (file) => { calls.push('kind'); return files.kind(file); }, list: async (dir) => { calls.push('list'); return files.list(dir); },
        remove: async () => { calls.push('remove'); }, write: async () => { calls.push('write'); } };
    await planReset({ ...installation().inputs, files: watching });
    assert.ok(calls.length > 0 && calls.every((call) => call === 'kind' || call === 'list'));
});

// ---- the launcher's gate ------------------------------------------------------------------

test('launcher: planning is refused without a bootstrap manifest that matches the world file', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'genesis-gate-'));
    const world_file = path.join(dir, 'genesis.world.json');
    const manifest_file = path.join(dir, 'genesis_world', 'bootstrap.manifest.json');
    const planning = { enabled: true, operators: ['TheOperator'], world_file, manifest_file, checkpoint_dir: path.join(dir, 'checkpoints'), model: { url: 'http://127.0.0.1:9', model: 'm' } };
    const settings = { profiles: [], genesis_planning: planning };
    const gate = () => checkBootstrap(settings, REPO_ROOT);

    assert.deepEqual(checkBootstrap({ genesis_planning: { ...planning, enabled: false } }, REPO_ROOT), [], 'planning off: nothing is asked for');
    // a minimal "v": 1 file names the zones, but no world was ever bootstrapped from it
    writeFileSync(world_file, JSON.stringify(WORLD_CONFIG));
    assert.match(gate()[0], /\[wrong_version\]$/);
    // a world file that does not pass its checks
    writeFileSync(world_file, JSON.stringify(changed(exampleWorld(), (c) => { c.plots[4] = { ...c.plots[4], min: [-20, 64, -20], max: [-5, 77, -5] }; })));
    assert.match(gate().join('\n'), /plot spare-1 overlaps the camp \[zone_overlap\]$/m);
    // a valid world file, never bootstrapped
    writeFileSync(world_file, JSON.stringify(exampleWorld()));
    assert.deepEqual(gate().length, 1);
    assert.match(gate()[0], /there is no bootstrap manifest, so planning stays off: run {2}node genesis\/world\/bootstrap\.js/);
    // bootstrapped: planning may start
    const { result } = await bootstrappedWorld(dir);
    assert.deepEqual(gate(), []);
    // the world file changes after the bootstrap: the manifest no longer matches
    writeFileSync(world_file, JSON.stringify(changed(exampleWorld(), (c) => { c.kits[4].count = 32; })));
    assert.match(gate()[0], /is for another version of the world file \(its hash does not match\)/);
    writeFileSync(world_file, JSON.stringify(exampleWorld(), null, 4)); // the same content, laid out differently
    assert.deepEqual(gate(), []);
    // a manifest whose checks did not pass, one that is not a manifest, and a reset that was not followed up
    writeFileSync(manifest_file, JSON.stringify({ ...result.manifest, verified: false }));
    assert.match(gate()[0], /the last bootstrap run did not pass its checks/);
    writeFileSync(manifest_file, '{ "kind": "something else" }');
    assert.match(gate()[0], /is not a bootstrap manifest/);
    writeFileSync(manifest_file, JSON.stringify(result.manifest));
    assert.deepEqual(gate(), []);
    writeFileSync(path.join(dir, 'genesis_world', RESET_MARKER_FILE), 'reset');
    assert.match(gate()[0], /a full reset was run and the world has not been bootstrapped since/);

    // the launcher itself: it does not start a single agent while the gate is closed
    const { rmSync } = await import('node:fs');
    rmSync(path.join(dir, 'genesis_world'), { recursive: true });
    const profile = path.join(dir, 'arthur.json');
    writeFileSync(profile, readFileSync(path.join(REPO_ROOT, 'genesis', 'profiles', 'arthur.json'), 'utf8').replaceAll('DESKTOP_IP', '192.0.2.10').replaceAll('GENESIS_MODEL', 'some-model:latest'));
    const settings_file = path.join(dir, 'settings.json');
    const shipped = JSON.parse(readFileSync(path.join(REPO_ROOT, 'genesis', 'settings.json'), 'utf8'));
    writeFileSync(settings_file, JSON.stringify({ ...shipped, profiles: [profile], genesis_planning: planning }));
    const preload = pathToFileURL(path.join(REPO_ROOT, 'genesis', 'tests', 'helpers', 'preload-main-stubs.mjs')).href;
    const env = { ...process.env, GENESIS_SETTINGS_FILE: settings_file };
    delete env.SETTINGS_JSON;
    const start = () => spawnSync(process.execPath, ['--import', preload, 'genesis/start.js'], { cwd: REPO_ROOT, env, encoding: 'utf8', timeout: 30000 });
    const refused = start();
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /Genesis config problem: .*there is no bootstrap manifest, so planning stays off/);
    assert.ok(!refused.stdout.includes('GENESIS_TEST_AGENT'), 'an agent was started without a bootstrapped world');
    assert.ok(!refused.stdout.includes('GENESIS_TEST_SOCKET_EXTENSION'), 'planning was switched on without a bootstrapped world');
    // a routine range that is not the decided one is still reported once, by the zones check
    assert.deepEqual(checkWorld(settings, REPO_ROOT).filter((problem) => /range/.test(problem)), []);
});

test('bootstrap script: --validate and --plan need no server, and a run without the RCON password changes nothing', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'genesis-bootstrap-cli-'));
    const world_file = path.join(dir, 'genesis.world.json');
    const manifest_file = path.join(dir, 'genesis_world', 'bootstrap.manifest.json');
    writeFileSync(world_file, JSON.stringify(exampleWorld()));
    const env = { ...process.env };
    for (const key of ['GENESIS_RCON_PASSWORD', 'GENESIS_RCON_HOST', 'GENESIS_RCON_PORT', 'GENESIS_SETTINGS_FILE']) delete env[key];
    const run = (...args) => spawnSync(process.execPath, ['genesis/world/bootstrap.js', '--world', world_file, '--manifest', manifest_file, ...args], { cwd: REPO_ROOT, env, encoding: 'utf8', timeout: 30000 });

    const valid = run('--validate');
    assert.equal(valid.status, 0, valid.stderr);
    assert.match(valid.stdout, /is valid \(seed 20261116, sha256 [0-9a-f]{64}\)/);
    const plan = run('--plan');
    assert.equal(plan.status, 0, plan.stderr);
    assert.equal(JSON.parse(plan.stdout).blocks.length, 280);
    const no_password = run();
    assert.equal(no_password.status, 1);
    assert.match(no_password.stderr, /GENESIS_RCON_PASSWORD is not set/);
    assert.equal(existsSync(manifest_file), false);

    writeFileSync(world_file, JSON.stringify(changed(exampleWorld(), (c) => { c.agents.Mira.range = 48; })));
    const invalid = run('--validate');
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /World file problem: agents\.Mira\.range is 48.*\[wrong_range\]/);
    assert.match(invalid.stderr, /Nothing was sent to the server/);
});

// ---- the strip one block outside the fence (decided after the first run: mobs stepped over the fence from higher land) ----

test('strip: land that is higher just outside the fence is brought down to the camp\'s floor, one block wide, recorded as the Operator\'s', async () => {
    const server = wildServer();
    const put = (x, y, z, name) => server.blocks.set(`${x},${y},${z}`, { name, states: {} });
    // a bank three blocks high along the whole east side, right against the fence, and two blocks deep
    for (let z = -12; z <= 12; z++) for (let y = 63; y <= 66; y++) { put(13, y, z, y === 66 ? 'grass_block' : 'dirt'); put(14, y, z, y === 66 ? 'grass_block' : 'dirt'); }
    const { result, files } = await bootstrap(exampleWorld(), { server });
    assert.equal(result.ok, true, result.problems.join('; '));
    for (let z = -12; z <= 12; z++) {
        assert.deepEqual([63, 64, 65, 66].map((y) => server.blockAt(13, y, z).name), ['grass_block', 'air', 'air', 'air'], `the strip at 13, ${z}`);
        assert.deepEqual([63, 66].map((y) => server.blockAt(14, y, z).name), ['dirt', 'grass_block'], 'the land two blocks outside is left as it is');
    }
    const areas = parseManifest(files.store.get(MANIFEST)).areas;
    const east = areas.filter((record) => record.zone === 'camp.strip.east').map((record) => [record.id, record.changed, record.status, record.by, record.method]);
    assert.deepEqual(east, [['camp.strip.east.clear', 75, 'filled', 'Operator', 'vanilla'], ['camp.strip.east.floor', 25, 'filled', 'Operator', 'vanilla']]);
    assert.deepEqual(result.warnings, []);

    // once: a second run levels nothing, and does not look at the strip again (what the agents do there later is theirs)
    server.log.length = 0;
    put(13, 64, 0, 'cobblestone');
    const again = await bootstrap(exampleWorld(), { server, files });
    assert.equal(again.result.ok, true, again.result.problems.join('; '));
    assert.equal(server.log.some((command) => command.startsWith('fill ')), false);
    assert.equal(server.blockAt(13, 64, 0).name, 'cobblestone');
});

test('strip: it is never levelled over something built, and it never cuts into the field or a plot', async () => {
    // something built stands in the west strip: that run of the strip is left alone, whole, and the report says so
    const server = wildServer();
    server.blocks.set('-13,64,3', { name: 'cobblestone', states: {} });
    const { result, files } = await bootstrap(exampleWorld(), { server });
    assert.equal(result.ok, true, result.problems.join('; '));
    assert.equal(server.blockAt(-13, 64, 3).name, 'cobblestone');
    assert.equal(server.blockAt(-13, 64, 0).name, 'oak_log', 'the natural log in the same run stays too: the run is not touched');
    assert.equal(server.blockAt(-13, 63, 5).name, 'air', 'no floor was laid in a run that holds something built');
    const west = parseManifest(files.store.get(MANIFEST)).areas.filter((record) => record.zone === 'camp.strip.west');
    assert.deepEqual(west.map((record) => [record.id, record.changed, record.placed, record.status]), [
        ['camp.strip.west.clear', 0, false, 'not levelled: something that is not natural land stands at -13, 64, 3'],
        ['camp.strip.west.floor', 0, false, 'not levelled: something that is not natural land stands at -13, 64, 3'],
    ]);
    assert.deepEqual(result.warnings.filter((line) => /strip/.test(line)).length, 1);
    assert.match(result.warnings.join('\n'), /The strip outside the fence \(west\) was NOT levelled: something that is not natural land stands at -13, 64, 3\. It was left as it is/);
    assert.equal(server.blockAt(13, 63, 0).name, 'grass_block', 'the other sides are levelled');

    // a plot that touches the fence: the cells of the ring that are the plot's are left out, the run is cut in two
    const config = exampleWorld();
    config.plots[3] = { ...config.plots[3], min: [-12, 64, -28], max: [3, 77, -13] };
    const strip = campStrip(config);
    assert.deepEqual(strip.segments.filter((part) => part.side === 'north'), [{ id: 'north.1', side: 'north', min: [-13, -13], max: [-13, -13] }, { id: 'north.2', side: 'north', min: [4, -13], max: [13, -13] }]);
    assert.deepEqual(strip.left_out, [{ zone: 'plot.nova-1', cells: 16, floor_y: 63, higher: false }]);
    const plan = buildBootstrapPlan(config);
    const others = [{ min: config.field.min, max: config.field.max }, ...config.plots.map((plot) => ({ min: [plot.min[0], plot.min[2]], max: [plot.max[0], plot.max[2]] }))];
    for (const area of plan.areas.filter((record) => record.strip)) {
        for (const box of others) {
            assert.equal(area.min[0] <= box.max[0] && box.min[0] <= area.max[0] && area.min[2] <= box.max[1] && box.min[1] <= area.max[2], false, `${area.id} cuts into a plot or the field`);
        }
    }
    assert.deepEqual(plan.areas.filter((record) => record.strip && record.kind === 'floor').map((record) => record.id),
        ['camp.strip.north.1.floor', 'camp.strip.north.2.floor', 'camp.strip.south.floor', 'camp.strip.west.floor', 'camp.strip.east.floor']);
    // the field against the fence, on a higher floor: left out, and the bootstrap warns that something could step over there
    const high = exampleWorld();
    high.field = { ...high.field, min: [13, -4], max: [21, 4], y: 64, water: [[17, 0]] };
    assert.deepEqual(campStrip(high).left_out, [{ zone: 'field', cells: 9, floor_y: 64, higher: true }]);
    const warned = await bootstrap(high, { server: fakeMinecraft({ seed: '20261116' }) });
    assert.match(warned.result.warnings.join('\n'), /The strip outside the fence leaves out 9 block\(s\) that belong to the field, whose floor \(layer 64\) is HIGHER than the camp's \(layer 63\): something could step over the fence there\./);
});

test('strip: a world bootstrapped before the strip was decided is asked to run the bootstrap again, which levels the strip and nothing else', async () => {
    const first = await bootstrap(exampleWorld(), { server: wildServer() });
    assert.equal(first.result.ok, true);
    // the manifest as an older bootstrap wrote it: no record of the strip; and the land outside the fence as it was then
    const old = parseManifest(first.files.store.get(MANIFEST));
    old.areas = old.areas.filter((record) => !record.zone.startsWith('camp.strip.'));
    first.files.store.set(MANIFEST, JSON.stringify(old));
    for (let z = -12; z <= 12; z++) { first.server.blocks.set(`13,64,${z}`, { name: 'dirt', states: {} }); first.server.blocks.set(`13,65,${z}`, { name: 'grass_block', states: {} }); }
    assert.match(checkManifest(old, first.config).join('\n'), /has no record of the strip outside the camp's fence .*run the bootstrap again/);
    assert.equal(checkManifest(old, first.config).length, 1);

    first.server.log.length = 0;
    const again = await bootstrap(first.config, { server: first.server, files: first.files, clock: first.clock });
    assert.equal(again.result.ok, true, again.result.problems.join('; '));
    // only the east strip had anything to change; the camp, the field and the plots were not levelled again
    assert.deepEqual(first.server.log.filter((command) => command.startsWith('fill ')), ['fill 13 64 -12 13 87 12 minecraft:air']);
    assert.deepEqual(again.result.placed, { blocks: 0, items: 0, rules: 0, cleared: 50, floored: 0 });
    const manifest = parseManifest(first.files.store.get(MANIFEST));
    assert.deepEqual(checkManifest(manifest, first.config), []);
    assert.equal(manifest.areas.length, 22);
    assert.equal(manifest.rules.find((rule) => rule.id === 'time.first_morning').status, 'set, once', 'the morning of the first run was set again, or its record lost');
    assert.equal(first.server.log.some((command) => command.startsWith('time set')), false);
});
