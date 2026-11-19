// Genesis building: the prefab format. It extends what genesis/catalog/blueprints.js reads
// ({ name, blocks[y][z][x] }) with optional fields a reader may ignore, so a prefab is also
// a blueprint the existing build template can be handed.
//
//   {
//     "v": 1,
//     "name": "cabin",                       matches ^[A-Za-z0-9_-]+$ (it becomes a file name)
//     "title": "Cabin",
//     "kind": "home",                        home | shared | bridge
//     "tier": 2,
//     "by": "Generated",                     Generated | Operator
//     "size": { "x": 7, "y": 5, "z": 7 },
//     "blocks": [[["cobblestone", ...]]],    blocks[y][z][x]: EXACT Minecraft block names (1.21.6), which for
//                                            everything a prefab may hold are also the item names.
//                                            "" = leave the cell alone, "air" = keep it clear
//     "below": 1,                            layers that lie under the plot's ground level (a floor set into the
//                                            ground). 0 when left out. Layer `below` stands on the ground.
//     "parts": { "oak_door": 2 },            cells one item fills (a door is two cells and one item)
//     "stages": [ { "name": "Foundation", "y": [0, 0] }, { "name": "Walls", "y": [1, 3] }, { "name": "Roof", "y": [4, 4] },
//                 { "name": "Fittings", "blocks": ["oak_door", "glass", "torch", "chest", "crafting_table"] } ],
//                                            a cell belongs to the stage that names its block, else to the stage whose
//                                            layers hold it. Stages are built in order.
//     "materials": { "cobblestone": 49 },    recomputed at load: a file whose bill does not match its blocks is refused
//     "keeps": [ { "block": "chest", "at": [1, 1, 1] } ],   cells an upgrade never breaks ([x, y, z] in the prefab)
//     "bed": { "head": [1, 1, 2], "foot": [1, 1, 3] },      home prefabs: the two clear cells kept for the owner's bed
//     "upgrade_of": "shack",
//     "source": { "file": "clock_tower.schem", "sha256": "...", "converted_at": "..." }     Operator prefabs only
//   }
//
// Build order: stage by stage; inside a stage layer by layer from the bottom, row by row,
// column by column. checkPrefab() refuses a prefab in which a cell would have to be placed
// against nothing in that order.
//
// Folders: genesis/prefabs/ (generated, in the repository) and
// bots/genesis_prefabs/operator/ (converted from the operator's schematics, on the VM).
//
// Depends only on Node built-ins.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

export const PREFAB_VERSION = 1;
export const PREFAB_KINDS = Object.freeze(['home', 'shared', 'bridge']);
export const PREFAB_BY = Object.freeze(['Generated', 'Operator']);
export const PREFAB_DIR = './genesis/prefabs';
export const OPERATOR_PREFAB_DIR = './bots/genesis_prefabs/operator';
export const PREFAB_NAME = /^[A-Za-z0-9_-]+$/;
const BLOCK_NAME = /^[a-z0-9_]{1,60}$/;

const isPlaced = (want) => typeof want === 'string' && want !== '' && want !== 'air';

// How many cells one item of this block fills.
export function partsOf(block, parts = {}) {
    if (Number.isInteger(parts[block]) && parts[block] > 0) return parts[block];
    if (block.endsWith('_door') || block.endsWith('_bed')) return 2;
    return 1;
}

// Blocks a GENERATED prefab may not hold until their placement is verified on a real server:
// the bot cannot control which way they face (upstream's placeBlock).
export const needsFacing = (block) => block.endsWith('_bed') || block.endsWith('_stairs') || block === 'wall_torch' || block.endsWith('_wall_torch');

export function prefabSize(prefab) {
    const layers = Array.isArray(prefab?.blocks) ? prefab.blocks : [];
    let x = 0;
    let z = 0;
    for (const layer of layers) {
        if (!Array.isArray(layer)) continue;
        z = Math.max(z, layer.length);
        for (const row of layer) if (Array.isArray(row)) x = Math.max(x, row.length);
    }
    return { x, y: layers.length, z };
}

export function stagesOf(prefab) {
    if (Array.isArray(prefab.stages) && prefab.stages.length > 0) return prefab.stages;
    return [{ name: 'Build', y: [0, Math.max(0, prefabSize(prefab).y - 1)] }];
}

