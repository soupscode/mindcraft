// Genesis: reading the world over RCON. The site selection (genesis/world/site.js) and the
// levelling of the bootstrap (genesis/world/bootstrap.js) both need to know what stands where
// BEFORE anything is changed, with no player online. Everything they learn comes through the
// few commands below, and nothing here changes a block.
//
// THE READING COMMANDS (READ_COMMANDS below; from general knowledge of Java Edition 1.21.6,
// NOT RUN AGAINST A REAL SERVER):
//
//   execute if blocks <x1 y1 z1> <x2 y2 z2> <x1 y1 z1> masked
//       compares a box with itself. "masked" skips the air of the source, so the count the
//       server answers with is the number of blocks in the box that are NOT air:
//       "Test passed, count: <n>". One command for up to 32768 cells.
//   execute if blocks <x1 y1 z1> <x2-1 y2 z2> <x1+1 y1 z1> all      (and the same along y and z)
//       compares a box with itself moved by one cell: it passes only when every cell equals
//       its neighbour, that is when the box is ONE kind of block throughout. "Test failed"
//       when it is not.
//   execute if block <x y z> minecraft:<name>
//       "Test passed" when that block is there, "Test failed" when it is not. The only way to
//       learn WHAT a block is: no command prints the name of a block, so a cell is tried
//       against the names in NATURAL_BLOCKS, the likeliest first.
//   forceload add <x1 z1> <x2 z2>, forceload remove <x1 z1> <x2 z2>
//       with no player online only the chunks around the world spawn are loaded, and every
//       command above answers "That position is not loaded" elsewhere. The chunks are force
//       loaded for the run and released at the end. The answer is not relied on: whether a
//       position can be read is found out by reading it.
//   forceload query ~ ~
//       "Chunk at [<cx>, <cz>] in minecraft:overworld is (not) marked for force loading". A
//       command sent over RCON runs at the world spawn, so this names the chunk of the spawn.
//
// THE PROBE (probe() below) runs each reading command once where the answer is known
// whatever the land looks like, and stops with the server's raw answer when it is not the
// expected one: the lowest layer of the overworld (y -64) is bedrock, the highest (y 319) is
// air. It also tries every name of NATURAL_BLOCKS once: a name this server does not know is
// left out and reported, so a wrong name in the table below can never stop a run half-way.
//
// Injected: send(command) -> Promise<answer text>, sleep(ms).
// No imports.

export const WORLD_BOTTOM = -64;   // the lowest layer of the overworld: bedrock everywhere
export const WORLD_TOP = 319;      // the highest: air everywhere
export const BOX_LIMIT = 32768;    // the most cells one "execute if blocks" may compare
export const FORCELOAD_LIMIT = 256; // the most chunks one "forceload add" may mark

// Every command this file sends, and the answer it looks for.
export const READ_COMMANDS = Object.freeze([
    { command: 'execute if blocks <x1> <y1> <z1> <x2> <y2> <z2> <x1> <y1> <z1> masked', answer: 'Test passed, count: <n>   (n: the blocks of the box that are not air)' },
    { command: 'execute if blocks <x1> <y1> <z1> <x2-1> <y2> <z2> <x1+1> <y1> <z1> all', answer: 'Test passed, count: <n> (one kind of block throughout) | Test failed' },
    { command: 'execute if block <x> <y> <z> minecraft:<name>', answer: 'Test passed | Test failed' },
    { command: 'forceload query ~ ~', answer: 'Chunk at [<cx>, <cz>] in minecraft:overworld is not marked for force loading   (the chunk of the world spawn)' },
    { command: 'forceload add <x1> <z1> <x2> <z2>', answer: 'not relied on: the position is read until it answers' },
    { command: 'forceload remove <x1> <z1> <x2> <z2>', answer: 'not read' },
]);

