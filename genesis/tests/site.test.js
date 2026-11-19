// Automatic site selection and the survey behind the levelling record: the reading commands,
// the probe, the scan and the score, and a whole bootstrap on land the script picked itself.
//
// Nothing here talks to a Minecraft server: helpers/fake-rcon.mjs stands in, with land from a
// function, chunks that are only readable once force-loaded, and the answers the game is
// documented to give. It shows that the script asks, counts and decides rightly, NOT that a
// real server words its answers this way: that is what the probe step is for.
// Run from the repository root:  node --test genesis/tests/*.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { REPO_ROOT } from './helpers/stubs.mjs';
import { fakeFiles, fakeClock } from './helpers/fakes.mjs';
import { fakeMinecraft } from './helpers/fake-rcon.mjs';
import { exampleWorld } from './helpers/bootstrapped.mjs';
import { fileBlueprints } from '../catalog/blueprints.js';
import { checkWorldConfig, worldHash } from '../world/world_config.js';
import { buildBootstrapPlan } from '../world/plan.js';
import { runBootstrap, runSiteStage, readSiteRecord, reportLines } from '../world/bootstrap.js';
import { parseManifest, checkManifest } from '../world/manifest.js';
import {
    createReader, probe, loadChunks, checkBox, forceloadBoxes, READ_ANSWERS, READ_COMMANDS, NATURAL_BLOCKS, NATURAL_KIND, ReadError,
} from '../world/survey.js';
import { probeWorldEdit, parseDistribution, blockKey, WORLDEDIT_ANSWERS, WORLDEDIT_COMMANDS } from '../world/worldedit.js';
import { pickSite, scoreSites, siteLayout, siteReportLines, SITE_DEFAULTS, SITE_REFUSALS, SITE_RECORD_FILE } from '../world/site.js';

const BLUEPRINTS = fileBlueprints(path.join(REPO_ROOT, 'src', 'agent', 'npc', 'construction'));
const MANIFEST = '/data/genesis_world/bootstrap.manifest.json';
const WORLD_FILE = '/data/genesis_world/genesis.world.json';
const noSleep = async () => {};

// A number from 0 to 99 for a column, always the same.
const dice = (x, z, salt = 0) => { let h = (x * 374761393 + z * 668265263 + salt * 2147483647) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) % 100; };

// Land for the stand-in. East of x = 20 lies a meadow at y 64 with grass, a few flowers and a
// rise; around the spawn the land rolls; to the south-west a lake, to the north-west a wood.
function land({ meadow = true } = {}) {
    const height = (x, z) => {
        if (meadow && x >= 20 && x <= 150 && z >= -70 && z <= 70) return x >= 60 && x <= 64 && z >= 0 && z <= 4 ? 65 : 64;
        if (x < -30 && z > 30) return 58;                                  // the lake's bed
        return 68 + Math.round(3 * Math.sin(x / 9) + 3 * Math.cos(z / 7)); // rolling land, 62 to 74
    };
    const trunk = (x, z) => x < -10 && z < -10 && dice(x, z, 1) < 3;
    return (x, y, z) => {
        if (y === -64) return 'bedrock';
        const h = height(x, z);
        if (y <= h - 4) return 'stone';
        if (y < h) return 'dirt';
        if (y === h) return h < 62 ? 'sand' : 'grass_block';
        if (h < 62) return y <= 62 ? 'water' : null;
        if (trunk(x, z)) return y <= h + 5 ? 'oak_log' : (y === h + 6 ? 'oak_leaves' : null);
        // the crown of a tree nearby
        if (y >= h + 4 && y <= h + 6) {
            for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) if (trunk(x + dx, z + dz) && height(x + dx, z + dz) === h) return 'oak_leaves';
        }
        if (y === h + 1) {
            const roll = dice(x, z, 2);
            if (roll < 22) return 'short_grass';
            if (roll < 24) return 'poppy';
            if (roll < 25) return 'tall_grass';
            return null;
        }
        if (y === h + 2 && dice(x, z, 2) === 24) return 'tall_grass';
        return null;
    };
}

const wild = (options = {}) => fakeMinecraft({ seed: '20261116', terrain: land(options), chunks: true, spawn: [3, 67, -5] });
const noChange = (server) => server.log.filter((command) => !/^(execute if blocks? |forceload |seed$)/.test(command));

// ---- the reading commands and the probe ------------------------------------------------------

test('survey: the answers of the reading commands are read, and anything else is not understood', () => {
    assert.equal(READ_ANSWERS.count('Test passed, count: 12'), 12);
    assert.equal(READ_ANSWERS.count('Test passed, count: 0'), 0);
    assert.equal(READ_ANSWERS.count('Test passed'), null);
    assert.equal(READ_ANSWERS.count('Test failed'), null);
    assert.deepEqual([READ_ANSWERS.passed('Test passed'), READ_ANSWERS.passed('Test failed'), READ_ANSWERS.passed('That position is not loaded')], [true, false, null]);
    assert.deepEqual(READ_ANSWERS.chunk('Chunk at [-3, 12] in minecraft:overworld is not marked for force loading'), [-3, 12]);
    assert.equal(READ_ANSWERS.chunk('Unknown or incomplete command'), null);
    assert.equal(READ_ANSWERS.not_loaded('That position is not loaded'), true);
    // every command is listed with the answer it expects, and the table of blocks has no name twice
    assert.equal(READ_COMMANDS.length, 6);
    assert.equal(new Set(NATURAL_BLOCKS.map(([name]) => name)).size, NATURAL_BLOCKS.length);
    assert.ok(NATURAL_BLOCKS.every(([name, kind]) => /^[a-z_]+$/.test(name) && ['ground', 'cover', 'tree', 'wet'].includes(kind)));
    assert.deepEqual([NATURAL_KIND.water, NATURAL_KIND.lava, NATURAL_KIND.oak_leaves, NATURAL_KIND.short_grass, NATURAL_KIND.grass_block], ['wet', 'wet', 'tree', 'cover', 'ground']);
    // no more than 256 chunks in one forceload command
    const boxes = forceloadBoxes({ min: [-300, -300], max: [300, 300] });
    assert.ok(boxes.length > 1);
    assert.ok(boxes.every((box) => ((box.max[0] - box.min[0] + 1) / 16) * ((box.max[1] - box.min[1] + 1) / 16) <= 256));
    assert.equal(boxes.reduce((n, box) => n + ((box.max[0] - box.min[0] + 1) / 16) * ((box.max[1] - box.min[1] + 1) / 16), 0), 38 * 38);
});

