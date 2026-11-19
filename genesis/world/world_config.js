// Genesis: the whole world file, genesis.world.json at "v": 2. One file says everything the
// operator's bootstrap puts into a new world and everything the agents are held to:
//
//   {
//     "v": 2,
//     "seed": "4815162342",                      the seed the world is generated from (whole number, as text or number)
//     "dimension": "overworld",
//     "home": [x, y, z],                         the home point: the world spawn. The layer under it is the camp's
//                                                floor: the bootstrap clears the camp area above it and lays it
//     "border": { "center": [x, z], "size": 512 },
//     "rules": { "difficulty": "easy", "keep_inventory": false, "mob_griefing": false,
//                "fire_spread": false, "raids": false, "nether": false, "end": false },
//     "camp": {
//       "min": [x, z], "max": [x, z],            protected zone
//       "facing": "south",                       which way the chests and the furnace face (optional)
//       "shared_chest_second_half": [x, y, z],   the other half of the shared double chest (next to chests.shared)
//       "crafting_table": [x, y, z],
//       "furnace": [x, y, z],
//       "beds": [ { "foot": [x, y, z], "facing": "north", "color": "red" }, ... four of them ]
//     },
//     "field": { "min": [x, z], "max": [x, z],   protected zone, 9 by 9
//                "y": 63,                        the layer of the farmland (crops grow on y + 1)
//                "water": [[x, z]],              water cells in that layer
//                "crop": null,                   always null (or left out): the field is left BARE (decided). The
//                                                bootstrap tills and waters it and sows nothing; the agents
//                                                plant it from the seeds in the kit
//                "owner": "Mira" },              whose range the field must lie in (optional)
//     "plots": [ { "id", "owner", "min": [x, y, z], "max": [x, y, z], "blueprint" } ],   protected zones, 16 by 16
//     "chests": { "shared": [x, y, z], "kits": [x, y, z] },
//     "kits": [ { "item": "bread", "count": 16 }, ... ],   what the kits chest is filled with, once. It must hold
//                                                seeds (the field is bare and the agents sow it)
//     "agents": { "Arthur": { "home": [x, y, z], "range": 48 }, ... }
//   }
//
// The zones (genesis/catalog/zones.js) read camp, field, plots, chests and agents from it,
// exactly as from the minimal "v": 1 shape. Everything else is for the bootstrap
// (genesis/world/bootstrap.js) and for the checks below.
//
// checkWorldConfig(config, { blueprints }) -> [{ code, message }]   (empty = fine; never throws)
// Every problem has a named reason, one of WORLD_PROBLEMS.
//
// Depends only on Node built-ins and the plain-data files of genesis/catalog and genesis/routines.

import { createHash } from 'node:crypto';
import { checkZonesConfig, flatDistance } from '../catalog/zones.js';
import { blueprintSize } from '../catalog/blueprints.js';
import { CROPS } from '../catalog/defaults.js';
import { ROUTINES } from '../routines/routines.js';

export const WORLD_VERSION = 2;

// Decided. A world file that says anything else is refused.
export const DECIDED_RULES = Object.freeze({
    difficulty: 'easy', keep_inventory: false, mob_griefing: false, fire_spread: false, raids: false, nether: false, end: false,
});
export const DECIDED_BORDER_SIZE = 512;
export const DECIDED_RANGES = Object.freeze(Object.fromEntries(Object.entries(ROUTINES).map(([agent, routine]) => [agent, routine.range])));
export const PLOT_SIZE = 16;        // plots are 16 by 16 (the largest shipped blueprint is 11 by 14)
export const FIELD_SIZE = 9;        // the field is 9 by 9
export const BED_COUNT = 4;
export const KIT_SLOTS = 27;        // a single chest
export const WATER_REACH = 4;       // water keeps farmland wet up to 4 blocks away, diagonals included
// Upstream's chest skills use the nearest chest within 32 blocks, whichever it is
// (src/agent/library/skills.js lines 881, 910, 954), and an agent counts as arrived within 3.5
// blocks. Two registered chests closer than this can be mistaken for one another.
export const CHEST_SEPARATION = 8;
export const BUILD_HEIGHT = Object.freeze({ min: -64, max: 319 }); // the overworld