// The blocks the land is made of, as far as this script knows them: [name, kind].
//   ground  what one stands on               cover   what grows or lies on the ground (the ground is under it)
//   tree    logs and leaves                  wet     water, lava, ice and what grows in water
// The site selection reads the kind; the levelling clears only what is named here and stops
// at anything else (it may be something somebody built). The order is the order of trying,
// which then follows what is found most often.
export const NATURAL_BLOCKS = Object.freeze([
    ['grass_block', 'ground'], ['short_grass', 'cover'], ['dirt', 'ground'], ['stone', 'ground'], ['tall_grass', 'cover'],
    ['oak_leaves', 'tree'], ['oak_log', 'tree'], ['birch_leaves', 'tree'], ['birch_log', 'tree'],
    ['dandelion', 'cover'], ['poppy', 'cover'], ['fern', 'cover'], ['large_fern', 'cover'], ['water', 'wet'],
    ['sand', 'ground'], ['gravel', 'ground'], ['coarse_dirt', 'ground'], ['podzol', 'ground'], ['snow', 'cover'], ['snow_block', 'ground'],
    ['spruce_leaves', 'tree'], ['spruce_log', 'tree'], ['dark_oak_leaves', 'tree'], ['dark_oak_log', 'tree'],
    ['jungle_leaves', 'tree'], ['jungle_log', 'tree'], ['acacia_leaves', 'tree'], ['acacia_log', 'tree'],
    ['cherry_leaves', 'tree'], ['cherry_log', 'tree'], ['mangrove_leaves', 'tree'], ['mangrove_log', 'tree'], ['mangrove_roots', 'tree'],
    ['pale_oak_leaves', 'tree'], ['pale_oak_log', 'tree'], ['azalea_leaves', 'tree'], ['flowering_azalea_leaves', 'tree'],
    ['bee_nest', 'tree'], ['mushroom_stem', 'tree'], ['brown_mushroom_block', 'tree'], ['red_mushroom_block', 'tree'], ['vine', 'tree'],
    ['azure_bluet', 'cover'], ['oxeye_daisy', 'cover'], ['cornflower', 'cover'], ['allium', 'cover'], ['blue_orchid', 'cover'],
    ['red_tulip', 'cover'], ['orange_tulip', 'cover'], ['white_tulip', 'cover'], ['pink_tulip', 'cover'], ['lily_of_the_valley', 'cover'],
    ['sunflower', 'cover'], ['lilac', 'cover'], ['rose_bush', 'cover'], ['peony', 'cover'], ['dead_bush', 'cover'],
    ['brown_mushroom', 'cover'], ['red_mushroom', 'cover'], ['sweet_berry_bush', 'cover'], ['sugar_cane', 'cover'],
    ['pumpkin', 'cover'], ['melon', 'cover'], ['moss_carpet', 'cover'], ['pink_petals', 'cover'], ['wildflowers', 'cover'],
    ['leaf_litter', 'cover'], ['bush', 'cover'], ['firefly_bush', 'cover'], ['short_dry_grass', 'cover'], ['tall_dry_grass', 'cover'],
    ['cactus', 'cover'], ['cactus_flower', 'cover'], ['bamboo', 'cover'], ['azalea', 'cover'], ['flowering_azalea', 'cover'], ['glow_lichen', 'cover'],
    ['andesite', 'ground'], ['diorite', 'ground'], ['granite', 'ground'], ['deepslate', 'ground'], ['tuff', 'ground'], ['calcite', 'ground'],
    ['clay', 'ground'], ['red_sand', 'ground'], ['sandstone', 'ground'], ['red_sandstone', 'ground'], ['terracotta', 'ground'],
    ['rooted_dirt', 'ground'], ['mud', 'ground'], ['moss_block', 'ground'], ['mycelium', 'ground'], ['mossy_cobblestone', 'ground'],
    ['coal_ore', 'ground'], ['iron_ore', 'ground'], ['copper_ore', 'ground'], ['gold_ore', 'ground'],
    ['lava', 'wet'], ['ice', 'wet'], ['packed_ice', 'wet'], ['seagrass', 'wet'], ['tall_seagrass', 'wet'], ['kelp', 'wet'], ['kelp_plant', 'wet'], ['lily_pad', 'wet'],
]);
export const NATURAL_KIND = Object.freeze(Object.fromEntries(NATURAL_BLOCKS));