test('survey: the reader counts, compares and names blocks, and finds the top of a column', async () => {
    const server = fakeMinecraft({ terrain: land() });
    const reader = createReader({ send: (command) => server.send(command) });
    // a column of the meadow: stone, 3 dirt, grass at 64
    assert.equal(await reader.count({ min: [40, 60, 0], max: [40, 64, 0] }), 5);
    assert.equal(await reader.count({ min: [40, 65, 0], max: [40, 80, 0] }), dice(40, 0, 2) < 25 ? 1 : 0);
    assert.deepEqual([await reader.uniform({ min: [40, 61, 0], max: [44, 63, 4] }), await reader.uniform({ min: [40, 61, 0], max: [44, 64, 4] })], [true, false]);
    assert.deepEqual([await reader.is([40, 64, 0], 'grass_block'), await reader.is([40, 64, 0], 'dirt')], [true, false]);
    assert.deepEqual([await reader.identify([40, 64, 0]), await reader.identify([40, 63, 0]), await reader.identify([40, 10, 0])], ['grass_block', 'dirt', 'stone']);
    server.blocks.set('40,64,1', { name: 'purpur_block', states: {} });
    assert.equal(await reader.identify([40, 64, 1]), null, 'a block that is not in the table has no name');
    // the top of a column: found from nothing, and in two commands from a neighbour's height
    const column = [41, 3];
    const top = await reader.highest(column);
    assert.equal(top, dice(41, 3, 2) < 25 ? 65 + (dice(41, 3, 2) === 24 ? 1 : 0) : 64);
    const before = reader.stats().commands;
    assert.equal(await reader.top([62, 2], 64), 65 + (dice(62, 2, 2) < 25 ? 1 : 0) + (dice(62, 2, 2) === 24 ? 1 : 0), 'the rise in the meadow');
    assert.equal(reader.stats().commands - before, 2, 'a solid column near the guess costs two commands');
    // a column with a gap under its top (a tree's crown) is searched: the answer is still the top
    server.blocks.set('50,70,0', { name: 'oak_leaves', states: {} });
    assert.equal(await reader.top([50, 0], 64), 70);
    // a box larger than one command may compare is cut up, never sent whole
    assert.equal(await reader.count({ min: [20, 61, 0], max: [59, 64, 39] }), 40 * 40 * 4);
    assert.equal(await reader.count({ min: [20, 20, 0], max: [59, 63, 39] }), 40 * 40 * 44);
    assert.ok(server.log.every((command) => !command.includes('Too many')));
    assert.deepEqual(noChange(server), []);
});

test('survey: the probe runs every reading command where the answer is known, and stops with the raw answer', async () => {
    const server = fakeMinecraft({ terrain: land() });
    server.unknown_blocks.add('firefly_bush').add('leaf_litter'); // an older server: two names of the table are not known to it
    const lines = [];
    const reader = createReader({ send: (command) => server.send(command) });
    const passed = await probe(reader, [8, 8], { log: (line) => lines.push(line) });
    assert.deepEqual([passed.ok, passed.dropped], [true, ['leaf_litter', 'firefly_bush']]);
    assert.match(lines.join('\n'), /does not know 2 block name\(s\) of the table, they are left out: leaf_litter, firefly_bush/);
    assert.ok(!reader.names().includes('firefly_bush') && reader.names().includes('grass_block'));
    // each reading command went out once on the known column: bedrock at the bottom, air at the top
    for (const command of ['execute if blocks 8 -64 8 8 -64 8 8 -64 8 masked', 'execute if blocks 8 319 8 8 319 8 8 319 8 masked', 'execute if block 8 -64 8 minecraft:bedrock',
        'execute if block 8 319 8 minecraft:air', 'execute if blocks 8 318 8 8 318 8 8 319 8 all', 'execute if blocks 8 -64 8 8 -64 8 8 319 8 all', 'execute if block 8 319 8 minecraft:grass_block']) {
        assert.ok(server.log.includes(command), command);
    }
    assert.equal(server.log.length, 8 + NATURAL_BLOCKS.length);
    assert.deepEqual(noChange(server), []);

    // a server that words the count differently: the probe stops at the first command, with the raw answer
    const odd = { log: [], async send(command) { this.log.push(command); return command.includes(' masked') ? 'Test passed (1 block)' : 'Test passed'; } };
    const stopped = await probe(createReader({ send: (command) => odd.send(command) }), [8, 8]);
    assert.equal(stopped.ok, false);
    assert.match(stopped.problem, /the probe stopped at "bedrock at the bottom is a block \(count 1\)".*"execute if blocks 8 -64 8 8 -64 8 8 -64 8 masked" was not understood: "Test passed \(1 block\)"\. Nothing was changed/);
    assert.equal(stopped.answer, 'Test passed (1 block)');
    assert.equal(odd.log.length, 1, 'nothing was asked after the answer that was not understood');

    // a server that answers "Test failed" for a box of air is understood too
    const terse = fakeMinecraft({ terrain: land() });
    const terse_reader = createReader({ send: async (command) => { const answer = await terse.send(command); return answer === 'Test passed, count: 0' ? 'Test failed' : answer; } });
    assert.equal((await probe(terse_reader, [8, 8], { names: false })).ok, true);
    assert.equal(await terse_reader.count({ min: [8, 300, 8], max: [9, 310, 9] }), 0);
});

