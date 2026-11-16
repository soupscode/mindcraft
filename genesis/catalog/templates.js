// Genesis: the eight skill templates of the first catalog.
//
// A template is the whole recipe for one kind of goal. Nothing in it is written by the
// model: the model only picks an option id, and everything else comes from here.
//   name, progress_unit, failures       the named failure reasons this template can end with
//   id(args) / parse(parts)             the stable option id and the way back from it
//   candidates(state, ctx) -> [args]    arguments filled in by code, from the world as it is
//   check(args, state, ctx)             the preconditions: null when they hold, else a reason
//   title(args) / describe(args, ...)   what the dashboard and the planner are shown
//   steps(args, state, ctx)             the ordered steps: [{ command, args }], each one call of
//                                       an upstream skill named in genesis/catalog/ops.js
//   baseline(args, state, ctx)          what progress is measured against, taken when the goal starts
//   before(step, args, state, ctx)      the guard run right before a step:
//                                       null (go on) | { skip: reason } | { fail: reason } |
//                                       { permit: { dig: true } }   the step may tunnel (never in a zone)
//                                       { intend: [pos] }           cells the step places on purpose
//   after(step, result, args, state, ctx, baseline)   bookkeeping after a step; may return { fail: reason }
//   progress(args, state, ctx, baseline, plan) -> { done, total }
//
// state: { agent, view, zones, ledger, blueprints, avoid }
//   view (the injected world view; genesis/adapters/bot_world.js for a real bot):
//     position() -> {x,y,z}             health(), food(), freeSlots() -> numbers
//     inventory() -> { item: count }    dayTicksLeft() -> game ticks of daylight left (0 at night)
//     blockAt(pos) -> { name, age? } | null (not loaded)
//     findBlocks(names, distance, count) -> [{ name, x, y, z, age? }]   nearest first
//     pathTo(pos, near) -> { status: 'ok' | 'partial' | 'none' | 'unknown', nodes?: [{x,y,z}] }   a path that digs nothing
//     recipe(item) -> { craftable, needs_table } | null (no such recipe)
//     canHarvest(block_name) -> boolean (a tool in the inventory harvests it)
//     fuel() -> { name, count, per_item } | null   isSmeltable(item) -> boolean
//   avoid: [{ x, y, z, radius }]  areas nothing may be aimed at (around a death point)
//
// Depends only on other files of genesis/catalog.

import { STATION_RANGE, COMMON_FAILURES, isEmptyBlock } from './ops.js';
import { boxContains, flatDistance } from './zones.js';
import { parseChestView } from './ledger.js';

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const held = (state, item) => state.view.inventory()[item] ?? 0;
const heldAny = (state, items) => items.reduce((n, item) => n + held(state, item), 0);
const whole = (text) => (/^\d{1,4}$/.test(text) ? Number(text) : null);
const ITEM = /^[a-z0-9_]{1,60}$/;
const clip = (text, max = 60) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);
const round = (n) => Math.max(0, Math.round(n));

// True when the spot lies in an area to avoid (around a death point). The camp is never
// avoided: after a death the agent has to get home and to its kit, wherever it died.
export function avoided(state, pos) {
    if ((state.avoid ?? []).length === 0) return false;
    if (state.zones.protectedAt(pos) === 'camp') return false;
    return state.avoid.some((area) => flatDistance(area, pos) <= area.radius);
}

// Why nothing may be aimed at this spot, or null.
function spotRefusal(state, pos) {
    if (state.zones.isProtected(pos)) return 'protected_zone';
    if (!state.zones.inRange(state.agent, pos)) return 'out_of_range';
    if (avoided(state, pos)) return 'avoid_area';
    return null;
}

// Why the agent cannot walk there without digging and without leaving its range, or null.
// A search that ran out of time but was getting there without digging ("partial") is
// accepted: walking never digs, so the worst case is a step that fails with no_safe_path.
function pathRefusal(state, target, near, ctx) {
    const here = state.view.position();
    if (dist(here, target) <= near + 1.5) return null;
    const path = state.view.pathTo(target, near);
    if (path?.status === 'none') return 'no_safe_path';
    if (path?.status !== 'ok' && !(path?.status === 'partial' && ctx.config.accept_partial_path)) return 'path_unknown';
    // an agent that is outside its range (after a respawn) may walk back in, but not further out
    const limit = Math.max(state.zones.range(state.agent) ?? 0, state.zones.distanceFromHome(state.agent, here)) + 1;
    if ((path.nodes ?? []).some((node) => state.zones.distanceFromHome(state.agent, node) > limit)) return 'path_leaves_range';
    return null;
}