// The index of the stage a cell belongs to, or -1.
export function stageIndex(stages, y, want) {
    const named = stages.findIndex((stage) => Array.isArray(stage.blocks) && stage.blocks.includes(want));
    if (named >= 0) return named;
    return stages.findIndex((stage) => Array.isArray(stage.y) && y >= stage.y[0] && y <= stage.y[1]);
}

// Every cell that is to hold a block, IN BUILD ORDER: [{ x, y, z, want, stage }] (prefab coordinates).
export function prefabCells(prefab) {
    const stages = stagesOf(prefab);
    const cells = [];
    prefab.blocks.forEach((layer, y) => layer.forEach((row, z) => row.forEach((want, x) => {
        if (isPlaced(want)) cells.push({ x, y, z, want, stage: stageIndex(stages, y, want) });
    })));
    return cells.sort((a, b) => a.stage - b.stage || a.y - b.y || a.z - b.z || a.x - b.x);
}

// The cells to keep clear: [{ x, y, z }].
export function clearCells(prefab) {
    const cells = [];
    prefab.blocks.forEach((layer, y) => layer.forEach((row, z) => row.forEach((want, x) => { if (want === 'air') cells.push({ x, y, z }); })));
    return cells;
}

// { item: count } for a list of cells: a block of several cells is one item.
export function billOfCells(cells, parts = {}) {
    const counts = {};
    for (const cell of cells) counts[cell.want] = (counts[cell.want] ?? 0) + 1;
    const bill = {};
    for (const block of Object.keys(counts).sort()) bill[block] = Math.ceil(counts[block] / partsOf(block, parts));
    return bill;
}

// { cells, materials } for the whole prefab.
export function billOf(prefab) {
    const cells = prefabCells(prefab);
    return { cells: cells.length, materials: billOfCells(cells, prefab.parts) };
}

// The per-stage material list, in build order: [{ name, index, cells, materials }].
export function stageBills(prefab) {
    const cells = prefabCells(prefab);
    return stagesOf(prefab).map((stage, index) => {
        const mine = cells.filter((cell) => cell.stage === index);
        return { name: stage.name, index, cells: mine.length, materials: billOfCells(mine, prefab.parts) };
    });
}

// How many cells would be placed against nothing, in build order. A cell is supported when it
// lies in or on the ground (layer `below` or lower) or touches a cell placed before it.
export function floatingCells(prefab) {
    const below = prefab.below ?? 0;
    const placed = new Set();
    const key = (x, y, z) => `${x},${y},${z}`;
    const floating = [];
    for (const cell of prefabCells(prefab)) {
        const supported = cell.y <= below || [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
            .some(([dx, dy, dz]) => placed.has(key(cell.x + dx, cell.y + dy, cell.z + dz)));
        if (!supported) floating.push(cell);
        placed.add(key(cell.x, cell.y, cell.z));
    }
    return floating;
}

const sameBill = (a, b) => {
    const keys = [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])];
    return keys.every((key) => (a?.[key] ?? 0) === (b?.[key] ?? 0));
};

