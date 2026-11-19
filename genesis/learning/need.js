// Genesis learning: `need`, the part of an option's score that is COMPUTED BY CODE and never
// learned (genesis/learning/scorer.js:  score = need x p_ok x yield / minutes - risk x p_danger).
//
// The learner knows how likely an option is to work and how long it takes. It does not know
// what is worth doing: left to success per minute alone it would walk back and forth between
// the camp and the field (two seconds, never fails) and turn every plank into sticks. `need`
// says how much an option serves the agent's work, from its role and from what the routine's
// own rule would do right now. It is a weight, never a gate: every option the catalog offers
// stays eligible, and one in four choices goes to an uncertain option whatever its need
// (decided).
//
//   commitment   2      a hand-over the agent agreed to; a build that is under way
//   routine      1.5    what the role routine's own rule would pick right now (at least this)
//   build        1.5    what leads to the materials of the agent's own build
//   role         1.3    the work of the agent's role (the builder's logs and stone, the farmer's field, ...)
//   normal       1
//   some         0.6    useful now and then (looking into a chest, smelting)
//   low          0.3
//   idle         0.05   serves nothing by itself (a walk to the camp, a craft nothing asked for)
//
// PROPOSED VALUES, all of them: they shape what the agents do while the model is away, and
// have not been tuned against a real run.
//
// No imports.

export const NEED = Object.freeze({ commitment: 2, routine: 1.5, build: 1.5, role: 1.3, normal: 1, some: 0.6, low: 0.3, idle: 0.05 });

const TOOL = /_(pickaxe|axe|hoe|sword|shovel)$/;
const ROLE_GATHERS = Object.freeze({
    builder: ['oak_log', 'birch_log', 'spruce_log', 'stone', 'sand'],
    explorer: ['sugar_cane', 'pumpkin', 'melon', 'brown_mushroom', 'red_mushroom', 'coal_ore', 'iron_ore'],
    farmer: [], merchant: [],
});
const ROLE_CRAFTS = Object.freeze({
    builder: ['oak_planks', 'birch_planks', 'spruce_planks'],
    farmer: ['bread'], explorer: ['torch'], merchant: ['torch'],
});

// option: what the catalog offered ({ id, skill, args, description?, for_build? })
// role: builder | farmer | explorer | merchant | null      routine_pick: the option id the routine's own rule chose, or null
// holds(suffix) -> true when the agent holds an item whose name ends so (a tool it already has is not made again)
export function needOf(option, { role = null, routine_pick = null, holds = () => false } = {}) {
    const args = option?.args ?? {};
    let need = NEED.normal;
    switch (option?.skill) {
        case 'give_items': need = NEED.commitment; break;
        case 'build_blueprint': need = NEED.commitment; break;
        case 'furnish_home': need = NEED.build; break;        // its own bed into its own home
        case 'travel': {
            const place = String(args.place ?? '');
            if (place.startsWith('ring-')) need = role === 'explorer' ? NEED.role : NEED.idle;
            else if (place.startsWith('chest-')) need = role === 'merchant' ? NEED.normal : NEED.some;
            else if (place === 'home') need = NEED.low;
            else need = NEED.idle;
            break;
        }
        case 'gather_blocks': need = (ROLE_GATHERS[role] ?? []).includes(args.type) ? NEED.role : NEED.normal; break;
        case 'craft_item': {
            const tool = TOOL.exec(String(args.item ?? ''));
            if ((ROLE_CRAFTS[role] ?? []).includes(args.item)) need = NEED.role;
            else if (tool) need = holds(`_${tool[1]}`) ? NEED.idle : NEED.some;
            else need = NEED.idle;
            break;
        }
        case 'store_items': need = role === 'merchant' ? NEED.role : NEED.normal; break;
        case 'fetch_items': need = NEED.idle; break;
        case 'harvest_replant': case 'sow_field': need = role === 'farmer' ? NEED.role : NEED.normal; break;
        case 'smelt_item': need = NEED.some; break;
        // asked for the agent's own work (the catalog says what for), or just because it has none of it
        case 'ask_agent': need = /\(for /.test(String(option.description ?? '')) ? NEED.normal : NEED.idle; break;
        case 'offer_agent': need = role === 'merchant' ? NEED.low : NEED.idle; break;
        default: need = NEED.normal;
    }
    if (option?.for_build) need = Math.max(need, NEED.build);
    if (routine_pick !== null && option?.id === routine_pick) need = Math.max(need, NEED.routine);
    return need;
}