test('survey: chunks are force-loaded before anything is read, waited for, and given back', async () => {
    const server = wild();
    const sent = [];
    const send = (command) => { sent.push(command); return server.send(command); };
    const reader = createReader({ send });
    // away from the spawn nothing can be read
    await assert.rejects(reader.count({ min: [100, 60, 100], max: [100, 70, 100] }), (err) => err instanceof ReadError && err.code === 'not_loaded');
    const waits = [];
    const loaded = await loadChunks({ send, reader, box: { min: [90, 90], max: [140, 120] }, sleep: async (ms) => { waits.push(ms); }, wait_ms: 250 });
    assert.equal(loaded.ok, true);
    assert.equal(sent.filter((command) => command.startsWith('forceload ')).join('; '), 'forceload add 80 80 143 127');
    assert.ok(waits.length >= 1 && waits.every((ms) => ms === 250), 'it waited between readings');
    assert.equal(await reader.count({ min: [100, 60, 100], max: [100, 70, 100] }) > 0, true);
    await loaded.release();
    assert.equal(sent.at(-1), 'forceload remove 80 80 143 127');
    assert.equal(server.forced.size, 0);
    // chunks that never load: a clean failure after the bounded wait, with the server's own words
    const dead = wild();
    dead.load_after = Infinity;
    const dead_reader = createReader({ send: (command) => dead.send(command) });
    const failed = await loadChunks({ send: (command) => dead.send(command), reader: dead_reader, box: { min: [200, 200], max: [210, 210] }, sleep: noSleep, tries: 5 });
    assert.equal(failed.ok, false);
    assert.match(failed.problem, /were not loaded after 5 tries: .*"That position is not loaded"/);
    await failed.release();
    assert.equal(dead.forced.size, 0);
    // chunks somebody else force-loaded are not given back by this script
    const kept = wild();
    await kept.send('forceload add 80 80 95 95');
    const kept_reader = createReader({ send: (command) => kept.send(command) });
    const again = await loadChunks({ send: (command) => kept.send(command), reader: kept_reader, box: { min: [80, 80], max: [95, 95] }, sleep: noSleep });
    await again.release();
    assert.equal(kept.forced.size, 1);
});

test('survey: a floor is checked a whole box at a time, and the one wrong cell is found with its position', async () => {
    const server = fakeMinecraft({ terrain: land() });
    const reader = createReader({ send: (command) => server.send(command) });
    const floor = { min: [100, 64, 20], max: [115, 64, 35] };
    assert.equal(await checkBox(reader, floor, ['minecraft:grass_block', 'minecraft:dirt']), null);
    assert.ok(server.log.length <= 4, `${server.log.length} commands for a floor of one kind of block`);
    server.blocks.set('107,64,29', { name: 'air', states: {} });
    assert.deepEqual(await checkBox(reader, floor, ['minecraft:grass_block', 'minecraft:dirt']), { pos: [107, 64, 29], found: 'air' });
    server.blocks.set('107,64,29', { name: 'cobblestone', states: {} });
    assert.deepEqual(await checkBox(reader, floor, ['minecraft:grass_block', 'minecraft:dirt']), { pos: [107, 64, 29], found: 'another block' });
    server.blocks.set('107,64,29', { name: 'dirt', states: {} });
    assert.equal(await checkBox(reader, floor, ['minecraft:grass_block', 'minecraft:dirt']), null, 'dirt in a grass floor is accepted');
    assert.deepEqual(noChange(server), []);
});

// ---- the selection ---------------------------------------------------------------------------

test('site: the score refuses water, trees, unknown blocks and uneven land, and prefers what needs the least levelling', () => {
    const layout = siteLayout(exampleWorld());
    assert.deepEqual(layout.land, { min: [-34, -30], max: [45, 29] });
    assert.deepEqual(layout.zones.map((zone) => zone.id), ['camp', 'field', 'plot.arthur-1', 'plot.mira-1', 'plot.felix-1', 'plot.nova-1', 'plot.spare-1']);
    const flat = (edit = () => null) => {
        const columns = new Map();
        for (let x = -200; x <= 200; x += 4) for (let z = -200; z <= 200; z += 4) columns.set(`${x},${z}`, edit(x, z) ?? { y: 70, kind: 'ground', covers: 0 });
        return columns;
    };
    const score = (columns, options = {}) => scoreSites({ columns, center: [0, 0], layout, options: { radius: 8, ...options } });
    // flat land everywhere: every place passes, the one at the spawn first
    const open = score(flat());
    assert.deepEqual([open.total, open.passed.length, open.rejected], [25, 25, {}]);
    assert.deepEqual([open.passed[0].home, open.passed[0].floor_y, open.passed[0].estimate, open.passed[0].relief], [[0, 71, 0], 70, 0, 0]);
    // water anywhere inside the site refuses the place, also between the zones
    assert.deepEqual(score(flat((x, z) => (x === 16 && z === 8 ? { y: 62, kind: 'wet', covers: 0 } : null)), { radius: 0 }).rejected, { wet: 1 });
    // a tree between the zones is fine; inside a zone it refuses the place
    assert.equal(score(flat((x, z) => (x === 16 && z === 8 ? { y: 75, kind: 'tree', covers: 0 } : null)), { radius: 0 }).passed.length, 1);
    assert.deepEqual(score(flat((x, z) => (x === 0 && z === 20 ? { y: 75, kind: 'tree', covers: 0 } : null)), { radius: 0 }).rejected, { tree: 1 });
    assert.deepEqual(score(flat((x, z) => (x === 0 && z === 20 ? { y: 70, kind: 'unknown', covers: 0 } : null)), { radius: 0 }).rejected, { unknown: 1 });
    // uneven land: within the relief it passes and costs, beyond it the place is refused
    const bump = score(flat((x, z) => (x === 0 && z === 20 ? { y: 72, kind: 'ground', covers: 0 } : null)), { radius: 0 });
    assert.deepEqual([bump.passed[0].relief, bump.passed[0].estimate], [2, 32]);
    assert.deepEqual(score(flat((x, z) => (x === 0 && z === 20 ? { y: 74, kind: 'ground', covers: 0 } : null)), { radius: 0 }).rejected, { steep: 1 });
    // below the lowest floor allowed (the sea is at 62)
    assert.deepEqual(scoreSites({ columns: new Map([...flat()].map(([key, column]) => [key, { ...column, y: 60 }])), center: [0, 0], layout, options: { radius: 0 } }).rejected, { low: 1 });
    // the place that needs less levelling wins over the nearer one
    const better = score(flat((x) => (x < 0 ? { y: 70 + (Math.abs(x) % 8 === 0 ? 1 : 0), kind: 'ground', covers: 0 } : null)), { radius: 48 });
    assert.equal(better.passed[0].estimate, 0);
    assert.ok(better.passed[0].home[0] >= 28 && better.passed[0].distance >= 28, 'the flat land to the east was not preferred');
    assert.equal(Object.keys(SITE_REFUSALS).length, 6);
});

