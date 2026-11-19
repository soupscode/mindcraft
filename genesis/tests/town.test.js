// The town: the town file layered over the world file, plot sizes, plots and bridges that code
// proposes, builds that are started, tracked and verified, homes the agents live in, and their
// long-term goals.
//
// No Minecraft server, no model, no database: the world is helpers/fake-world.mjs, the files
// are in memory. Nothing here was levelled, built or slept in by a real bot.
// Run from the repository root:  node --test genesis/tests/*.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { REPO_ROOT } from './helpers/stubs.mjs';
import { fakeClock, fakeFiles, settle } from './helpers/fakes.mjs';
import { fakeWorld, WORLD_CONFIG } from './helpers/fake-world.mjs';
import { makeTown } from './helpers/town.mjs';
import { createZones } from '../catalog/zones.js';
import { buildBlueprints } from '../catalog/blueprints.js';
import { worldHash } from '../world/world_config.js';
import { createTown, spanPrefabName } from '../town/town.js';
import { createTownFile, checkTown, emptyTown, plotSizeFor, sizeFits, PLOT_SIZES, SPAN_WIDTH, LANE, DEFAULT_TOWN_FILE } from '../town/town_file.js';
import { proposePlot, proposeSpan, PROPOSER_RULES } from '../town/proposer.js';
import { createTownClient, townZones, townBlueprints, building } from '../town/client.js';
import { columnOf } from '../town/tracker.js';
import { homePlaces, homeChestName } from '../town/homes.js';
import { longTermCandidates, defaultChoice, nextRung, parseGoalReply, ROLE_GOALS, LONG_TERM_LIMITS } from '../town/goals.js';
import { townView, importPrefab } from '../town/views.js';
import { rotatePrefab, checkPrefab, prefabCells, billOf } from '../build/prefab.js';
import { buildSchematic } from '../build/schematic.js';
import { validateEvent } from '../shared/events.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const PREFABS = buildBlueprints({ root: REPO_ROOT });
const NAMES = ['Arthur', 'Mira', 'Felix', 'Nova'];
// a world file with a 16 by 16 home plot for each agent, as the example has them (v 1 shape: the zones read both)
const CONFIG = {
    ...WORLD_CONFIG,
    plots: [
        { id: 'arthur-1', owner: 'Arthur', min: [-34, 64, 14], max: [-19, 77, 29], blueprint: 'lean_to' },
        { id: 'mira-1', owner: 'Mira', min: [-4, 64, 14], max: [11, 77, 29], blueprint: null },
        { id: 'felix-1', owner: 'Felix', min: [28, 64, 14], max: [43, 77, 29], blueprint: null },
        { id: 'nova-1', owner: 'Nova', min: [-12, 64, -30], max: [3, 77, -15], blueprint: null },
        { id: 'spare-1', owner: null, min: [-34, 64, -30], max: [-19, 77, -15], blueprint: null },
    ],
};
const HASH = worldHash(CONFIG);
const verifiedBuild = (builder, prefab, plot, at = '2026-11-18T10:00:00.000Z') => ({ build_id: `b-${builder}-${prefab}`, plot, prefab, prefab_sha256: 'x', builder, tier: PREFABS.get(prefab).tier, kind: PREFABS.get(prefab).kind, stage: null,
    cells_total: billOf(PREFABS.get(prefab)).cells, cells_matching: billOf(PREFABS.get(prefab)).cells, started_at: at, finished_at: at, verified_at: at, verified_day: 3 });

async function freshTown({ files = fakeFiles(), clock = fakeClock(), world_sha256 = HASH, events = [] } = {}) {
    const file = createTownFile({ files, file: '/town/genesis.town.json' });
    const town = createTown({ file, zones_config: CONFIG, prefabs: PREFABS, clock, world_sha256, emit: (type, data) => events.push(data) });
    const loaded = await town.load();
    return { town, files, clock, file, loaded, events };
}
// puts a verified build into the town, as a builder's process would report it
function verify(town, builder, prefab, plot) {
    assert.deepEqual(town.apply(builder, { kind: 'build_started', plot }).ok, true, `${builder} could not start ${prefab} on ${plot}: ${JSON.stringify(town.view().plots.find((p) => p.id === plot))}`);
    const done = town.apply(builder, { kind: 'build_verified', plot, day: 5 });
    assert.equal(done.ok, true, JSON.stringify(done));
}

// ---- step 5: the town file ---------------------------------------------------------------------------

test('town file: sizes, what does not hold is refused, and it is written the way checkpoints are', async () => {
    assert.deepEqual({ ...PLOT_SIZES }, { S: 16, M: 24, L: 32 });
    assert.deepEqual([SPAN_WIDTH, LANE, DEFAULT_TOWN_FILE], [5, 4, './bots/genesis_town/genesis.town.json']);
    // decided table: S homes up to the Cottage, M the House and the Storehouse, L the Hall; a bridge gets a span
    assert.deepEqual(Object.fromEntries(PREFABS.names().map((name) => [name, plotSizeFor(PREFABS.get(name))])),
        { cabin: 'S', cottage: 'S', footbridge: 'span', hall: 'L', house: 'M', lean_to: 'S', shack: 'S', storehouse: 'M' });
    assert.deepEqual([plotSizeFor({ by: 'Operator', kind: 'shared', size: { x: 10, z: 12 } }), plotSizeFor({ by: 'Operator', kind: 'shared', size: { x: 18, z: 9 } }), plotSizeFor({ by: 'Operator', kind: 'shared', size: { x: 26, z: 26 } })], ['S', 'M', 'L']);
    assert.deepEqual([sizeFits('S', 'S'), sizeFits('S', 'M'), sizeFits('L', 'M'), sizeFits('S', 'span')], [true, false, true, false]);
    const town = emptyTown({ world_sha256: HASH, home: [0, 64, 0] });
    assert.deepEqual(checkTown(town), []);
    assert.deepEqual(town.limit, { min: [-44, -44], max: [44, 44] }, 'the default town limit: 44 blocks from the home point');
    const bad = (change) => { const t = JSON.parse(JSON.stringify(town)); change(t); return checkTown(t).join(' | '); };
    assert.match(bad((t) => { t.v = 2; }), /"v" must be 1/);
    assert.match(bad((t) => { t.plots.push({ id: 'town-1', size: 'M', kind: 'shared', owner: 'Arthur', min: [0, 64, 0], max: [15, 77, 15] }); }), /is 16 by 16, a plot of size M is 24 by 24/);
    assert.match(bad((t) => { t.plots.push({ id: 'town 1', size: 'S', kind: 'home', owner: 'Mira', min: [0, 64, 0], max: [15, 77, 15] }); }), /id must be a name/);
    assert.match(bad((t) => { t.plots.push({ id: 'a', size: 'S', kind: 'castle', owner: 'Mira', min: [0, 64, 0], max: [15, 77, 15] }, { id: 'a', size: 'S', kind: 'home', owner: 'Mira', min: [40, 64, 0], max: [55, 77, 15] }); }), /kind must be home or shared.*used twice/);
    assert.match(bad((t) => { t.spans.push({ id: 's', owner: 'Arthur', min: [0, 64, 0], max: [5, 67, 8] }); }), /a span is 5 wide/);
    assert.match(bad((t) => { t.limit = { min: [0], max: [1, 2] }; }), /"limit" must be/);
    assert.equal(checkTown(null)[0], 'the town file must be a JSON object');

    // written to .tmp, read back, renamed; a write that dies leaves the town as it was
    const files = fakeFiles();
    const file = createTownFile({ files, file: '/town/genesis.town.json' });
    assert.deepEqual(await file.load(), { ok: false, missing: true, problems: [] });
    await file.save(town);
    assert.deepEqual(files.log.slice(-2), [['write', '/town/genesis.town.json.tmp'], ['rename', '/town/genesis.town.json.tmp', '/town/genesis.town.json']]);
    const changed = { ...town, wanted: [{ id: 'w', for: 'Arthur', kind: 'shared', size: 'M', prefab: 'storehouse', why: 'x' }] };
    files.fail_rename = new Error('killed');
    await assert.rejects(file.save(changed), /killed/);
    assert.deepEqual((await file.load()).town.wanted, [], 'the town as it was is still what the file holds');
    await file.save(changed);
    assert.equal((await file.load()).town.wanted.length, 1);
    await assert.rejects(file.save({ ...town, v: 9 }), /town file refused/);
    files.store.set('/town/genesis.town.json', '{"v":1');
    assert.match((await file.load()).problems[0], /is not JSON/);
});

