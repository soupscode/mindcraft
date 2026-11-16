// Genesis: the upstream skills a template step may call, and how a failed call gets a name.
//
// A step is { command, args }. `command` is one of the names below, and the step runner
// (genesis/adapters/bot_ops.js for a real bot, a fake in the tests) calls the upstream
// function of that name as  skills.<command>(bot, ...args).  Nothing else is ever called:
// a step whose command is not in this table is refused.
//
// Line numbers are those of src/agent/library/skills.js on the branch this was written on.
// No imports.

export const UPSTREAM_OPS = Object.freeze({
    goToPosition:      { file: 'src/agent/library/skills.js', line: 1194, args: ['x', 'y', 'z', 'min_distance'], timeout_min: 5, places_blocks: false },
    breakBlockAt:      { file: 'src/agent/library/skills.js', line: 563,  args: ['x', 'y', 'z'], timeout_min: 3, places_blocks: false },
    pickupNearbyItems: { file: 'src/agent/library/skills.js', line: 533,  args: [], timeout_min: 2, places_blocks: false },
    craftRecipe:       { file: 'src/agent/library/skills.js', line: 37,   args: ['itemName', 'num'], timeout_min: 3, places_blocks: false },
    putInChest:        { file: 'src/agent/library/skills.js', line: 871,  args: ['itemName', 'num'], timeout_min: 3, places_blocks: false },
    takeFromChest:     { file: 'src/agent/library/skills.js', line: 900,  args: ['itemName', 'num'], timeout_min: 3, places_blocks: false },
    viewChest:         { file: 'src/agent/library/skills.js', line: 946,  args: [], timeout_min: 3, places_blocks: false },
    tillAndSow:        { file: 'src/agent/library/skills.js', line: 1589, args: ['x', 'y', 'z', 'seedType'], timeout_min: 3, places_blocks: false },
    placeBlock:        { file: 'src/agent/library/skills.js', line: 613,  args: ['blockType', 'x', 'y', 'z'], timeout_min: 3, places_blocks: true },
    smeltItem:         { file: 'src/agent/library/skills.js', line: 143,  args: ['itemName', 'num'], timeout_min: 10, places_blocks: false },
    // the direct hand-over of items to another agent (genesis/relay): walks up to the player and tosses the items
    giveToPlayer:      { file: 'src/agent/library/skills.js', line: 1000, args: ['itemType', 'username', 'num'], timeout_min: 3, places_blocks: false },
});

export const OP_NAMES = Object.freeze(Object.keys(UPSTREAM_OPS));

// Steps that are NOT an upstream skill: Genesis code in the agent's own process carries them out
// (genesis/agent/runtime.js hands them on; the step runner of a bot never sees them).
//   relayMessage   the one step of an ask_agent or offer_agent goal: a structured request or offer
//                  goes to the relay through the agent's message desk (genesis/relay/desk.js, sendStep)
export const LOCAL_OPS = Object.freeze({
    relayMessage: { file: 'genesis/relay/desk.js', args: ['type', 'to', 'item', 'count'], places_blocks: false },
});
export const MESSAGE_STEP = 'relayMessage';
// Every command a template step may name.
export const STEP_NAMES = Object.freeze([...OP_NAMES, ...Object.keys(LOCAL_OPS)]);

// craftRecipe and smeltItem place a crafting table or a furnace from the inventory when
// none is within 16 blocks (skills.js lines 56-69 and 162-169). The templates never let
// that happen: their step guard refuses the step unless one stands within this distance.
export const STATION_RANGE = 16;

// The blocks upstream's placeBlock treats as an empty cell (skills.js line 708). Anything
// else is occupied, and upstream would break it first (lines 709-715): the build template
// refuses such a cell instead.
export const EMPTY_BLOCKS = Object.freeze(['air', 'water', 'lava', 'grass', 'short_grass', 'tall_grass', 'snow', 'dead_bush', 'fern']);

export const isEmptyBlock = (name) => name === null || name === undefined || EMPTY_BLOCKS.includes(name);

// Failure reasons every template can end with, besides its own.
export const COMMON_FAILURES = Object.freeze([
    'no_safe_path', 'not_reached', 'interrupted', 'timed_out', 'skill_error', 'unknown_command',
    'scaffold_left_in_zone', 'protected_zone', 'out_of_range',
]);

// Text upstream logs when a skill fails, and the reason it stands for. First match wins.
// [pattern, reason, where upstream logs it]
const LOG_REASONS = [
    [/no_safe_path/, 'no_safe_path', 'genesis/lib/no_dig_pathing.js'],
    [/Don't have right tools/, 'wrong_tool', 'skills.js:598'],
    [/Could not find a chest nearby/, 'no_chest', 'skills.js:883, 912, 956'],
    [/Could not find any \S+ in the chest/, 'ledger_stale', 'skills.js:921'],
    [/You do not have any \S+ to put in the chest/, 'not_held', 'skills.js:888'],
    [/does not have a crafting recipe/, 'no_recipe', 'skills.js:49'],
    [/requires a crafting table/, 'no_table_near', 'skills.js:77'],
    [/You do not have the resources to craft/, 'missing_ingredients', 'skills.js:86'],
    [/Cannot smelt /, 'not_smeltable', 'skills.js:156'],
    [/There is no furnace nearby/, 'no_furnace_near', 'skills.js:175'],
    [/The furnace is currently smelting/, 'furnace_busy', 'skills.js:191'],
    [/You do not have enough \S+ to smelt/, 'not_held', 'skills.js:199'],
    [/You have no fuel to smelt/, 'no_fuel', 'skills.js:209'],
    [/You don't have enough \S+ to smelt/, 'not_enough_fuel', 'skills.js:219'],
    [/Failed to smelt|Only smelted/, 'smelt_incomplete', 'skills.js:265, 269'],
    [/Cannot till/, 'cannot_till', 'skills.js:1619, 1644'],
    [/No \S+ to plant/, 'no_seed', 'skills.js:1656'],
    [/Don't have any \S+ to place/, 'missing_materials', 'skills.js:699'],
    [/block in the way/, 'cell_occupied', 'skills.js:713'],
    [/nothing to place on/, 'nothing_to_place_on', 'skills.js:751'],
    [/Failed to place/, 'place_failed', 'skills.js:788'],
    [/Skipping block at/, 'block_gone', 'skills.js:606'],
    [/You cannot give items to yourself/, 'self_handoff', 'skills.js:1012'],
    [/Could not find [A-Za-z0-9_]{3,16}\.$/m, 'recipient_not_near', 'skills.js:1017'],
    [/it was never received|too close\./, 'not_received', 'skills.js:1042, 1067'],
    [/You do not have any \S+ to discard/, 'not_held', 'skills.js:861'],
    [/Unable to reach|Pathfinding stopped|Missing coordinates/, 'not_reached', 'skills.js:1208, 1222, 1241, 1245'],
    [/message_rejected: /, 'message_rejected', 'genesis/relay/desk.js'],
    [/!!Code threw exception!!/, 'skill_error', 'src/agent/action_manager.js'],
];

// The named reason for a step that did not succeed.
//   result: { ok, interrupted, timedout, output }
export function classifyFailure(command, result) {
    if (!Object.hasOwn(UPSTREAM_OPS, command) && !Object.hasOwn(LOCAL_OPS, command)) return 'unknown_command';
    if (result?.timedout === true) return 'timed_out';
    if (result?.interrupted === true) return 'interrupted';
    const output = String(result?.output ?? '');
    for (const [pattern, reason] of LOG_REASONS) {
        if (pattern.test(output)) return reason;
    }
    return `${command}_failed`;
}
