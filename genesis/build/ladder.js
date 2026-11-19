// Genesis building: the generator of the first prefab ladder. Eight prefabs from two
// parametric builders (a box house and a span), so the files in genesis/prefabs/ can be
// made again at any time:  node genesis/tools/make_prefabs.js
//
//   tier  name        kind    x by z by y    cells   bill
//   0     lean_to     home    5 x 3 x 3        34    33 oak_planks, 1 chest
//   1     shack       home    5 x 5 x 4        75    59 oak_planks, 12 oak_log, 1 oak_door, 1 chest, 1 torch
//   1     footbridge  bridge  3 x 9 x 2        45    27 oak_planks, 14 oak_fence, 4 oak_log     (length 5 to 15: footbridge(length))
//   2     cabin       home    7 x 7 x 5       174    49 cobblestone, 54 oak_planks, 49 oak_slab, 12 oak_log, 4 glass, 1 oak_door, 1 chest, 1 crafting_table, 2 torch
//   3     cottage     home    9 x 7 x 6       244    86 cobblestone, 65 oak_planks, 63 oak_slab, 16 oak_log, 6 glass, 1 oak_door, 1 chest, 1 furnace, 1 crafting_table, 3 torch
//   3     storehouse  shared  9 x 7 x 5       220    133 cobblestone, 63 oak_planks, 12 oak_log, 6 chest, 1 oak_door, 4 torch
//   4     house       home    11 x 9 x 8      490    130 cobblestone, 209 oak_planks, 99 oak_slab, 24 oak_log, 12 glass, 4 ladder, 1 oak_door, 2 chest, 1 furnace, 1 crafting_table, 6 torch
//   4     hall        shared  15 x 11 x 7     602    237 cobblestone, 267 oak_planks, 70 oak_log, 12 glass, 2 oak_door, 2 chest, 1 furnace, 1 crafting_table, 8 torch
// (the sizes, cell counts and bills of the plan's section 3.3; genesis/tests/build.test.js holds them to it)
//
// Every name is an exact Minecraft 1.21.6 block name that is also the item's name. No bed,
// stair or wall torch: the bot cannot control which way they face.
//
// HOMES (decided: an agent lives in its finished home, with its own bed and a personal chest)
//   Every home tier has its chest at the same cell of the plot (one in from the corner, on the
//   floor) and its door on the same side, so an upgrade never breaks the chest: `keeps`.
//   Tiers with a stone floor set that floor INTO the ground (`below: 1`), which is what keeps
//   the chest's cell the same from the floorless tiers to the floored ones.
//   Every home tier keeps two clear floor cells for the owner's bed: `bed`. The bed itself is
//   not a cell of the prefab (it would need its facing verified, and wool the catalog cannot
//   get yet): it is furniture placed after the build is verified. See the open decision in the report.
//
// Depends only on genesis/build/prefab.js.

import { billOf, prefabSize, PREFAB_VERSION } from './prefab.js';

const grid = (w, d, h) => Array.from({ length: h }, () => Array.from({ length: d }, () => Array(w).fill('')));
const set = (b, x, y, z, v) => { b[y][z][x] = v; };
function fillLayer(b, y, v, x0 = 0, z0 = 0, x1 = b[0][0].length - 1, z1 = b[0].length - 1) {
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) set(b, x, y, z, v);
}
// One layer of wall: the edge of the box, with its own block at the four corners, and the inside kept clear.
function ring(b, y, v, corner = v) {
    const w = b[0][0].length;
    const d = b[0].length;
    for (let z = 0; z < d; z++) {
        for (let x = 0; x < w; x++) {
            const ex = x === 0 || x === w - 1;
            const ez = z === 0 || z === d - 1;
            if (ex || ez) set(b, x, y, z, ex && ez ? corner : v);
            else if (b[y][z][x] === '') set(b, x, y, z, 'air');
        }
    }
}

// A box house. floor: the block of a floor layer under the walls (or null); walls: the wall block per
// layer from the bottom (the last repeats); roof_y: the layer of the flat roof; door: 1 or 2 doors wide,
// in the middle of the z = depth - 1 side; upper: a second floor with a ladder up to it.
function house({ w, d, floor = null, walls, corner = 'oak_log', roof, roof_y, door = 1, windows = [], fittings = [], upper = null, posts = [] }) {
    const b = grid(w, d, roof_y + 1);
    const base = floor ? 1 : 0;
    if (floor) fillLayer(b, 0, floor);
    for (let y = base; y < roof_y; y++) ring(b, y, walls[Math.min(y - base, walls.length - 1)], corner);
    for (const [x, z] of posts) for (let y = base; y < roof_y; y++) set(b, x, y, z, corner);
    if (upper) {
        fillLayer(b, upper.y, upper.block, 1, 1, w - 2, d - 2);
        for (let y = base; y <= upper.y; y++) set(b, upper.ladder_x, y, 1, 'ladder');     // against the back wall, up through the floor
    }
    fillLayer(b, roof_y, roof);
    const mid = Math.floor(w / 2);
    for (let dx = 0; dx < door; dx++) { set(b, mid + dx, base, d - 1, 'oak_door'); set(b, mid + dx, base + 1, d - 1, 'oak_door'); }
    for (const [x, y, z] of windows) set(b, x, y, z, 'glass');
    for (const [x, y, z, v] of fittings) set(b, x, y, z, v);
    return b;
}