// The registered chest must be the one upstream's chest skills will use: they take the
// nearest chest within 32 blocks (skills.js lines 881, 910, 954), whichever that is.
function chestGuard(state, chest_name, ctx) {
    const pos = state.zones.chest(chest_name);
    if (!pos) return { fail: 'unknown_chest' };
    const nearest = state.view.findBlocks(['chest'], ctx.config.chest_distance, 1)[0];
    if (!nearest) return { fail: 'no_chest' };
    if (dist(nearest, pos) > 1) return { fail: 'wrong_chest' }; // 1: the other half of a double chest
    return null;
}

function chestRefusal(state, chest_name, ctx) {
    const pos = state.zones.chest(chest_name);
    if (!pos) return 'unknown_chest';
    if (!state.zones.inRange(state.agent, pos)) return 'out_of_range';
    if (avoided(state, pos)) return 'avoid_area';
    const path = pathRefusal(state, pos, ctx.config.arrive_distance, ctx);
    return path ? 'chest_unreachable' : null;
}

const walkTo = (pos, ctx) => ({ command: 'goToPosition', args: [pos.x, pos.y, pos.z, ctx.config.arrive_distance] });
const doneSteps = (plan, command) => (plan?.steps ?? []).filter((step) => step.command === command && step.status === 'done').length;

// ---- travel ------------------------------------------------------------------------------

const travel = {
    name: 'travel',
    progress_unit: 'blocks covered',
    failures: ['unknown_place', 'out_of_range', 'avoid_area', 'already_there', 'ledger_fresh', 'no_safe_path', 'path_unknown', 'path_leaves_range', 'wrong_chest', 'no_chest'],
    id: (args) => `travel:${args.place}`,
    parse: (parts) => (parts.length === 1 && /^[A-Za-z0-9_-]{1,60}$/.test(parts[0]) ? { place: parts[0] } : null),
    place: (args, state) => state.zones.places(state.agent).find((place) => place.id === args.place) ?? null,
    candidates(state) {
        const here = state.view.position();
        const places = state.zones.places(state.agent);
        const fixed = places.filter((place) => place.kind !== 'patrol');
        // of the patrol waypoints only the two nearest that are not where the agent stands
        const ring = places.filter((place) => place.kind === 'patrol' && dist(here, place.pos) > 4)
            .sort((a, b) => dist(here, a.pos) - dist(here, b.pos)).slice(0, 2);
        return [...fixed, ...ring].map((place) => ({ place: place.id }));
    },
    check(args, state, ctx) {
        const place = travel.place(args, state);
        if (!place) return 'unknown_place';
        if (!state.zones.inRange(state.agent, place.pos)) return 'out_of_range';
        if (avoided(state, place.pos)) return 'avoid_area';
        if (place.kind === 'chest') {
            // going to a chest is how the ledger learns what is in it: worth doing from next to it too,
            // but not again while what the ledger knows is fresh
            const seen = state.ledger.seen_at(place.chest);
            const fresh = state.ledger.known(place.chest) && (!Number.isFinite(state.now) || state.now - seen < ctx.config.ledger_fresh_ms);
            if (fresh) return 'ledger_fresh';
        } else if (dist(state.view.position(), place.pos) <= ctx.config.arrive_distance + 1.5) {
            return 'already_there';
        }
        return pathRefusal(state, place.pos, ctx.config.arrive_distance, ctx);
    },
    title: (args) => clip(`Walk to ${args.place}`),
    describe(args, state) {
        const place = travel.place(args, state);
        const far = place ? round(dist(state.view.position(), place.pos)) : 0;
        return `Walk to ${args.place} (${far} blocks)${place?.kind === 'chest' ? ' and look into the chest' : ''}`;
    },
    steps(args, state, ctx) {
        const place = travel.place(args, state);
        const steps = [walkTo(place.pos, ctx)];
        if (place.kind === 'chest') steps.push({ command: 'viewChest', args: [] }); // arriving at a chest reads it into the ledger
        return steps;
    },
    baseline(args, state) {
        const place = travel.place(args, state);
        return { distance: round(dist(state.view.position(), place.pos)) };
    },
    before(step, args, state, ctx) {
        const place = travel.place(args, state);
        if (!place) return { fail: 'unknown_place' };
        if (step.command === 'viewChest') return chestGuard(state, place.chest, ctx);
        return null;
    },
    after(step, result, args, state) {
        if (step.command !== 'viewChest') return null;
        const contents = parseChestView(result.output);
        const place = travel.place(args, state);
        if (contents && place?.chest) state.ledger.set(place.chest, contents, Number.isFinite(state.now) ? state.now : 0);
        return null;
    },
    progress(args, state, ctx, baseline) {
        const place = travel.place(args, state);
        const left = place ? round(dist(state.view.position(), place.pos)) : baseline.distance;
        return { done: Math.min(baseline.distance, Math.max(0, baseline.distance - left)), total: baseline.distance };
    },
};