const xyz = (pos) => pos.join(' ');
const volume = (box) => (box.max[0] - box.min[0] + 1) * (box.max[1] - box.min[1] + 1) * (box.max[2] - box.min[2] + 1);

// What the server said, or null when the answer is not understood.
export const READ_ANSWERS = Object.freeze({
    count: (answer) => { const found = /Test passed,?\s*count:\s*(\d+)/i.exec(String(answer ?? '')); return found ? Number(found[1]) : null; },
    passed: (answer) => (/Test failed/i.test(String(answer ?? '')) ? false : /Test passed/i.test(String(answer ?? '')) ? true : null),
    chunk: (answer) => { const found = /Chunk at \[\s*(-?\d+)\s*,\s*(-?\d+)\s*\]/i.exec(String(answer ?? '')); return found ? [Number(found[1]), Number(found[2])] : null; },
    not_loaded: (answer) => /not loaded/i.test(String(answer ?? '')),
});

// Why a reading failed: code "not_loaded" (the chunk is not there yet) or "not_understood".
export class ReadError extends Error {
    constructor(code, command, answer) {
        super(code === 'not_loaded'
            ? `the position is not loaded: the server answered ${JSON.stringify(answer)} to "${command}"`
            : `the server's answer to "${command}" was not understood: ${JSON.stringify(answer)}`);
        this.code = code;
        this.command = command;
        this.answer = answer;
    }
}

