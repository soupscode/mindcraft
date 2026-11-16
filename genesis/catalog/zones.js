// Genesis: the zones of the world. Protected zones (the camp, the field and the building
// plots), each agent's home and range, and the registered chests. They come from one world
// config file, genesis.world.json, which the operator writes for the world that is running.
//
// The file (minimal shape; every coordinate is a block position):
//   {
//     "v": 1,
//     "dimension": "overworld",
//     "camp":  { "min": [x, z], "max": [x, z] },
//     "field": { "min": [x, z], "max": [x, z] },
//     "plots": [ { "id": "plot-1", "owner": "Arthur", "min": [x, y, z], "max": [x, y, z], "blueprint": "small_wood_house" } ],
//     "chests": { "shared": [x, y, z], "kits": [x, y, z] },
//     "agents": { "Arthur": { "home": [x, y, z], "range": 48 }, "Mira": { ... }, ... }
//   }
//   - A box is { "min", "max" }, both corners included. Two numbers [x, z] make a column
//     that is protected at every height; three numbers [x, y, z] limit the height too.
//   - "camp" and "field" are required. "plots" and "chests" may be empty or left out.
//     A plot's "owner" and "blueprint" may be null or left out (nobody owns it yet / nothing
//     is planned on it). Plot ids and chest names: letters, digits, "_" and "-".
//   - "agents": one entry per agent. "home" is where the agent shelters, "range" is how far
//     (in blocks, measured flat, ignoring height) the agent may be from home. An optional
//     "patrol": [[x, y, z], ...] lists waypoints for a patrol; without it a ring is used.
//   - "v": 2 is the same file with more in it (the seed, the home point, the world border, the
//     game rules, the camp's blocks, the kit: genesis/world/world_config.js describes and
//     checks those). The zones read the same keys from both versions and ignore the rest.
//
// Zones interface (what the catalog, the executor and the routines use; the tests use a
// hand-made one through createZones):
//   home(agent) -> {x,y,z} | null          range(agent) -> number | null
//   inRange(agent, pos) -> boolean         distanceFromHome(agent, pos) -> number
//   protectedAt(pos) -> 'camp' | 'field' | 'plot:<id>' | null
//   isProtected(pos) -> boolean
//   field() -> box                         camp() -> box
//   fieldOwner() -> the agent the field is for ("field.owner" of the file), or null (nobody in particular)
//   agents() -> [names]                    every agent the file lists
//   plots() -> [plot]                      plot(id) -> plot | null
//   plotOverlaps(id) -> [names of the zones and plots the plot overlaps]
//   chests() -> [{ name, pos }]            chest(name) -> {x,y,z} | null
//   patrol(agent) -> [{x,y,z}]             places(agent) -> [{ id, kind, pos }]
//
// Depends only on Node built-ins (the loader reads the file through an injected `read`).

export const ZONES_VERSION = 1;            // the minimal shape above
export const ZONES_VERSIONS = Object.freeze([1, 2]); // 2: the full world file (genesis/world/world_config.js)
export const ZONES_FILE = 'genesis.world.json';
const NAME = /^[A-Za-z0-9_-]{1,40}$/;

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isPoint = (value, size) => Array.isArray(value) && value.length === size && value.every((n) => Number.isFinite(n));

function checkBox(box, where, problems, { need_height = false } = {}) {
    if (!isPlainObject(box)) { problems.push(`${where} must be { "min": [...], "max": [...] }`); return; }
    const size = Array.isArray(box.min) ? box.min.length : 0;
    if ((size !== 2 && size !== 3) || !isPoint(box.min, size) || !isPoint(box.max, size)) {
        problems.push(`${where}.min and ${where}.max must both be [x, z] or both be [x, y, z]`);
        return;
    }
    if (need_height && size !== 3) problems.push(`${where} needs a height: min and max must be [x, y, z]`);
    for (let i = 0; i < size; i++) {
        if (box.min[i] > box.max[i]) problems.push(`${where}: min is larger than max`);
    }
}