// Everything that is wrong with a prefab: [] when it holds.
//   obtainable(item) -> boolean   can the catalog get this item (catalogObtainable below); left out: not checked
export function checkPrefab(prefab, { obtainable = null } = {}) {
    const problems = [];
    if (prefab === null || typeof prefab !== 'object') return ['a prefab must be an object'];
    if (!PREFAB_NAME.test(String(prefab.name ?? ''))) problems.push('name must match ^[A-Za-z0-9_-]+$');
    if (prefab.v !== PREFAB_VERSION) problems.push(`v must be ${PREFAB_VERSION}`);
    if (!PREFAB_KINDS.includes(prefab.kind)) problems.push(`kind must be one of ${PREFAB_KINDS.join(', ')}`);
    if (!PREFAB_BY.includes(prefab.by)) problems.push(`by must be one of ${PREFAB_BY.join(', ')}`);
    if (!Number.isInteger(prefab.tier) || prefab.tier < 0) problems.push('tier must be a whole number, 0 or more');
    if (!Array.isArray(prefab.blocks) || prefab.blocks.length === 0) return [...problems, 'blocks must be a list of layers'];
    const size = prefabSize(prefab);
    let ragged = false;
    const names = new Set();
    for (const layer of prefab.blocks) {
        if (!Array.isArray(layer) || layer.length !== size.z) { ragged = true; continue; }
        for (const row of layer) {
            if (!Array.isArray(row) || row.length !== size.x) { ragged = true; continue; }
            for (const want of row) {
                if (typeof want !== 'string') problems.push('every cell must be a block name, "" or "air"');
                else if (isPlaced(want)) names.add(want);
            }
        }
    }
    if (ragged) problems.push('every layer must have the same number of rows and every row the same length');
    if (problems.length > 0) return [...new Set(problems)];
    if (prefab.size && (prefab.size.x !== size.x || prefab.size.y !== size.y || prefab.size.z !== size.z)) problems.push(`size says ${prefab.size.x} x ${prefab.size.y} x ${prefab.size.z}, the blocks are ${size.x} x ${size.y} x ${size.z}`);
    for (const name of names) if (!BLOCK_NAME.test(name)) problems.push(`"${name}" is not a block name`);
    const below = prefab.below ?? 0;
    if (!Number.isInteger(below) || below < 0 || below >= size.y) problems.push('below must be a whole number of layers, fewer than the prefab has');
    const cells = prefabCells(prefab);
    if (cells.length === 0) problems.push('the prefab places nothing');
    const unstaged = cells.filter((cell) => cell.stage < 0).length;
    if (unstaged > 0) problems.push(`${unstaged} cells belong to no stage`);
    const bill = billOfCells(cells, prefab.parts);
    if (prefab.materials && !sameBill(prefab.materials, bill)) problems.push('materials do not match the blocks');
    const floating = floatingCells(prefab);
    if (floating.length > 0) problems.push(`${floating.length} cells would be placed against nothing in build order (first: ${floating[0].want} at ${floating[0].x},${floating[0].y},${floating[0].z})`);
    // a torch stands on something
    for (const cell of cells) {
        if (cell.want !== 'torch') continue;
        const under = cell.y > 0 ? prefab.blocks[cell.y - 1][cell.z][cell.x] : null;
        if (!(cell.y <= below ? (under === null || under === '' || isPlaced(under)) : isPlaced(under))) problems.push(`the torch at ${cell.x},${cell.y},${cell.z} stands on nothing`);
    }
    if (prefab.by === 'Generated') {
        for (const name of names) if (needsFacing(name)) problems.push(`${name} is not allowed in a generated prefab until its placement is verified on a real server`);
    }
    for (const keep of prefab.keeps ?? []) {
        const [x, y, z] = keep.at ?? [];
        if (prefab.blocks[y]?.[z]?.[x] !== keep.block) problems.push(`keeps names ${keep.block} at ${keep.at}, the blocks have ${JSON.stringify(prefab.blocks[y]?.[z]?.[x])}`);
    }
    for (const where of prefab.bed ? [prefab.bed.head, prefab.bed.foot] : []) {
        const [x, y, z] = where ?? [];
        if (prefab.blocks[y]?.[z]?.[x] !== 'air') problems.push(`the bed place ${where} is not a clear cell`);
    }
    if (typeof obtainable === 'function') {
        const missing = [...names].filter((name) => !obtainable(name)).sort();
        if (missing.length > 0) problems.push(`not buildable yet: the catalog cannot obtain ${missing.join(', ')}`);
    }
    return problems;
}

// The blocks of a prefab the catalog cannot obtain: [] when it is buildable.
export function unobtainable(prefab, obtainable) {
    return [...new Set(prefabCells(prefab).map((cell) => cell.want))].filter((name) => !obtainable(name)).sort();
}