// The reader: counts, compares and names blocks. `send` is told every command; nothing here
// can change the world.
export function createReader({ send, names = NATURAL_BLOCKS.map(([name]) => name) } = {}) {
    const stats = { commands: 0, counts: 0, uniform: 0, tests: 0 };
    let zero_is_failed = false;     // set by the probe when an all-air box is answered with "Test failed"
    let order = [...names];
    const hits = new Map();

    async function ask(command) {
        stats.commands++;
        const answer = String(await send(command) ?? '');
        if (READ_ANSWERS.not_loaded(answer)) throw new ReadError('not_loaded', command, answer);
        return answer;
    }

    async function countOne(box) {
        stats.counts++;
        const command = `execute if blocks ${xyz(box.min)} ${xyz(box.max)} ${xyz(box.min)} masked`;
        const answer = await ask(command);
        const n = READ_ANSWERS.count(answer);
        if (n !== null) return n;
        if (zero_is_failed && READ_ANSWERS.passed(answer) === false) return 0;
        throw new ReadError('not_understood', command, answer);
    }

    const reader = {
        stats: () => ({ ...stats }),
        names: () => [...order],
        // One command as it is, for the probe: the answer text (a position that is not loaded throws).
        raw: (command) => ask(command),
        // The names that may be tried (the probe drops what the server does not know).
        setNames(list) { order = order.filter((name) => list.includes(name)); },
        setZeroIsFailed(value) { zero_is_failed = value === true; },
        // How many blocks of the box are not air. A box larger than one command may compare is cut into slabs.
        async count(box) {
            if (volume(box) <= BOX_LIMIT) return countOne(box);
            const layer = (box.max[0] - box.min[0] + 1) * (box.max[2] - box.min[2] + 1);
            let total = 0;
            if (layer <= BOX_LIMIT) {
                const layers = Math.max(1, Math.floor(BOX_LIMIT / layer));
                for (let y = box.min[1]; y <= box.max[1]; y += layers) {
                    total += await countOne({ min: [box.min[0], y, box.min[2]], max: [box.max[0], Math.min(box.max[1], y + layers - 1), box.max[2]] });
                }
                return total;
            }
            const half = Math.floor((box.min[0] + box.max[0]) / 2);
            return await reader.count({ min: box.min, max: [half, box.max[1], box.max[2]] }) + await reader.count({ min: [half + 1, box.min[1], box.min[2]], max: box.max });
        },
        // True when the box holds ONE kind of block (the same block state) throughout.
        async uniform(box) {
            for (const axis of [1, 0, 2]) {
                if (box.max[axis] === box.min[axis]) continue;
                stats.uniform++;
                const end = [...box.max];
                end[axis]--;
                const moved = [...box.min];
                moved[axis]++;
                const command = `execute if blocks ${xyz(box.min)} ${xyz(end)} ${xyz(moved)} all`;
                const answer = await ask(command);
                const passed = READ_ANSWERS.passed(answer);
                if (passed === null) throw new ReadError('not_understood', command, answer);
                if (!passed) return false;
            }
            return true;
        },
        // Is that block at the position? `name` without "minecraft:".
        async is(pos, name) {
            stats.tests++;
            const command = `execute if block ${xyz(pos)} minecraft:${name}`;
            const answer = await ask(command);
            const passed = READ_ANSWERS.passed(answer);
            if (passed === null) throw new ReadError('not_understood', command, answer);
            return passed;
        },
        // The name of the block at a position that is not air, or null when it is none of the names.
        async identify(pos) {
            for (const name of order) {
                if (!(await reader.is(pos, name))) continue;
                const count = (hits.get(name) ?? 0) + 1;
                hits.set(name, count);
                // what is found often is tried first
                let at = order.indexOf(name);
                while (at > 0 && (hits.get(order[at - 1]) ?? 0) < count) { order[at] = order[at - 1]; order[at - 1] = name; at--; }
                return name;
            }
            return null;
        },
        // The highest block of a column that is not air, between `low` and `high`, or null when there is none.
        async highest([x, z], low = WORLD_BOTTOM, high = WORLD_TOP) {
            if (low > high || (await reader.count({ min: [x, low, z], max: [x, high, z] })) === 0) return null;
            let from = low;
            let to = high; // invariant: something that is not air lies in [from, to], nothing above `to`
            while (from < to) {
                const middle = Math.floor((from + to + 1) / 2);
                if ((await reader.count({ min: [x, middle, z], max: [x, to, z] })) > 0) from = middle; else to = middle - 1;
            }
            return from;
        },
        // The same, starting from a guess (the neighbouring column's height): two commands when the
        // column is solid under its top and the guess was within `reach` blocks, a full search otherwise.
        async top([x, z], guess = null, reach = 12) {
            if (guess === null) return reader.highest([x, z]);
            const base = Math.max(WORLD_BOTTOM, guess - reach);
            const above_base = await reader.count({ min: [x, base, z], max: [x, WORLD_TOP, z] });
            if (above_base === 0) return reader.highest([x, z], WORLD_BOTTOM, base - 1);
            const candidate = base + above_base - 1;
            if (candidate >= WORLD_TOP) return WORLD_TOP;
            // nothing above the candidate: the blocks counted fill [base, candidate] without a gap, and it is the top
            if ((await reader.count({ min: [x, candidate + 1, z], max: [x, WORLD_TOP, z] })) === 0) return candidate;
            return reader.highest([x, z], candidate + 1, WORLD_TOP);
        },
    };
    return reader;
}