// ---- gather_blocks -----------------------------------------------------------------------

// The matching blocks the agent may break, nearest first, and why the others were left out.
function gatherTargets(args, state, ctx) {
    const type = ctx.gather_types[args.type];
    if (!type) return { targets: [], refused: [] };
    const found = state.view.findBlocks(type.blocks, ctx.config.gather_distance, 64);
    const targets = [];
    const refused = [];
    for (const block of found) {
        const reason = spotRefusal(state, block);
        if (reason) refused.push(reason); else targets.push(block);
    }
    return { targets, refused };
}

const gather_blocks = {
    name: 'gather_blocks',
    progress_unit: 'items gained',
    failures: ['unknown_type', 'night', 'inventory_full', 'wrong_tool', 'none_nearby', 'protected_zone', 'out_of_range', 'avoid_area', 'block_gone'],
    id: (args) => `gather_blocks:${args.type}:${args.count}`,
    parse(parts) {
        const count = whole(parts[1] ?? '');
        return parts.length === 2 && ITEM.test(parts[0]) && count >= 1 && count <= 64 ? { type: parts[0], count } : null;
    },
    candidates(state, ctx) {
        const here = state.view.position();
        return Object.keys(ctx.gather_types)
            .map((type) => ({ type, near: gatherTargets({ type }, state, ctx).targets[0] }))
            .filter((entry) => entry.near)
            .sort((a, b) => dist(here, a.near) - dist(here, b.near))
            .map((entry) => ({ type: entry.type, count: ctx.config.gather_count }));
    },
    check(args, state, ctx) {
        const type = ctx.gather_types[args.type];
        if (!type) return 'unknown_type';
        if (state.view.dayTicksLeft() <= 0) return 'night';
        if (state.view.freeSlots() < ctx.config.free_slots_needed) return 'inventory_full';
        const { targets, refused } = gatherTargets(args, state, ctx);
        // every matching block is where it may not be touched: say which rule it was
        if (targets.length === 0) return refused[0] ?? 'none_nearby';
        if (!targets.some((block) => state.view.canHarvest(block.name))) return 'wrong_tool';
        return null;
    },
    title: (args) => clip(`Gather ${args.count} ${args.type}`),
    describe(args, state, ctx) {
        const near = gatherTargets(args, state, ctx).targets[0];
        return `Gather up to ${args.count} ${args.type}${near ? ` (nearest ${round(dist(state.view.position(), near))} blocks away)` : ''}`;
    },
    steps(args, state, ctx) {
        const targets = gatherTargets(args, state, ctx).targets
            .filter((block) => state.view.canHarvest(block.name)).slice(0, args.count);
        const steps = targets.map((block) => ({ command: 'breakBlockAt', args: [block.x, block.y, block.z] }));
        steps.push({ command: 'pickupNearbyItems', args: [] });
        return steps;
    },
    baseline: (args, state, ctx) => ({ had: heldAny(state, ctx.gather_types[args.type]?.drops ?? []) }),
    before(step, args, state, ctx) {
        if (step.command !== 'breakBlockAt') return null;
        const [x, y, z] = step.args;
        const pos = { x, y, z };
        // checked again at every block: a plan read back from a checkpoint is not trusted either
        const refusal = spotRefusal(state, pos);
        if (refusal) return { fail: refusal };
        const block = state.view.blockAt(pos);
        if (!block || !(ctx.gather_types[args.type]?.blocks ?? []).includes(block.name)) return { skip: 'block_gone' };
        if (!state.view.canHarvest(block.name)) return { fail: 'wrong_tool' };
        return { permit: { dig: true } };
    },
    after: () => null,
    progress(args, state, ctx, baseline) {
        const gained = heldAny(state, ctx.gather_types[args.type]?.drops ?? []) - baseline.had;
        return { done: Math.max(0, gained), total: args.count };
    },
};