test('town over world: the zones read both files, overlaps are refused across both, and the world file is never touched', async () => {
    const { town, files, events } = await freshTown();
    const world_text = JSON.stringify(CONFIG);
    // everyone builds their own home (decided): each agent's own plot is given the first tier
    const assigned = Object.fromEntries(town.view().plots.map((plot) => [plot.id, plot.prefab]));
    assert.deepEqual(assigned, { 'arthur-1': 'lean_to', 'mira-1': 'lean_to', 'felix-1': 'lean_to', 'nova-1': 'lean_to', 'spare-1': null });
    assert.ok(town.view().plots.every((plot) => plot.world && plot.by === 'Operator'), 'the plots of the world file are the Operator\'s');
    // Arthur has verified his lean-to, shack and cabin: the storehouse is his next shared project, and the town wants a plot for it
    for (const prefab of ['lean_to', 'shack', 'cabin']) verify(town, 'Arthur', prefab, 'arthur-1');
    assert.deepEqual(town.view().wanted.map((w) => [w.for, w.kind, w.size, w.prefab]), [['Arthur', 'shared', 'M', 'storehouse']]);
    const wanted = town.view().wanted[0];
    const propose = (min) => town.apply('Arthur', { kind: 'propose_plot', wanted: wanted.id, min, max: [min[0] + 23, min[1] + 13, min[2] + 23], score: { relief: 1, distance: 30 } });
    // across both files: on the camp, on a plot of the world file, closer than a lane, outside the limit, out of range
    assert.deepEqual(propose([-8, 64, -8]), { ok: false, reason: 'too_close_to_camp' });
    assert.deepEqual(propose([-30, 64, 20]), { ok: false, reason: 'too_close_to_plot_arthur-1' });
    assert.deepEqual(propose([-34, 64, 32]), { ok: false, reason: 'too_close_to_plot_arthur-1' }, 'two blocks from the plot: closer than a lane');
    assert.deepEqual(propose([30, 64, 34]), { ok: false, reason: 'outside_town_limit' });
    assert.deepEqual(town.apply('Arthur', { kind: 'propose_plot', wanted: wanted.id, min: [-40, 64, 34], max: [-25, 77, 49] }), { ok: false, reason: 'wrong_size' });
    assert.deepEqual(town.apply('Mira', { kind: 'propose_plot', wanted: wanted.id, min: [-44, 64, 34], max: [-21, 77, 57] }), { ok: false, reason: 'not_wanted' }, 'only the agent the plot is for places it');
    town.operator({ kind: 'limit', min: [-60, -60], max: [60, 60] });
    assert.deepEqual(propose([-12, 64, 34]), { ok: false, reason: 'outside_Arthur_range' }, 'a corner 58 blocks from his home');
    // (with the five plots of the world file there is one place for an M plot inside Arthur's 48 blocks: north-east of the camp)
    const ok = propose([8, 64, -36]);
    assert.deepEqual(ok, { ok: true, id: 'town-1' });
    await town.flush();
    const plot = town.view().plots.find((p) => p.id === 'town-1');
    assert.deepEqual([plot.size, plot.kind, plot.owner, plot.prefab, plot.by, plot.levelled_by, plot.world], ['M', 'shared', 'Arthur', 'storehouse', 'Code', 'Builder', false]);
    assert.deepEqual(town.view().wanted, [], 'the plot that was wanted is there');
    assert.equal(JSON.stringify(CONFIG), world_text, 'the world file\'s content was changed');
    assert.equal(worldHash(CONFIG), HASH);
    assert.ok(!files.log.some(([op, name]) => op !== 'read' && !String(name).startsWith('/town/')), 'something outside the town file was written');
    assert.deepEqual(checkTown(JSON.parse(files.store.get('/town/genesis.town.json'))), []);
    assert.ok(events.some((data) => data.state === 'plot_proposed' && data.detail.id === 'town-1' && data.detail.why === 'Storehouse is the next shared project'));

    // an agent's zones: the world file's first, then the town's
    const client = { agent: 'Arthur', state: () => town.state() };
    const zones = townZones(createZones(CONFIG), client, 'Arthur');
    assert.deepEqual(zones.plots().map((p) => p.id), ['arthur-1', 'mira-1', 'felix-1', 'nova-1', 'spare-1', 'town-1']);
    const mine = zones.plot('town-1');
    assert.deepEqual([mine.blueprint, mine.built, mine.owner, mine.town, mine.level], ['storehouse', null, 'Arthur', true, true]);
    assert.deepEqual([zones.plot('arthur-1').blueprint, zones.plot('arthur-1').built, zones.plot('arthur-1').level], ['cottage', 'cabin', false], 'his home plot holds the next tier, on the verified one');
    assert.equal(zones.protectedAt({ x: 20, y: 70, z: -20 }), 'plot:town-1', 'a plot of the town is a protected zone like any other');
    assert.equal(zones.protectedAt({ x: 20, y: 63, z: -20 }), 'plot:town-1', 'with the layer under it');
    assert.equal(zones.protectedAt({ x: 0, y: 64, z: 0 }), 'camp');
    assert.deepEqual(zones.plotOverlaps('town-1'), []);
    assert.ok(zones.places('Arthur').some((place) => place.id === 'plot-town-1' && place.kind === 'plot'));
    assert.ok(!zones.places('Mira').some((place) => place.id === 'plot-town-1'), 'somebody else\'s plot is not a place to walk to');
    assert.equal(createZones(CONFIG).plot('town-1'), null, 'the world file\'s own zones know nothing of the town');

    // kept: a new process reads the same town; a town file of another world is not this town
    const again = await freshTown({ files });
    assert.deepEqual([again.loaded.loaded, again.loaded.plots, again.loaded.builds], [true, 1, 3]);
    assert.deepEqual(again.town.view().plots.find((p) => p.id === 'town-1').min, [8, 64, -36]);
    const other = await freshTown({ files, world_sha256: 'another-world' });
    assert.deepEqual([other.loaded.loaded, other.town.view().plots.length], [false, 5]);
});

// ---- step 5: the proposer ------------------------------------------------------------------------------

test('proposer: on a synthetic survey it picks the flattest cell in range, nearest first, and never a place that is taken, wet, unloaded or on a tree', () => {
    const home = { x: 0, y: 64, z: 0 };
    const limit = { min: [-44, -44], max: [44, 44] };
    const taken = [{ name: 'camp', min: { x: -8, z: -8 }, max: { x: 8, z: 8 } }, { name: 'field', min: { x: 12, z: -4 }, max: { x: 20, z: 4 } }];
    const ranges = [{ agent: 'Arthur', home, range: 48 }];
    // the land: flat at 63 everywhere, a hill in the north-east, a lake in the south, and one flat shelf at 64 far west
    const land = (x, z) => {
        if (z > 16 && x > -10 && x < 30) return { y: 61, wet: true };
        if (x > 10 && z < -10) return { y: 63 + Math.floor((x - 10) / 2) + Math.floor((-10 - z) / 3), wet: false };
        return { y: 63, wet: false };
    };
    const found = proposePlot({ size: 'S', home, limit, taken, ranges, heightAt: land });
    assert.equal(found.ok, true);
    const { min, max } = found.plot;
    assert.deepEqual([max[0] - min[0] + 1, max[2] - min[2] + 1, max[1] - min[1] + 1], [16, 16, 14]);
    assert.equal(found.score.relief, 0, 'flat land was there to be had');
    assert.equal(min[1], 64, 'the plot\'s lowest layer is the one over the ground');
    // not closer than a lane to the camp or the field, inside the limit, every corner in range
    const box = { min: { x: min[0], z: min[2] }, max: { x: max[0], z: max[2] } };
    for (const other of taken) assert.ok(box.min.x - LANE > other.max.x || other.min.x - LANE > box.max.x || box.min.z - LANE > other.max.z || other.min.z - LANE > box.max.z, `closer than a lane to the ${other.name}`);
    assert.ok(min[0] >= -44 && max[0] <= 44 && min[2] >= -44 && max[2] <= 44);
    for (const [x, z] of [[min[0], min[2]], [max[0], max[2]], [min[0], max[2]], [max[0], min[2]]]) assert.ok(Math.hypot(x, z) <= 48);
    assert.ok(found.score.distance < 30, `the nearest of the flat cells (${found.score.distance} blocks from home)`);
    assert.equal(min[0] % PROPOSER_RULES.grid === 0 && min[2] % PROPOSER_RULES.grid === 0, true, 'on the 4-block grid from the home point');
    // the same land gives the same plot
    assert.deepEqual(proposePlot({ size: 'S', home, limit, taken, ranges, heightAt: land }), found);
    // a tree on the best cell: the next best is taken
    const tree = { x: min[0] + 7, z: min[2] + 9 };
    const moved = proposePlot({ size: 'S', home, limit, taken, ranges, heightAt: land, blockedAt: (x, z) => x === tree.x && z === tree.z });
    assert.ok(moved.ok && (moved.plot.min[0] !== min[0] || moved.plot.min[2] !== min[2]), 'the plot was put on a tree');
    assert.ok(!(tree.x >= moved.plot.min[0] && tree.x <= moved.plot.max[0] && tree.z >= moved.plot.min[2] && tree.z <= moved.plot.max[2]));
    // flatter beats nearer: rough land near home, a flat shelf further out
    const rough = (x, z) => (Math.hypot(x, z) < 30 ? { y: 63 + ((Math.abs(x) + Math.abs(z)) % 8 < 4 ? 0 : 2), wet: false } : { y: 63, wet: false });
    const far = proposePlot({ size: 'S', home, limit, taken, ranges, heightAt: rough });
    assert.deepEqual([far.ok, far.score.relief], [true, 0]);
    assert.ok(far.score.distance > 28);
    // a bigger plot, and the reasons nothing fits
    const m = proposePlot({ size: 'M', home, limit: { min: [-60, -60], max: [60, 60] }, taken, ranges: [{ agent: 'Arthur', home, range: 48 }], heightAt: () => ({ y: 63, wet: false }) });
    assert.deepEqual([m.ok, m.plot.max[0] - m.plot.min[0] + 1], [true, 24]);
    assert.deepEqual(proposePlot({ size: 'L', home, limit, taken, ranges: [{ agent: 'Mira', home, range: 32 }], heightAt: land }).ok, false, 'an L plot has no place inside 32 blocks of home around the camp');
    assert.match(proposePlot({ size: 'S', home, limit, taken, ranges, heightAt: () => null }).reason, /no_place: unloaded/);
    assert.match(proposePlot({ size: 'S', home, limit, taken, ranges, heightAt: () => ({ y: 61, wet: true }) }).reason, /no_place: wet/);
    assert.match(proposePlot({ size: 'S', home, limit, taken, ranges, heightAt: (x, z) => ({ y: 60 + ((x * 7 + z * 13) % 9 + 9) % 9, wet: false }) }).reason, /no_place: rough/);
    assert.equal(proposePlot({ size: 'S', home, limit: { min: [0, 0], max: [10, 10] }, taken, ranges, heightAt: land }).reason, 'no_room_inside_the_limit');
    assert.equal(proposePlot({ size: 'XL', home, limit, heightAt: land }).reason, 'unknown_size');
});

