// Genesis: the town file. The world file (genesis.world.json) is locked to the bootstrap
// manifest by its hash and is NEVER edited by the running system. The town grows through
// this second file, which Genesis writes and which is layered over the world file's zones
// (genesis/town/client.js: townZones).
//
//   {
//     "v": 1,
//     "world_sha256": "<the hash of the world file this town belongs to>",
//     "limit": { "min": [x, z], "max": [x, z] },      the town limit: no plot is proposed outside it
//     "plots": [ { "id": "town-1", "size": "M", "kind": "home" | "shared", "owner": "Arthur",
//                  "min": [x, y, z], "max": [x, y, z], "prefab": "storehouse" | null, "rotation": 0,
//                  "by": "Code" | "Operator",            who placed it (the operator's move makes it the operator's)
//                  "levelled_by": "Builder",             decided: the builder levels a new plot by hand
//                  "score": { "relief", "distance" }, "at": "<ISO time>" } ],
//     "spans":  [ { "id": "span-1", "owner": "Arthur", "min", "max", "prefab": "footbridge_9", "rotation": 0 | 90,
//                  "from": [x, y, z], "to": [x, y, z], "length": 9, "why": "Felix: 3 walks to ring-3 found no way", "by", "at" } ],
//     "assign": { "<plot id>": { "prefab": "shack", "built": "lean_to" | null } },
//                  what a plot is to hold next and which VERIFIED build stands on it (plots of the world file too)
//     "builds": [ { "build_id", "plot", "prefab", "prefab_sha256", "builder", "tier", "kind", "stage",
//                   "cells_total", "cells_matching", "started_at", "finished_at", "verified_at", "verified_day" } ],
//     "homes":  { "Mira": { "plot": "mira-1", "prefab": "shack", "tier": 1, "verified_at", "verified_day",
//                           "shelter": [x, y, z], "bed": { "head": [x, y, z], "foot": [x, y, z], "placed": false },
//                           "chest": [x, y, z] } },
//                  decided: an agent lives in its finished home (genesis/town/homes.js)
//     "wanted": [ { "id", "for": "Arthur", "kind", "size", "prefab", "why" } ],   plots code wants and nobody has placed yet
//     "gaps":   { "<place id>": { "count", "agents": [...], "last_at" } },        walks that found no way (bridge proposals come from these)
//     "goals":  { "Arthur": { "pinned": "...", "override": [...] | null } }       long-term goals the operator set (genesis/town/goals.js)
//   }
//
// Plot sizes: S 16 by 16 (homes up to the Cottage), M 24 by 24 (House, Storehouse), L 32 by 32
// (Hall and bigger), and spans 5 wide for bridges.
//
// Depends only on Node built-ins.

export const DEFAULT_TOWN_FILE = './bots/genesis_town/genesis.town.json';
export const TOWN_VERSION = 1;
export const PLOT_SIZES = Object.freeze({ S: 16, M: 24, L: 32 });
export const SPAN_WIDTH = 5;
export const PLOT_HEIGHT = 14;          // layers of a plot's box, as the world file's plots have them (64 to 77)
export const TOWN_LIMIT_BLOCKS = 44;    // the default town limit: this far from the home point (inside the builder's 48)
export const LANE = 4;                  // blocks kept free between plots, and between a plot and the camp or the field
const NAME = /^[A-Za-z0-9_-]{1,40}$/;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isBlock = (value, size) => Array.isArray(value) && value.length === size && value.every((n) => Number.isInteger(n));

export function emptyTown({ world_sha256 = null, home = [0, 64, 0], limit_blocks = TOWN_LIMIT_BLOCKS } = {}) {
    return {
        v: TOWN_VERSION, world_sha256,
        limit: { min: [home[0] - limit_blocks, home[2] - limit_blocks], max: [home[0] + limit_blocks, home[2] + limit_blocks] },
        plots: [], spans: [], assign: {}, builds: [], homes: {}, wanted: [], gaps: {}, goals: {},
    };
}

// The size class a prefab is given a plot of. Decided table first (S: homes up to the Cottage, M: the House and
// the Storehouse, L: the Hall and bigger), then by footprint for anything else (an operator's prefab).
export function plotSizeFor(prefab) {
    const x = prefab?.size?.x ?? prefab?.blocks?.[0]?.[0]?.length ?? 0;
    const z = prefab?.size?.z ?? prefab?.blocks?.[0]?.length ?? 0;
    const longest = Math.max(x, z);
    if (prefab?.kind === 'bridge') return 'span';
    if (prefab?.by === 'Generated') {
        if (prefab.kind === 'home') return prefab.tier >= 4 ? 'M' : 'S';
        return prefab.tier >= 4 ? 'L' : 'M';
    }
    if (longest <= PLOT_SIZES.S - 4) return 'S';
    if (longest <= PLOT_SIZES.M - 4) return 'M';
    return 'L';
}
// Does a plot of this class take a prefab of that class?
export const sizeFits = (plot_size, needed) => (PLOT_SIZES[plot_size] ?? 0) >= (PLOT_SIZES[needed] ?? Infinity);

