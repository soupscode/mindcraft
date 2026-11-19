// Genesis: the nine skill templates of the catalog (the eight of the first catalog, and
// sow_field, added when the starter field was decided to be left bare).
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
//   after(step, result, args, state, ctx, baseline)   bookkeeping after a step; may return { fail: reason },
//                                       or { ok: true } when the step did what it was for whatever the skill answered
//   progress(args, state, ctx, baseline, plan) -> { done, total }
//   release(args, state)                (optional) the goal ended, however it ended: give back what it held
//                                       (fetch_items frees its reservation in the chest ledger)
//
// Beside the nine: give_items (the hand-over of a commitment) and the two messages the planner
// may choose to send, ask_agent and offer_agent (decided). They have the same shape.
//
// ctx.contested(claim): told when an agent wants items another agent has reserved in the
// chest ledger: { chest, item, count, holder, held, asker, in_chest }. Never a silent failure.
//
// ctx.known(item): is the item something the catalog knows (a drop of what it gathers, something
// it crafts, a seed or the produce of a crop it farms).
//
// state: { agent, view, zones, ledger, blueprints, avoid, duties?, talk? }
//   duties: [{ to, item, count }]   what the agent agreed to hand over (genesis/relay/desk.js)
//   talk:   the message desk's view, or null without one: { open, max_open, sent, max_sent,
//           spare(item), waiting(type, to, item), repeated(type, to, item, count) }
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
import { parseChestView, contestedClaim } from './ledger.js';

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

// A patrol waypoint is a column: its nominal height is the home's, which on real land is inside a hill or
// in the air ("no way to the goal without breaking blocks"). Where the land is known (the chunk is loaded)
// the waypoint is put on the ground: the nearest height within 12 blocks where one can stand. Where it is
// not known the nominal point stays.
const PASSABLE = new Set(['air', 'cave_air', 'short_grass', 'tall_grass', 'fern', 'large_fern', 'snow', 'dandelion', 'poppy', 'torch']);
const WET = new Set(['water', 'lava']);
export function onGround(state, pos, reach = 12) {
    try {
        const at = (y) => state.view.blockAt({ x: pos.x, y, z: pos.z });
        for (let step = 0; step <= 2 * reach; step++) {
            const y = pos.y + (step % 2 === 1 ? (step + 1) / 2 : -step / 2);
            const [under, feet, head] = [at(y - 1), at(y), at(y + 1)];
            if (!under || !feet || !head) return pos; // not loaded: nothing is known
            if (!PASSABLE.has(under.name) && !WET.has(under.name) && PASSABLE.has(feet.name) && PASSABLE.has(head.name)) return { ...pos, y };
        }
    } catch { /* a view that cannot be read: the nominal point */ }
    return pos;
}