export const FACINGS = Object.freeze({
    north: { x: 0, z: -1 }, east: { x: 1, z: 0 }, south: { x: 0, z: 1 }, west: { x: -1, z: 0 },
});
export const CLOCKWISE = Object.freeze({ north: 'east', east: 'south', south: 'west', west: 'north' });
export const BED_COLORS = Object.freeze(['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray',
    'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black']);
const SINGLE_ITEM = /_(axe|pickaxe|shovel|hoe|sword|helmet|chestplate|leggings|boots)$/; // these do not stack

export const WORLD_PROBLEMS = Object.freeze([
    'bad_shape', 'wrong_version', 'rule_not_as_decided', 'wrong_range', 'missing_agent', 'unknown_owner',
    'zone_overlap', 'plot_wrong_size', 'plot_too_small_for_blueprint', 'unknown_blueprint', 'field_wrong_size',
    'outside_border', 'outside_owner_range', 'outside_camp', 'outside_build_height', 'bad_double_chest',
    'blocks_collide', 'chests_too_close', 'water_on_field_edge', 'field_not_watered', 'bad_kit',
    'off_camp_floor', 'kit_without_seeds',
]);

// What can be sown on the field: the seed of every crop the catalog knows.
export const SEED_ITEMS = Object.freeze(Object.values(CROPS).map((crop) => crop.seed));

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isBlock = (value, size) => Array.isArray(value) && value.length === size && value.every((n) => Number.isInteger(n));
const at = (p) => `[${p.join(', ')}]`;

// The seed as the text of a whole number, or null when it is not one.
export function seedText(seed) {
    if (typeof seed === 'number') return Number.isSafeInteger(seed) ? String(seed) : null;
    if (typeof seed === 'string' && /^-?\d{1,19}$/.test(seed.trim())) {
        try {
            const value = BigInt(seed.trim());
            return value >= -(2n ** 63n) && value < 2n ** 63n ? value.toString() : null;
        } catch { return null; }
    }
    return null;
}

// The world border as the block columns inside it: { min: {x, z}, max: {x, z} }, both included.
export function borderBox(border) {
    const half = border.size / 2;
    return {
        min: { x: Math.ceil(border.center[0] - half), z: Math.ceil(border.center[1] - half) },
        max: { x: Math.ceil(border.center[0] + half) - 1, z: Math.ceil(border.center[1] + half) - 1 },
    };
}

const flat = (box) => ({ min: { x: box.min[0], z: box.min[box.min.length - 1] }, max: { x: box.max[0], z: box.max[box.max.length - 1] } });
const flatOverlap = (a, b) => a.min.x <= b.max.x && b.min.x <= a.max.x && a.min.z <= b.max.z && b.min.z <= a.max.z;
const flatInside = (box, x, z) => x >= box.min.x && x <= box.max.x && z >= box.min.z && z <= box.max.z;
const corners = (box) => [[box.min.x, box.min.z], [box.min.x, box.max.z], [box.max.x, box.min.z], [box.max.x, box.max.z]];

// The second cell of a bed: the head lies in the direction the bed faces.
export const bedHead = (bed) => [bed.foot[0] + FACINGS[bed.facing].x, bed.foot[1], bed.foot[2] + FACINGS[bed.facing].z];

