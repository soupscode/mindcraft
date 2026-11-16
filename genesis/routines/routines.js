// Genesis: the four role routines (decided).
//
//   Agent   Routine       Phases                                              Range
//   Arthur  Site upkeep   Kit check, Gather, Craft, Stockpile, Shelter        48 blocks
//   Mira    Field round   Kit check, Harvest, Bake, Stock, Shelter            32 blocks
//   Felix   Ring patrol   Kit check, Patrol, Forage, Return, Unload, Shelter  128 blocks
//   Nova    Stock round   Stocktake, Haul, Supply, Kits, Shelter              32 blocks
//
// A phase is { name, max_goals, pick(ctx) }. pick returns { option, why } or null (nothing
// to do here: on to the next phase). The option always comes from ctx.option() or
// ctx.firstCandidate(), that is from the action catalog with its preconditions checked;
// build_blueprint is never asked for, so a routine never places a block.
// The Shelter phase and the shared bounds are the engine's (genesis/routines/engine.js).
//
// The range is the one in the world config file (genesis.world.json, agents.<name>.range):
// checkRoutineRanges() reports a file that gives an agent another range than decided here.
// No imports.

const SHELTER_PHASE = { name: 'Shelter' };
const SHARED = 'shared';
const KITS = 'kits';

export const KIT_FOOD = Object.freeze({ item: 'bread', keep: 2, take: 4 });

// The tools each role carries. Read by the Kit check phase below and by the re-equip after a
// death (genesis/recovery/death.js): `suffix` is what the tool's name ends with, `craft` what
// the routine makes when the kit chest has none.
export const ROLE_KITS = Object.freeze({
    Arthur: Object.freeze([{ suffix: '_axe', craft: ['stone_axe', 'wooden_axe'] }, { suffix: '_pickaxe', craft: ['stone_pickaxe', 'wooden_pickaxe'] }]),
    Mira: Object.freeze([{ suffix: '_hoe', craft: ['stone_hoe', 'wooden_hoe'] }]),
    Felix: Object.freeze([{ suffix: '_sword', craft: ['stone_sword', 'wooden_sword'] }]),
    Nova: Object.freeze([]),
});

// The kit chest is read once per round, then a missing tool is fetched from it, or made,
// and some food is taken along (upstream's auto-eat eats it, src/agent/agent.js lines 191-195).
function kitCheck(tools) {
    return {
        name: 'Kit check',
        max_goals: tools.length + 2,
        pick(ctx) {
            const missing = tools.filter((tool) => !ctx.holdsSuffix(tool.suffix));
            const hungry = ctx.held(KIT_FOOD.item) < KIT_FOOD.keep;
            if (missing.length === 0 && !hungry) return null;
            if (ctx.zones.chest(KITS) && !ctx.memo.kits_read) {
                ctx.memo.kits_read = true;
                const look = ctx.option('travel', { place: `chest-${KITS}` });
                if (look) return { option: look, why: 'looking into the kit chest' };
            }
            for (const tool of missing) {
                const in_chest = Object.keys(ctx.ledger.stock(KITS)).find((item) => item.endsWith(tool.suffix));
                const fetched = in_chest ? ctx.option('fetch_items', { chest: KITS, item: in_chest, count: 1 }) : null;
                if (fetched) return { option: fetched, why: `fetching a ${tool.suffix.slice(1)} from the kit chest` };
                for (const item of tool.craft ?? []) {
                    const made = ctx.option('craft_item', { item, count: 1 });
                    if (made) return { option: made, why: `making a ${item}` };
                }
            }
            if (hungry) {
                const count = Math.min(KIT_FOOD.take, ctx.ledger.count(KITS, KIT_FOOD.item));
                const food = count > 0 ? ctx.option('fetch_items', { chest: KITS, item: KIT_FOOD.item, count }) : null;
                if (food) return { option: food, why: 'taking food from the kit chest' };
            }
            return null;
        },
    };
}

// What the agent carries and does not keep goes into a chest, most first. With `only`,
// exactly those items go (when `enough(ctx, item)` says there is enough to part with).
function unload(name, chest = SHARED, max_goals = 4, only = null, enough = () => true) {
    return {
        name,
        max_goals,
        pick(ctx) {
            if (only === null) {
                const option = ctx.firstCandidate('store_items', (args) => args.chest === chest);
                return option ? { option, why: `putting ${option.args.item} into the ${chest} chest` } : null;
            }
            for (const item of only) {
                if (ctx.held(item) <= 0 || !enough(ctx, item)) continue;
                const option = ctx.option('store_items', { chest, item });
                if (option) return { option, why: `putting ${item} into the ${chest} chest` };
            }
            return null;
        },
    };
}

function gather(name, types, max_goals, count = 8) {
    return {
        name,
        max_goals,
        pick(ctx) {
            for (const type of types) {
                const option = ctx.option('gather_blocks', { type, count });
                if (option) return { option, why: `gathering ${type}` };
            }
            return null;
        },
    };
}