// The same prefab turned a quarter turn at a time about the vertical axis (0, 90, 180 or 270 degrees, clockwise seen
// from above): a span that runs east-west is the footbridge turned by 90. Names only: which way a block faces is
// not in a prefab. keeps and the bed place turn with it.
export function rotatePrefab(prefab, degrees = 0) {
    const turns = ((Math.round(degrees / 90) % 4) + 4) % 4;
    if (turns === 0) return prefab;
    let out = prefab;
    for (let turn = 0; turn < turns; turn++) {
        const size = prefabSize(out);
        // (x, z) -> (size.z - 1 - z, x)
        const point = ([x, y, z]) => [size.z - 1 - z, y, x];
        const blocks = out.blocks.map((layer) => Array.from({ length: size.x }, (_, nz) => Array.from({ length: size.z }, (_, nx) => layer[size.z - 1 - nx][nz])));
        out = {
            ...out, blocks, size: { x: size.z, y: size.y, z: size.x },
            ...(out.keeps ? { keeps: out.keeps.map((keep) => ({ ...keep, at: point(keep.at) })) } : {}),
            ...(out.bed ? { bed: { head: point(out.bed.head), foot: point(out.bed.foot) } } : {}),
        };
    }
    return { ...out, rotation: turns * 90 };
}

// The file text of a prefab: one key a line, one row of blocks a line, so a change to a
// prefab reads as a change to the rows it touches.
export function prefabText(prefab) {
    const lines = Object.entries(prefab).map(([key, value]) => {
        if (key !== 'blocks') return `  ${JSON.stringify(key)}: ${JSON.stringify(value)}`;
        const layers = value.map((layer) => `    [\n${layer.map((row) => `      ${JSON.stringify(row)}`).join(',\n')}\n    ]`);
        return `  "blocks": [\n${layers.join(',\n')}\n  ]`;
    });
    return `{\n${lines.join(',\n')}\n}\n`;
}

// sha256 of the blocks: what a build row stores, so a changed prefab is noticed.
export function prefabHash(prefab) {
    return createHash('sha256').update(JSON.stringify({ blocks: prefab.blocks, below: prefab.below ?? 0 })).digest('hex');
}

// What smelting gives for the things the catalog gathers (smelt_item takes whatever the agent holds that smelts).
export const SMELTED = Object.freeze({ sand: 'glass', raw_iron: 'iron_ingot', cobblestone: 'stone', clay_ball: 'brick' });

// obtainable(item) from the catalog's tables (genesis/catalog/defaults.js): what it gathers,
// crafts, farms, and what smelting those gives.
export function catalogObtainable({ gather_types, craft_items, crops, smelted = SMELTED }) {
    const items = new Set([
        ...Object.values(gather_types).flatMap((type) => type.drops),
        ...craft_items.map(([item]) => item),
        ...Object.values(crops).flatMap((crop) => [crop.seed, crop.produce].filter(Boolean)),
    ]);
    for (const [from, to] of Object.entries(smelted)) if (items.has(from)) items.add(to);
    return (item) => items.has(item);
}

// The prefabs of one or more folders, with the interface the catalog's blueprints have
// ({ get(name), names() }): a prefab can be handed to the build template as a blueprint.
// A file that does not hold (checkPrefab) is not given out; problems(name) says why.
export function filePrefabs(dirs = [PREFAB_DIR, OPERATOR_PREFAB_DIR]) {
    const folders = Array.isArray(dirs) ? dirs : [dirs];
    const cache = new Map();
    function load(name) {
        if (!PREFAB_NAME.test(String(name))) return { prefab: null, problems: ['bad name'] };
        for (const dir of folders) {
            let parsed;
            try { parsed = JSON.parse(readFileSync(path.join(dir, `${name}.json`), 'utf8')); } catch { continue; }
            const problems = checkPrefab(parsed);
            if (problems.length > 0) return { prefab: null, problems };
            const bill = billOf(parsed);
            return { prefab: { ...parsed, size: prefabSize(parsed), cells: bill.cells, materials: bill.materials }, problems: [] };
        }
        return { prefab: null, problems: ['no such prefab'] };
    }
    // (a name that is not there is looked for again next time: the operator may upload it while the agents run)
    const entry = (name) => {
        if (cache.has(name)) return cache.get(name);
        const loaded = load(name);
        if (loaded.prefab !== null) cache.set(name, loaded);
        return loaded;
    };
    return {
        get: (name) => entry(name).prefab,
        problems: (name) => entry(name).problems,
        names() {
            const found = new Set();
            for (const dir of folders) {
                try { for (const file of readdirSync(dir)) if (file.endsWith('.json')) found.add(file.slice(0, -5)); } catch { /* no such folder */ }
            }
            return [...found].sort();
        },
    };
}