// ---- craft_item --------------------------------------------------------------------------

function tableRefusal(args, state) {
    const recipe = state.view.recipe(args.item);
    if (!recipe) return 'no_recipe';
    if (!recipe.craftable) return 'missing_ingredients';
    if (recipe.needs_table && state.view.findBlocks(['crafting_table'], STATION_RANGE, 1).length === 0) return 'no_table_near';
    return null;
}

const craft_item = {
    name: 'craft_item',
    progress_unit: 'items made',
    failures: ['no_recipe', 'missing_ingredients', 'no_table_near'],
    id: (args) => `craft_item:${args.item}:${args.count}`,
    parse(parts) {
        const count = whole(parts[1] ?? '');
        return parts.length === 2 && ITEM.test(parts[0]) && count >= 1 && count <= 64 ? { item: parts[0], count } : null;
    },
    candidates: (state, ctx) => ctx.craft_items.map(([item, count]) => ({ item, count })),
    check: (args, state) => tableRefusal(args, state),
    title: (args) => clip(`Craft ${args.item} x${args.count}`),
    describe: (args) => `Craft ${args.item} (recipe made ${args.count} time${args.count === 1 ? '' : 's'})`,
    steps: (args) => [{ command: 'craftRecipe', args: [args.item, args.count] }],
    baseline: (args, state) => ({ had: held(state, args.item) }),
    // craftRecipe would put down a crafting table of its own when none is near (skills.js 66-69)
    before(step, args, state) {
        const refusal = tableRefusal(args, state);
        return refusal ? { fail: refusal } : null;
    },
    after: () => null,
    progress: (args, state, ctx, baseline) => ({ done: Math.max(0, held(state, args.item) - baseline.had), total: null }),
};

// ---- store_items -------------------------------------------------------------------------

const store_items = {
    name: 'store_items',
    progress_unit: 'items stored',
    failures: ['not_held', 'unknown_chest', 'chest_unreachable', 'out_of_range', 'avoid_area', 'wrong_chest', 'no_chest'],
    id: (args) => `store_items:${args.chest}:${args.item}`,
    parse: (parts) => (parts.length === 2 && /^[A-Za-z0-9_-]{1,40}$/.test(parts[0]) && ITEM.test(parts[1]) ? { chest: parts[0], item: parts[1] } : null),
    candidates(state, ctx) {
        const chest = state.zones.chest('shared') ? 'shared' : state.zones.chests()[0]?.name;
        if (!chest) return [];
        return Object.entries(state.view.inventory())
            .filter(([item, count]) => count > 0 && !ctx.keep(item))
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .map(([item]) => ({ chest, item }));
    },
    check(args, state, ctx) {
        if (held(state, args.item) <= 0) return 'not_held';
        return chestRefusal(state, args.chest, ctx);
    },
    title: (args) => clip(`Store ${args.item} in the ${args.chest} chest`),
    describe: (args, state) => `Put all ${held(state, args.item)} ${args.item} into the ${args.chest} chest`,
    steps: (args, state, ctx) => [walkTo(state.zones.chest(args.chest), ctx), { command: 'putInChest', args: [args.item, -1] }],
    baseline: (args, state) => ({ had: held(state, args.item) }),
    before(step, args, state, ctx) {
        if (step.command !== 'putInChest') return null;
        if (held(state, args.item) <= 0) return { skip: 'not_held' };
        return chestGuard(state, args.chest, ctx);
    },
    after(step, result, args, state, ctx, baseline) {
        if (step.command !== 'putInChest') return null;
        const stored = baseline.had - held(state, args.item);
        state.ledger.add(args.chest, args.item, stored);
        return null;
    },
    progress: (args, state, ctx, baseline) => ({ done: Math.max(0, baseline.had - held(state, args.item)), total: baseline.had }),
};