export const ROUTINES = Object.freeze({
    Arthur: {
        name: 'Site upkeep',
        role: 'builder',
        food: KIT_FOOD.item,
        range: 48,
        phases: [
            kitCheck(ROLE_KITS.Arthur),
            gather('Gather', ['oak_log', 'birch_log', 'spruce_log', 'stone'], 2),
            {
                name: 'Craft',
                max_goals: 1,
                pick(ctx) {
                    // building stock: logs become planks, a few logs are kept as they are
                    for (const wood of ['oak', 'birch', 'spruce']) {
                        if (ctx.held(`${wood}_log`) < 4) continue;
                        const option = ctx.option('craft_item', { item: `${wood}_planks`, count: 4 });
                        if (option) return { option, why: `turning ${wood} logs into planks` };
                    }
                    return null;
                },
            },
            unload('Stockpile'),
            SHELTER_PHASE,
        ],
    },
    Mira: {
        name: 'Field round',
        role: 'farmer',
        food: KIT_FOOD.item,
        range: 32,
        phases: [
            kitCheck(ROLE_KITS.Mira),
            {
                name: 'Harvest',
                max_goals: 4,
                pick(ctx) {
                    const option = ctx.option('harvest_replant', {});
                    return option ? { option, why: 'the field has mature crops' } : null;
                },
            },
            {
                name: 'Bake',
                max_goals: 1,
                pick(ctx) {
                    const loaves = Math.min(8, Math.floor(ctx.held('wheat') / 3));
                    const option = loaves > 0 ? ctx.option('craft_item', { item: 'bread', count: loaves }) : null;
                    return option ? { option, why: 'baking bread from the wheat' } : null;
                },
            },
            // the produce goes to the shared chest; the seeds stay with the farmer
            unload('Stock', SHARED, 4, ['bread', 'wheat', 'carrot', 'potato', 'beetroot', 'baked_potato', 'wheat_seeds', 'beetroot_seeds'],
                (ctx, item) => (item === 'bread' ? ctx.held(item) >= 8 : !item.endsWith('_seeds') || ctx.held(item) >= 128)),
            SHELTER_PHASE,
        ],
    },
    Felix: {
        name: 'Ring patrol',
        role: 'explorer',
        food: KIT_FOOD.item,
        range: 128,
        phases: [
            kitCheck(ROLE_KITS.Felix),
            {
                name: 'Patrol',
                max_goals: 3,
                pick(ctx) {
                    // the next waypoint of the ring that can be walked to; one that cannot is passed over
                    const points = ctx.patrol.points();
                    for (let tried = 0; tried < points.length; tried++) {
                        const index = ctx.patrol.index();
                        ctx.patrol.advance();
                        const option = ctx.option('travel', { place: `ring-${index}` });
                        if (option) return { option, why: `patrolling to waypoint ${index + 1} of ${points.length}` };
                    }
                    return null;
                },
            },
            gather('Forage', ['sugar_cane', 'pumpkin', 'melon', 'brown_mushroom', 'red_mushroom', 'oak_log'], 1, 4),
            {
                name: 'Return',
                max_goals: 1,
                pick(ctx) {
                    const option = ctx.atHome() ? null : ctx.option('travel', { place: 'home' });
                    return option ? { option, why: 'bringing back what was found' } : null;
                },
            },
            unload('Unload'),
            SHELTER_PHASE,
        ],
    },
    Nova: {
        name: 'Stock round',
        role: 'merchant',
        food: KIT_FOOD.item,
        range: 32,
        phases: [
            {
                name: 'Stocktake',
                max_goals: 8,
                pick(ctx) {
                    // every registered chest is looked into once per round
                    ctx.memo.counted ??= [];
                    for (const chest of ctx.zones.chests()) {
                        if (ctx.memo.counted.includes(chest.name)) continue;
                        ctx.memo.counted.push(chest.name);
                        const option = ctx.option('travel', { place: `chest-${chest.name}` });
                        if (option) return { option, why: `counting the ${chest.name} chest` };
                    }
                    return null;
                },
            },
            {
                name: 'Haul',
                max_goals: 2,
                pick(ctx) {
                    // what lies in the outlying chests comes to the shared one
                    const option = ctx.firstCandidate('fetch_items', (args) => args.chest !== SHARED && args.chest !== KITS);
                    return option ? { option, why: `hauling ${option.args.item} from the ${option.args.chest} chest` } : null;
                },
            },
            unload('Supply'),
            {
                name: 'Kits',
                max_goals: 4,
                pick(ctx) {
                    if (!ctx.zones.chest(KITS)) return null;
                    for (const [item, want] of Object.entries(KIT_STOCK)) {
                        const lacking = want - ctx.ledger.count(KITS, item);
                        if (lacking <= 0) continue;
                        if (ctx.held(item) > 0) {
                            const put = ctx.option('store_items', { chest: KITS, item });
                            if (put) return { option: put, why: `restocking the kit chest with ${item}` };
                        }
                        const take = ctx.option('fetch_items', { chest: SHARED, item, count: Math.min(lacking, ctx.ledger.count(SHARED, item)) });
                        if (take) return { option: take, why: `taking ${item} for the kit chest` };
                    }
                    return null;
                },
            },
            SHELTER_PHASE,
        ],
    },
});

// What the kit chest should hold (Nova's Kits phase keeps it at this).
export const KIT_STOCK = Object.freeze({ bread: 8, torch: 8 });

export const routineFor = (agent) => ROUTINES[agent] ?? null;

// Problems when the world config gives an agent another range than its routine was decided for.
export function checkRoutineRanges(zones) {
    const problems = [];
    for (const [agent, routine] of Object.entries(ROUTINES)) {
        const range = zones.range(agent);
        if (range === null) problems.push(`world config: agents.${agent} is missing (home and range)`);
        else if (range !== routine.range) problems.push(`world config: agents.${agent}.range is ${range}, the routine "${routine.name}" was decided for ${routine.range} blocks`);
    }
    return problems;
}