test('proposer: a bridge goes where a walk cannot get across: from bank to bank, 5 to 15 long, turned to the way of the walk', () => {
    // a river 7 wide running north-south at x 20..26, the banks at 63
    const river = (x) => (x >= 20 && x <= 26 ? { y: 61, wet: true } : { y: 63, wet: false });
    const east = proposeSpan({ from: { x: 10, y: 64, z: 3 }, to: { x: 40, y: 64, z: 5 }, columnAt: (x) => river(x) });
    assert.equal(east.ok, true);
    assert.deepEqual([east.span.axis, east.span.length, east.span.rotation, east.span.from, east.span.to], ['x', 9, 90, [19, 63, 3], [27, 63, 3]]);
    assert.deepEqual([east.span.min, east.span.max], [[19, 64, 1], [27, 67, 5]], 'five wide across the walk, from the top of one bank to the other');
    // walked the other way it is the same span
    const west = proposeSpan({ from: { x: 40, y: 64, z: 3 }, to: { x: 10, y: 64, z: 3 }, columnAt: (x) => river(x) });
    assert.deepEqual([west.span.min, west.span.max, west.span.length], [[19, 64, 1], [27, 67, 5], 9]);
    // north-south: not turned
    const south = proposeSpan({ from: { x: 0, y: 64, z: 0 }, to: { x: 2, y: 64, z: 30 }, columnAt: (x, z) => river(z) });
    assert.deepEqual([south.span.axis, south.span.rotation, south.span.min, south.span.max], ['z', 0, [-2, 64, 19], [2, 67, 27]]);
    // a ravine (a drop of three or more) counts like water; a narrow one still gets the shortest bridge there is
    const ravine = proposeSpan({ from: { x: 0, y: 64, z: 0 }, to: { x: 30, y: 64, z: 0 }, columnAt: (x) => (x >= 10 && x <= 11 ? { y: 50, wet: false } : { y: 63, wet: false }) });
    assert.deepEqual([ravine.ok, ravine.span.length], [true, 5]);
    // too wide, no far bank, no gap, land not loaded
    assert.equal(proposeSpan({ from: { x: 0, y: 64, z: 0 }, to: { x: 60, y: 64, z: 0 }, columnAt: (x) => (x >= 10 && x <= 40 ? { y: 61, wet: true } : { y: 63, wet: false }) }).reason, 'too_wide');
    assert.equal(proposeSpan({ from: { x: 0, y: 64, z: 0 }, to: { x: 14, y: 64, z: 0 }, columnAt: (x) => (x >= 10 ? { y: 61, wet: true } : { y: 63, wet: false }) }).reason, 'no_far_bank');
    assert.equal(proposeSpan({ from: { x: 0, y: 64, z: 0 }, to: { x: 30, y: 64, z: 0 }, columnAt: () => ({ y: 63, wet: false }) }).reason, 'no_gap_on_the_way');
    assert.equal(proposeSpan({ from: { x: 0, y: 64, z: 0 }, to: { x: 30, y: 64, z: 0 }, columnAt: (x) => (x > 8 ? null : { y: 63, wet: false }) }).reason, 'not_loaded');
    assert.equal(proposeSpan({ from: { x: 0, y: 64, z: 0 }, to: { x: 20, y: 64, z: 0 }, columnAt: (x) => (x >= 10 && x <= 14 ? { y: 61, wet: true } : { y: x > 14 ? 70 : 63, wet: false }) }).reason, 'no_far_bank', 'the far side is a cliff, not a bank');

    // the span's prefab: the footbridge of that length, five wide, turned for an east-west span
    const blueprints = townBlueprints(PREFABS);
    const span = blueprints.get(spanPrefabName(9));
    assert.deepEqual([span.size, span.below, span.kind], [{ x: 5, y: 2, z: 9 }, 1, 'bridge']);
    assert.deepEqual(span.blocks[0][0], ['', 'oak_planks', 'oak_planks', 'oak_planks', ''], 'the deck is three wide, with a column left alone on each side');
    const turned = blueprints.get('span_9@90');
    assert.deepEqual(turned.size, { x: 9, y: 2, z: 5 });
    assert.equal(prefabCells(turned).length, prefabCells(span).length);
    assert.deepEqual(checkPrefab({ ...turned, materials: undefined }), []);
    assert.equal(blueprints.get('span_99'), null);
    assert.equal(blueprints.get('cabin@45'), null);
    // a quarter turn four times is the prefab again, and keeps and the bed place turn with it
    const cabin = PREFABS.get('cabin');
    const once = rotatePrefab(cabin, 90);
    assert.deepEqual(rotatePrefab(rotatePrefab(rotatePrefab(once, 90), 90), 90).blocks, cabin.blocks);
    assert.equal(once.blocks[once.keeps[0].at[1]][once.keeps[0].at[2]][once.keeps[0].at[0]], 'chest');
    assert.equal(once.blocks[once.bed.head[1]][once.bed.head[2]][once.bed.head[0]], 'air');
    assert.equal(rotatePrefab(cabin, 0), cabin);
});

test('town: a walk that keeps finding no way gets a bridge proposed; the operator can move or remove what code proposed, until a build stands on it', async () => {
    const { town, events } = await freshTown();
    const span = { axis: 'x', length: 9, rotation: 90, from: [29, 63, 3], to: [37, 63, 3], min: [29, 64, 1], max: [37, 67, 5] };
    assert.deepEqual(town.apply('Felix', { kind: 'gap', place: 'ring-3', span }), { ok: true, count: 1, span: null });
    assert.deepEqual(town.apply('Mira', { kind: 'gap', place: 'ring-3', span: null }), { ok: true, count: 2, span: null });
    assert.deepEqual(town.view().plots.filter((p) => p.kind === 'bridge'), [], 'two walks are not enough');
    assert.deepEqual(town.apply('Felix', { kind: 'gap', place: 'ring-3', span }), { ok: true, count: 3, span: 'span-1' });
    const bridge = town.view().plots.find((p) => p.id === 'span-1');
    assert.deepEqual([bridge.kind, bridge.owner, bridge.prefab, bridge.by, bridge.length], ['bridge', 'Arthur', 'span_9', 'Code', 9]);
    assert.equal(bridge.why, 'Felix, Mira: 3 walks to ring-3 found no way');
    assert.deepEqual(town.apply('Felix', { kind: 'gap', place: 'ring-3', span }), { ok: true, count: 4, span: null }, 'one bridge per place');
    assert.ok(events.some((data) => data.state === 'plot_proposed' && data.detail.kind === 'bridge'));
    // a span that is the wrong shape, or outside the builder's range, is counted and not proposed
    for (let i = 0; i < 3; i++) town.apply('Felix', { kind: 'gap', place: 'ring-9', span: { ...span, min: [100, 64, 1], max: [108, 67, 5] } });
    assert.deepEqual([town.state().gaps['ring-9'].span, town.state().gaps['ring-9'].refused], [null, 'outside_Arthur_range']);
    // it is Arthur's to build, as a plot of his zones
    const zones = townZones(createZones(CONFIG), { agent: 'Arthur', state: () => town.state() }, 'Arthur');
    assert.deepEqual([zones.plot('span-1').blueprint, zones.plot('span-1').owner, zones.plot('span-1').min], ['span_9@90', 'Arthur', { x: 29, y: 64, z: 1 }]);

    // the operator moves it two blocks north; then removes it
    assert.deepEqual(town.operator({ kind: 'move', id: 'span-1', min: [29, 64, -1] }), { ok: true, id: 'span-1' });
    assert.deepEqual([town.view().plots.find((p) => p.id === 'span-1').max, town.view().plots.find((p) => p.id === 'span-1').by], [[37, 67, 3], 'Operator']);
    assert.deepEqual(town.operator({ kind: 'move', id: 'span-1', min: [-4, 64, -2] }), { ok: false, reason: 'too_close_to_camp' });
    assert.deepEqual(town.operator({ kind: 'move', id: 'arthur-1', min: [0, 64, 40] }), { ok: false, reason: 'no_such_proposal' }, 'a plot of the world file is not the town\'s to move');
    // once a build was started on it, it stays where it is
    assert.equal(town.apply('Arthur', { kind: 'build_started', plot: 'span-1' }).ok, true);
    assert.deepEqual(town.operator({ kind: 'move', id: 'span-1', min: [29, 64, 5] }), { ok: false, reason: 'a_build_was_started_there' });
    assert.deepEqual(town.operator({ kind: 'remove', id: 'span-1' }), { ok: false, reason: 'a_build_was_started_there' });
    // a proposal nothing stands on can be removed; the town then wants the plot again
    for (const prefab of ['lean_to', 'shack', 'cabin']) verify(town, 'Arthur', prefab, 'arthur-1');
    town.operator({ kind: 'limit', min: [-60, -60], max: [60, 60] });
    const wanted = town.view().wanted.find((w) => w.prefab === 'storehouse');
    assert.equal(town.apply('Arthur', { kind: 'propose_plot', wanted: wanted.id, min: [8, 64, -36], max: [31, 77, -13] }).ok, true);
    assert.deepEqual(town.operator({ kind: 'remove', id: 'town-1' }), { ok: true, id: 'town-1' });
    assert.ok(!town.view().plots.some((p) => p.id === 'town-1'));
    assert.deepEqual(town.view().wanted.map((w) => w.prefab), ['storehouse']);
    assert.deepEqual(town.operator({ kind: 'nonsense' }), { ok: false, reason: 'unknown_op' });
    // nobody builds on somebody else's plot, and nothing is verified that was not started
    assert.deepEqual(town.apply('Mira', { kind: 'build_started', plot: 'arthur-1' }), { ok: false, reason: 'not_your_plot' });
    assert.deepEqual(town.apply('Mira', { kind: 'build_verified', plot: 'mira-1' }), { ok: false, reason: 'no_such_build' });
    assert.deepEqual(town.apply('Stranger', { kind: 'gap', place: 'x' }), { ok: false, reason: 'not_an_agent' });
});