// The probe: every reading command once, where the answer is known. Resolves to
//   { ok: true, dropped: [names the server does not know], commands }
//   { ok: false, problem, command, answer }     the raw answer that was not the expected one
// It also teaches the reader how this server answers for a box of air, and which names it knows
// (names: false leaves the table of names untried, for a run that names nothing).
export async function probe(reader, [x, z], { log = () => {}, names = true } = {}) {
    const low = [x, WORLD_BOTTOM, z];
    const high = [x, WORLD_TOP, z];
    const steps = [];
    const failed = (what, err) => ({
        ok: false, command: err.command ?? null, answer: err.answer ?? null,
        problem: `the probe stopped at "${what}": ${err.message}. Nothing was changed. Send this line: the command and its answer decide how the script must read this server.`,
    });
    const expect = async (what, run, wanted) => {
        let got;
        try { got = await run(); } catch (err) { return failed(what, err); }
        if (got !== wanted) return failed(what, new Error(`expected ${JSON.stringify(wanted)}, read ${JSON.stringify(got)}`));
        steps.push(what);
        return null;
    };
    let stop = await expect('bedrock at the bottom is a block (count 1)', () => reader.count({ min: low, max: low }), 1);
    if (stop) return stop;
    // a box of air: "Test passed, count: 0" is expected; a server that says "Test failed" for it is understood too
    try {
        await reader.count({ min: high, max: high });
    } catch (err) {
        if (err.code === 'not_understood' && READ_ANSWERS.passed(err.answer) === false) reader.setZeroIsFailed(true);
        else return failed('air at the top counts 0', err);
    }
    stop = await expect('air at the top counts 0', () => reader.count({ min: high, max: high }), 0)
        ?? await expect('bedrock at the bottom is minecraft:bedrock', () => reader.is(low, 'bedrock'), true)
        ?? await expect('bedrock at the bottom is not minecraft:air', () => reader.is(low, 'air'), false)
        ?? await expect('air at the top is minecraft:air', () => reader.is(high, 'air'), true)
        ?? await expect('two cells of air at the top are one kind of block', () => reader.uniform({ min: [x, WORLD_TOP - 1, z], max: high }), true);
    if (stop) return stop;
    // bedrock and air are not the same block: the comparison must fail
    try {
        const command = `execute if blocks ${xyz(low)} ${xyz(low)} ${xyz(high)} all`;
        const answer = String(await reader.raw(command) ?? '');
        if (READ_ANSWERS.passed(answer) !== false) return failed('bedrock compared with air fails', new ReadError('not_understood', command, answer));
    } catch (err) { return failed('bedrock compared with air fails', err); }
    // every name once, against air: "Test failed" is the only right answer; anything else means the server does not know the name
    const dropped = [];
    for (const name of names ? reader.names() : []) {
        try {
            if (await reader.is(high, name)) dropped.push(name); // air is none of them
        } catch (err) {
            if (err.code === 'not_loaded') return failed(`minecraft:${name} is a block name`, err);
            dropped.push(name);
        }
    }
    if (dropped.length > 0) {
        reader.setNames(reader.names().filter((name) => !dropped.includes(name)));
        log(`Probe: this server does not know ${dropped.length} block name(s) of the table, they are left out: ${dropped.join(', ')}`);
    }
    return { ok: true, dropped, steps };
}

// ---- chunks ---------------------------------------------------------------------------------

const chunkOf = (n) => Math.floor(n / 16);

// The "forceload add" boxes that cover a flat box of block columns, none over the limit of one command.
export function forceloadBoxes({ min, max }) {
    const cx1 = chunkOf(min[0]);
    const cx2 = chunkOf(max[0]);
    const cz1 = chunkOf(min[1]);
    const cz2 = chunkOf(max[1]);
    const boxes = [];
    const wide = Math.min(cx2 - cx1 + 1, FORCELOAD_LIMIT);
    const rows = Math.max(1, Math.floor(FORCELOAD_LIMIT / wide));
    for (let cx = cx1; cx <= cx2; cx += wide) {
        for (let cz = cz1; cz <= cz2; cz += rows) {
            boxes.push({ min: [cx * 16, cz * 16], max: [Math.min(cx2, cx + wide - 1) * 16 + 15, Math.min(cz2, cz + rows - 1) * 16 + 15] });
        }
    }
    return boxes;
}