// Problems with the content of a world config file (empty = fine). Never throws.
export function checkZonesConfig(config) {
    if (!isPlainObject(config)) return ['the world config must be a JSON object'];
    const problems = [];
    if (!ZONES_VERSIONS.includes(config.v)) problems.push(`"v" must be ${ZONES_VERSIONS.join(' or ')}`);
    if (config.dimension !== undefined && (typeof config.dimension !== 'string' || config.dimension.length === 0)) {
        problems.push('"dimension" must be a dimension name');
    }
    checkBox(config.camp, 'camp', problems);
    checkBox(config.field, 'field', problems);
    const plots = config.plots ?? [];
    if (!Array.isArray(plots)) {
        problems.push('"plots" must be a list');
    } else {
        const seen = new Set();
        plots.forEach((plot, index) => {
            const where = `plots[${index}]`;
            if (!isPlainObject(plot)) { problems.push(`${where} must be an object`); return; }
            if (typeof plot.id !== 'string' || !NAME.test(plot.id)) problems.push(`${where}.id must be a name of letters, digits, _ and -`);
            else if (seen.has(plot.id)) problems.push(`${where}.id "${plot.id}" is used twice`);
            else seen.add(plot.id);
            for (const key of ['owner', 'blueprint']) {
                if (plot[key] !== undefined && plot[key] !== null && (typeof plot[key] !== 'string' || plot[key].length === 0)) {
                    problems.push(`${where}.${key} must be a name or null`);
                }
            }
            checkBox(plot, where, problems, { need_height: true });
        });
    }
    const chests = config.chests ?? {};
    if (!isPlainObject(chests)) {
        problems.push('"chests" must be an object of name: [x, y, z]');
    } else {
        for (const [name, pos] of Object.entries(chests)) {
            if (!NAME.test(name)) problems.push(`chests: "${name}" must be a name of letters, digits, _ and -`);
            if (!isPoint(pos, 3)) problems.push(`chests.${name} must be [x, y, z]`);
        }
    }
    if (!isPlainObject(config.agents) || Object.keys(config.agents).length === 0) {
        problems.push('"agents" must list at least one agent');
    } else {
        for (const [name, entry] of Object.entries(config.agents)) {
            const where = `agents.${name}`;
            if (!isPlainObject(entry)) { problems.push(`${where} must be an object`); continue; }
            if (!isPoint(entry.home, 3)) problems.push(`${where}.home must be [x, y, z]`);
            if (!Number.isFinite(entry.range) || entry.range <= 0) problems.push(`${where}.range must be a number of blocks, more than 0`);
            if (entry.patrol !== undefined && (!Array.isArray(entry.patrol) || !entry.patrol.every((p) => isPoint(p, 3)))) {
                problems.push(`${where}.patrol must be a list of [x, y, z]`);
            }
        }
    }
    return problems;
}

const point = ([x, y, z]) => ({ x, y, z });

function makeBox(box) {
    const tall = box.min.length === 3;
    return {
        min: { x: box.min[0], y: tall ? box.min[1] : -Infinity, z: box.min[tall ? 2 : 1] },
        max: { x: box.max[0], y: tall ? box.max[1] : Infinity, z: box.max[tall ? 2 : 1] },
    };
}

export function boxContains(box, pos) {
    const x = Math.floor(pos.x), y = Math.floor(pos.y), z = Math.floor(pos.z);
    return x >= box.min.x && x <= box.max.x && y >= box.min.y && y <= box.max.y && z >= box.min.z && z <= box.max.z;
}

function boxesOverlap(a, b) {
    return ['x', 'y', 'z'].every((axis) => a.min[axis] <= b.max[axis] && b.min[axis] <= a.max[axis]);
}

function boxCentre(box, y) {
    return {
        x: Math.floor((box.min.x + box.max.x) / 2),
        y: Number.isFinite(box.min.y) ? box.min.y : y,
        z: Math.floor((box.min.z + box.max.z) / 2),
    };
}

// Distance on the ground: height does not count toward an agent's range.
export function flatDistance(a, b) {
    return Math.hypot(a.x - b.x, a.z - b.z);
}

// How many waypoints the default patrol ring has, and how far out it lies (part of the range).
export const PATROL_RING = Object.freeze({ points: 16, radius_share: 0.75 });