test('town: homes are upgraded in place tier by tier; a home that outgrows its plot and Arthur\'s shared projects get plots of their size', async () => {
    const { town } = await freshTown();
    const prefabOn = (plot) => town.view().plots.find((p) => p.id === plot);
    // Mira: lean-to, then the shack on the same plot, on top of the verified lean-to
    verify(town, 'Mira', 'lean_to', 'mira-1');
    assert.deepEqual([prefabOn('mira-1').prefab, prefabOn('mira-1').built], ['shack', 'lean_to']);
    for (const prefab of ['shack', 'cabin', 'cottage']) verify(town, 'Mira', prefab, 'mira-1');
    // the House is 11 by 9: decided to stand on an M plot. Her S plot keeps the cottage, and the town wants a plot for her
    assert.deepEqual([prefabOn('mira-1').prefab, prefabOn('mira-1').built], ['cottage', 'cottage']);
    assert.deepEqual(town.view().wanted.filter((w) => w.for === 'Mira').map((w) => [w.kind, w.size, w.prefab]), [['home', 'M', 'house']]);
    // nobody else's tier moved, and a build under way is not reassigned under its builder
    assert.equal(prefabOn('felix-1').prefab, 'lean_to');
    assert.equal(town.apply('Felix', { kind: 'build_started', plot: 'felix-1' }).ok, true);
    assert.equal(town.apply('Felix', { kind: 'build_progress', plot: 'felix-1', stage: 'Walls', cells_matching: 12, bill: { oak_planks: 21, chest: 1 }, held: { oak_planks: 4 } }).ok, true);
    assert.deepEqual([prefabOn('felix-1').prefab, town.state().builds.at(-1).cells_matching, town.state().builds.at(-1).stage], ['lean_to', 12, 'Walls']);
    // Arthur: nothing shared until he has earned it (the storehouse is tier 3: after a tier 2 build of his own)
    assert.deepEqual(town.view().wanted.filter((w) => w.for === 'Arthur'), []);
    for (const prefab of ['lean_to', 'shack']) verify(town, 'Arthur', prefab, 'arthur-1');
    assert.deepEqual(town.view().wanted.filter((w) => w.for === 'Arthur'), []);
    verify(town, 'Arthur', 'cabin', 'arthur-1');
    assert.deepEqual(town.view().wanted.filter((w) => w.for === 'Arthur').map((w) => [w.size, w.prefab]), [['M', 'storehouse']]);
    assert.deepEqual(nextRung({ town_state: town.state(), prefabs: PREFABS }), { prefab: 'cottage', title: 'Cottage', kind: 'home', tier: 3, order: 0 }, 'his own home first among the rungs of one tier');
});

// ---- steps 5 and 6 end to end: Arthur builds his home, it is verified, he lives there -------------------------

// a planner that answers at once (the real one keeps 90 seconds between two calls of an agent: genesis/broker/budget.js)
const QUICK = { broker: { budget: { min_gap_ms: 0, max_calls: 1000 } } };
const flat = (world) => { world.fill([-60, 63, -60], [60, 63, 60], 'grass_block'); return world; };
const walking = (command, args, far) => (command === 'goToPosition' ? 500 + far * 100 : 400);
// a model that builds whenever a build is on offer, and else takes the first option
const builder = (request, offered) => {
    const id = offered.find((option) => option.startsWith('build_blueprint:')) ?? offered.find((option) => option.startsWith('furnish_home:')) ?? offered[0];
    return { thought: 'Build.', goals: [{ option_id: id, title: `Do ${id}`.slice(0, 60), reason: 'the test builds' }] };
};

test('building in the town: started, tracked stage by stage, verified twice 60 seconds apart, and the next tier is assigned on the verified one', async () => {
    const clock = fakeClock();
    const world = flat(fakeWorld({ clock }));
    world.set(2, 64, 2, 'chest', { contents: {} });
    world.set(-2, 64, 2, 'chest', { contents: {} });
    const t = makeTown({ clock, world, config: CONFIG, agents: ['Arthur'], inventories: { Arthur: { oak_planks: 33, chest: 1, bread: 4 } }, town: true, learning: true, host: QUICK, runtime: { tracker: { tick_ms: 10 * SECOND } } });
    t.model.replies = Array.from({ length: 60 }, () => builder);
    await t.start({ available: true });
    world.durations = walking;
    const arthur = t.agents.Arthur;
    assert.equal(arthur.zones.plot('arthur-1').blueprint, 'lean_to');
    // the whole first stage (18 planks for the walls) is in hand: the build may start
    assert.equal(arthur.runtime.catalog?.check, undefined);
    t.run();
    await clock.advance(20 * SECOND);
    const started = t.town.town.state().builds;
    assert.deepEqual(started.map((b) => [b.plot, b.prefab, b.builder, b.tier, b.verified_at]), [['arthur-1', 'lean_to', 'Arthur', 0, null]], 'the first build goal started the build');
    await clock.advance(4 * MINUTE);
    const build = t.town.town.state().builds[0];
    assert.ok(build.verified_at, `the lean-to is verified (${build.cells_matching}/${build.cells_total}, stage ${build.stage})`);
    assert.deepEqual([build.cells_matching, build.cells_total, build.verified_day], [34, 34, 0]);
    // told as it went: started, the stages in order, verified
    const told = t.town_events.filter((event) => ['build_progress', 'build_verified'].includes(event.data.state)).map((event) => [event.data.state, event.data.detail.stage ?? null, event.data.detail.cells_matching]);
    assert.deepEqual(told[0], ['build_progress', null, 0]);
    assert.deepEqual(told.at(-1), ['build_verified', null, 34]);
    const stages = told.map(([, stage]) => stage).filter(Boolean);
    assert.deepEqual([...new Set(stages)], ['Walls', 'Roof', 'Fittings'].filter((name) => stages.includes(name)));
    assert.ok(stages.includes('Walls') && stages.includes('Roof'));
    // verified: two looks at least 60 seconds apart, by the builder's own process
    const first_look = arthur.eventsOf('agent.state').find((event) => event.data.state === 'goal_completed' && event.data.detail.done === event.data.detail.total && event.data.detail.option_id === 'build_blueprint:arthur-1');
    const said = arthur.eventsOf('agent.state').find((event) => event.data.state === 'build_verified');
    assert.ok(said && /every cell matched by name twice, \d+ seconds apart/.test(said.data.detail.reason), said?.data.detail.reason);
    assert.ok(Date.parse(build.verified_at) - Date.parse(first_look.ts) >= 60 * SECOND, 'verified less than 60 seconds after the last cell');
    // the next tier is assigned on top of the verified one, and the ladder's lock is asked for it
    assert.deepEqual([arthur.zones.plot('arthur-1').blueprint, arthur.zones.plot('arthur-1').built], ['shack', 'lean_to']);
    const check = arthur.runtime.state();
    assert.equal(check.building.started('arthur-1', 'shack'), false);
    assert.deepEqual(check.building.builds.map((b) => b.prefab), ['lean_to']);
    // the builds row is in the learner's store as well
    await settle();
    const rows = await t.learning_store.listBuilds({});
    assert.deepEqual(rows.map((row) => [row.prefab, row.builder, row.cells_total, row.verified_at !== null]), [['lean_to', 'Arthur', 34, true]]);
    for (const event of arthur.events) assert.deepEqual(validateEvent(event).errors, []);

    // DECIDED: he lives there now. His home point is the bed place in his lean-to; his range is still measured from the camp
    const home = t.town.town.state().homes.Arthur;
    assert.deepEqual([home.plot, home.prefab, home.tier, home.shelter, home.bed, home.chest, home.chest_name], ['arthur-1', 'lean_to', 0, [-32, 64, 15], { head: [-31, 64, 15], foot: [-32, 64, 15], placed: false }, [-33, 64, 15], 'home-Arthur']);
    assert.deepEqual(arthur.zones.home('Arthur'), { x: -32, y: 64, z: 15 });
    assert.deepEqual(arthur.zones.campHome('Arthur'), { x: 0, y: 64, z: 0 });
    assert.equal(arthur.zones.range('Arthur'), 48);
    assert.equal(arthur.zones.inRange('Arthur', { x: 40, y: 64, z: 0 }), true, 'the range is centred on the camp, not on the home');
    assert.equal(arthur.zones.inRange('Arthur', { x: -70, y: 64, z: 15 }), false);
    assert.deepEqual(arthur.zones.home('Mira'), { x: 0, y: 64, z: 0 }, 'an agent without a finished home shelters in the camp');
    // his personal chest is a chest of HIS zones only; the shared chest stays what it was
    assert.deepEqual(arthur.zones.chests().map((chest) => chest.name), ['shared', 'kits', 'home-Arthur']);
    assert.deepEqual(arthur.zones.chest('home-Arthur'), { x: -33, y: 64, z: 15 });
    assert.equal(arthur.zones.homeChest('Arthur'), 'home-Arthur');
    assert.equal(arthur.zones.homeChest('Mira'), null);
    const mira_zones = townZones(t.zones, arthur.town, 'Mira');
    assert.deepEqual(mira_zones.chests().map((chest) => chest.name), ['shared', 'kits'], 'nobody else\'s zones hold his chest');
    assert.ok(arthur.zones.places('Arthur').some((place) => place.id === 'chest-home-Arthur' && place.kind === 'chest'));
    assert.ok(arthur.zones.places('Arthur').find((place) => place.id === 'home').pos.x === -32);
    await t.stop();
});