// Problems with a town file's content (empty = fine). Never throws.
export function checkTown(town) {
    if (!isObject(town)) return ['the town file must be a JSON object'];
    const problems = [];
    if (town.v !== TOWN_VERSION) problems.push(`"v" must be ${TOWN_VERSION}`);
    if (!isObject(town.limit) || !isBlock(town.limit.min, 2) || !isBlock(town.limit.max, 2)) problems.push('"limit" must be { "min": [x, z], "max": [x, z] } in whole blocks');
    const seen = new Set();
    for (const [list, name] of [[town.plots, 'plots'], [town.spans, 'spans']]) {
        if (!Array.isArray(list)) { problems.push(`"${name}" must be a list`); continue; }
        list.forEach((plot, index) => {
            const where = `${name}[${index}]`;
            if (!isObject(plot)) { problems.push(`${where} must be an object`); return; }
            if (typeof plot.id !== 'string' || !NAME.test(plot.id)) problems.push(`${where}.id must be a name of letters, digits, _ and -`);
            else if (seen.has(plot.id)) problems.push(`${where}.id "${plot.id}" is used twice`);
            else seen.add(plot.id);
            if (!isBlock(plot.min, 3) || !isBlock(plot.max, 3) || plot.min.some((n, i) => n > plot.max[i])) { problems.push(`${where}.min and .max must be [x, y, z] in whole blocks, min not above max`); return; }
            const [dx, dz] = [plot.max[0] - plot.min[0] + 1, plot.max[2] - plot.min[2] + 1];
            if (name === 'plots') {
                if (!Object.hasOwn(PLOT_SIZES, plot.size)) problems.push(`${where}.size must be one of ${Object.keys(PLOT_SIZES).join(', ')}`);
                else if (dx !== PLOT_SIZES[plot.size] || dz !== PLOT_SIZES[plot.size]) problems.push(`${where} is ${dx} by ${dz}, a plot of size ${plot.size} is ${PLOT_SIZES[plot.size]} by ${PLOT_SIZES[plot.size]}`);
                if (!['home', 'shared'].includes(plot.kind)) problems.push(`${where}.kind must be home or shared`);
            } else if (Math.min(dx, dz) !== SPAN_WIDTH) problems.push(`${where} is ${dx} by ${dz}, a span is ${SPAN_WIDTH} wide`);
            if (plot.owner !== null && (typeof plot.owner !== 'string' || plot.owner.length === 0)) problems.push(`${where}.owner must be a name or null`);
            if (![0, 90, 180, 270].includes(plot.rotation ?? 0)) problems.push(`${where}.rotation must be 0, 90, 180 or 270`);
        });
    }
    for (const key of ['assign', 'homes', 'gaps', 'goals']) if (!isObject(town[key])) problems.push(`"${key}" must be an object`);
    for (const key of ['builds', 'wanted']) if (!Array.isArray(town[key])) problems.push(`"${key}" must be a list`);
    return problems;
}

// Reads and writes the file the way checkpoints are written (to .tmp, read back, renamed): whatever dies on the
// way, the town as it was stays readable.   files { write, rename, read, remove }   genesis/store/node_files.js
export function createTownFile({ files, file = DEFAULT_TOWN_FILE } = {}) {
    if (!files) throw new Error('the town file needs files');
    let chain = Promise.resolve();
    return {
        file,
        // -> { ok: true, town } | { ok: false, missing: true } | { ok: false, problems }
        async load() {
            let text;
            try { text = await files.read(file); } catch (err) { return { ok: false, problems: [`${file}: cannot be read (${err?.message ?? err})`] }; }
            if (text === null || text === undefined) return { ok: false, missing: true, problems: [] };
            let town;
            try { town = JSON.parse(text); } catch (err) { return { ok: false, problems: [`${file}: is not JSON (${err.message})`] }; }
            const problems = checkTown(town).map((problem) => `${file}: ${problem}`);
            return problems.length > 0 ? { ok: false, problems } : { ok: true, town };
        },
        // One write at a time, in order. Rejects when the town does not hold or the file cannot be written.
        save(town) {
            const text = `${JSON.stringify(town, null, 1)}\n`;
            chain = chain.catch(() => {}).then(async () => {
                const problems = checkTown(town);
                if (problems.length > 0) throw new Error(`town file refused: ${problems.join('; ')}`);
                await files.write(`${file}.tmp`, text);
                if (await files.read(`${file}.tmp`) !== text) throw new Error(`${file}.tmp did not read back as written`);
                await files.rename(`${file}.tmp`, file);
            });
            return chain;
        },
        flush: () => chain.catch(() => {}),
    };
}
