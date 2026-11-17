// Genesis: automatic site selection (decided). The bootstrap picks where the settlement goes,
// so the operator gives no coordinates: it reads the land around the world spawn over RCON,
// with no player online, scores every place the camp, the field and all plots would fit, and
// writes the world file for the best one (the example layout moved there, exactly as
// genesis/tools/place_world.js moves it for coordinates given by hand).
//
// What it does, in this order, stopping at the first thing that fails. NOTHING here changes a
// block, a rule or the spawn; the chunks it force-loads are released at the end.
//   1. spawn   asks which chunk the world spawn is in ("forceload query ~ ~"), unless the
//              operator said where to search (--site-from x z)
//   2. probe   runs every reading command once where the answer is known (genesis/world/survey.js)
//              and stops with the raw answer when it is not understood
//   3. load    force-loads the chunks of the search area and waits until they can be read
//   4. scan    one column every `step` blocks: its height (the highest block that is not air)
//              and what the surface is made of. Typically 3 to 4 commands a column.
//   5. score   every place on the same grid within `radius` of the spawn: the place is REFUSED
//              when a sampled column inside the site is water, lava or ice, when one inside the
//              camp, the field or a plot is a tree (leaves or logs) or a block the script does
//              not know, when the land there differs more than `max_relief` blocks from the
//              floor, when the floor would lie below `min_floor_y`, or when the world file for
//              it fails its checks (the world border, every agent's range). The others are
//              ordered by how many blocks the levelling would change (estimated from the samples).
//   6. verify  for the best few, the levelling is COUNTED exactly (two commands per zone) and
//              the place with the fewest blocks to change wins
// The record of all this (how the site was chosen, the scores, what was refused and why) goes
// into the bootstrap manifest under "site".
//
// THE BOUND ON COMMANDS: columns = (2*radius + site width) / step + 1 by the same for the depth,
// 1,716 with the starting values (44 by 39). A column costs 2 commands for its height (9 more when it is not
// solid under its top) and 1 to 3 for its surface when that is a common block; a block low in
// the table costs up to the length of the table. On the stand-in's land (genesis/tests/site.test.js):
// about 7,800 commands. A hard limit
// (`max_commands`, 25,000) stops the selection cleanly, with nothing changed, whatever the land.
//
// Injected: send(command) -> Promise<answer text> (RCON), sleep(ms), log(line), clock.
// Depends on genesis/world (survey.js, plan.js, world_config.js) and genesis/tools/place_world.js.

import { createReader, probe, loadChunks, READ_ANSWERS, NATURAL_KIND, WORLD_TOP } from './survey.js';
import { levelZones, CAMP_LEVELLING } from './plan.js';
import { checkWorldConfig, describeProblem, worldHash } from './world_config.js';
import { moveWorld, landUsed } from '../tools/place_world.js';
import { OPERATOR } from './manifest.js';

export const SITE_RECORD_KIND = 'genesis.site.selection';
export const SITE_RECORD_FILE = 'site.selection.json';

// Proposed starting values, all of them.
export const SITE_DEFAULTS = Object.freeze({
    radius: 48,            // how far from the spawn the home point may lie, along x and along z
    step: 4,               // one column is read every this many blocks
    max_relief: 3,         // inside the camp, the field and the plots the land may differ this much from the floor
    min_floor_y: 63,       // the floor is never below this layer (the sea is at 62)
    verify: 3,             // how many of the best places are counted exactly
    max_commands: 25000,   // the hard limit on RCON commands for one selection
    load_tries: 90,        // readings while waiting for the chunks, one every load_wait_ms
    load_wait_ms: 1000,
    tree_reach: 48,        // trees are counted this far from the home point (the woodcutter's range)
});

export const SITE_REFUSALS = Object.freeze({
    wet: 'water, lava or ice at the surface inside the site',
    tree: 'a tree (leaves or logs) inside the camp, the field or a plot',
    unknown: 'a surface block this script does not know inside the camp, the field or a plot',
    steep: 'the land is not flat enough inside the camp, the field or a plot',
    low: 'the floor would lie below the lowest layer allowed',
    world_file: 'the world file for this place fails its checks',
});