test('homes: the bed is furniture the agent places itself; what its build wants goes into its own chest; the model away, it shelters at home', async () => {
    const clock = fakeClock();
    const world = flat(fakeWorld({ clock }));
    world.set(2, 64, 2, 'chest', { contents: {} });
    world.set(-2, 64, 2, 'chest', { contents: {} });
    const t = makeTown({ clock, world, config: CONFIG, agents: ['Arthur'], inventories: { Arthur: { oak_planks: 33, chest: 1, bread: 4, wooden_axe: 1, wooden_pickaxe: 1 } }, town: true, learning: true, host: QUICK, runtime: { tracker: { tick_ms: 10 * SECOND } } });
    t.model.replies = Array.from({ length: 80 }, () => builder);
    await t.start({ available: true });
    world.durations = walking;
    const arthur = t.agents.Arthur;
    t.run();
    await clock.advance(5 * MINUTE);
    assert.ok(t.town.town.state().homes.Arthur, 'the lean-to is his home');
    const offer = () => arthur.runtime.catalog ?? null;
    void offer;
    const options = () => t.model.offered(-1);
    // no bed in hand: nothing to furnish with
    assert.ok(!options().some((id) => id === 'furnish_home:bed'));
    world.body('Arthur').inventory.red_bed = 1;
    arthur.runtime.planner.trigger('operator_message', { from: 'op', text: 'your bed' });
    await clock.advance(40 * SECOND);
    assert.ok(t.model.requests.some((request) => request.format.properties.goals.items.properties.option_id.enum.includes('furnish_home:bed')), 'with a bed in hand, putting it in his home is on offer');
    await clock.advance(1 * MINUTE);
    assert.equal(world.get(-32, 64, 15)?.name, 'red_bed', 'the bed stands in the place the lean-to keeps for it');
    assert.equal(t.town.town.state().homes.Arthur.bed.placed, true);
    assert.equal(world.body('Arthur').inventory.red_bed ?? 0, 0);
    // the bed blocks neither the verification of the home nor the next build
    assert.ok(!arthur.eventsOf('agent.state').some((event) => event.data.state === 'goal_failed' && event.data.detail.option_id === 'furnish_home:bed'));
    assert.equal(t.town.view().homes.find((home) => home.agent === 'Arthur').living.bed, 'Placed');

    // personal storage: what his next build (the shack) still wants goes into his own chest, the rest to the shared one
    world.body('Arthur').inventory = { oak_log: 6, wheat: 5, bread: 4, wooden_axe: 1 };
    const store = arthur.runtime.state();
    const { createCatalog } = await import('../catalog/catalog.js');
    const catalog = createCatalog({ zones: arthur.zones, blueprints: townBlueprints(t.prefabs) });
    assert.deepEqual(catalog.candidates('store_items', store), [{ chest: 'home-Arthur', item: 'oak_log' }, { chest: 'shared', item: 'wheat' }]);
    // what the town holds for his build counts his own chest too
    assert.equal(catalog.check('build_blueprint:arthur-1', store).reason, 'town_short');
    arthur.ledger.set('home-Arthur', { oak_planks: 34, oak_log: 6 }, clock.now());
    await settle();
    assert.notEqual(catalog.check('build_blueprint:arthur-1', arthur.runtime.state()).reason, 'town_short', 'his own chest and what he carries hold the shack\'s first stage');

    // the model leaves: by night he is at home, in his lean-to, not in the camp
    await t.host.signal('desktop_leaving');
    await clock.advance(12 * MINUTE);
    const here = world.body('Arthur').position;
    assert.ok(Math.hypot(here.x - -32, here.z - 15) <= 4, `he shelters at ${Math.round(here.x)}, ${Math.round(here.z)}`);
    await t.stop();
});

test('upgrade of a home that is lived in: the bed is taken along, the chest stays, and the model away a started build is continued but none is started', async () => {
    const clock = fakeClock();
    const world = flat(fakeWorld({ clock }));
    world.set(2, 64, 2, 'chest', { contents: {} });
    world.set(-2, 64, 2, 'chest', { contents: {} });
    const t = makeTown({ clock, world, config: CONFIG, agents: ['Arthur'], inventories: { Arthur: { oak_planks: 33, chest: 1, bread: 4, red_bed: 1 } }, town: true, learning: { seed: 4 }, host: QUICK, runtime: { tracker: { tick_ms: 10 * SECOND } } });
    t.model.replies = Array.from({ length: 200 }, () => builder);
    await t.start({ available: true });
    world.durations = walking;
    world.daylight_stopped = true;
    world.ticks = () => 2000;
    const arthur = t.agents.Arthur;
    t.run();
    await clock.advance(7 * MINUTE);
    assert.equal(world.get(-32, 64, 15)?.name, 'red_bed');
    world.get(-33, 64, 15).contents = { bread: 2 };
    // the shack: its first stage in hand. The model starts it, then leaves
    world.body('Arthur').inventory = { oak_planks: 45, oak_log: 12, oak_door: 1, torch: 1, bread: 4 };
    arthur.runtime.planner.trigger('operator_message', { from: 'op', text: 'the shack' });
    for (let i = 0; i < 60 && !t.town.town.state().builds.some((b) => b.prefab === 'shack'); i++) await clock.advance(5 * SECOND);
    assert.ok(t.town.town.state().builds.some((b) => b.prefab === 'shack' && !b.verified_at), 'the model started the shack');
    await t.host.signal('desktop_leaving');
    const left_at = clock.now();
    await clock.advance(40 * MINUTE);
    const shack = t.town.town.state().builds.find((b) => b.prefab === 'shack');
    const decisions = (await t.learning_store.listDecisions({ agent: 'Arthur' })).filter((d) => d.chooser === 'network' && d.ts >= left_at);
    assert.ok(decisions.some((d) => d.chosen === 'build_blueprint:arthur-1'), 'with the model away the learner continued the started build');
    assert.ok(shack.verified_at, `the shack was finished and verified with the model away (${shack.cells_matching}/${shack.cells_total}, ${shack.stage})`);
    // the chest was never broken; the bed was taken up for the torch that stands in its old place, and is the agent's to place again
    assert.equal(world.broken.filter((b) => b.name === 'chest').length, 0);
    assert.deepEqual(world.get(-33, 64, 15).contents, { bread: 2 });
    assert.ok(world.broken.some((b) => b.name === 'red_bed'), 'the bed stood where the shack wants its torch');
    const home = t.town.town.state().homes.Arthur;
    assert.deepEqual([home.prefab, home.tier, home.bed.foot], ['shack', 1, [-33, 64, 17]]);
    // (and with his bed back in hand he put it in the new place himself: that is not starting a build)
    const with_him = world.body('Arthur').inventory.red_bed ?? 0;
    const in_place = world.get(-33, 64, 17)?.name === 'red_bed' || world.get(-33, 64, 16)?.name === 'red_bed';
    assert.ok(with_him === 1 || in_place, `his bed is neither with him nor in its new place: ${JSON.stringify(world.body('Arthur').inventory)}`);
    assert.equal(t.host.ledger.view('shared')?.items?.red_bed ?? 0, 0, 'a bed is the agent\'s own: never put into the shared chest');
    // the cabin is next and its plot is assigned, but with the model away no build is STARTED
    assert.deepEqual([arthur.zones.plot('arthur-1').blueprint, arthur.zones.plot('arthur-1').built], ['cabin', 'shack']);
    world.body('Arthur').inventory = { cobblestone: 60, oak_planks: 60, oak_slab: 50, oak_log: 12, glass: 4, oak_door: 1, crafting_table: 1, torch: 2, bread: 4, ...(with_him ? { red_bed: 1 } : {}) };
    const before = clock.now();
    await clock.advance(30 * MINUTE);
    assert.ok(!t.town.town.state().builds.some((b) => b.prefab === 'cabin'), 'a build was started while the model was away');
    const later = (await t.learning_store.listDecisions({ agent: 'Arthur' })).filter((d) => d.chooser === 'network' && d.ts >= before);
    assert.ok(later.length > 5 && later.some((d) => d.offered.some((o) => o.id === 'build_blueprint:arthur-1')), 'the cabin was on offer');
    assert.ok(later.every((d) => d.chosen !== 'build_blueprint:arthur-1'), 'the learner started the cabin');
    // but the bed, which is his own furniture, he may put back
    await t.stop();
});