// Force-loads the chunks under a flat box and waits until its corners can be read. Resolves to
//   { ok: true, release() }                     release() gives the chunks back (only those this call marked)
//   { ok: false, problem, release() }
// `send(command, changes)` is the bootstrap's; the wait is bounded: `tries` readings, `wait_ms` apart.
export async function loadChunks({ send, reader, box, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), tries = 90, wait_ms = 1000, log = () => {} } = {}) {
    const marked = [];
    const release = async () => {
        while (marked.length > 0) {
            const one = marked.pop();
            try { await send(`forceload remove ${one.min.join(' ')} ${one.max.join(' ')}`); } catch { /* the connection is gone: the chunks stay marked, the report says so */ }
        }
    };
    let last_answer = null;
    for (const one of forceloadBoxes(box)) {
        last_answer = String(await send(`forceload add ${one.min.join(' ')} ${one.max.join(' ')}`) ?? '');
        // only what this run marked is given back: chunks somebody else force-loaded stay as they are
        if (/Marked/i.test(last_answer) && !/No chunks/i.test(last_answer)) marked.push(one);
    }
    const corners = [[box.min[0], box.min[1]], [box.min[0], box.max[1]], [box.max[0], box.min[1]], [box.max[0], box.max[1]],
        [Math.floor((box.min[0] + box.max[0]) / 2), Math.floor((box.min[1] + box.max[1]) / 2)]];
    for (let attempt = 1; attempt <= tries; attempt++) {
        let waiting = null;
        for (const [x, z] of corners) {
            try {
                if (!(await reader.is([x, WORLD_BOTTOM, z], 'bedrock'))) {
                    return { ok: false, release, problem: `the lowest layer at ${x}, ${z} is not bedrock: this is not a normal overworld, the script cannot read it` };
                }
            } catch (err) {
                if (err.code !== 'not_loaded') return { ok: false, release, problem: err.message };
                waiting = err;
                break;
            }
        }
        if (waiting === null) return { ok: true, release };
        if (attempt === 1 || attempt % 10 === 0) log(`Waiting for the server to load the chunks (${attempt} of ${tries})...`);
        if (attempt < tries) await sleep(wait_ms);
        else {
            return { ok: false, release, problem: `the chunks from ${box.min.join(', ')} to ${box.max.join(', ')} were not loaded after ${tries} tries: ${waiting.message}. `
                + `The answer to "forceload add" was ${JSON.stringify(last_answer)}.` };
        }
    }
    return { ok: false, release, problem: 'the chunks were not loaded' };
}

// ---- a whole box at a time ------------------------------------------------------------------

// Is every cell of a box one of the accepted blocks? Resolves to null when it is, else to the
// first cell that is not: { pos, found } with found "air" or "another block". Needs no table of
// names: whole boxes of one kind are settled by one cell.
export async function checkBox(reader, box, accepts) {
    const names = accepts.map((name) => name.replace(/^minecraft:/, ''));
    async function look(part, known = null) {
        const n = known ?? await reader.count(part);
        const size = volume(part);
        if (n === 0) return { pos: [...part.min], found: 'air' };
        if (size === 1 || (n === size && await reader.uniform(part))) {
            for (const name of names) if (await reader.is(part.min, name)) return null;
            return { pos: [...part.min], found: 'another block' };
        }
        const spans = [0, 1, 2].map((axis) => part.max[axis] - part.min[axis] + 1);
        const axis = spans[1] > 1 ? 1 : (spans[0] >= spans[2] ? 0 : 2);
        const middle = part.min[axis] + Math.floor(spans[axis] / 2) - 1;
        const first = { min: [...part.min], max: [...part.max] };
        const second = { min: [...part.min], max: [...part.max] };
        first.max[axis] = middle;
        second.min[axis] = middle + 1;
        const in_first = await reader.count(first);
        return await look(first, in_first) ?? await look(second, n - in_first);
    }
    return look(box);
}