// Builds the zones from a checked config. Throws when the config has problems: call
// checkZonesConfig first when the problems should be reported instead.
export function createZones(config) {
    const problems = checkZonesConfig(config);
    if (problems.length > 0) throw new Error(`world config: ${problems.join('; ')}`);

    const camp = makeBox(config.camp);
    const field = makeBox(config.field);
    const plots = (config.plots ?? []).map((plot) => ({
        id: plot.id, owner: plot.owner ?? null, blueprint: plot.blueprint ?? null, ...makeBox(plot),
    }));
    const chests = Object.entries(config.chests ?? {}).map(([name, pos]) => ({ name, pos: point(pos) }));
    const agents = new Map(Object.entries(config.agents).map(([name, entry]) => [name, {
        home: point(entry.home), range: entry.range, patrol: (entry.patrol ?? []).map(point),
    }]));

    function protectedAt(pos) {
        if (boxContains(camp, pos)) return 'camp';
        if (boxContains(field, pos)) return 'field';
        for (const plot of plots) if (boxContains(plot, pos)) return `plot:${plot.id}`;
        return null;
    }

    function distanceFromHome(agent, pos) {
        const entry = agents.get(agent);
        return entry ? flatDistance(entry.home, pos) : Infinity;
    }

    function patrol(agent) {
        const entry = agents.get(agent);
        if (!entry) return [];
        if (entry.patrol.length > 0) return entry.patrol.map((p) => ({ ...p }));
        const radius = Math.floor(entry.range * PATROL_RING.radius_share);
        return Array.from({ length: PATROL_RING.points }, (_, k) => {
            const angle = (2 * Math.PI * k) / PATROL_RING.points;
            return {
                x: Math.round(entry.home.x + radius * Math.cos(angle)),
                y: entry.home.y,
                z: Math.round(entry.home.z + radius * Math.sin(angle)),
            };
        });
    }

    const zones = {
        dimension: config.dimension ?? 'overworld',
        agents: () => [...agents.keys()],
        home: (agent) => (agents.has(agent) ? { ...agents.get(agent).home } : null),
        range: (agent) => agents.get(agent)?.range ?? null,
        distanceFromHome,
        // An agent the file does not list has no range: nothing is in range for it.
        inRange: (agent, pos) => distanceFromHome(agent, pos) <= (agents.get(agent)?.range ?? -1),
        protectedAt,
        isProtected: (pos) => protectedAt(pos) !== null,
        camp: () => camp,
        field: () => field,
        fieldOwner: () => (typeof config.field.owner === 'string' && config.field.owner.length > 0 ? config.field.owner : null),
        plots: () => plots.map((plot) => ({ ...plot })),
        plot: (id) => plots.find((plot) => plot.id === id) ?? null,
        // The zones and other plots a plot shares at least one cell with.
        plotOverlaps(id) {
            const plot = plots.find((p) => p.id === id);
            if (!plot) return [];
            const hits = [];
            if (boxesOverlap(plot, camp)) hits.push('camp');
            if (boxesOverlap(plot, field)) hits.push('field');
            for (const other of plots) if (other !== plot && boxesOverlap(plot, other)) hits.push(`plot:${other.id}`);
            return hits;
        },
        chests: () => chests.map((chest) => ({ name: chest.name, pos: { ...chest.pos } })),
        chest: (name) => {
            const chest = chests.find((c) => c.name === name);
            return chest ? { ...chest.pos } : null;
        },
        patrol,
        // The named places an agent can be sent to. The ids are part of the travel option ids.
        places(agent) {
            const entry = agents.get(agent);
            if (!entry) return [];
            const list = [{ id: 'home', kind: 'home', pos: { ...entry.home } }];
            list.push({ id: 'camp', kind: 'zone', pos: boxCentre(camp, entry.home.y) });
            list.push({ id: 'field', kind: 'zone', pos: boxCentre(field, entry.home.y) });
            for (const chest of chests) list.push({ id: `chest-${chest.name}`, kind: 'chest', chest: chest.name, pos: { ...chest.pos } });
            for (const plot of plots) {
                if (plot.owner === null || plot.owner === agent) list.push({ id: `plot-${plot.id}`, kind: 'plot', pos: boxCentre(plot, entry.home.y) });
            }
            patrol(agent).forEach((pos, k) => list.push({ id: `ring-${k}`, kind: 'patrol', pos }));
            return list;
        },
    };
    return zones;
}

// Reads and checks the world config file. Never throws.
//   read(path) -> text | null (null: no such file). genesis/store/node_files.js has one.
// Resolves to { ok: true, zones, config } or { ok: false, problems: [...] }.
export async function loadZones({ file = ZONES_FILE, read } = {}) {
    let text;
    try {
        text = await read(file);
    } catch (err) {
        return { ok: false, problems: [`${file}: cannot be read (${err?.message ?? err})`] };
    }
    if (text === null || text === undefined) return { ok: false, problems: [`${file}: the world config file does not exist`] };
    let config;
    try {
        config = JSON.parse(text);
    } catch (err) {
        return { ok: false, problems: [`${file}: is not JSON (${err.message})`] };
    }
    const problems = checkZonesConfig(config).map((problem) => `${file}: ${problem}`);
    if (problems.length > 0) return { ok: false, problems };
    return { ok: true, zones: createZones(config), config };
}