test('a plot of the town is levelled by its builder by hand: holes under the build are filled, ground in its way is cleared', async () => {
    const clock = fakeClock();
    const world = flat(fakeWorld({ clock }));
    world.set(2, 64, 2, 'chest', { contents: {} });
    world.set(-2, 64, 2, 'chest', { contents: {} });
    const t = makeTown({ clock, world, config: CONFIG, agents: ['Arthur'], inventories: { Arthur: { oak_planks: 33, chest: 1, dirt: 6, bread: 4 } }, town: true, runtime: { tracker: { tick_ms: 10 * SECOND } } });
    await t.start({ available: false });
    // a plot of the town for Arthur, on rough ground (put there directly: where it may stand is another test's)
    await t.town.town.update((town) => {
        town.plots.push({ id: 'town-1', size: 'S', kind: 'shared', owner: 'Arthur', min: [-16, 64, 30], max: [-1, 77, 45], prefab: 'lean_to', rotation: 0, by: 'Code', levelled_by: 'Builder', score: { relief: 2, distance: 40 }, at: '2026-11-18T00:00:00.000Z' });
        town.assign['town-1'] = { prefab: 'lean_to', built: null };
    });
    await settle();
    const arthur = t.agents.Arthur;
    world.set(-16, 63, 30, 'air');          // two holes where the back wall stands
    world.set(-14, 63, 30, 'air');
    world.set(-13, 64, 31, 'dirt');         // a bump inside
    world.set(-13, 65, 31, 'dirt');
    const plot = arthur.zones.plot('town-1');
    assert.deepEqual([plot.level, plot.blueprint, plot.owner], [true, 'lean_to', 'Arthur']);
    const { createCatalog } = await import('../catalog/catalog.js');
    const catalog = createCatalog({ zones: arthur.zones, blueprints: townBlueprints(t.prefabs) });
    const state = () => ({ ...arthur.runtime.state(), building: undefined });
    const survey = catalog.buildSurvey('town-1', state());
    assert.equal(survey.stage_bill.dirt, 2, 'the two holes under the walls are the first thing on the bill');
    const checked = catalog.check('build_blueprint:town-1', state());
    assert.equal(checked.ok, true, checked.reason);
    const steps = catalog.plan(checked.option, state()).steps;
    assert.deepEqual(steps.slice(0, 2).map((step) => [step.command, ...step.args]), [['placeBlock', 'dirt', -16, 63, 30], ['placeBlock', 'dirt', -14, 63, 30]], 'levelling comes before the first wall');
    assert.deepEqual(catalog.before('build_blueprint:town-1', steps[0], state()), { intend: [{ x: -16, y: 63, z: 30 }] });
    assert.ok(steps.some((step) => step.command === 'breakBlockAt' && step.args.join() === '-13,64,31'), 'the bump inside is taken away');
    // on a plot of the world file (levelled by the Operator's bootstrap) nothing is levelled by the builder
    world.set(-34, 63, 14, 'air');
    assert.equal(catalog.buildSurvey('arthur-1', state()).stage_bill.dirt, undefined);
    assert.deepEqual(catalog.before('build_blueprint:arthur-1', { command: 'placeBlock', args: ['dirt', -34, 63, 14] }, state()), { fail: 'outside_plot' });
    await t.stop();
    // what an agent sees of a column: the ground under a tree, water, and nothing where the land is not loaded
    const view = { blockAt: ({ x, y }) => (x === 9 ? null : x === 1 ? (y >= 66 ? { name: 'oak_leaves' } : y >= 64 ? { name: 'oak_log' } : { name: 'dirt' }) : x === 2 ? (y > 62 ? { name: 'air' } : y > 60 ? { name: 'water' } : { name: 'sand' }) : (y > 63 ? { name: 'air' } : { name: 'grass_block' })) };
    assert.deepEqual([columnOf(view, 0, 0, 64), columnOf(view, 1, 0, 64), columnOf(view, 2, 0, 64), columnOf(view, 9, 0, 64)], [{ y: 63, wet: false, tree: false }, { y: 63, wet: false, tree: true }, { y: 62, wet: true, tree: false }, null]);
});

test('town: an agent proposes the plot the town wants for it from what it sees, and the town takes it', async () => {
    const clock = fakeClock();
    const world = flat(fakeWorld({ clock }));
    world.set(2, 64, 2, 'chest', { contents: {} });
    // a hill west of the camp, a pond in the south-east: the flat land is north and south-west
    world.fill([-60, 64, -12], [-14, 66, 12], 'dirt');
    world.fill([20, 63, 30], [44, 63, 44], 'water');
    for (let y = 64; y <= 68; y++) world.set(14, y, -30, 'oak_log');     // one tree
    // (a world file with his plot only: with all five plots of the example there is exactly one place for an M plot)
    const t = makeTown({ clock, world, config: { ...CONFIG, plots: CONFIG.plots.slice(0, 1) }, agents: ['Arthur'], inventories: { Arthur: { bread: 4 } }, town: true, runtime: { tracker: { tick_ms: 10 * SECOND } } });
    await t.start({ available: false });
    await t.host.signal('desktop_leaving');
    for (const prefab of ['lean_to', 'shack', 'cabin']) verify(t.town.town, 'Arthur', prefab, 'arthur-1');
    assert.deepEqual(t.town.town.view().wanted.map((w) => w.prefab), ['storehouse']);
    t.town.town.operator({ kind: 'limit', min: [-56, -56], max: [56, 56] });
    await settle();
    t.run();
    await clock.advance(30 * SECOND);
    const plot = t.town.town.view().plots.find((p) => p.id === 'town-1');
    assert.ok(plot, `no plot was proposed: ${JSON.stringify(t.agents.Arthur.eventsOf('agent.state').filter((e) => e.data.state === 'plot_not_placed').map((e) => e.data.detail))}`);
    assert.deepEqual([plot.size, plot.prefab, plot.owner, plot.by, plot.max[0] - plot.min[0] + 1, plot.min[1]], ['M', 'storehouse', 'Arthur', 'Code', 24, 64]);
    // on dry flat land, off the hill, the pond and the tree, a lane from everything, every corner in his range
    for (let x = plot.min[0]; x <= plot.max[0]; x++) for (let z = plot.min[2]; z <= plot.max[2]; z++) {
        assert.equal(world.get(x, 63, z)?.name, 'grass_block', `${x},${z} is not flat dry ground`);
        assert.equal(world.get(x, 64, z), null, `${x},${z} has something standing on it`);
        assert.ok(Math.hypot(x, z) <= 48);
    }
    assert.deepEqual(t.agents.Arthur.zones.plotOverlaps('town-1'), []);
    assert.deepEqual(t.town.town.view().wanted, []);
    assert.equal(t.agents.Arthur.runtime.builds().stats().proposed, 1);
    await t.stop();
});

// ---- step 7: long-term goals ----------------------------------------------------------------------------