// ---- fetch_items -------------------------------------------------------------------------

const fetch_items = {
    name: 'fetch_items',
    progress_unit: 'items taken',
    failures: ['ledger_empty', 'inventory_full', 'unknown_chest', 'chest_unreachable', 'out_of_range', 'avoid_area', 'wrong_chest', 'no_chest', 'ledger_stale'],
    id: (args) => `fetch_items:${args.chest}:${args.item}:${args.count}`,
    parse(parts) {
        const count = whole(parts[2] ?? '');
        return parts.length === 3 && /^[A-Za-z0-9_-]{1,40}$/.test(parts[0]) && ITEM.test(parts[1]) && count >= 1 && count <= 64
            ? { chest: parts[0], item: parts[1], count } : null;
    },
    candidates(state, ctx) {
        const list = [];
        for (const chest of state.zones.chests()) {
            for (const [item, count] of Object.entries(state.ledger.stock(chest.name))) {
                list.push({ chest: chest.name, item, stock: count });
            }
        }
        return list.sort((a, b) => b.stock - a.stock || a.item.localeCompare(b.item))
            .map(({ chest, item, stock }) => ({ chest, item, count: Math.min(stock, ctx.config.fetch_count) }));
    },
    check(args, state, ctx) {
        if (state.ledger.count(args.chest, args.item) <= 0) return 'ledger_empty';
        if (state.view.freeSlots() < 1) return 'inventory_full';
        return chestRefusal(state, args.chest, ctx);
    },
    title: (args) => clip(`Fetch ${args.count} ${args.item} from the ${args.chest} chest`),
    describe: (args, state) => `Take up to ${args.count} ${args.item} from the ${args.chest} chest (the ledger says ${state.ledger.count(args.chest, args.item)})`,
    steps: (args, state, ctx) => [walkTo(state.zones.chest(args.chest), ctx), { command: 'takeFromChest', args: [args.item, args.count] }],
    baseline: (args, state) => ({ had: held(state, args.item) }),
    before(step, args, state, ctx) {
        if (step.command !== 'takeFromChest') return null;
        if (state.view.freeSlots() < 1) return { fail: 'inventory_full' };
        return chestGuard(state, args.chest, ctx);
    },
    after(step, result, args, state, ctx, baseline) {
        if (step.command !== 'takeFromChest') return null;
        if (result.ok) {
            state.ledger.remove(args.chest, args.item, Math.max(0, held(state, args.item) - baseline.had));
            return null;
        }
        // the chest did not hold what the ledger said (skills.js line 921): the ledger learns it
        if (/Could not find any \S+ in the chest/.test(String(result.output ?? ''))) {
            state.ledger.zero(args.chest, args.item);
            return { fail: 'ledger_stale' };
        }
        return null;
    },
    progress: (args, state, ctx, baseline) => ({ done: Math.max(0, held(state, args.item) - baseline.had), total: args.count }),
};

// ---- harvest_replant ---------------------------------------------------------------------

const isMature = (block, ctx) => Boolean(block && ctx.crops[block.name] && Number.isFinite(block.age) && block.age >= ctx.crops[block.name].max_age);

function matureCrops(state, ctx) {
    const field = state.zones.field();
    return state.view.findBlocks(Object.keys(ctx.crops), 64, 512)
        .filter((block) => boxContains(field, block) && isMature(block, ctx) && !avoided(state, block));
}

