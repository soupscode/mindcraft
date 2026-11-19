// Genesis: writes a world file (genesis.world.json) from the example, moved to the spot the
// operator picked in his own world (by hand: the bootstrap does the same for the site it picks). The example (genesis/genesis.world.example.json) lays the
// camp, the field and the plots out around the home point 0, 64, 0; this moves every
// coordinate by the same amount, sets the seed, and checks the result with the same checks the
// bootstrap and the launcher run. Nothing is sent to any server.
//
//   node genesis/tools/place_world.js --at <x> <y> <z> --seed <seed>
//       x y z   where you stand, feet on the ground, in the middle of flat land: the "Block:" line
//               of the F3 screen. The ground under your feet becomes the camp's floor.
//       seed    the server's level-seed (a whole number)
//   options:  --out <file>      default GENESIS_WORLD_FILE, else ./genesis/genesis.world.json
//             --example <file>  default ./genesis/genesis.world.example.json
//             --force           replace a world file that is already there
//
// This is the MANUAL OVERRIDE: without a world file the bootstrap picks the site itself
// (genesis/world/site.js). The land it needs, seen from that spot: about 35 blocks west, 46 east,
// 31 north and 30 south (printed exactly at the end). The bootstrap levels the camp, the field and
// the plots; the land between them is used as it lies.
//
// Depends only on Node built-ins and genesis/world/world_config.js.

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkWorldConfig, describeProblem } from '../world/world_config.js';

const moved3 = (pos, d) => [pos[0] + d.x, pos[1] + d.y, pos[2] + d.z];
const moved2 = (pos, d) => [pos[0] + d.x, pos[1] + d.z];

// The example's world moved by d = { x, y, z }, with the given seed. Returns a new object.
export function moveWorld(example, d, seed = example.seed) {
    const world = JSON.parse(JSON.stringify(example));
    world.seed = String(seed);
    world.home = moved3(world.home, d);
    world.border.center = moved2(world.border.center, d);
    const camp = world.camp;
    camp.min = moved2(camp.min, d);
    camp.max = moved2(camp.max, d);
    for (const key of ['shared_chest_second_half', 'crafting_table', 'furnace']) camp[key] = moved3(camp[key], d);
    for (const bed of camp.beds) bed.foot = moved3(bed.foot, d);
    const field = world.field;
    field.min = moved2(field.min, d);
    field.max = moved2(field.max, d);
    field.y += d.y;
    field.water = field.water.map((cell) => moved2(cell, d));
    for (const plot of world.plots) {
        plot.min = moved3(plot.min, d);
        plot.max = moved3(plot.max, d);
    }
    for (const name of Object.keys(world.chests)) world.chests[name] = moved3(world.chests[name], d);
    for (const agent of Object.values(world.agents)) agent.home = moved3(agent.home, d);
    return world;
}

// The flat land the world file uses: { min: [x, z], max: [x, z] } over the camp, the field and the plots.
export function landUsed(world) {
    const corners = [world.camp.min, world.camp.max, world.field.min, world.field.max,
        ...world.plots.flatMap((plot) => [[plot.min[0], plot.min[2]], [plot.max[0], plot.max[2]]])];
    return {
        min: [Math.min(...corners.map((c) => c[0])), Math.min(...corners.map((c) => c[1]))],
        max: [Math.max(...corners.map((c) => c[0])), Math.max(...corners.map((c) => c[1]))],
    };
}

async function main(argv) {
    const { readFileSync, writeFileSync, existsSync } = await import('node:fs');
    const { fileBlueprints } = await import('../catalog/blueprints.js');
    const repo_root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    process.chdir(repo_root);
    const option = (name, count = 1) => {
        const at = argv.indexOf(name);
        return at >= 0 && at + count < argv.length ? argv.slice(at + 1, at + 1 + count) : null;
    };
    const at = option('--at', 3)?.map(Number);
    const seed = option('--seed')?.[0];
    if (!at || !at.every(Number.isInteger) || !seed || !/^-?\d+$/.test(seed)) {
        console.error('Usage: node genesis/tools/place_world.js --at <x> <y> <z> --seed <seed>   (whole numbers; x y z from the "Block:" line of F3)');
        return 1;
    }
    const example_file = option('--example')?.[0] ?? './genesis/genesis.world.example.json';
    const out_file = option('--out')?.[0] ?? process.env.GENESIS_WORLD_FILE ?? './genesis/genesis.world.json';
    if (existsSync(out_file) && !argv.includes('--force')) {
        console.error(`${out_file} is already there. Nothing was written. Add --force to replace it.`);
        return 1;
    }
    const example = JSON.parse(readFileSync(example_file, 'utf8'));
    const d = { x: at[0] - example.home[0], y: at[1] - example.home[1], z: at[2] - example.home[2] };
    const world = moveWorld(example, d, seed);
    const problems = checkWorldConfig(world, { blueprints: fileBlueprints() });
    if (problems.length > 0) {
        for (const problem of problems) console.error(`World file problem: ${describeProblem(problem)}`);
        console.error('Nothing was written.');
        return 1;
    }
    writeFileSync(out_file, `${JSON.stringify(world, null, 4)}\n`);
    const land = landUsed(world);
    console.log(`Wrote ${out_file}: home ${world.home.join(', ')}, seed ${world.seed}.`);
    console.log(`The camp's floor is layer y=${world.home[1] - 1}. Flat land is needed from x=${land.min[0]}, z=${land.min[1]} to x=${land.max[0]}, z=${land.max[1]}.`);
    console.log('Next: node genesis/world/bootstrap.js --validate');
    return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    main(process.argv.slice(2)).then((code) => process.exit(code), (err) => { console.error(err); process.exit(1); });
}