test('long-term goals: what a role may choose from, Arthur\'s pinned next rung, and what the model\'s reply must be', async () => {
    const { town } = await freshTown();
    const of = (agent, role) => longTermCandidates({ agent, role, town_state: town.state(), prefabs: PREFABS });
    // Arthur: the next rung of the ladder is his first goal, pinned; then his home; then his role's
    assert.deepEqual(of('Arthur', 'builder').map((c) => [c.id, c.title, c.pinned === true]), [
        ['rung', 'Build the Lean-to', true], ['home', 'My home: build the Lean-to', false],
        ['connect', 'Keep the town connected: steps and bridges', false], ['stock_build', 'Keep building materials in the shared chest', false], ['help_homes', 'Help the others get their homes built', false],
    ]);
    assert.deepEqual(of('Mira', 'farmer').map((c) => c.id), ['home', 'feed', 'fields', 'bread']);
    assert.deepEqual(of('Felix', 'explorer').map((c) => c.id), ['home', 'routes', 'supply', 'ring']);
    assert.deepEqual(of('Nova', 'merchant').map((c) => c.id), ['home', 'chests', 'broker', 'kits']);
    for (const list of Object.values(ROLE_GOALS)) for (const [, title] of list) assert.ok(title.length <= 60);
    // the rung follows the builds: lean-to, shack, cabin, then the cottage and the storehouse of tier 3 (his home first), ...
    const rungs = [];
    for (const prefab of ['lean_to', 'shack', 'cabin', 'cottage']) { verify(town, 'Arthur', prefab, 'arthur-1'); rungs.push(of('Arthur', 'builder')[0].title); }
    assert.deepEqual(rungs, ['Build the Shack', 'Build the Cabin', 'Build the Cottage', 'Build the Storehouse']);
    assert.equal(of('Arthur', 'builder')[1].title, 'My home: build the House');
    // a bridge the town has placed is a rung of tier 1: it comes before everything bigger
    const span = { axis: 'x', length: 9, rotation: 90, from: [29, 63, 3], to: [37, 63, 3], min: [29, 64, 1], max: [37, 67, 5] };
    for (let i = 0; i < 3; i++) town.apply('Felix', { kind: 'gap', place: 'ring-3', span });
    assert.equal(of('Arthur', 'builder')[0].title, 'Build the Footbridge');
    // the defaults while the model has not chosen: the pinned goal, the first of the role, the home
    assert.deepEqual(defaultChoice(of('Arthur', 'builder')), ['rung', 'connect', 'home']);
    assert.deepEqual(defaultChoice(of('Mira', 'farmer')), ['feed', 'home', 'fields']);
    // the model's reply: ids that were offered, 1 to max, a reason, and nothing else
    const ids = ['home', 'feed', 'fields', 'bread'];
    assert.deepEqual(parseGoalReply('{"goals":["feed","home"],"reason":"The field comes first."}', ids, 3), { goals: ['feed', 'home'], reason: 'The field comes first.' });
    for (const raw of ['{"goals":["rule the town"],"reason":"x"}', '{"goals":[],"reason":"x"}', '{"goals":["feed","feed"],"reason":"x"}', '{"goals":["feed"]}', '{"goals":["feed"],"reason":"x","code":"run()"}', 'feed', `{"goals":["feed"],"reason":"${'x'.repeat(141)}"}`, '{"goals":["home","feed","fields","bread"],"reason":"x"}']) {
        assert.equal(parseGoalReply(raw, ids, 3), null, raw.slice(0, 60));
    }
    assert.deepEqual([LONG_TERM_LIMITS.max_calls, LONG_TERM_LIMITS.window_ms], [2, 12 * 60 * 60 * 1000]);
});

test('long-term goals: defaults at once, the model\'s own choice when it is there, Arthur\'s rung following his builds, and the operator\'s override above all', async () => {
    const clock = fakeClock();
    const world = flat(fakeWorld({ clock }));
    world.set(2, 64, 2, 'chest', { contents: {} });
    world.set(-2, 64, 2, 'chest', { contents: {} });
    const t = makeTown({ clock, world, config: CONFIG, agents: NAMES, inventories: { Arthur: { oak_planks: 33, chest: 1, bread: 4 } }, town: true, host: QUICK, runtime: { tracker: { tick_ms: 10 * SECOND } } });
    await t.start({ available: false });
    await t.host.signal('desktop_leaving');
    const long = async (name) => (await t.agents[name].runtime.goals.get(name)).goals.long_term.map((goal) => goal.title);
    const changes = (name) => t.agents[name].changes().filter((change) => change.scope === 'long_term');
    // the model is away: every agent has its role's defaults from the first minute (nothing wrote long-term goals before)
    assert.deepEqual(await long('Arthur'), ['Build the Lean-to', 'Keep the town connected: steps and bridges', 'My home: build the Lean-to']);
    assert.deepEqual(await long('Mira'), ['Keep the town fed', 'My home: build the Lean-to', 'Keep the field sown and harvested']);
    assert.deepEqual(await long('Felix'), ['Find routes and resources around the town', 'My home: build the Lean-to', 'Bring back what the builds need']);
    assert.deepEqual(await long('Nova'), ['Keep the chests stocked and fair', 'My home: build the Lean-to', 'Broker materials for the current project']);
    for (const name of NAMES) {
        assert.deepEqual(changes(name).map((change) => [change.source, change.reason]), [['routine', `role default for the ${{ Arthur: 'builder', Mira: 'farmer', Felix: 'explorer', Nova: 'merchant' }[name]}: the model has not chosen yet`]]);
        for (const event of t.agents[name].events) assert.deepEqual(validateEvent(event).errors, []);
    }
    assert.equal(t.model.goal_requests.length, 0, 'the model was asked while it was away');
    // the planner's prompt carries them
    world.durations = walking;
    t.run();

    // the model comes back: each agent's model chooses its own, within its role (a small call of its own kind)
    t.model.goal_choices.push(
        (request, ids) => { assert.ok(!ids.includes('rung'), 'the pinned goal is not the model\'s to choose or drop'); return { goals: ['stock_build'], reason: 'The town runs short of wood too often.' }; },
        ['bread', 'home'], ['ring'], '{"goals":["become the mayor"],"reason":"x"}',
    );
    t.model.probe_ok = true;
    await t.host.signal('desktop_available');
    await clock.advance(3 * MINUTE);
    assert.equal(t.model.goal_requests.length, 4);
    assert.match(t.model.goal_requests[0].messages[0].content, /You are Arthur, the builder, of a small Minecraft town\. Choose your own long-term goals/);
    assert.match(t.model.goal_requests[0].messages[1].content, /- stock_build: Keep building materials in the shared chest/);
    assert.deepEqual(await long('Arthur'), ['Build the Lean-to', 'Keep building materials in the shared chest'], 'his rung stays in front; the model chose what stands beside it');
    assert.deepEqual(await long('Mira'), ['Bake bread for the kit chest', 'My home: build the Lean-to']);
    assert.deepEqual(await long('Felix'), ['Walk the whole patrol ring']);
    const arthur_change = changes('Arthur').at(-1);
    assert.deepEqual([arthur_change.source, arthur_change.reason, typeof arthur_change.call_id], ['planner', 'The town runs short of wood too often.', 'string']);
    // a reply that names something that was not offered is not used: Nova keeps her defaults
    assert.deepEqual(await long('Nova'), ['Keep the chests stocked and fair', 'My home: build the Lean-to', 'Broker materials for the current project']);
    assert.equal(changes('Nova').length, 1);
    const planning = t.model.requests.find((request) => /You are Mira/.test(request.messages.at(-1).content));
    if (planning) assert.match(planning.messages.at(-1).content, /Long-term goals: 1\) /);
    // the choice is kept in the town file: a new process of the agent has it without asking again
    assert.deepEqual([t.town.town.state().goals.Mira.chosen, t.town.town.state().goals.Mira.chosen_by], [['bread', 'home'], 'planner']);

    // Arthur's lean-to is verified: his first goal moves to the next rung by itself, with a computed reason
    t.model.replies = Array.from({ length: 80 }, () => builder);
    t.agents.Arthur.runtime.planner.trigger('operator_message', { from: 'op', text: 'build' });
    for (let i = 0; i < 80 && !t.town.town.state().builds.some((b) => b.verified_at); i++) await clock.advance(10 * SECOND);
    assert.ok(t.town.town.state().builds.some((b) => b.prefab === 'lean_to' && b.verified_at), 'the lean-to was built and verified');
    await clock.advance(1 * MINUTE);
    assert.equal((await long('Arthur'))[0], 'Build the Shack');
    const moved = changes('Arthur').find((change) => change.after[0].title === 'Build the Shack');
    assert.ok(['executor', 'planner'].includes(moved.source), moved.source);
    assert.ok(moved.before[0].title === 'Build the Lean-to');

    // the operator overrides Mira's goals in the dashboard; it stands until it is lifted
    const before_override = t.model.goal_requests.length;
    assert.deepEqual(await t.town.goals.override('Mira', ['Grow a field of pumpkins', '  ']), { ok: true, agent: 'Mira', titles: ['Grow a field of pumpkins'] });
    await clock.advance(1 * MINUTE);
    assert.deepEqual(await long('Mira'), ['Grow a field of pumpkins']);
    assert.deepEqual([changes('Mira').at(-1).source, changes('Mira').at(-1).reason], ['operator', 'set by the operator in the dashboard']);
    await clock.advance(10 * MINUTE);
    assert.deepEqual(await long('Mira'), ['Grow a field of pumpkins'], 'nothing replaces the operator\'s goals');
    // Arthur's too: the operator's word is above his pinned rung
    await t.town.goals.override('Arthur', ['Build a tower by the field']);
    await clock.advance(1 * MINUTE);
    assert.deepEqual(await long('Arthur'), ['Build a tower by the field']);
    assert.deepEqual(await t.town.goals.override('Nobody', ['x']), { ok: false, reason: 'unknown_agent' });
    assert.deepEqual(await t.town.goals.override('Mira', []), { ok: false, reason: 'one_to_three_goals' });
    assert.deepEqual(await t.town.goals.override('Mira', ['a', 'b', 'c', 'd']), { ok: false, reason: 'one_to_three_goals' });
    // lifted: the agents' own goals are back (the model's earlier choice, Arthur's rung in front)
    await t.town.goals.override('Mira', null);
    await t.town.goals.override('Arthur', null);
    await clock.advance(1 * MINUTE);
    assert.deepEqual(await long('Mira'), ['Bake bread for the kit chest', 'My home: build the Lean-to']);
    assert.equal((await long('Arthur'))[0], 'Build the Shack');
    assert.ok(t.model.goal_requests.length - before_override <= 2, 'the override did not set off a round of model calls');
    assert.ok(t.town_events.some((event) => event.data.state === 'long_term_override' && event.data.detail.agent === 'Mira'));
    await t.stop();
});