test('site: from the world spawn, with no player online, it finds flat dry land, changes nothing and stays within its bound', async () => {
    const server = wild();
    const lines = [];
    const picked = await pickSite({ send: (command) => server.send(command), example: exampleWorld(), seed: '20261116', blueprints: BLUEPRINTS, sleep: noSleep, log: (line) => lines.push(line), clock: fakeClock() });
    assert.equal(picked.ok, true, picked.problems.join('; '));
    assert.equal(picked.stage, 'done');
    // the spawn is asked for first, then the probe runs before anything is scanned
    assert.equal(server.log[0], 'forceload query ~ ~');
    assert.deepEqual(picked.record.spawn, { source: 'forceload query ~ ~', chunk: [0, -1], center: [8, -8] });
    assert.ok(server.log.indexOf('execute if blocks 8 -64 -8 8 -64 -8 8 -64 -8 masked') < server.log.indexOf('execute if block 8 319 -8 minecraft:grass_block'));
    // the chosen site lies in the meadow: flat, dry, no tree in a zone, and the world file for it is valid
    const chosen = picked.record.chosen;
    assert.deepEqual([chosen.floor_y, chosen.home[1], chosen.relief], [64, 65, 0]);
    assert.ok(chosen.land.min[0] >= 20, `the site ${JSON.stringify(chosen.land)} is not in the meadow`);
    assert.deepEqual(checkWorldConfig(picked.world, { blueprints: BLUEPRINTS }), []);
    assert.deepEqual([picked.world.home, picked.world.seed, picked.world.border.center], [chosen.home, '20261116', [chosen.home[0], chosen.home[2]]]);
    assert.equal(picked.record.world_sha256, worldHash(picked.world));
    // the scores are recorded: what passed, what was refused and why, the exact count for the best few
    assert.deepEqual([picked.record.method, picked.record.by], ['automatic', 'Operator']);
    assert.equal(picked.candidates.total, 25 * 25);
    assert.ok(picked.candidates.passed > 0 && picked.candidates.rejected.wet > 0 && picked.candidates.rejected.tree > 0 && picked.candidates.rejected.steep > 0);
    assert.equal(picked.candidates.passed + Object.values(picked.candidates.rejected).reduce((a, b) => a + b, 0), 625);
    assert.equal(chosen.exact.floor_holes, 0);
    let grows = 0;
    const plan = buildBootstrapPlan(picked.world);
    for (const zone of plan.zones) for (let x = zone.min[0]; x <= zone.max[0]; x++) for (let z = zone.min[1]; z <= zone.max[1]; z++) for (let y = 65; y <= 88; y++) if (server.blockAt(x, y, z).name !== 'air') grows++;
    assert.equal(chosen.exact.to_clear, grows, 'the exact count is what really stands above the floor');
    assert.equal(picked.record.runners_up.length, 2);
    assert.ok(picked.record.runners_up.every((other) => other.exact.changes >= chosen.exact.changes));
    // NOTHING was changed: only reading commands and forceload went out, and every chunk was given back
    assert.deepEqual(noChange(server), []);
    assert.equal(server.forced.size, 0);
    // the bound: 44 by 39 columns with the starting values, and far fewer commands than the hard limit
    assert.deepEqual([picked.record.search.columns, picked.record.search.radius, picked.record.search.step], [44 * 39, 48, 4]);
    assert.equal(picked.commands, server.log.length);
    assert.ok(picked.commands < 9000, `${picked.commands} commands`);
    assert.ok(picked.commands < SITE_DEFAULTS.max_commands);
    console.log(`    site selection on the stand-in: ${picked.commands} commands for ${picked.record.search.columns} columns`);
    // progress was streamed, and the report says what was chosen
    assert.ok(lines.some((line) => /scanned 200 of 1716 columns/.test(line)));
    const report = siteReportLines(picked, { dry_run: true }).join('\n');
    assert.match(report, /Site selection PASSED: \d+ commands, \d+ of 625 places pass\./);
    assert.match(report, new RegExp(`Chosen: home ${chosen.home.join(', ')} \\(the floor is layer y=64\\)`));
    assert.match(report, /Refused: \d+ places, water, lava or ice at the surface inside the site/);
    assert.match(report, /Dry run \(--pick-site\): nothing was written and nothing was changed\./);
});