const harvest_replant = {
    name: 'harvest_replant',
    progress_unit: 'plots replanted',
    failures: ['inventory_full', 'no_mature_crop', 'out_of_range', 'outside_field', 'crop_not_mature', 'no_seed', 'cannot_till'],
    id: () => 'harvest_replant:field',
    parse: (parts) => (parts.length === 1 && parts[0] === 'field' ? {} : null),
    candidates: () => [{}],
    check(args, state, ctx) {
        if (state.view.freeSlots() < ctx.config.free_slots_needed) return 'inventory_full';
        const crops = matureCrops(state, ctx);
        if (crops.length === 0) return 'no_mature_crop';
        if (!crops.some((block) => state.zones.inRange(state.agent, block))) return 'out_of_range';
        return null;
    },
    title: () => 'Harvest the field and replant',
    describe: (args, state, ctx) => `Harvest the ${matureCrops(state, ctx).length} mature crops in the field and replant them`,
    steps(args, state, ctx) {
        const here = state.view.position();
        const crops = matureCrops(state, ctx)
            .filter((block) => state.zones.inRange(state.agent, block))
            .sort((a, b) => dist(here, a) - dist(here, b))
            .slice(0, ctx.config.harvest_batch);
        const steps = [];
        for (const crop of crops) {
            steps.push({ command: 'breakBlockAt', args: [crop.x, crop.y, crop.z] });
            steps.push({ command: 'pickupNearbyItems', args: [] }); // the seeds to sow back lie on the ground
            steps.push({ command: 'tillAndSow', args: [crop.x, crop.y - 1, crop.z, ctx.crops[crop.name].seed] });
        }
        return steps;
    },
    baseline: () => ({}),
    before(step, args, state, ctx) {
        if (step.command === 'breakBlockAt') {
            const [x, y, z] = step.args;
            if (!boxContains(state.zones.field(), { x, y, z })) return { fail: 'outside_field' };
            // upstream breaks a crop at any age: only a mature one is ever handed to it
            if (!isMature(state.view.blockAt({ x, y, z }), ctx)) return { skip: 'crop_not_mature' };
            return null;
        }
        if (step.command === 'tillAndSow') {
            const [x, y, z, seed] = step.args;
            if (!boxContains(state.zones.field(), { x, y: y + 1, z })) return { fail: 'outside_field' };
            // tillAndSow breaks whatever stands on the soil (skills.js 1622-1632): only sow on a cleared plot
            if (!isEmptyBlock(state.view.blockAt({ x, y: y + 1, z })?.name ?? 'unknown')) return { skip: 'plot_not_cleared' };
            if (held(state, seed) <= 0) return { skip: 'no_seed' };
            return null;
        }
        return null;
    },
    after: () => null,
    progress(args, state, ctx, baseline, plan) {
        const total = (plan?.steps ?? []).filter((step) => step.command === 'tillAndSow').length;
        return { done: doneSteps(plan, 'tillAndSow'), total };
    },
};

// ---- build_blueprint ---------------------------------------------------------------------

// What upstream's blockSatisfied accepts for dirt (src/agent/npc/utils.js line 75), kept here.
const satisfied = (want, name) => name === want || (want === 'dirt' && name === 'grass_block');

// Every cell of the blueprint, in the world, lowest layer first. The blueprint has upstream's
// construction format (src/agent/npc/construction/*.json): blocks[y][z][x]. Its lowest
// layer lies on the plot's lowest layer and its corner on the plot's min corner.
function blueprintCells(plot, blueprint) {
    const cells = [];
    blueprint.blocks.forEach((layer, ry) => layer.forEach((row, rz) => row.forEach((want, rx) => {
        if (want === null || want === '') return;
        cells.push({ x: plot.min.x + rx, y: plot.min.y + ry, z: plot.min.z + rz, want });
    })));
    return cells;
}

// Sorts the cells into: matching, to clear, to place, not natural, not loaded.
function surveyPlot(args, state, ctx) {
    const plot = state.zones.plot(args.plot);
    const blueprint = plot?.blueprint ? state.blueprints.get(plot.blueprint) : null;
    if (!plot || !blueprint) return null;
    const survey = { plot, blueprint, total: 0, matching: 0, work: [], foreign: 0, unloaded: 0, fits: true };
    const size = { x: blueprint.blocks[0]?.[0]?.length ?? 0, y: blueprint.blocks.length, z: blueprint.blocks[0]?.length ?? 0 };
    survey.fits = size.x > 0 && plot.min.x + size.x - 1 <= plot.max.x && plot.min.y + size.y - 1 <= plot.max.y && plot.min.z + size.z - 1 <= plot.max.z;
    if (!survey.fits) return survey;
    for (const cell of blueprintCells(plot, blueprint)) {
        survey.total++;
        const block = state.view.blockAt(cell);
        if (!block) { survey.unloaded++; continue; }
        const empty = isEmptyBlock(block.name);
        if (cell.want === 'air' ? empty : satisfied(cell.want, block.name)) { survey.matching++; continue; }
        if (!empty && !ctx.natural(block.name)) { survey.foreign++; continue; }
        survey.work.push({ ...cell, clear: !empty });
    }
    return survey;
}