// ---- the Town screen's data and the prefab upload ----------------------------------------------------------

test('town view: plots with whose they are, homes, Arthur\'s project and the ladder, all from the town file and the shared chest', async () => {
    const { town } = await freshTown();
    for (const prefab of ['lean_to', 'shack', 'cabin']) verify(town, 'Arthur', prefab, 'arthur-1');
    verify(town, 'Mira', 'lean_to', 'mira-1');
    town.operator({ kind: 'limit', min: [-60, -60], max: [60, 60] });
    const wanted = town.view().wanted.find((w) => w.prefab === 'storehouse');
    town.apply('Arthur', { kind: 'propose_plot', wanted: wanted.id, min: [8, 64, -36], max: [31, 77, -13], score: { relief: 1, distance: 31.3 } });
    town.apply('Arthur', { kind: 'build_started', plot: 'town-1' });
    town.apply('Arthur', { kind: 'build_progress', plot: 'town-1', stage: 'Walls', cells_matching: 117, bill: { cobblestone: 16, oak_log: 12, oak_planks: 63, chest: 6, oak_door: 1, torch: 4 }, held: { cobblestone: 10 } });
    const roles = { Arthur: 'builder', Mira: 'farmer', Felix: 'explorer', Nova: 'merchant' };
    const view = townView({ town, prefabs: PREFABS, stock: { cobblestone: 6, oak_planks: 40, torch: 8, oak_door: 1 }, roles, zones_config: CONFIG });
    assert.deepEqual(view.counts, { plots: 6, by_code: 1, by_operator: 5, verified: 4, building: 1 });
    assert.deepEqual(view.plots.find((p) => p.id === 'town-1'), { id: 'town-1', size: 'M', kind: 'shared', owner: 'Arthur', min: [8, 64, -36], max: [31, 77, -13], by: 'Code', levelled_by: 'Builder', prefab: 'storehouse', built: null, world: false });
    // Arthur's project, as the mock-up's panel has it: 117 of 220, the stages, the materials still to place against what the town holds
    const p = view.project;
    assert.deepEqual([p.title, p.kind, p.tier, p.plot, p.builder, p.state, p.check, p.by], ['Storehouse', 'shared', 3, 'town-1', 'Arthur', 'Building', 'By name', 'Generated']);
    assert.deepEqual(p.cells, { done: 117, total: 220 });
    assert.deepEqual(p.stages.map((s) => [s.name, s.done, s.total]), [['Foundation', 63, 63], ['Walls', 54, 82], ['Roof', 0, 63], ['Fittings', 0, 12]]);
    const material = Object.fromEntries(p.materials.map((m) => [m.item, [m.need, m.have, m.short, m.state]]));
    assert.deepEqual(material.oak_planks, [63, 40, 23, 'Short']);
    assert.deepEqual(material.cobblestone, [16, 16, 0, 'Ready'], 'the shared chest\'s six and the ten the builder holds');
    assert.deepEqual(material.torch, [4, 8, 0, 'Ready']);
    assert.deepEqual(material.chest, [6, 0, 6, 'Short']);
    // the ladder and the homes
    const rows = Object.fromEntries(view.ladder.generated.list.map((e) => [e.name, [e.tier, e.state]]));
    assert.deepEqual([rows.storehouse, rows.hall, rows.lean_to[1]], [[3, 'Building'], [4, 'Locked'], 'Open']);
    assert.deepEqual(view.homes.map((h) => [h.agent, h.role, h.plot, h.home?.title ?? null, h.next?.title ?? null]), [
        ['Arthur', 'builder', 'arthur-1', 'Cabin', 'Cottage'], ['Mira', 'farmer', 'mira-1', 'Lean-to', 'Shack'], ['Felix', 'explorer', 'felix-1', null, 'Lean-to'], ['Nova', 'merchant', 'nova-1', null, 'Lean-to'],
    ]);
    assert.deepEqual(view.long_term.Arthur.candidates[0], { id: 'rung', title: 'Build the Cottage', pinned: true });
    assert.equal(view.stock_of, 'the shared chest');
    assert.ok(JSON.stringify(view).length < 40000, 'the view is small enough to send');
});

test('prefab upload: a schematic is converted and checked; blocks the agents cannot get are listed; the tier comes from cells and footprint', async () => {
    const AIR = 'minecraft:air';
    const hut = [   // 3 by 3, two high: a stone floor, plank walls with a door gap
        [['minecraft:cobblestone', 'minecraft:cobblestone', 'minecraft:cobblestone'], ['minecraft:cobblestone', 'minecraft:cobblestone', 'minecraft:cobblestone'], ['minecraft:cobblestone', 'minecraft:cobblestone', 'minecraft:cobblestone']],
        [['minecraft:oak_planks', 'minecraft:oak_planks', 'minecraft:oak_planks'], ['minecraft:oak_planks', AIR, 'minecraft:oak_planks'], ['minecraft:oak_planks', AIR, 'minecraft:oak_planks']],
    ];
    const files = fakeFiles();
    const upload = (blocks, more = {}) => importPrefab({ name: 'stone_hut', title: 'Stone hut', file_base64: buildSchematic({ blocks }).toString('base64'), prefabs: PREFABS, files, dir: '/prefabs/operator', now: Date.parse('2026-11-18T12:00:00Z'), ...more });
    const looked = await upload(hut);
    assert.equal(looked.ok, true, looked.reason);
    assert.deepEqual([looked.saved, looked.prefab.by, looked.prefab.kind, looked.prefab.tier, looked.prefab.cells, looked.prefab.size], [false, 'Operator', 'shared', 0, 16, { x: 3, y: 2, z: 3 }]);
    assert.deepEqual(looked.prefab.materials, { cobblestone: 9, oak_planks: 7 });
    assert.deepEqual([looked.report.buildable, looked.report.unobtainable, looked.report.too_big, looked.report.format_checked], [true, {}, false, false]);
    assert.deepEqual(files.store.size, 0, 'looking at an upload saves nothing');
    // decided: air in an uploaded schematic leaves the cell alone
    const kept = await upload(hut, { save: true });
    assert.deepEqual([kept.ok, kept.saved, kept.file], [true, true, '/prefabs/operator/stone_hut.json']);
    const stored = JSON.parse(files.store.get('/prefabs/operator/stone_hut.json'));
    assert.equal(stored.blocks[1][1][1], '');
    assert.deepEqual(checkPrefab(stored), []);
    assert.deepEqual([stored.by, stored.source.file, stored.source.format_checked], ['Operator', 'stone_hut.schem', false]);
    // blocks the agents cannot get: listed, the prefab is "not buildable yet", and the operator may name substitutes
    const fancy = JSON.parse(JSON.stringify(hut));
    fancy[1][0][1] = 'minecraft:oak_stairs[facing=north]';
    fancy[0][1][1] = 'minecraft:stone_bricks';
    const blocked = await upload(fancy);
    assert.deepEqual([blocked.ok, blocked.report.buildable, blocked.report.unobtainable, blocked.prefab.blocked], [true, false, { oak_stairs: 1, stone_bricks: 1 }, ['oak_stairs', 'stone_bricks']]);
    assert.deepEqual(blocked.report.needs_facing, ['oak_stairs']);
    const swapped = await upload(fancy, { substitute: { oak_stairs: 'oak_planks', stone_bricks: 'cobblestone', 'bad name': 'x' } });
    assert.deepEqual([swapped.report.buildable, swapped.report.substituted], [true, { oak_stairs: 'oak_planks', stone_bricks: 'cobblestone' }]);
    // the tier: by cells and footprint against the generated ladder
    const big = Array.from({ length: 4 }, () => Array.from({ length: 7 }, () => Array(7).fill('minecraft:cobblestone')));
    assert.equal((await upload(big, { name: 'block' })).prefab.tier, 3, '196 cells on 7 by 7');
    // what is refused
    assert.match((await upload(hut, { name: 'my hut' })).reason, /name is letters/);
    assert.match((await upload(hut, { name: 'cabin' })).reason, /generated ladder/);
    assert.match((await upload(hut, { kind: 'bridge' })).reason, /kind must be/);
    assert.match((await importPrefab({ name: 'x', file_base64: Buffer.from('not a schematic').toString('base64'), prefabs: PREFABS })).reason, /not a schematic this can read/);
    assert.match((await importPrefab({ name: 'x', file_base64: '', prefabs: PREFABS })).reason, /no file/);
    assert.match((await importPrefab({ name: 'x', file_base64: 'A'.repeat(3 * 1024 * 1024), prefabs: PREFABS })).reason, /larger than 2 MB/);
    // once saved it is a prefab the agents' blueprint source finds (the operator's folder), earned like any other
    const { filePrefabs } = await import('../build/prefab.js');
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const dir = mkdtempSync(path.join(tmpdir(), 'genesis-prefabs-'));
    const source = filePrefabs([path.join(REPO_ROOT, 'genesis', 'prefabs'), dir]);
    assert.equal(source.get('stone_hut'), null, 'not there yet');
    writeFileSync(path.join(dir, 'stone_hut.json'), files.store.get('/prefabs/operator/stone_hut.json'));
    assert.deepEqual([source.get('stone_hut')?.by, source.get('stone_hut')?.cells], ['Operator', 16], 'found without a restart: a name that was missing is looked for again');
    assert.ok(source.names().includes('stone_hut'));
});