test('site: it fails cleanly when no place passes, when the probe is not understood, and at its limit of commands', async () => {
    // no meadow: rolling land everywhere, a lake and a wood
    const rough = wild({ meadow: false });
    const none = await pickSite({ send: (command) => rough.send(command), example: exampleWorld(), seed: '20261116', blueprints: BLUEPRINTS, sleep: noSleep });
    assert.deepEqual([none.ok, none.stage, none.world, none.record], [false, 'score', null, null]);
    assert.match(none.problems[0], /^No place within 48 blocks of 8, -8 passes: 625 places were looked at and all were refused \(.*the land is not flat enough.*\)\. Nothing was changed\. Search wider \(--site-radius 96\)/);
    assert.match(none.problems[0], /or pick the place by hand: node genesis\/tools\/place_world\.js --at <x> <y> <z> --seed <seed>\.$/);
    assert.deepEqual(noChange(rough), []);
    assert.equal(rough.forced.size, 0, 'the chunks were not given back');
    assert.match(siteReportLines(none).join('\n'), /Site selection FAILED at stage "score"/);

    // the spawn cannot be asked for: stop, and say how to go on
    const mute = { async send() { return 'Unknown or incomplete command, see below for error'; } };
    const lost = await pickSite({ send: (command) => mute.send(command), example: exampleWorld(), seed: '1', sleep: noSleep });
    assert.deepEqual([lost.ok, lost.stage, lost.commands], [false, 'spawn', 1]);
    assert.match(lost.problems[0], /answer to "forceload query ~ ~" was not understood: "Unknown or incomplete command, see below for error"\. Nothing was changed\. Say where to search instead: --site-from <x> <z>/);

    // the probe is not understood: stop with the raw answer, before anything is scanned
    const server = wild();
    const worded = { log: [], async send(command) { this.log.push(command); const answer = await server.send(command); return answer.replace('Test passed, count: ', 'Passed with count '); } };
    const stopped = await pickSite({ send: (command) => worded.send(command), example: exampleWorld(), seed: '20261116', sleep: noSleep });
    assert.deepEqual([stopped.ok, stopped.stage], [false, 'probe']);
    assert.match(stopped.problems[0], /the probe stopped at "bedrock at the bottom is a block \(count 1\)".*was not understood: "Passed with count 1"/);
    assert.ok(worded.log.length < 12, 'the scan started although the probe failed');
    assert.equal(server.forced.size, 0);

    // the hard limit: a clean stop, the chunks given back
    const small = wild();
    const limited = await pickSite({ send: (command) => small.send(command), example: exampleWorld(), seed: '20261116', sleep: noSleep, options: { max_commands: 600 } });
    assert.deepEqual([limited.ok, limited.stage], [false, 'scan']);
    assert.ok(limited.commands >= 600 && limited.commands <= 603, 'only giving the chunks back may go over the limit');
    assert.match(limited.problems[0], /stopped at its limit of 600 commands \(stage "scan"\)\. Nothing was changed/);
    assert.deepEqual(noChange(small), []);
    assert.equal(small.forced.size, 0);

    // the operator says where to search: the spawn is not asked for
    const given = wild();
    const there = await pickSite({ send: (command) => given.send(command), example: exampleWorld(), seed: '20261116', blueprints: BLUEPRINTS, sleep: noSleep, from: [90, 0], options: { radius: 16 } });
    assert.equal(there.ok, true, there.problems.join('; '));
    assert.equal(given.log.includes('forceload query ~ ~'), false);
    assert.deepEqual([there.record.spawn.source, there.record.spawn.center, there.candidates.total], ['--site-from', [90, 0], 81]);
});

// ---- WorldEdit from the console ---------------------------------------------------------------

test('worldedit: its answers are read tolerantly, and the probe finds out how the console takes its commands', async () => {
    assert.deepEqual(WORLDEDIT_ANSWERS.position('First position set to (234, 67, -48).'), [234, 67, -48]);
    assert.deepEqual(WORLDEDIT_ANSWERS.position('Second position set to (313, 67, 11) (4800).'), [313, 67, 11]);
    assert.equal(WORLDEDIT_ANSWERS.position('Too many arguments.'), null);
    assert.deepEqual([WORLDEDIT_ANSWERS.affected('Operation completed (15,000 blocks affected).'), WORLDEDIT_ANSWERS.affected('1 block affected'), WORLDEDIT_ANSWERS.affected('Done.')], [15000, 1, null]);
    assert.deepEqual([blockKey('Grass Block'), blockKey('minecraft:oak_log[axis=y]'), blockKey('block.minecraft.air')], ['grass_block', 'oak_log', 'air']);
    assert.deepEqual(parseDistribution('Total Block Count: 15,000\n14,981  (99.873%) Air\n10  (0.067%) Oak Log\n9 (0.060%) minecraft:stone'), { air: 14981, oak_log: 10, stone: 9 });
    assert.equal(parseDistribution('Block distribution: see the chat window.'), null);
    assert.equal(WORLDEDIT_COMMANDS.length, 6);

    // the plugin is absent: said so, nothing else is tried
    const bare = fakeMinecraft();
    assert.deepEqual(await probeWorldEdit({ send: (command) => bare.send(command), at: [0, -64, 0] }), { present: false, answer: 'Unknown or incomplete command, see below for error\nworldedit version<--[HERE]' });
    assert.deepEqual(bare.log, ['worldedit version']);
    // both slashes, as typed in the game: the first try
    const usual = fakeMinecraft({ worldedit: {} });
    assert.deepEqual(await probeWorldEdit({ send: (command) => usual.send(command), at: [0, -64, 0] }), { present: true, ok: true, prefix: '//', version: '7.4.6', world: 'world' });
    assert.deepEqual(usual.log, ['worldedit version', '//world world', '//pos1 0,-64,0']);
    // a console that wants one slash: found on the second try, nothing changed meanwhile
    const single = fakeMinecraft({ worldedit: { prefix: '/' } });
    assert.equal((await probeWorldEdit({ send: (command) => single.send(command), at: [0, -64, 0] })).prefix, '/');
    assert.deepEqual(single.log, ['worldedit version', '//world world', '//pos1 0,-64,0', '/world world', '/pos1 0,-64,0']);
    // it is there but not understood (here: another world name): stop, with every raw answer
    const other = fakeMinecraft({ worldedit: { world: 'genesis' } });
    const lost = await probeWorldEdit({ send: (command) => other.send(command), at: [0, -64, 0] });
    assert.deepEqual([lost.present, lost.ok], [true, false]);
    assert.match(lost.problem, /WorldEdit is installed but its console commands were not understood\. Nothing was changed\..*"\/\/world world" -> "World world was not found".*"\/\/pos1 0,-64,0" -> "You need to provide a world \(Try \/\/world\)".*GENESIS_WORLDEDIT_WORLD.*--no-worldedit/);
    assert.deepEqual(other.changing(), []);
});