// The cells one goal works on: only what can be done with what is held now.
function buildBatch(survey, state, ctx) {
    const stock = { ...state.view.inventory() };
    const batch = [];
    for (const cell of survey.work) {
        if (batch.length >= ctx.config.build_batch) break;
        if (cell.want !== 'air') {
            if (!(stock[cell.want] > 0)) continue;
            stock[cell.want]--;
        }
        batch.push(cell);
    }
    return batch;
}

const build_blueprint = {
    name: 'build_blueprint',
    progress_unit: 'matching cells',
    failures: ['plot_not_registered', 'not_your_plot', 'plot_overlaps_zone', 'no_blueprint', 'blueprint_too_big', 'out_of_range',
        'plot_not_loaded', 'plot_not_natural', 'already_built', 'missing_materials', 'outside_plot', 'cell_occupied',
        'nothing_to_place_on', 'place_failed'],
    id: (args) => `build_blueprint:${args.plot}`,
    parse: (parts) => (parts.length === 1 && /^[A-Za-z0-9_-]{1,40}$/.test(parts[0]) ? { plot: parts[0] } : null),
    candidates: (state) => state.zones.plots()
        .filter((plot) => plot.blueprint && (plot.owner === null || plot.owner === state.agent))
        .map((plot) => ({ plot: plot.id })),
    check(args, state, ctx) {
        const plot = state.zones.plot(args.plot);
        if (!plot) return 'plot_not_registered'; // the build only ever happens on a registered plot
        if (plot.owner !== null && plot.owner !== state.agent) return 'not_your_plot';
        if (state.zones.plotOverlaps(args.plot).length > 0) return 'plot_overlaps_zone';
        if (!state.zones.inRange(state.agent, plot.min) || !state.zones.inRange(state.agent, plot.max)) return 'out_of_range';
        const survey = surveyPlot(args, state, ctx);
        if (!survey) return 'no_blueprint';
        if (!survey.fits) return 'blueprint_too_big';
        if (survey.unloaded > 0) return 'plot_not_loaded';
        if (survey.foreign > 0) return 'plot_not_natural';
        if (survey.work.length === 0) return 'already_built';
        if (buildBatch(survey, state, ctx).length === 0) return 'missing_materials';
        return null;
    },
    title: (args) => clip(`Build on plot ${args.plot}`),
    describe(args, state, ctx) {
        const survey = surveyPlot(args, state, ctx);
        if (!survey) return `Build on plot ${args.plot}`;
        return `Build ${buildBatch(survey, state, ctx).length} more cells of ${survey.blueprint.name ?? survey.plot.blueprint} on plot ${args.plot} (${survey.matching}/${survey.total} done)`;
    },
    steps(args, state, ctx) {
        const steps = [];
        for (const cell of buildBatch(surveyPlot(args, state, ctx), state, ctx)) {
            if (cell.clear) steps.push({ command: 'breakBlockAt', args: [cell.x, cell.y, cell.z] });
            if (cell.want !== 'air') steps.push({ command: 'placeBlock', args: [cell.want, cell.x, cell.y, cell.z] });
        }
        return steps;
    },
    baseline: () => ({}),
    before(step, args, state, ctx) {
        const plot = state.zones.plot(args.plot);
        if (!plot) return { fail: 'plot_not_registered' };
        const [x, y, z] = step.command === 'placeBlock' ? step.args.slice(1) : step.args;
        const pos = { x, y, z };
        if (!boxContains(plot, pos)) return { fail: 'outside_plot' };
        const block = state.view.blockAt(pos);
        if (!block) return { fail: 'plot_not_loaded' };
        if (step.command === 'breakBlockAt') {
            if (isEmptyBlock(block.name)) return { skip: 'already_clear' };
            // only the ground is ever cleared: something that was built is left alone
            return ctx.natural(block.name) ? null : { fail: 'plot_not_natural' };
        }
        const want = step.args[0];
        if (satisfied(want, block.name)) return { skip: 'already_matches' };
        // upstream's placeBlock breaks whatever is in the cell (skills.js 709-715): never hand it an occupied one
        if (!isEmptyBlock(block.name)) return { fail: 'cell_occupied' };
        if (held(state, want) <= 0) return { fail: 'missing_materials' };
        return { intend: [pos] };
    },
    after: () => null,
    progress(args, state, ctx) {
        const survey = surveyPlot(args, state, ctx);
        return survey ? { done: survey.matching, total: survey.total } : { done: 0, total: null };
    },
};