class OverLimit extends Error {}

// The site as offsets from the home point: the zones the bootstrap levels, and the land the whole site uses.
export function siteLayout(example) {
    const [hx, , hz] = example.home;
    const land = landUsed(example);
    return {
        zones: levelZones(example).map((zone) => ({ id: zone.id, dy: zone.y - (example.home[1] - 1), min: [zone.min[0] - hx, zone.min[1] - hz], max: [zone.max[0] - hx, zone.max[1] - hz] })),
        land: { min: [land.min[0] - hx, land.min[1] - hz], max: [land.max[0] - hx, land.max[1] - hz] },
    };
}

const median = (values) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor((sorted.length - 1) / 2)]; };

// Scores every candidate from the scanned columns. Pure: no command is sent.
//   columns   Map("x,z" -> { y, kind, covers })   y: the layer of the ground
//   center    [x, z] the grid's origin (a column of the scan)
// Returns { passed: [candidate, best first], rejected: { reason: count }, total }.
//   candidate { home: [x, y, z], floor_y, score, estimate, relief, covers, trees_nearby, distance }
export function scoreSites({ columns, center, layout, options = {}, accept = () => true }) {
    const opts = { ...SITE_DEFAULTS, ...options };
    const step = opts.step;
    const reach = Math.floor(opts.radius / step);
    const inside = (box, hx, hz) => {
        const found = [];
        const x1 = Math.ceil((hx + box.min[0] - center[0]) / step);
        const x2 = Math.floor((hx + box.max[0] - center[0]) / step);
        const z1 = Math.ceil((hz + box.min[1] - center[1]) / step);
        const z2 = Math.floor((hz + box.max[1] - center[1]) / step);
        for (let i = x1; i <= x2; i++) {
            for (let j = z1; j <= z2; j++) found.push(columns.get(`${center[0] + i * step},${center[1] + j * step}`) ?? null);
        }
        return found;
    };
    const passed = [];
    const rejected = {};
    const refuse = (reason) => { rejected[reason] = (rejected[reason] ?? 0) + 1; };
    let total = 0;
    for (let i = -reach; i <= reach; i++) {
        for (let j = -reach; j <= reach; j++) {
            total++;
            const hx = center[0] + i * step;
            const hz = center[1] + j * step;
            const land = inside(layout.land, hx, hz);
            const zones = layout.zones.flatMap((zone) => inside(zone, hx, hz));
            if (land.some((column) => column?.kind === 'wet')) { refuse('wet'); continue; }
            if (zones.some((column) => column?.kind === 'tree')) { refuse('tree'); continue; }
            if (zones.length === 0 || zones.some((column) => column === null || column.kind !== 'ground')) { refuse('unknown'); continue; }
            const floor_y = median(zones.map((column) => column.y));
            if (floor_y < opts.min_floor_y) { refuse('low'); continue; }
            const relief = Math.max(...zones.map((column) => Math.abs(column.y - floor_y)));
            if (relief > opts.max_relief) { refuse('steep'); continue; }
            const home = [hx, floor_y + 1, hz];
            if (!accept(home)) { refuse('world_file'); continue; }
            const covers = zones.reduce((n, column) => n + column.covers, 0);
            const distance = Math.round(Math.hypot(hx - center[0], hz - center[1]));
            // the blocks the levelling would change, estimated: each sampled column stands for step * step columns
            const estimate = step * step * zones.reduce((n, column) => n + Math.abs(column.y - floor_y), 0) + Math.round(step * step * covers);
            let trees_nearby = 0;
            for (const [key, column] of columns) {
                if (column.kind !== 'tree') continue;
                const [x, z] = key.split(',').map(Number);
                if (Math.hypot(x - hx, z - hz) <= opts.tree_reach) trees_nearby++;
            }
            // fewest blocks to change first; of equals the nearer to the spawn, and one with trees in reach
            passed.push({ home, floor_y, score: estimate + distance / 4 + (trees_nearby === 0 ? 40 : 0), estimate, relief, covers, trees_nearby, distance });
        }
    }
    passed.sort((a, b) => a.score - b.score || a.distance - b.distance || a.home[0] - b.home[0] || a.home[2] - b.home[2]);
    return { passed, rejected, total };
}