// The shape of the keys only "v": 2 has. Returns messages (all of them `bad_shape`).
function checkShape(config) {
    const out = [];
    if (seedText(config.seed) === null) out.push('"seed" must be a whole number (as a number, or as text for a 64-bit one)');
    if (config.dimension !== undefined && config.dimension !== 'overworld') out.push('"dimension" must be "overworld": the Nether and the End are disabled');
    if (!isBlock(config.home, 3)) out.push('"home" must be [x, y, z] in whole blocks');
    const border = config.border;
    if (!isPlainObject(border) || !isBlock(border.center, 2) || !Number.isInteger(border.size) || border.size <= 0) {
        out.push('"border" must be { "center": [x, z], "size": <blocks> } in whole blocks');
    }
    if (!isPlainObject(config.rules)) out.push('"rules" must be an object');
    else {
        for (const key of Object.keys(DECIDED_RULES)) if (!Object.hasOwn(config.rules, key)) out.push(`rules.${key} is missing`);
        for (const key of Object.keys(config.rules)) if (!Object.hasOwn(DECIDED_RULES, key)) out.push(`rules.${key} is not a rule this file knows`);
    }
    const camp = isPlainObject(config.camp) ? config.camp : {};
    if (camp.facing !== undefined && !Object.hasOwn(FACINGS, camp.facing)) out.push('camp.facing must be north, east, south or west');
    for (const key of ['shared_chest_second_half', 'crafting_table', 'furnace']) {
        if (!isBlock(camp[key], 3)) out.push(`camp.${key} must be [x, y, z] in whole blocks`);
    }
    if (!Array.isArray(camp.beds) || camp.beds.length !== BED_COUNT) out.push(`camp.beds must list ${BED_COUNT} beds`);
    else {
        camp.beds.forEach((bed, index) => {
            if (!isPlainObject(bed) || !isBlock(bed.foot, 3) || !Object.hasOwn(FACINGS, bed.facing ?? '')) {
                out.push(`camp.beds[${index}] must be { "foot": [x, y, z], "facing": "north" | "east" | "south" | "west" }`);
            } else if (bed.color !== undefined && !BED_COLORS.includes(bed.color)) {
                out.push(`camp.beds[${index}].color must be one of ${BED_COLORS.join(', ')}`);
            }
        });
    }
    for (const zone of ['camp', 'field']) {
        if (isPlainObject(config[zone]) && Array.isArray(config[zone].min) && (config[zone].min.length !== 2 || !isBlock(config[zone].min, 2) || !isBlock(config[zone].max, 2))) {
            out.push(`${zone}.min and ${zone}.max must be [x, z] in whole blocks`);
        }
    }
    const field = isPlainObject(config.field) ? config.field : {};
    if (!Number.isInteger(field.y)) out.push('field.y must be the layer of the farmland (a whole number)');
    if (!Array.isArray(field.water) || field.water.length === 0 || !field.water.every((cell) => isBlock(cell, 2))) {
        out.push('field.water must list at least one [x, z]');
    }
    if (field.crop !== undefined && field.crop !== null && !Object.hasOwn(CROPS, field.crop)) {
        out.push(`field.crop must be null or one of ${Object.keys(CROPS).join(', ')}`);
    }
    if (field.owner !== undefined && field.owner !== null && typeof field.owner !== 'string') out.push('field.owner must be an agent name or null');
    for (const [index, plot] of (config.plots ?? []).entries()) {
        if (!isBlock(plot.min, 3) || !isBlock(plot.max, 3)) out.push(`plots[${index}].min and .max must be [x, y, z] in whole blocks`);
    }
    for (const name of ['shared', 'kits']) {
        if (!isBlock(config.chests?.[name], 3)) out.push(`chests.${name} must be [x, y, z] in whole blocks`);
    }
    for (const [name, entry] of Object.entries(config.agents ?? {})) {
        if (!isBlock(entry?.home, 3)) out.push(`agents.${name}.home must be [x, y, z] in whole blocks`);
    }
    if (!Array.isArray(config.kits)) out.push('"kits" must be a list of { "item", "count" } (it may be empty)');
    return out;
}