const FITTINGS = ['oak_door', 'glass', 'torch', 'chest', 'crafting_table', 'furnace'];
const fittingsOf = (blocks) => { const used = new Set(blocks.flat(2)); return FITTINGS.filter((name) => used.has(name)); };

function finish({ name, title, kind, tier, blocks, below = 0, stages, upgrade_of = null, keeps = [], bed = null }) {
    const prefab = { v: PREFAB_VERSION, name, title, kind, tier, by: 'Generated', size: null, below, blocks, parts: { oak_door: 2 }, stages, materials: null, keeps };
    if (bed) prefab.bed = bed;
    if (upgrade_of) prefab.upgrade_of = upgrade_of;
    prefab.size = prefabSize(prefab);
    prefab.materials = billOf(prefab).materials;
    return prefab;
}

// The stages of a box house: Foundation (when it has a floor), Walls, Roof, Fittings.
function houseStages(blocks, has_floor) {
    const top = blocks.length - 1;
    const stages = [];
    if (has_floor) stages.push({ name: 'Foundation', y: [0, 0] });
    stages.push({ name: 'Walls', y: [has_floor ? 1 : 0, top - 1] }, { name: 'Roof', y: [top, top] }, { name: 'Fittings', blocks: fittingsOf(blocks) });
    return stages;
}

function leanTo() {
    // back and side walls two high, a flat roof, the front open
    const b = grid(5, 3, 3);
    for (let y = 0; y < 2; y++) {
        for (let x = 0; x < 5; x++) set(b, x, y, 0, 'oak_planks');
        for (let z = 1; z < 3; z++) { set(b, 0, y, z, 'oak_planks'); set(b, 4, y, z, 'oak_planks'); }
        for (let z = 1; z < 3; z++) for (let x = 1; x < 4; x++) set(b, x, y, z, 'air');
    }
    fillLayer(b, 2, 'oak_planks');
    set(b, 1, 0, 1, 'chest');
    return finish({ name: 'lean_to', title: 'Lean-to', kind: 'home', tier: 0, blocks: b, stages: [{ name: 'Walls', y: [0, 1] }, { name: 'Roof', y: [2, 2] }, { name: 'Fittings', blocks: ['chest'] }],
        keeps: [{ block: 'chest', at: [1, 0, 1] }], bed: { head: [3, 0, 1], foot: [2, 0, 1] } });
}

function home({ name, title, tier, upgrade_of, spec }) {
    const blocks = house(spec);
    const has_floor = Boolean(spec.floor);
    const base = has_floor ? 1 : 0;
    return finish({ name, title, kind: 'home', tier, blocks, below: base, stages: houseStages(blocks, has_floor), upgrade_of,
        keeps: [{ block: 'chest', at: [1, base, 1] }], bed: { head: [1, base, 2], foot: [1, base, 3] } });
}

// A footbridge: a plank deck three wide, fence rails, log posts at both ends. Length 5 to 15.
export function footbridge(length = 9) {
    if (!Number.isInteger(length) || length < 5 || length > 15) throw new Error('a footbridge is 5 to 15 long');
    const b = grid(3, length, 2);
    fillLayer(b, 0, 'oak_planks');
    for (let z = 0; z < length; z++) { set(b, 0, 1, z, 'oak_fence'); set(b, 2, 1, z, 'oak_fence'); set(b, 1, 1, z, 'air'); }
    for (const z of [0, length - 1]) { set(b, 0, 1, z, 'oak_log'); set(b, 2, 1, z, 'oak_log'); }
    return finish({ name: length === 9 ? 'footbridge' : `footbridge_${length}`, title: 'Footbridge', kind: 'bridge', tier: 1, blocks: b, below: 1,
        stages: [{ name: 'Deck', y: [0, 0] }, { name: 'Rails', y: [1, 1] }] });
}