// Picks the site. Never throws: resolves to
//   { ok, stage, problems, warnings, commands, world, record, candidates }
//     stage    where it ended: spawn | probe | load | scan | score | verify | done
//     world    the world file for the chosen site (null when none was chosen)
//     record   what goes into the manifest under "site" and into site.selection.json
export async function pickSite({
    send, example, seed, blueprints = null, options = {}, from = null, clock = { now: Date.now },
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), log = () => {},
} = {}) {
    const opts = { ...SITE_DEFAULTS, ...options };
    const result = { ok: false, stage: 'spawn', problems: [], warnings: [], commands: 0, world: null, record: null, candidates: null };
    const counted = async (command) => {
        // (giving the chunks back is never held up by the limit)
        if (result.commands >= opts.max_commands && !command.startsWith('forceload remove')) throw new OverLimit();
        result.commands++;
        return send(command);
    };
    const reader = createReader({ send: counted });
    const layout = siteLayout(example);
    const loaded = [];
    const stop = (problem) => { result.problems.push(problem); return result; };
    const release = async () => { for (const one of loaded.splice(0)) await one.release(); };

    try {
        // ---- 1. where the world spawn is ----
        let center = from;
        let spawn = { source: '--site-from', chunk: null };
        if (!center) {
            const answer = String(await counted('forceload query ~ ~') ?? '');
            const chunk = READ_ANSWERS.chunk(answer);
            if (!chunk) {
                return stop(`the server's answer to "forceload query ~ ~" was not understood: ${JSON.stringify(answer)}. Nothing was changed. `
                    + 'Say where to search instead: --site-from <x> <z> (any column near where the settlement may go).');
            }
            center = [chunk[0] * 16 + 8, chunk[1] * 16 + 8];
            spawn = { source: 'forceload query ~ ~', chunk };
        }
        log(`Site selection: searching ${opts.radius} blocks around ${center.join(', ')} (${spawn.chunk ? `the world spawn is in chunk ${spawn.chunk.join(', ')}` : 'given by hand'}).`);

        // ---- 2. the probe, on the column the search starts from ----
        result.stage = 'probe';
        const first = await loadChunks({ send: counted, reader, box: { min: center, max: center }, sleep, tries: opts.load_tries, wait_ms: opts.load_wait_ms, log });
        loaded.push(first);
        if (!first.ok) return stop(`${first.problem}. Nothing was changed.`);
        const probed = await probe(reader, center, { log });
        if (!probed.ok) return stop(probed.problem);
        log(`Probe passed: the server answers the reading commands as expected (${result.commands} commands so far).`);

        // ---- 3. the chunks of the search area ----
        result.stage = 'load';
        const reach = Math.floor(opts.radius / opts.step) * opts.step;
        const grid = (low, high) => { const out = []; for (let n = Math.ceil(low / opts.step); n <= Math.floor(high / opts.step); n++) out.push(n * opts.step); return out; };
        const xs = grid(-reach + layout.land.min[0], reach + layout.land.max[0]).map((dx) => center[0] + dx);
        const zs = grid(-reach + layout.land.min[1], reach + layout.land.max[1]).map((dz) => center[1] + dz);
        const area = { min: [xs[0], zs[0]], max: [xs.at(-1), zs.at(-1)] };
        const whole = await loadChunks({ send: counted, reader, box: area, sleep, tries: opts.load_tries, wait_ms: opts.load_wait_ms, log });
        loaded.push(whole);
        if (!whole.ok) return stop(`${whole.problem}. Nothing was changed.`);

        // ---- 4. the scan: back and forth, so every column starts from its neighbour's height ----
        result.stage = 'scan';
        const columns = new Map();
        const total = xs.length * zs.length;
        log(`Scanning ${total} columns (every ${opts.step} blocks from ${area.min.join(', ')} to ${area.max.join(', ')}).`);
        let guess = null;
        let done = 0;
        for (const [row, z] of zs.entries()) {
            for (const x of row % 2 === 0 ? xs : [...xs].reverse()) {
                const top = await reader.top([x, z], guess);
                if (top === null) { columns.set(`${x},${z}`, { top: null, y: null, name: null, kind: 'unknown', covers: 0 }); done++; continue; }
                guess = top;
                let y = top;
                let name = await reader.identify([x, y, z]);
                let covers = 0;
                // what grows or lies on the ground is not the ground: look under it (tall plants are two blocks)
                while (name !== null && NATURAL_KIND[name] === 'cover' && covers < 3 && y > -64) {
                    covers++;
                    y--;
                    name = await reader.identify([x, y, z]);
                }
                columns.set(`${x},${z}`, { top, y, name, kind: name === null ? 'unknown' : NATURAL_KIND[name], covers });
                if (++done % 200 === 0) log(`  scanned ${done} of ${total} columns, ${result.commands} commands`);
            }
        }
        log(`Scan done: ${total} columns, ${result.commands} commands.`);

        // ---- 5. the score ----
        result.stage = 'score';
        const accept = (home) => {
            const world = moveWorld(example, { x: home[0] - example.home[0], y: home[1] - example.home[1], z: home[2] - example.home[2] }, seed);
            return checkWorldConfig(world, { blueprints }).length === 0;
        };
        const scored = scoreSites({ columns, center, layout, options: opts, accept });
        result.candidates = { total: scored.total, passed: scored.passed.length, rejected: scored.rejected };
        const refused = Object.entries(scored.rejected).sort((a, b) => b[1] - a[1]).map(([reason, count]) => `${count} for ${SITE_REFUSALS[reason] ?? reason}`);
        if (scored.passed.length === 0) {
            return stop(`No place within ${opts.radius} blocks of ${center.join(', ')} passes: ${scored.total} places were looked at and all were refused (${refused.join('; ')}). `
                + `Nothing was changed. Search wider (--site-radius ${opts.radius * 2}), search elsewhere (--site-from <x> <z>), allow more relief (--site-relief ${opts.max_relief + 1}), `
                + 'or pick the place by hand: node genesis/tools/place_world.js --at <x> <y> <z> --seed <seed>.');
        }
        log(`${scored.passed.length} of ${scored.total} places pass${refused.length > 0 ? ` (refused: ${refused.join('; ')})` : ''}.`);

        // ---- 6. the best few, counted exactly ----
        result.stage = 'verify';
        const finalists = scored.passed.slice(0, Math.max(1, opts.verify));
        for (const place of finalists) {
            let to_clear = 0;
            let floor_holes = 0;
            for (const zone of layout.zones) {
                const floor = place.floor_y + zone.dy;
                const top = Math.min(WORLD_TOP, floor + CAMP_LEVELLING.clear_height);
                const [x1, z1] = [place.home[0] + zone.min[0], place.home[2] + zone.min[1]];
                const [x2, z2] = [place.home[0] + zone.max[0], place.home[2] + zone.max[1]];
                to_clear += await reader.count({ min: [x1, floor + 1, z1], max: [x2, top, z2] });
                floor_holes += (x2 - x1 + 1) * (z2 - z1 + 1) - await reader.count({ min: [x1, floor, z1], max: [x2, floor, z2] });
            }
            place.exact = { to_clear, floor_holes, changes: to_clear + floor_holes };
        }
        finalists.sort((a, b) => a.exact.changes - b.exact.changes || a.score - b.score);
        const chosen = finalists[0];

        // ---- the world file for it ----
        const world = moveWorld(example, { x: chosen.home[0] - example.home[0], y: chosen.home[1] - example.home[1], z: chosen.home[2] - example.home[2] }, seed);
        const world_problems = checkWorldConfig(world, { blueprints });
        if (world_problems.length > 0) return stop(`the world file for the chosen site fails its checks: ${world_problems.map(describeProblem).join('; ')}`);
        if (chosen.trees_nearby === 0) result.warnings.push(`No tree was seen within ${opts.tree_reach} blocks of the chosen home point: the agents gather wood near home.`);
        const land = landUsed(world);
        result.world = world;
        result.record = {
            v: 1, kind: SITE_RECORD_KIND, method: 'automatic', by: OPERATOR, at: new Date(clock.now()).toISOString(),
            world_sha256: worldHash(world), seed: world.seed,
            how: 'genesis/world/site.js read the land around the world spawn over RCON and chose the place where the levelling changes the fewest blocks',
            spawn: { ...spawn, center },
            search: { radius: opts.radius, step: opts.step, max_relief: opts.max_relief, min_floor_y: opts.min_floor_y, columns: total, area },
            commands: result.commands,
            candidates: result.candidates,
            refusals: Object.fromEntries(Object.keys(scored.rejected).map((reason) => [reason, SITE_REFUSALS[reason] ?? reason])),
            chosen: { ...chosen, land },
            runners_up: finalists.slice(1),
            unknown_block_names: probed.dropped,
        };
        result.stage = 'done';
        result.ok = true;
        return result;
    } catch (err) {
        if (err instanceof OverLimit) {
            return stop(`the site selection stopped at its limit of ${opts.max_commands} commands (stage "${result.stage}"). Nothing was changed. `
                + 'Search a smaller area (--site-radius), read fewer columns (--site-step), or pick the place by hand.');
        }
        return stop(`the server could not be asked (${err?.message ?? err}). Nothing was changed.`);
    } finally {
        // however it ended: the chunks force-loaded for the selection are given back
        await release().catch(() => {});
    }
}