// ---- the whole bootstrap on land it picked itself ---------------------------------------------

test('bootstrap: with no world file it picks the site, writes the world file, levels camp, field and plots with WorldEdit, and records counts by kind of block', async () => {
    const server = fakeMinecraft({ seed: '20261116', terrain: land(), chunks: true, spawn: [3, 67, -5], worldedit: {} });
    const files = fakeFiles();
    const clock = fakeClock();
    const lines = [];
    const stage = await runSiteStage({ rcon: server, files, example: exampleWorld(), world_file: WORLD_FILE, manifest_file: MANIFEST, blueprints: BLUEPRINTS, clock, sleep: noSleep, log: (line) => lines.push(line) });
    assert.equal(stage.ok, true, stage.lines.join('\n'));
    // the world file and the record of the selection were written, and say the same
    const config = JSON.parse(files.store.get(WORLD_FILE));
    assert.deepEqual(config, stage.config);
    assert.deepEqual(JSON.parse(files.store.get(`/data/genesis_world/${SITE_RECORD_FILE}`)), stage.site);
    assert.deepEqual(await readSiteRecord({ files, manifest_file: MANIFEST, config }), stage.site);
    assert.equal(await readSiteRecord({ files, manifest_file: MANIFEST, config: exampleWorld() }), null, 'the record of another world file was taken');
    assert.match(stage.lines.join('\n'), /Wrote \/data\/genesis_world\/genesis\.world\.json \(seed 20261116\)/);
    const site_commands = server.log.length;

    // what stands in the zones before anything is changed, by kind of block
    const plan = buildBootstrapPlan(config);
    const before = new Map();
    for (const area of plan.areas) {
        const counts = {};
        for (let x = area.min[0]; x <= area.max[0]; x++) for (let y = area.min[1]; y <= area.max[1]; y++) for (let z = area.min[2]; z <= area.max[2]; z++) { const name = server.blockAt(x, y, z).name; counts[name] = (counts[name] ?? 0) + 1; }
        before.set(area.id, counts);
    }
    server.log.length = 0;
    const result = await runBootstrap({ config, rcon: server, files, clock, manifest_file: MANIFEST, world_file: WORLD_FILE, blueprints: BLUEPRINTS, site: stage.site, sleep: noSleep, log: (line) => lines.push(line) });
    assert.equal(result.ok, true, result.problems.join('; '));
    assert.deepEqual(result.warnings, []);
    const manifest = parseManifest(files.store.get(MANIFEST));
    assert.deepEqual(checkManifest(manifest, config), []);
    // how the site was chosen and how it was levelled are in the manifest
    assert.deepEqual([manifest.site.method, manifest.site.by, manifest.site.chosen.home], ['automatic', 'Operator', config.home]);
    assert.ok(manifest.site.candidates.passed > 0 && manifest.site.chosen.exact.changes >= 0 && manifest.site.commands > 0);
    assert.deepEqual(manifest.levelling, { method: 'worldedit', version: '7.4.6', prefix: '//', world: 'world' });

    // camp, field and plots are level: the floor is grass (farmland and water on the field), and above it only the camp stands
    for (const zone of plan.zones) {
        for (let x = zone.min[0]; x <= zone.max[0]; x++) {
            for (let z = zone.min[1]; z <= zone.max[1]; z++) {
                const floor = server.blockAt(x, zone.y, z).name;
                assert.ok(zone.id === 'field' ? ['farmland', 'water'].includes(floor) : floor === 'grass_block', `${zone.id} floor at ${x}, ${z} is ${floor}`);
                if (zone.id !== 'camp') for (let y = zone.y + 1; y <= zone.y + 24; y++) assert.equal(server.blockAt(x, y, z).name, 'air', `${zone.id} at ${x}, ${y}, ${z}`);
            }
        }
    }
    // decided: counts by kind of block per area. What was there before is WorldEdit's own distribution
    // of the selection, and it is what really stood there; what was laid is every cell that was not the block already
    let cleared = 0;
    let strip_cleared = 0;
    for (const record of manifest.areas) {
        const was = before.get(record.id);
        const target = record.block.replace('minecraft:', '');
        const to_change = record.cells - (was[target] ?? 0);
        assert.deepEqual([record.by, record.before.not_air], ['Operator', record.cells - (was.air ?? 0)], record.id);
        if (to_change === 0) {
            // the meadow is already flat and grassed: such a box is left alone, WorldEdit is not asked, and the record says so
            assert.deepEqual([record.status, record.changed, record.placed, record.laid.count, record.before.by_type], ['nothing to change', 0, false, 0, null], record.id);
        } else {
            assert.deepEqual([record.status, record.method, record.changed, record.laid], ['filled', 'worldedit', to_change, { block: record.block, count: to_change }], record.id);
            assert.deepEqual(record.before.by_type, was, `${record.id}: the distribution before`);
            assert.equal(record.worldedit.affected, record.cells);
            if (record.kind === 'clear') cleared += to_change;
            if (record.kind === 'clear' && record.zone.startsWith('camp.strip.')) strip_cleared += to_change;
        }
    }
    assert.equal(result.placed.cleared, cleared);
    // (the strip one block outside the fence is levelled with the site, but is not part of what the selection scores)
    assert.equal(cleared - strip_cleared, manifest.site.chosen.exact.to_clear, 'the selection counted what the levelling then cleared');
    assert.ok(strip_cleared > 0, 'the strip outside the fence had something to clear on this land');
    // per box that changes: select (pos1, pos2), the distribution, the set; coordinates comma-separated with no spaces (seen in the game)
    const changed_boxes = manifest.areas.filter((record) => record.changed > 0);
    const sets = server.log.filter((command) => command.startsWith('//set '));
    assert.equal(sets.length, changed_boxes.length);
    assert.ok(sets.every((command) => ['//set air', '//set grass_block'].includes(command)));
    const camp = manifest.areas.find((record) => record.id === 'camp.clear');
    const at = server.log.indexOf(`//pos1 ${camp.min.join(',')}`);
    assert.deepEqual(server.log.slice(at, at + 4), [`//pos1 ${camp.min.join(',')}`, `//pos2 ${camp.max.join(',')}`, '//distr', '//set air']);
    assert.equal(server.log.some((command) => command.startsWith('fill ')), false, 'the fill command was used although WorldEdit is there');
    assert.equal(server.log.filter((command) => /^\/\/(pos1|pos2|distr)/.test(command)).length, 1 + 3 * changed_boxes.length, 'the probe sets one position; each changed box three commands more');
    // the whole run: some hundreds of commands, not thousands
    assert.ok(result.commands.length < 1300, `${result.commands.length} commands`);
    console.log(`    bootstrap on the stand-in's meadow with WorldEdit: ${site_commands} commands to pick the site; levelling ${result.placed.cleared + result.placed.floored} blocks in ${changed_boxes.length} of 22 boxes: ${server.log.filter((command) => command.startsWith('//')).length} WorldEdit commands, ${result.survey.commands} reading commands, ${result.commands.length} commands in all`);
    assert.ok(lines.some((line) => /^Levelling with WorldEdit 7\.4\.6 from the console/.test(line)));
    assert.ok(lines.some((line) => /^Levelled 1 of 22: camp cleared \(layers 65 to 88\): \d+ blocks changed/.test(line)), 'progress was not streamed');
    assert.match(reportLines(result, { manifest_file: MANIFEST }).join('\n'), /Bootstrap PASSED[\s\S]*Levelled the site \(camp, field, plots, and the strip one block outside the fence\) with WorldEdit 7\.4\.6: \d+ blocks cleared/);
    assert.equal(server.forced.size, 0, 'the chunks were not given back');

    // a second run: nothing is levelled, nothing is changed, WorldEdit is not asked, the record is carried
    server.log.length = 0;
    const again = await runBootstrap({ config, rcon: server, files, clock, manifest_file: MANIFEST, world_file: WORLD_FILE, blueprints: BLUEPRINTS, site: await readSiteRecord({ files, manifest_file: MANIFEST, config }), sleep: noSleep });
    assert.equal(again.ok, true, again.problems.join('; '));
    assert.deepEqual(server.changing(), []);
    assert.equal(server.log.some((command) => /worldedit|^\//.test(command)), false);
    const carried = parseManifest(files.store.get(MANIFEST));
    assert.deepEqual([carried.areas, carried.site.method, carried.levelling.method], [manifest.areas, 'automatic', 'worldedit']);
});

test('bootstrap: no WorldEdit falls back to fill and says so; WorldEdit that is not understood, or does nothing, stops with the raw answer', async () => {
    const config = exampleWorld();
    const run = (server, more = {}) => runBootstrap({ config, rcon: server, files: fakeFiles(), clock: fakeClock(), manifest_file: MANIFEST, blueprints: BLUEPRINTS, sleep: noSleep, ...more });
    const tree = (server) => { for (let y = 64; y <= 68; y++) server.blocks.set(`3,${y},3`, { name: 'oak_log', states: {} }); return server; };

    // absent: the game's own fill command levels, the manifest and a warning say which method it was
    const bare = tree(fakeMinecraft({ seed: '20261116' }));
    const fallback = await run(bare);
    assert.equal(fallback.ok, true, fallback.problems.join('; '));
    assert.deepEqual(fallback.manifest.levelling, { method: 'vanilla', version: null, why: 'WorldEdit is not installed' });
    assert.match(fallback.warnings.join('\n'), /WorldEdit is not installed on this server .*the site was levelled with the game's own fill command instead/);
    assert.ok(bare.log.includes('fill -12 64 -12 12 87 12 minecraft:air') && !bare.log.some((command) => command.startsWith('//')));
    assert.deepEqual(fallback.manifest.areas.find((record) => record.id === 'camp.clear').laid, { block: 'minecraft:air', count: 5 });

    // present, and switched off for the run: no WorldEdit command at all
    const off = tree(fakeMinecraft({ seed: '20261116', worldedit: {} }));
    assert.equal((await run(off, { worldedit: false })).manifest.levelling.method, 'vanilla');
    assert.equal(off.log.some((command) => /worldedit|^\//.test(command)), false);

    // present but its console commands are not understood: stop, nothing changed, the raw answers in the problem
    const strange = tree(fakeMinecraft({ seed: '20261116', worldedit: { world: 'another' } }));
    const stopped = await run(strange);
    assert.deepEqual([stopped.ok, stopped.stage, stopped.failed.id], [false, 'level', 'worldedit.probe']);
    assert.match(stopped.problems[0], /WorldEdit is installed but its console commands were not understood\. Nothing was changed/);
    assert.deepEqual(strange.changing().filter((command) => /^(fill|setblock|\/)/.test(command)), []);
    assert.equal(strange.blockAt(3, 64, 3).name, 'oak_log');
    assert.equal(strange.forced.size, 0, 'the chunks were not given back after the failure');

    // WorldEdit says "done" and changes nothing: its word is not relied on, the box is read back
    const idle = tree(fakeMinecraft({ seed: '20261116', worldedit: { set: false } }));
    const unchanged = await run(idle);
    assert.deepEqual([unchanged.ok, unchanged.stage, unchanged.failed.id], [false, 'level', 'camp.clear']);
    assert.match(unchanged.problems[0], /the camp cleared \(layers 64 to 87\) is not minecraft:air after "\/\/set air": the box still holds blocks that are not air\. WorldEdit answered "Operation completed \(15,000 blocks affected\)\."/);

    // a distribution nobody can read: the levelling goes on, and the record says the counts by kind were not read
    const mute = tree(fakeMinecraft({ seed: '20261116', worldedit: { distr: false } }));
    const levelled = await run(mute);
    assert.equal(levelled.ok, true, levelled.problems.join('; '));
    const record = levelled.manifest.areas.find((entry) => entry.id === 'camp.clear');
    assert.deepEqual([record.before, record.laid.count], [{ not_air: 5, by_type: null, not_read: 'Block distribution: see the chat window.' }, 5]);
});

test('bootstrap: a site the operator flattened himself passes untouched; chunks that do not load, or unload, are named as that', async () => {
    const config = exampleWorld();
    // flat and floored already (the operator's own //set): every box is as it should be
    const flat = fakeMinecraft({ seed: '20261116', worldedit: {}, chunks: true, terrain: (x, y, z) => (y === -64 ? 'bedrock' : y < 60 ? 'stone' : y < 63 ? 'dirt' : y === 63 ? 'grass_block' : null) });
    const done = await runBootstrap({ config, rcon: flat, files: fakeFiles(), clock: fakeClock(), manifest_file: MANIFEST, blueprints: BLUEPRINTS, sleep: noSleep });
    assert.equal(done.ok, true, done.problems.join('; '));
    assert.deepEqual([done.placed.cleared, done.placed.floored], [0, 0]);
    assert.ok(done.manifest.areas.length === 22 && done.manifest.areas.every((record) => record.status === 'nothing to change' && record.changed === 0));
    assert.equal(flat.log.some((command) => /^\/\/set |^fill /.test(command)), false, 'a flat site was levelled again');
    assert.deepEqual(checkManifest(done.manifest, config), []);

    // item: with no player online nothing can be read until the chunks are force-loaded; afterwards it can; they are released at the end
    const far = fakeMinecraft({ seed: '20261116', chunks: true, spawn: [5000, 64, 5000] });
    assert.equal(await far.send('execute if block -2 64 -6 minecraft:chest'), 'That position is not loaded');
    far.log.length = 0;
    const loaded = await runBootstrap({ config, rcon: far, files: fakeFiles(), clock: fakeClock(), manifest_file: MANIFEST, blueprints: BLUEPRINTS, sleep: noSleep, worldedit: false });
    assert.equal(loaded.ok, true, loaded.problems.join('; '));
    const add = far.log.indexOf('forceload add -48 -32 47 31');
    assert.ok(add >= 0 && far.log.slice(0, add).every((command) => !/^(execute|fill|setblock|data|item)/.test(command)), 'a block was read or changed before the chunks were force-loaded');
    assert.equal(far.log.at(-1), 'forceload remove -48 -32 47 31');
    assert.equal(far.forced.size, 0);

    // the chunks never load: stopped at the levelling, nothing placed, released
    const dead = fakeMinecraft({ seed: '20261116', chunks: true, spawn: [5000, 64, 5000], load_after: Infinity });
    const unloaded = await runBootstrap({ config, rcon: dead, files: fakeFiles(), clock: fakeClock(), manifest_file: MANIFEST, blueprints: BLUEPRINTS, sleep: noSleep, load: { tries: 3 } });
    assert.deepEqual([unloaded.ok, unloaded.stage], [false, 'level']);
    assert.match(unloaded.problems[0], /the site's chunks could not be loaded: the chunks from -34, -30 to 45, 29 were not loaded after 3 tries: the position is not loaded/);
    assert.equal(dead.log.some((command) => /^(fill|setblock) /.test(command)), false);
    assert.equal(dead.forced.size, 0, 'the chunks were not given back after the failure');

    // the chunks unload in the middle of the run: the answer is named as "not loaded", never as a block that does not match
    const flaky = fakeMinecraft({ seed: '20261116', chunks: true, spawn: [5000, 64, 5000] });
    const real_send = flaky.send;
    flaky.send = async (command) => (command.startsWith('execute if block -6 64 2 ') && flaky.log.some((sent) => sent.startsWith('setblock ')) ? 'That position is not loaded' : real_send(command));
    const broken = await runBootstrap({ config, rcon: flaky, files: fakeFiles(), clock: fakeClock(), manifest_file: MANIFEST, blueprints: BLUEPRINTS, sleep: noSleep, worldedit: false });
    assert.deepEqual([broken.ok, broken.failed.id], [false, 'not_loaded']);
    assert.match(broken.problems[0], /^the area is NOT LOADED: the server answered "That position is not loaded" to "execute if block -6 64 2 minecraft:crafting_table"\. No block was read as missing or wrong because of it/);
    assert.ok(!/block check failed/.test(broken.problems.join(' ')));
    assert.equal(flaky.log.at(-1), 'forceload remove -48 -32 47 31');
});