// The eight prefabs of the first ladder, lowest tier first.
export function generateLadder() {
    const shack = home({ name: 'shack', title: 'Shack', tier: 1, upgrade_of: 'lean_to', spec: {
        w: 5, d: 5, walls: ['oak_planks'], roof: 'oak_planks', roof_y: 3, fittings: [[1, 0, 1, 'chest'], [3, 0, 1, 'torch']] } });
    const cabin = home({ name: 'cabin', title: 'Cabin', tier: 2, upgrade_of: 'shack', spec: {
        w: 7, d: 7, floor: 'cobblestone', walls: ['oak_planks'], roof: 'oak_slab', roof_y: 4,
        windows: [[0, 2, 3], [6, 2, 3], [2, 2, 0], [4, 2, 0]],
        fittings: [[1, 1, 1, 'chest'], [5, 1, 1, 'crafting_table'], [1, 1, 5, 'torch'], [5, 1, 5, 'torch']] } });
    const cottage = home({ name: 'cottage', title: 'Cottage', tier: 3, upgrade_of: 'cabin', spec: {
        w: 9, d: 7, floor: 'cobblestone', walls: ['cobblestone', 'oak_planks'], roof: 'oak_slab', roof_y: 5,
        windows: [[0, 3, 2], [0, 3, 4], [8, 3, 2], [8, 3, 4], [2, 3, 0], [6, 3, 0]],
        fittings: [[1, 1, 1, 'chest'], [7, 1, 1, 'furnace'], [6, 1, 1, 'crafting_table'], [1, 1, 5, 'torch'], [7, 1, 5, 'torch'], [4, 1, 1, 'torch']] } });
    const big = home({ name: 'house', title: 'House', tier: 4, upgrade_of: 'cottage', spec: {
        w: 11, d: 9, floor: 'cobblestone', walls: ['cobblestone', 'oak_planks'], roof: 'oak_slab', roof_y: 7, upper: { y: 4, block: 'oak_planks', ladder_x: 9 },
        windows: [[0, 2, 2], [0, 2, 6], [10, 2, 2], [10, 2, 6], [3, 2, 0], [7, 2, 0], [0, 6, 4], [10, 6, 4], [3, 6, 0], [7, 6, 0], [3, 6, 8], [7, 6, 8]],
        fittings: [[1, 1, 1, 'chest'], [1, 5, 1, 'chest'], [8, 1, 1, 'furnace'], [7, 1, 1, 'crafting_table'],
            [1, 1, 7, 'torch'], [9, 1, 7, 'torch'], [5, 1, 1, 'torch'], [9, 5, 7, 'torch'], [1, 5, 7, 'torch'], [5, 5, 4, 'torch']] } });

    const store_blocks = house({ w: 9, d: 7, floor: 'cobblestone', walls: ['cobblestone'], roof: 'oak_planks', roof_y: 4,
        fittings: [[1, 1, 1, 'chest'], [3, 1, 1, 'chest'], [5, 1, 1, 'chest'], [7, 1, 1, 'chest'], [1, 1, 3, 'chest'], [7, 1, 3, 'chest'],
            [1, 1, 5, 'torch'], [7, 1, 5, 'torch'], [4, 1, 1, 'torch'], [4, 1, 3, 'torch']] });
    const storehouse = finish({ name: 'storehouse', title: 'Storehouse', kind: 'shared', tier: 3, blocks: store_blocks, below: 1, stages: houseStages(store_blocks, true) });

    const posts = [];
    for (const x of [4, 10]) for (const z of [0, 10]) posts.push([x, z]);
    for (const x of [0, 14]) posts.push([x, 5]);
    for (const x of [4, 10]) for (const z of [3, 7]) posts.push([x, z]);
    const windows = [];
    for (const x of [2, 6, 8, 12]) windows.push([x, 3, 0]);
    // on the door side the windows stand one further from the double door: the wall above the door is
    // then built against wall, not against glass and doors that only come in the last stage
    for (const x of [2, 5, 9, 12]) windows.push([x, 3, 10]);
    for (const z of [2, 8]) { windows.push([0, 3, z]); windows.push([14, 3, z]); }
    const fittings = [[1, 1], [13, 1], [1, 9], [13, 9], [7, 1], [7, 5], [5, 9], [9, 9]].map(([x, z]) => [x, 1, z, 'torch']);
    fittings.push([6, 1, 1, 'chest'], [8, 1, 1, 'chest'], [1, 1, 5, 'crafting_table'], [13, 1, 5, 'furnace']);
    const hall_blocks = house({ w: 15, d: 11, floor: 'cobblestone', walls: ['cobblestone', 'cobblestone', 'oak_planks'], roof: 'oak_planks', roof_y: 6, door: 2, posts, windows, fittings });
    const hall = finish({ name: 'hall', title: 'Hall', kind: 'shared', tier: 4, blocks: hall_blocks, below: 1, stages: houseStages(hall_blocks, true) });

    return [leanTo(), shack, footbridge(9), cabin, cottage, storehouse, big, hall];
}

// The same prefab in another wood the catalog gathers: every oak name swapped.
export function inWood(prefab, wood) {
    if (!['oak', 'birch', 'spruce'].includes(wood)) throw new Error('wood must be oak, birch or spruce');
    if (wood === 'oak') return prefab;
    const swap = (name) => (typeof name === 'string' && name.startsWith('oak_') ? `${wood}_${name.slice(4)}` : name);
    const copy = {
        ...prefab, name: `${prefab.name}_${wood}`, blocks: prefab.blocks.map((layer) => layer.map((row) => row.map(swap))),
        parts: Object.fromEntries(Object.entries(prefab.parts ?? {}).map(([k, n]) => [swap(k), n])),
        stages: prefab.stages.map((stage) => (stage.blocks ? { ...stage, blocks: stage.blocks.map(swap) } : stage)),
        keeps: (prefab.keeps ?? []).map((keep) => ({ ...keep, block: swap(keep.block) })),
    };
    if (prefab.upgrade_of) copy.upgrade_of = `${prefab.upgrade_of}_${wood}`;
    copy.materials = billOf(copy).materials;
    return copy;
}