// What the selection found, as lines for the operator.
export function siteReportLines(result, { dry_run = false } = {}) {
    const lines = [];
    if (!result.ok) {
        lines.push(`Site selection FAILED at stage "${result.stage}" after ${result.commands} commands.`);
        for (const problem of result.problems) lines.push(`PROBLEM: ${problem}`);
        return lines;
    }
    const chosen = result.record.chosen;
    lines.push(`Site selection PASSED: ${result.commands} commands, ${result.candidates.passed} of ${result.candidates.total} places pass.`);
    lines.push(`Chosen: home ${chosen.home.join(', ')} (the floor is layer y=${chosen.floor_y}), ${chosen.distance} blocks from the spawn.`);
    lines.push(`  land used: x=${chosen.land.min[0]}, z=${chosen.land.min[1]} to x=${chosen.land.max[0]}, z=${chosen.land.max[1]}`);
    lines.push(`  levelling, counted exactly: ${chosen.exact.to_clear} blocks to clear above the floor, ${chosen.exact.floor_holes} holes in the floor layer`);
    lines.push(`  from the samples: estimate ${chosen.estimate}, relief ${chosen.relief}, score ${chosen.score.toFixed(1)}, trees seen within reach: ${chosen.trees_nearby}`);
    for (const other of result.record.runners_up) {
        lines.push(`Runner-up: home ${other.home.join(', ')}: ${other.exact.changes} blocks to change (chosen: ${chosen.exact.changes}), score ${other.score.toFixed(1)}`);
    }
    for (const [reason, count] of Object.entries(result.candidates.rejected)) lines.push(`Refused: ${count} places, ${SITE_REFUSALS[reason] ?? reason}`);
    for (const warning of result.warnings) lines.push(`WARNING: ${warning}`);
    if (dry_run) lines.push('Dry run (--pick-site): nothing was written and nothing was changed.');
    return lines;
}