// Problems with a world file (empty = fine). Never throws.
//   blueprints: { get(name) -> { blocks } | null }   without it, blueprints are not looked at
export function checkWorldConfig(config, { blueprints = null } = {}) {
    const problems = [];
    const add = (code, message) => problems.push({ code, message });

    const zone_problems = checkZonesConfig(config);
    if (zone_problems.length > 0) return zone_problems.map((message) => ({ code: 'bad_shape', message }));
    if (config.v !== WORLD_VERSION) {
        return [{ code: 'wrong_version', message: `"v" must be ${WORLD_VERSION}: the minimal "v": ${config.v} shape names the zones only and cannot be bootstrapped` }];
    }
    const shape = checkShape(config);
    if (shape.length > 0) return shape.map((message) => ({ code: 'bad_shape', message }));

    // ---- the rules, as decided ----
    for (const [key, decided] of Object.entries(DECIDED_RULES)) {
        if (config.rules[key] !== decided) add('rule_not_as_decided', `rules.${key} is ${JSON.stringify(config.rules[key])}, decided is ${JSON.stringify(decided)}`);
    }
    if (config.border.size !== DECIDED_BORDER_SIZE) add('rule_not_as_decided', `border.size is ${config.border.size}, decided is ${DECIDED_BORDER_SIZE}`);
    if (config.field.crop !== undefined && config.field.crop !== null) {
        add('rule_not_as_decided', `field.crop is ${JSON.stringify(config.field.crop)}, decided is a bare field (null): the bootstrap sows nothing, the agents plant the field from the seeds in the kit`);
    }

    // ---- the agents and their ranges ----
    for (const [agent, decided] of Object.entries(DECIDED_RANGES)) {
        const entry = config.agents[agent];
        if (!entry) add('missing_agent', `agents.${agent} is missing (home and range)`);
        else if (entry.range !== decided) add('wrong_range', `agents.${agent}.range is ${entry.range}, the routine "${ROUTINES[agent].name}" was decided for ${decided} blocks`);
    }
    const homes = Object.entries(config.agents).map(([name, entry]) => ({ name, home: { x: entry.home[0], z: entry.home[2] }, range: entry.range }));
    const agentNamed = (name) => homes.find((agent) => agent.name === name) ?? null;

    // ---- the zones: sizes and overlaps ----
    const camp = flat(config.camp);
    const field = flat(config.field);
    const size = (box) => ({ x: box.max.x - box.min.x + 1, z: box.max.z - box.min.z + 1 });
    if (size(field).x !== FIELD_SIZE || size(field).z !== FIELD_SIZE) {
        add('field_wrong_size', `the field is ${size(field).x} by ${size(field).z}, decided is ${FIELD_SIZE} by ${FIELD_SIZE}`);
    }
    if (flatOverlap(camp, field)) add('zone_overlap', 'the camp and the field overlap');
    const plots = (config.plots ?? []).map((plot) => ({ ...plot, flat: flat(plot) }));
    plots.forEach((plot, index) => {
        const where = `plot ${plot.id}`;
        const extent = size(plot.flat);
        if (extent.x !== PLOT_SIZE || extent.z !== PLOT_SIZE) add('plot_wrong_size', `${where} is ${extent.x} by ${extent.z}, plots are ${PLOT_SIZE} by ${PLOT_SIZE}`);
        if (flatOverlap(plot.flat, camp)) add('zone_overlap', `${where} overlaps the camp`);
        if (flatOverlap(plot.flat, field)) add('zone_overlap', `${where} overlaps the field`);
        for (const other of plots.slice(index + 1)) {
            if (flatOverlap(plot.flat, other.flat)) add('zone_overlap', `${where} overlaps plot ${other.id}`);
        }
        if (plot.blueprint && blueprints) {
            const blueprint = blueprints.get(plot.blueprint);
            if (!blueprint) add('unknown_blueprint', `${where}: there is no blueprint named "${plot.blueprint}"`);
            else {
                // (a prefab's layers set into the ground lie under the plot: they do not count against its height)
                const full = blueprintSize(blueprint);
                const needs = { ...full, y: full.y - (Number.isInteger(blueprint.below) ? blueprint.below : 0) };
                const has = { ...extent, y: plot.max[1] - plot.min[1] + 1 };
                if (needs.x > has.x || needs.y > has.y || needs.z > has.z) {
                    add('plot_too_small_for_blueprint', `${where} is ${has.x} by ${has.z} and ${has.y} high, the blueprint "${plot.blueprint}" needs ${needs.x} by ${needs.z} and ${needs.y} high`);
                }
            }
        }
        if (plot.owner) {
            const owner = agentNamed(plot.owner);
            if (!owner) add('unknown_owner', `${where}: its owner ${plot.owner} is not under "agents"`);
            else {
                const far = corners(plot.flat).map(([x, z]) => flatDistance(owner.home, { x, z })).reduce((a, b) => Math.max(a, b), 0);
                if (far > owner.range) add('outside_owner_range', `${where} reaches ${Math.ceil(far)} blocks from ${owner.name}'s home, outside the range of ${owner.range}`);
            }
        }
        // (the layer under a plot is its floor, which the bootstrap lays: it must exist too)
        if (plot.min[1] - 1 < BUILD_HEIGHT.min || plot.max[1] > BUILD_HEIGHT.max) add('outside_build_height', `${where} leaves the build height (${BUILD_HEIGHT.min} to ${BUILD_HEIGHT.max})`);
    });

    // ---- the blocks of the camp ----
    const facing = config.camp.facing ?? 'south';
    const shared = config.chests.shared;
    const second = config.camp.shared_chest_second_half;
    const cells = [
        { what: 'chests.shared', pos: shared }, { what: 'camp.shared_chest_second_half', pos: second },
        { what: 'chests.kits', pos: config.chests.kits },
        { what: 'camp.crafting_table', pos: config.camp.crafting_table }, { what: 'camp.furnace', pos: config.camp.furnace },
    ];
    config.camp.beds.forEach((bed, index) => {
        cells.push({ what: `camp.beds[${index}] (foot)`, pos: bed.foot });
        cells.push({ what: `camp.beds[${index}] (head)`, pos: bedHead(bed) });
    });
    for (const cell of [...cells, { what: 'home', pos: config.home }]) {
        if (!flatInside(camp, cell.pos[0], cell.pos[2])) add('outside_camp', `${cell.what} at ${at(cell.pos)} is outside the camp`);
    }
    // the bootstrap levels the camp: its floor is the layer under the home point, and the camp's blocks stand on it
    for (const cell of cells) {
        if (cell.pos[1] !== config.home[1]) add('off_camp_floor', `${cell.what} at ${at(cell.pos)} does not stand on the camp's floor: its y must be ${config.home[1]}, the y of "home"`);
    }
    const seen = new Map();
    for (const cell of cells) {
        const key = cell.pos.join(',');
        if (seen.has(key)) add('blocks_collide', `${cell.what} and ${seen.get(key)} are both at ${at(cell.pos)}`);
        else seen.set(key, cell.what);
    }
    const step = { x: second[0] - shared[0], y: second[1] - shared[1], z: second[2] - shared[2] };
    const sideways = FACINGS[CLOCKWISE[facing]];
    const beside = step.y === 0 && ((step.x === sideways.x && step.z === sideways.z) || (step.x === -sideways.x && step.z === -sideways.z));
    if (!beside) add('bad_double_chest', `camp.shared_chest_second_half at ${at(second)} must be right beside chests.shared at ${at(shared)}, to the left or right of the way the chest faces (${facing})`);
    for (const half of [shared, second]) {
        const gap = Math.hypot(half[0] - config.chests.kits[0], half[1] - config.chests.kits[1], half[2] - config.chests.kits[2]);
        if (gap < CHEST_SEPARATION) {
            add('chests_too_close', `chests.kits is ${gap.toFixed(1)} blocks from the shared chest: closer than ${CHEST_SEPARATION} blocks an agent can take one for the other`);
            break;
        }
    }
    for (const [name, pos] of Object.entries(config.chests)) {
        for (const agent of homes) {
            const far = flatDistance(agent.home, { x: pos[0], z: pos[2] });
            if (far > agent.range) add('outside_owner_range', `chests.${name} is ${Math.ceil(far)} blocks from ${agent.name}'s home, outside the range of ${agent.range}`);
        }
    }

    // ---- the field ----
    const field_y = config.field.y;
    for (const [x, z] of config.field.water) {
        if (!flatInside(field, x, z)) add('water_on_field_edge', `field.water [${x}, ${z}] is outside the field`);
        else if (x === field.min.x || x === field.max.x || z === field.min.z || z === field.max.z) {
            add('water_on_field_edge', `field.water [${x}, ${z}] is on the edge of the field: the water would run out`);
        }
    }
    let dry = 0;
    for (let x = field.min.x; x <= field.max.x; x++) {
        for (let z = field.min.z; z <= field.max.z; z++) {
            if (!config.field.water.some(([wx, wz]) => Math.max(Math.abs(wx - x), Math.abs(wz - z)) <= WATER_REACH)) dry++;
        }
    }
    if (dry > 0) add('field_not_watered', `${dry} cells of the field are more than ${WATER_REACH} blocks from water`);
    if (config.field.owner) {
        const owner = agentNamed(config.field.owner);
        if (!owner) add('unknown_owner', `field.owner ${config.field.owner} is not under "agents"`);
        else {
            const far = corners(field).map(([x, z]) => flatDistance(owner.home, { x, z })).reduce((a, b) => Math.max(a, b), 0);
            if (far > owner.range) add('outside_owner_range', `the field reaches ${Math.ceil(far)} blocks from ${owner.name}'s home, outside the range of ${owner.range}`);
        }
    }

    // ---- heights ----
    for (const cell of [...cells, { what: 'home', pos: config.home }, { what: 'the camp\'s floor (under "home")', pos: [0, config.home[1] - 1, 0] },
        { what: 'field.y', pos: [0, field_y - 1, 0] }, { what: 'field.y', pos: [0, field_y + 1, 0] }]) {
        if (cell.pos[1] < BUILD_HEIGHT.min || cell.pos[1] > BUILD_HEIGHT.max) add('outside_build_height', `${cell.what} leaves the build height (${BUILD_HEIGHT.min} to ${BUILD_HEIGHT.max})`);
    }

    // ---- everything inside the world border ----
    const border = borderBox(config.border);
    const inside = (x, z) => flatInside(border, x, z);
    const outside = (what) => add('outside_border', `${what} lies outside the world border (${border.min.x}, ${border.min.z} to ${border.max.x}, ${border.max.z})`);
    if (!corners(camp).every(([x, z]) => inside(x, z))) outside('the camp');
    if (!corners(field).every(([x, z]) => inside(x, z))) outside('the field');
    for (const plot of plots) if (!corners(plot.flat).every(([x, z]) => inside(x, z))) outside(`plot ${plot.id}`);
    for (const cell of [...cells, { what: 'home', pos: config.home }]) if (!inside(cell.pos[0], cell.pos[2])) outside(`${cell.what} at ${at(cell.pos)}`);
    for (const [name, entry] of Object.entries(config.agents)) {
        const [x, , z] = entry.home;
        if (!inside(x, z)) outside(`agents.${name}.home`);
        else if (Number.isFinite(entry.range) && !(inside(x - entry.range, z - entry.range) && inside(x + entry.range, z + entry.range))) {
            outside(`the range of ${name} (${entry.range} blocks around its home)`);
        }
        for (const point of entry.patrol ?? []) if (!inside(point[0], point[2])) outside(`a patrol point of ${name} at ${at(point)}`);
    }

    // ---- the kit ----
    if (config.kits.length > KIT_SLOTS) add('bad_kit', `"kits" lists ${config.kits.length} stacks, a chest holds ${KIT_SLOTS}`);
    config.kits.forEach((stack, index) => {
        if (!isPlainObject(stack) || typeof stack.item !== 'string' || !/^[a-z0-9_]{1,60}$/.test(stack.item)) {
            add('bad_kit', `kits[${index}].item must be an item name such as "bread"`);
        } else if (!Number.isInteger(stack.count) || stack.count < 1 || stack.count > 64) {
            add('bad_kit', `kits[${index}].count must be 1 to 64`);
        } else if (SINGLE_ITEM.test(stack.item) && stack.count !== 1) {
            add('bad_kit', `kits[${index}]: ${stack.item} does not stack, list it once per piece`);
        }
    });
    // the field is left bare (decided): without seeds in the kit the agents could never plant it
    if (!config.kits.some((stack) => isPlainObject(stack) && SEED_ITEMS.includes(stack.item))) {
        add('kit_without_seeds', `"kits" holds no seeds (one of ${SEED_ITEMS.join(', ')}): the field is left bare, and the agents sow it from the kit`);
    }
    return problems;
}

// One line per problem, with its named reason.
export const describeProblem = (problem) => `${problem.message} [${problem.code}]`;

const canonical = (value) => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value !== null && typeof value === 'object') {
        return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
};

// The hash of a world file's content. It does not change with the spacing or the order of
// the keys, and changes with anything else.
export function worldHash(config) {
    return createHash('sha256').update(canonical(config), 'utf8').digest('hex');
}