// ---- smelt_item --------------------------------------------------------------------------

function smeltRefusal(args, state) {
    // upstream refuses to start with fewer than `num` of the item (skills.js lines 197-203)
    if (held(state, args.item) < args.count) return 'not_held';
    if (!state.view.isSmeltable(args.item)) return 'not_smeltable';
    const fuel = state.view.fuel();
    if (!fuel) return 'no_fuel';
    // what upstream puts in: Math.ceil(num / output per fuel item) (skills.js line 216)
    if (fuel.count < Math.ceil(args.count / fuel.per_item)) return 'not_enough_fuel';
    return null;
}

const smelt_item = {
    name: 'smelt_item',
    progress_unit: 'items smelted',
    failures: ['not_held', 'not_smeltable', 'no_fuel', 'not_enough_fuel', 'no_furnace', 'furnace_unreachable', 'out_of_range',
        'avoid_area', 'no_furnace_near', 'furnace_busy', 'smelt_incomplete'],
    id: (args) => `smelt_item:${args.item}:${args.count}`,
    parse(parts) {
        const count = whole(parts[1] ?? '');
        return parts.length === 2 && ITEM.test(parts[0]) && count >= 1 && count <= 64 ? { item: parts[0], count } : null;
    },
    furnace: (state, ctx) => state.view.findBlocks(['furnace'], ctx.config.chest_distance, 1)[0] ?? null,
    candidates: (state, ctx) => Object.entries(state.view.inventory())
        .filter(([item, count]) => count > 0 && state.view.isSmeltable(item) && !item.includes('log') && !item.includes('planks'))
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([item, count]) => ({ item, count: Math.min(count, ctx.config.smelt_batch) })),
    check(args, state, ctx) {
        const refusal = smeltRefusal(args, state);
        if (refusal) return refusal;
        const furnace = smelt_item.furnace(state, ctx);
        if (!furnace) return 'no_furnace';
        const spot = spotRefusal(state, furnace);
        if (spot && spot !== 'protected_zone') return spot; // a furnace in the camp is fine: it is used, not broken
        return pathRefusal(state, furnace, ctx.config.arrive_distance, ctx) ? 'furnace_unreachable' : null;
    },
    title: (args) => clip(`Smelt ${args.count} ${args.item}`),
    describe: (args, state) => `Smelt ${args.count} ${args.item} in the nearest furnace, with ${state.view.fuel()?.name ?? 'fuel'}`,
    steps(args, state, ctx) {
        const furnace = smelt_item.furnace(state, ctx);
        return [walkTo(furnace, ctx), { command: 'smeltItem', args: [args.item, args.count] }];
    },
    baseline: (args, state) => ({ had: held(state, args.item) }),
    before(step, args, state) {
        if (step.command !== 'smeltItem') return null;
        const refusal = smeltRefusal(args, state);
        if (refusal) return { fail: refusal };
        // smeltItem would put down a furnace of its own when none is within 16 blocks (skills.js 162-169)
        if (state.view.findBlocks(['furnace'], STATION_RANGE, 1).length === 0) return { fail: 'no_furnace_near' };
        return null;
    },
    after: () => null,
    progress: (args, state, ctx, baseline) => ({ done: Math.max(0, baseline.had - held(state, args.item)), total: args.count }),
};

export const TEMPLATES = Object.freeze([travel, gather_blocks, craft_item, store_items, fetch_items, harvest_replant, build_blueprint, smelt_item]);
export const TEMPLATE_NAMES = Object.freeze(TEMPLATES.map((template) => template.name));
export { COMMON_FAILURES };