const travel = {
    name: 'travel',
    progress_unit: 'blocks covered',
    failures: ['unknown_place', 'out_of_range', 'avoid_area', 'already_there', 'ledger_fresh', 'no_safe_path', 'path_unknown', 'path_leaves_range', 'wrong_chest', 'no_chest'],
    id: (args) => `travel:${args.place}`,
    parse: (parts) => (parts.length === 1 && /^[A-Za-z0-9_-]{1,60}$/.test(parts[0]) ? { place: parts[0] } : null),
    place(args, state) {
        const place = state.zones.places(state.agent).find((entry) => entry.id === args.place) ?? null;
        return place && place.kind === 'patrol' ? { ...place, pos: onGround(state, place.pos) } : place;
    },
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
    // what the goal uses up of what the agent carries: [{ want, count }] (asked by the message desk: genesis/relay/desk.js)
    needs(args, state) {
        const one = state.view.ingredients?.(args.item) ?? null;
        return one ? Object.entries(one).map(([want, count]) => ({ want, count: count * args.count })) : [];
    },
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

// What the agent may still take: the count in the ledger less what other agents have reserved.
const freeFor = (state, chest, item) => state.ledger.available(chest, item, state.agent, state.now);

// Reserves the items for this agent, so that no second agent is sent after them. When
// another agent holds them the step does not fail silently: the catalog is told a contested
// claim (who wanted what, and who holds it), and the reason is named.
function reserveGuard(args, state, ctx) {
    const got = state.ledger.reserve(args.chest, args.item, args.count, state.agent, state.now);
    if (got.ok || got.code !== 'contested') return null; // an empty ledger is for the chest itself to confirm
    ctx.contested(got.claim);
    return { fail: 'contested_claim' };
}

const fetch_items = {
    name: 'fetch_items',
    progress_unit: 'items taken',
    failures: ['ledger_empty', 'contested_claim', 'inventory_full', 'unknown_chest', 'chest_unreachable', 'out_of_range', 'avoid_area', 'wrong_chest', 'no_chest', 'ledger_stale'],
    id: (args) => `fetch_items:${args.chest}:${args.item}:${args.count}`,
    parse(parts) {
        const count = whole(parts[2] ?? '');
        return parts.length === 3 && /^[A-Za-z0-9_-]{1,40}$/.test(parts[0]) && ITEM.test(parts[1]) && count >= 1 && count <= 64
            ? { chest: parts[0], item: parts[1], count } : null;
    },
    // only what nobody else has reserved is put forward
    candidates(state, ctx) {
        const list = [];
        for (const chest of state.zones.chests()) {
            for (const item of Object.keys(state.ledger.stock(chest.name))) {
                const stock = freeFor(state, chest.name, item);
                if (stock > 0) list.push({ chest: chest.name, item, stock });
            }
        }
        return list.sort((a, b) => b.stock - a.stock || a.item.localeCompare(b.item))
            .map(({ chest, item, stock }) => ({ chest, item, count: Math.min(stock, ctx.config.fetch_count) }));
    },
    check(args, state, ctx) {
        const in_chest = state.ledger.count(args.chest, args.item);
        if (in_chest <= 0) return 'ledger_empty';
        if (freeFor(state, args.chest, args.item) <= 0) {
            // the items are there, but another agent has reserved them all: a contested claim
            const holders = new Map();
            for (const held of state.ledger.reservations(state.now)) {
                if (held.chest === args.chest && held.item === args.item && held.holder !== state.agent) holders.set(held.holder, (holders.get(held.holder) ?? 0) + held.count);
            }
            ctx.contested(contestedClaim({ chest: args.chest, item: args.item, count: args.count, asker: state.agent, in_chest, held_by: holders }));
            return 'contested_claim';
        }
        if (state.view.freeSlots() < 1) return 'inventory_full';
        return chestRefusal(state, args.chest, ctx);
    },
    title: (args) => clip(`Fetch ${args.count} ${args.item} from the ${args.chest} chest`),
    describe: (args, state) => `Take up to ${args.count} ${args.item} from the ${args.chest} chest (the ledger says ${state.ledger.count(args.chest, args.item)}, ${freeFor(state, args.chest, args.item)} not reserved by others)`,
    steps: (args, state, ctx) => [walkTo(state.zones.chest(args.chest), ctx), { command: 'takeFromChest', args: [args.item, args.count] }],
    baseline: (args, state) => ({ had: held(state, args.item) }),
    before(step, args, state, ctx) {
        // reserved when the agent sets out, and again right before it takes (a reservation lapses)
        const refused = reserveGuard(args, state, ctx);
        if (refused) return refused;
        if (step.command !== 'takeFromChest') return null;
        if (state.view.freeSlots() < 1) return { fail: 'inventory_full' };
        return chestGuard(state, args.chest, ctx);
    },
    after(step, result, args, state, ctx, baseline) {
        if (step.command !== 'takeFromChest') return null;
        state.ledger.release(args.chest, args.item, state.agent); // taken or not, the claim is over
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
    // The goal ended, however it ended: what it had reserved is free again.
    release(args, state) { state.ledger.release(args.chest, args.item, state.agent); },
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

// ---- sow_field ---------------------------------------------------------------------------

// The starter field is left bare (decided): tilled farmland with its water, and nothing on
// it. The agents plant it. Sowing is the upstream skill harvest_replant sows back with
// (tillAndSow, skills.js line 1589). Upstream sows only where the cell above the soil is
// exactly air: with anything else standing on farmland it answers true and plants nothing
// (skills.js lines 1625-1629), so "unsown" is read the same way here.
const cropOfSeed = (ctx, seed) => Object.keys(ctx.crops).find((crop) => ctx.crops[crop].seed === seed) ?? null;
const isBare = (state, soil) => state.view.blockAt({ x: soil.x, y: soil.y + 1, z: soil.z })?.name === 'air';

// The farmland of the field that has nothing on it and that the agent may go to, nearest first.
function bareFarmland(state) {
    const field = state.zones.field();
    const here = state.view.position();
    return state.view.findBlocks(['farmland'], 64, 512)
        .filter((soil) => boxContains(field, soil) && state.zones.inRange(state.agent, soil) && !avoided(state, soil) && isBare(state, soil))
        .sort((a, b) => dist(here, a) - dist(here, b));
}

const sow_field = {
    name: 'sow_field',
    progress_unit: 'cells sown',
    failures: ['unknown_seed', 'no_bare_farmland', 'no_seed', 'outside_field', 'cannot_till'],
    id: (args) => `sow_field:${args.seed}`,
    parse: (parts) => (parts.length === 1 && ITEM.test(parts[0]) ? { seed: parts[0] } : null),
    // one candidate per kind of seed the agent holds, in the order of the crop table
    candidates: (state, ctx) => Object.values(ctx.crops).map((crop) => crop.seed).filter((seed) => held(state, seed) > 0).map((seed) => ({ seed })),
    check(args, state, ctx) {
        if (!cropOfSeed(ctx, args.seed)) return 'unknown_seed';
        if (bareFarmland(state).length === 0) return 'no_bare_farmland';
        if (held(state, args.seed) <= 0) return 'no_seed';
        return null;
    },
    title: (args) => clip(`Sow the field with ${args.seed}`),
    describe(args, state, ctx) {
        const bare = bareFarmland(state).length;
        return `Sow ${Math.min(bare, held(state, args.seed), ctx.config.sow_batch)} of the ${bare} bare cells of the field with ${args.seed}`;
    },
    steps: (args, state, ctx) => bareFarmland(state)
        .slice(0, Math.min(ctx.config.sow_batch, held(state, args.seed)))
        .map((soil) => ({ command: 'tillAndSow', args: [soil.x, soil.y, soil.z, args.seed] })),
    baseline: () => ({}),
    before(step, args, state) {
        const [x, y, z, seed] = step.args;
        if (!boxContains(state.zones.field(), { x, y, z })) return { fail: 'outside_field' };
        // only farmland that is still bare is sown: tilling, and breaking what stands on the soil
        // (which tillAndSow does on its own, skills.js 1622-1632), are never this goal's
        if (state.view.blockAt({ x, y, z })?.name !== 'farmland') return { skip: 'not_farmland' };
        if (!isBare(state, { x, y, z })) return { skip: 'already_sown' };
        if (held(state, seed) <= 0) return { skip: 'no_seed' };
        return null;
    },
    after: () => null,
    progress(args, state, ctx, baseline, plan) {
        const total = (plan?.steps ?? []).filter((step) => step.command === 'tillAndSow').length;
        return { done: doneSteps(plan, 'tillAndSow'), total };
    },
};

// ---- build_blueprint ---------------------------------------------------------------------

// A blueprint may name a FAMILY where the world only has its members: upstream's construction files say
// "planks" and "log" (src/agent/npc/construction/small_wood_house.json: 55 and 8 cells), the world has
// oak_planks, birch_log, ... Seen on the live run: with the names compared as text nothing an agent held
// ever counted as building material, so no build was ever offered. Wherever an item is matched against
// what a blueprint wants, a family matches its members.
export const ITEM_FAMILIES = Object.freeze(Object.fromEntries(
    ['log', 'planks', 'sign', 'boat', 'fence_gate', 'door', 'fence', 'slab', 'stairs', 'button', 'pressure_plate', 'trapdoor', 'bed'].map((name) => [name, `_${name}`])));
// what a family is made from, one step back (doors from planks, planks from logs)
export const FAMILY_SOURCES = Object.freeze({ planks: ['log'], door: ['planks'], fence: ['planks'], fence_gate: ['planks'], slab: ['planks'], stairs: ['planks'], trapdoor: ['planks'], sign: ['planks'] });
// Is `name` what a blueprint means by `want`? The name itself, or a member of the family: "planks" is
// oak_planks, birch_planks, ...; "log" is any *_log (upstream: blockSatisfied in src/agent/npc/utils.js
// 73-84 with MATCHING_WOOD_BLOCKS of src/utils/mcdata.js 23-36, and "bed").
export const isMember = (want, name) => name === want || (Object.hasOwn(ITEM_FAMILIES, want) && String(name).endsWith(ITEM_FAMILIES[want]));
// The item of `stock` that can stand for `want`: the item itself, or the family's member held most.
export function memberHeld(stock, want) {
    if (!Object.hasOwn(ITEM_FAMILIES, want)) return stock[want] > 0 ? want : null;
    return Object.keys(stock).filter((item) => item.endsWith(ITEM_FAMILIES[want]) && stock[item] > 0).sort((a, b) => stock[b] - stock[a] || a.localeCompare(b))[0] ?? null;
}
const heldOf = (state, want) => Object.entries(state.view.inventory()).reduce((n, [item, count]) => n + (isMember(want, item) ? count : 0), 0);
// The members of what a blueprint wants that the catalog knows (to ask for, gather or craft): ["oak_planks", ...].
const membersKnown = (want, ctx) => (Object.hasOwn(ITEM_FAMILIES, want) ? ctx.knownItems().filter((item) => item.endsWith(ITEM_FAMILIES[want])) : (ctx.known(want) ? [want] : []));

// What upstream's blockSatisfied accepts for dirt (src/agent/npc/utils.js line 75), kept here.
const satisfied = (want, name) => isMember(want, name) || (want === 'dirt' && name === 'grass_block') || (want === 'torch' && String(name).includes('torch'));

// What the agent's own build is short of, and what leads to it (decided: the way to a first build must be
// reachable through offered options): { plot, items: Set of item names } or null when it has no build
// or nothing is missing. `items` holds the missing materials (every known member of a family) and what
// they are made from, one step back (logs for planks).
export function buildNeeds(state, ctx) {
    try {
        for (const plot of state.zones.plots()) {
            if (!plot.blueprint || plot.owner !== state.agent) continue;
            const survey = surveyPlot({ plot: plot.id }, state, ctx);
            if (!survey || !survey.fits) continue;
            const wanted = new Map();
            for (const cell of survey.work) if (cell.want !== 'air') wanted.set(cell.want, (wanted.get(cell.want) ?? 0) + 1);
            const items = new Set();
            for (const [want, count] of wanted) {
                if (heldOf(state, want) >= count) continue;
                // the material itself, and what it is made from, every step back (a door from planks, planks from logs)
                const chain = [want];
                for (const name of chain) for (const source of FAMILY_SOURCES[name] ?? []) if (!chain.includes(source)) chain.push(source);
                for (const name of chain) for (const item of membersKnown(name, ctx)) items.add(item);
            }
            if (items.size > 0) return { plot: plot.id, items };
        }
    } catch { /* a view that cannot be read: nothing is known about the build */ }
    return null;
}
// Does this option lead to one of those items? (what a gather yields, what is crafted, what is fetched)
export function leadsTo(skill, args, needs, ctx) {
    if (!needs) return false;
    if (skill === 'gather_blocks') return (ctx.gather_types[args.type]?.drops ?? []).some((item) => needs.items.has(item));
    if (skill === 'craft_item' || skill === 'fetch_items') return needs.items.has(args.item);
    return false;
}

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
        let item = null;
        if (cell.want !== 'air') {
            // the member of the family that is held ("planks" is built with the oak_planks in the inventory)
            item = memberHeld(stock, cell.want);
            if (!item) continue;
            stock[item]--;
        }
        batch.push({ ...cell, item });
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
            if (cell.want !== 'air') steps.push({ command: 'placeBlock', args: [cell.item ?? cell.want, cell.x, cell.y, cell.z] });
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
        // what the BLUEPRINT wants in this cell (a family, perhaps), not only the item this step would place:
        // a cell that already holds another member of the family matches
        const blueprint = plot.blueprint ? state.blueprints.get(plot.blueprint) : null;
        const cell = blueprint ? blueprintCells(plot, blueprint).find((c) => c.x === pos.x && c.y === pos.y && c.z === pos.z) : null;
        if (satisfied(cell?.want ?? want, block.name) || satisfied(want, block.name)) return { skip: 'already_matches' };
        // upstream's placeBlock breaks whatever is in the cell (skills.js 709-715): never hand it an occupied one
        if (!isEmptyBlock(block.name)) return { fail: 'cell_occupied' };
        if (held(state, want) <= 0) return { fail: 'missing_materials' };
        return { intend: [pos] };
    },
    after: () => null,
    // every cell that is still to build wants one of its material (a family name stands for all its members)
    needs(args, state, ctx) {
        const survey = surveyPlot(args, state, ctx);
        const wanted = new Map();
        for (const cell of survey?.work ?? []) if (cell.want !== 'air') wanted.set(cell.want, (wanted.get(cell.want) ?? 0) + 1);
        return [...wanted].map(([want, count]) => ({ want, count }));
    },
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

// ---- give_items (the hand-over of an agent-to-agent commitment; not one of the eight) -------

// Items go from one agent to another in two ways (decided: both): handed over directly when
// the two are near each other, and through the shared chest otherwise. The option only
// exists while there is something to give for: a commitment this agent has accepted
// (state.duties: a request it said yes to, or an offer of its own that was accepted). The list
// holds { to, item, count }; the agent runtime fills it (genesis/relay/desk.js), and without
// it nothing is ever offered. (Saying yes or no to a request is not done here: decided, the
// model decides that with a call of its own, and a code rule when it cannot.)
const sameGive = (args) => (entry) => entry.to === args.to && entry.item === args.item && entry.count === args.count;
const nearEnough = (args, state, ctx) => {
    const there = state.view.agentPosition?.(args.to) ?? null;
    return there !== null && dist(state.view.position(), there) <= ctx.config.handoff_distance;
};

const give_items = {
    name: 'give_items',
    progress_unit: 'items handed over',
    failures: ['no_commitment', 'not_held', 'unknown_chest', 'chest_unreachable', 'out_of_range', 'avoid_area', 'wrong_chest', 'no_chest', 'recipient_not_near', 'not_received'],
    id: (args) => `give_items:${args.to}:${args.item}:${args.count}`,
    parse(parts) {
        const count = whole(parts[2] ?? '');
        return parts.length === 3 && /^[A-Za-z0-9_]{3,16}$/.test(parts[0]) && ITEM.test(parts[1]) && count >= 1 && count <= 64
            ? { to: parts[0], item: parts[1], count } : null;
    },
    candidates: (state) => (state.duties ?? []).map(({ to, item, count }) => ({ to, item, count })),
    check(args, state, ctx) {
        if (args.to === state.agent) return 'no_commitment';
        if (!(state.duties ?? []).some(sameGive(args))) return 'no_commitment';
        if (held(state, args.item) < args.count) return 'not_held';
        if (nearEnough(args, state, ctx)) return null;
        return chestRefusal(state, ctx.config.handoff_chest, ctx);
    },
    title: (args) => clip(`Give ${args.count} ${args.item} to ${args.to}`),
    describe: (args, state, ctx) => `Give ${args.count} ${args.item} to ${args.to}, who asked for them (${nearEnough(args, state, ctx) ? 'handed over directly' : `through the ${ctx.config.handoff_chest} chest`})`,
    steps(args, state, ctx) {
        if (nearEnough(args, state, ctx)) return [{ command: 'giveToPlayer', args: [args.item, args.to, args.count] }];
        return [walkTo(state.zones.chest(ctx.config.handoff_chest), ctx), { command: 'putInChest', args: [args.item, args.count] }];
    },
    baseline: (args, state) => ({ had: held(state, args.item) }),
    before(step, args, state, ctx) {
        if (held(state, args.item) <= 0) return { fail: 'not_held' };
        if (step.command === 'putInChest') return chestGuard(state, ctx.config.handoff_chest, ctx);
        return null;
    },
    after(step, result, args, state, ctx, baseline) {
        const gone = Math.max(0, baseline.had - held(state, args.item));
        if (step.command === 'putInChest') {
            if (gone > 0) state.ledger.add(ctx.config.handoff_chest, args.item, gone);
            if (gone >= args.count) state.handedOver?.(args, { via: 'chest', chest: ctx.config.handoff_chest });
            return null;
        }
        if (step.command === 'giveToPlayer' && gone >= args.count) {
            // the items left the inventory towards the other agent: upstream only waits 3 seconds to
            // see them picked up (skills.js lines 1047-1067), which is not what decides here
            state.handedOver?.(args, { via: 'direct' });
            return { ok: true };
        }
        return null;
    },
    progress: (args, state, ctx, baseline) => ({ done: Math.min(args.count, Math.max(0, baseline.had - held(state, args.item))), total: args.count }),
};

// ---- ask_agent, offer_agent (messages the planner may choose to send; not skill templates) ----

// Decided: the planner can start agent-to-agent messages. Two options it may choose as goals:
//   ask_agent     request items from a named agent
//   offer_agent   offer items the agent holds to a named agent
// Each is ONE step, relayMessage, which hands a structured request or offer to the relay
// through the agent's message desk (genesis/relay/desk.js). The relay applies every one of its
// limits, as to any message; nothing here is free text, and the goal is done once the message
// was relayed (the answer comes later and is the desk's business).
//
// Offered only when (state.talk is the desk's view; without a desk nothing is ever offered):
//   - the other agent exists (the world file lists it) and is not the sender
//   - the agent has an open conversation slot and message budget left
//   - the same request or offer does not still wait for its answer, and the relay would not
//     block it as a repeat
//   - ask: the item is something the catalog knows (ctx.known). Decided: an agent may ask another for
//     ANYTHING the catalog knows (it was: blueprint materials and seeds only)
//   - offer: the items are held beyond the agent's own reserve (talk.spare)
// What is asked for is filled in by code: first what the agent's own work is short of right now
// (materials the blueprint of its plot still wants, seeds for the bare field), then everything
// else the catalog knows that the agent holds none of; never what a registered chest has for
// it. Any other known item can be asked for by its option id as well: the check is the same.
// What is offered: what the agent can spare, most first.
const AGENT_NAME = /^[A-Za-z0-9_]{3,16}$/;
const parseTalk = (parts) => {
    const count = whole(parts[2] ?? '');
    return parts.length === 3 && AGENT_NAME.test(parts[0]) && ITEM.test(parts[1]) && count >= 1 && count <= 64 ? { to: parts[0], item: parts[1], count } : null;
};
const MESSAGE_FAILURES = Object.freeze(['self_message', 'unknown_agent', 'no_messaging', 'no_conversation_slot', 'message_budget_spent', 'already_waiting', 'repeat_blocked',
    'relay_rate_limit', 'relay_repeat_blocked', 'relay_too_many_conversations', 'relay_recipient_busy', 'relay_unknown_recipient', 'relay_timeout', 'relay_not_connected']);

// The other agents, those in sight first (nearest first), then the rest in the order of the world file.
function otherAgents(state) {
    const here = state.view.position();
    return state.zones.agents().filter((name) => name !== state.agent)
        .map((name, index) => { const at = state.view.agentPosition?.(name) ?? null; return { name, index, far: at ? dist(here, at) : null }; })
        .sort((a, b) => (a.far === null ? 1 : 0) - (b.far === null ? 1 : 0) || (a.far ?? 0) - (b.far ?? 0) || a.index - b.index)
        .map((entry) => entry.name);
}

// Why this message may not be sent now, or null. `type` is request (ask_agent) or offer (offer_agent).
function talkRefusal(type, args, state) {
    if (args.to === state.agent) return 'self_message';
    if (!state.zones.agents().includes(args.to)) return 'unknown_agent';
    const talk = state.talk ?? null;
    if (!talk) return 'no_messaging';
    if (talk.open >= talk.max_open) return 'no_conversation_slot';
    if (talk.sent >= talk.max_sent) return 'message_budget_spent';
    if (talk.waiting(type, args.to, args.item)) return 'already_waiting';
    if (talk.repeated(type, args.to, args.item, args.count)) return 'repeat_blocked';
    return null;
}

// What the agent's own work is short of right now and no registered chest has, most wanted first: [{ item, count, why }].
function shortOf(state, ctx) {
    const needs = [];
    const add = (item, count, why) => {
        if (count <= 0 || needs.some((need) => need.item === item) || !ctx.known(item)) return;
        if (state.zones.chests().some((chest) => freeFor(state, chest.name, item) > 0)) return; // it can be fetched: no need to ask
        needs.push({ item, count: Math.min(count, ctx.config.ask_count), why });
    };
    // building: what the blueprint on the agent's plot still wants and the agent does not hold
    for (const plot of state.zones.plots()) {
        if (!plot.blueprint || (plot.owner !== null && plot.owner !== state.agent)) continue;
        const survey = surveyPlot({ plot: plot.id }, state, ctx);
        if (!survey || !survey.fits) continue;
        const wanted = new Map();
        for (const cell of survey.work) if (cell.want !== 'air') wanted.set(cell.want, (wanted.get(cell.want) ?? 0) + 1);
        // (a family is asked for by a member the catalog knows: "planks" as oak_planks)
        for (const [want, count] of [...wanted].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) add(membersKnown(want, ctx)[0] ?? want, count - heldOf(state, want), `plot ${plot.id}`);
    }
    // sowing: seeds, when the field (the agent's, or nobody's in particular) has bare cells and the agent holds none
    const field_owner = state.zones.fieldOwner?.() ?? null;
    const seeds = Object.values(ctx.crops).map((crop) => crop.seed);
    if ((field_owner === null || field_owner === state.agent) && heldAny(state, seeds) === 0) {
        const bare = bareFarmland(state).length;
        if (bare > 0) add(seeds[0], bare, 'the bare field');
    }
    return needs;
}

const relayStep = (type, args) => [{ command: 'relayMessage', args: [type, args.to, args.item, args.count] }];
// A message the relay (or the desk) did not take: the goal fails with the relay's own reason, and is not tried again.
function relayAfter(step, result) {
    if (step.command !== 'relayMessage' || result.ok) return null;
    const reason = /message_rejected: ([a-z_]+)/.exec(String(result.output ?? ''))?.[1] ?? 'no_answer';
    return { fail: reason.startsWith('relay_') ? reason : `relay_${reason}` };
}
const relayProgress = (args, state, ctx, baseline, plan) => ({ done: doneSteps(plan, 'relayMessage'), total: 1 });

const ask_agent = {
    name: 'ask_agent',
    progress_unit: 'messages sent',
    failures: [...MESSAGE_FAILURES, 'unknown_item'],
    id: (args) => `ask_agent:${args.to}:${args.item}:${args.count}`,
    parse: parseTalk,
    candidates(state, ctx) {
        if (!state.talk) return [];
        const others = otherAgents(state);
        if (others.length === 0) return [];
        const needs = shortOf(state, ctx);
        // the agent's own work first: each need to the two nearest
        const first = needs.flatMap((need) => others.slice(0, 2).map((to) => ({ to, item: need.item, count: need.count })));
        // then anything else the catalog knows that the agent has none of and cannot fetch, one agent each, taking turns
        const rest = ctx.knownItems().filter((item) => !needs.some((need) => need.item === item) && held(state, item) === 0
            && !state.zones.chests().some((chest) => freeFor(state, chest.name, item) > 0));
        const turn = rest.length > 0 ? Math.floor((state.now ?? 0) / ctx.config.ask_rotate_ms) % rest.length : 0;
        const any = [...rest.slice(turn), ...rest.slice(0, turn)].map((item, index) => ({ to: others[index % others.length], item, count: ctx.config.ask_any_count }));
        // the agents further away for the agent's own needs come before the rest of those
        const more = needs.flatMap((need) => others.slice(2).map((to) => ({ to, item: need.item, count: need.count })));
        return [...first, ...any.slice(0, 1), ...more, ...any.slice(1)];
    },
    check(args, state, ctx) {
        if (!ctx.known(args.item)) return 'unknown_item';
        return talkRefusal('request', args, state);
    },
    title: (args) => clip(`Ask ${args.to} for ${args.count} ${args.item}`),
    describe(args, state, ctx) {
        const why = shortOf(state, ctx).find((need) => need.item === args.item)?.why ?? null;
        return `Ask ${args.to} for ${args.count} ${args.item}${why ? ` (for ${why})` : ''}: ${args.to} may say no`;
    },
    steps: (args) => relayStep('request', args),
    baseline: () => ({}),
    before(step, args, state, ctx) {
        const refusal = ask_agent.check(args, state, ctx);
        return refusal ? { fail: refusal } : null;
    },
    after: relayAfter,
    progress: relayProgress,
};

const offer_agent = {
    name: 'offer_agent',
    progress_unit: 'messages sent',
    failures: [...MESSAGE_FAILURES, 'not_spare'],
    id: (args) => `offer_agent:${args.to}:${args.item}:${args.count}`,
    parse: parseTalk,
    candidates(state, ctx) {
        const talk = state.talk ?? null;
        if (!talk) return [];
        const others = otherAgents(state);
        return Object.keys(state.view.inventory())
            .map((item) => ({ item, spare: talk.spare(item) }))
            .filter((entry) => entry.spare > 0)
            .sort((a, b) => b.spare - a.spare || a.item.localeCompare(b.item))
            .flatMap((entry) => others.map((to) => ({ to, item: entry.item, count: Math.min(entry.spare, ctx.config.offer_count) })));
    },
    check(args, state) {
        const refusal = talkRefusal('offer', args, state);
        if (refusal) return refusal;
        // only what is held beyond the agent's own reserve is ever offered (its tools, and its food up to the reserve, stay)
        return state.talk.spare(args.item) >= args.count ? null : 'not_spare';
    },
    title: (args) => clip(`Offer ${args.count} ${args.item} to ${args.to}`),
    describe: (args, state) => `Offer ${args.count} of your ${held(state, args.item)} ${args.item} to ${args.to}: handed over if ${args.to} says yes`,
    steps: (args) => relayStep('offer', args),
    baseline: () => ({}),
    before(step, args, state) {
        const refusal = offer_agent.check(args, state);
        return refusal ? { fail: refusal } : null;
    },
    after: relayAfter,
    progress: relayProgress,
};

export const TEMPLATES = Object.freeze([travel, gather_blocks, craft_item, store_items, fetch_items, harvest_replant, sow_field, build_blueprint, smelt_item]);
// The messages the planner may choose to send as goals (decided). Not skill templates: their one step is Genesis's own.
export const MESSAGE_TEMPLATES = Object.freeze([ask_agent, offer_agent]);
// Templates beside the nine skill templates. They are only ever offered for a commitment.
export const HANDOFF_TEMPLATES = Object.freeze([give_items]);
export const TEMPLATE_NAMES = Object.freeze(TEMPLATES.map((template) => template.name));
export { COMMON_FAILURES };
