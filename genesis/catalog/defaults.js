// Genesis: the tables the skill templates fill their arguments from. All of it is data:
// createCatalog({ config }) takes replacements for any of these.
// No imports.

// What gather_blocks may be asked for. `blocks` are the block names that count as a match,
// `drops` the items whose count is the progress measure ("items gained").
export const GATHER_TYPES = Object.freeze({
    oak_log: { blocks: ['oak_log'], drops: ['oak_log'] },
    birch_log: { blocks: ['birch_log'], drops: ['birch_log'] },
    spruce_log: { blocks: ['spruce_log'], drops: ['spruce_log'] },
    stone: { blocks: ['stone', 'cobblestone'], drops: ['cobblestone'] },
    coal_ore: { blocks: ['coal_ore', 'deepslate_coal_ore'], drops: ['coal'] },
    iron_ore: { blocks: ['iron_ore', 'deepslate_iron_ore'], drops: ['raw_iron'] },
    sand: { blocks: ['sand'], drops: ['sand'] },
    gravel: { blocks: ['gravel'], drops: ['gravel', 'flint'] },
    dirt: { blocks: ['dirt', 'grass_block'], drops: ['dirt'] },
    clay: { blocks: ['clay'], drops: ['clay_ball'] },
    sugar_cane: { blocks: ['sugar_cane'], drops: ['sugar_cane'] },
    pumpkin: { blocks: ['pumpkin'], drops: ['pumpkin'] },
    melon: { blocks: ['melon'], drops: ['melon_slice'] },
    brown_mushroom: { blocks: ['brown_mushroom'], drops: ['brown_mushroom'] },
    red_mushroom: { blocks: ['red_mushroom'], drops: ['red_mushroom'] },
});

// Crops harvest_replant and sow_field know: the block, the age at which it is mature, what
// is sown (back), and what a mature one yields. Upstream digs a crop at any age, so the
// harvest template reads the age itself first.
export const CROPS = Object.freeze({
    wheat: { max_age: 7, seed: 'wheat_seeds', produce: 'wheat' },
    carrots: { max_age: 7, seed: 'carrot', produce: 'carrot' },
    potatoes: { max_age: 7, seed: 'potato', produce: 'potato' },
    beetroots: { max_age: 3, seed: 'beetroot_seeds', produce: 'beetroot' },
});

// What craft_item may be asked for: [item, how many times the recipe is made].
export const CRAFT_ITEMS = Object.freeze([
    ['oak_planks', 4], ['birch_planks', 4], ['spruce_planks', 4], ['stick', 2], ['crafting_table', 1],
    ['wooden_pickaxe', 1], ['wooden_axe', 1], ['wooden_hoe', 1], ['wooden_sword', 1],
    ['stone_pickaxe', 1], ['stone_axe', 1], ['stone_hoe', 1], ['stone_sword', 1],
    ['torch', 2], ['chest', 1], ['furnace', 1], ['bread', 1],
]);

// Blocks a building plot may hold where the blueprint wants something else: they are
// what the ground is made of, and may be cleared. Anything else was put there by someone.
export const NATURAL_BLOCKS = Object.freeze([
    'dirt', 'grass_block', 'coarse_dirt', 'podzol', 'rooted_dirt', 'mud', 'sand', 'red_sand', 'gravel', 'clay',
    'stone', 'andesite', 'diorite', 'granite', 'deepslate', 'tuff', 'snow_block',
    'dandelion', 'poppy', 'azure_bluet', 'oxeye_daisy', 'cornflower', 'large_fern',
]);
export const NATURAL_SUFFIXES = Object.freeze(['_leaves']);
// Torches are exempt from scaffold clean-up (decided: upstream's idle torch reflex may leave
// them in the camp, the field and the plots). So that such a torch never blocks a build for
// good, the owner's build may clear one that stands where the blueprint wants something else.
export const CLEARABLE_BLOCKS = Object.freeze(['torch', 'wall_torch']);

// Items an agent keeps when it stores things away (never offered to store_items).
export const KEEP_SUFFIXES = Object.freeze(['_pickaxe', '_axe', '_shovel', '_hoe', '_sword', '_helmet', '_chestplate', '_leggings', '_boots']);
export const KEEP_ITEMS = Object.freeze(['torch', 'bread', 'shield', 'crafting_table']);

export const CATALOG_DEFAULTS = Object.freeze({
    gather_count: 8,        // blocks one gather goal goes for
    gather_distance: 32,    // how far a matching block may be
    harvest_batch: 12,      // crops one harvest goal takes
    sow_batch: 16,          // proposed: bare cells of the field one sow goal sows
    build_batch: 12,        // cells one build goal changes
    smelt_batch: 8,         // items one smelt goal smelts
    fetch_count: 8,         // items one fetch goal takes
    chest_distance: 32,     // upstream's chest skills use the nearest chest within 32 blocks
    arrive_distance: 2,     // how close goToPosition is asked to get
    ledger_fresh_ms: 5 * 60 * 1000, // a chest is not walked to just to be looked into again within this time
    free_slots_needed: 3,   // gather_blocks and harvest_replant
    max_options: 16,        // how many options one offer holds at most
    per_skill: { travel: 5, gather_blocks: 3, craft_item: 3, store_items: 2, fetch_items: 2, harvest_replant: 1, sow_field: 1, build_blueprint: 1, smelt_item: 2, give_items: 2,
        ask_agent: 3, offer_agent: 1 }, // proposed: how many messages the planner is offered to send at a time
    ask_count: 8,           // proposed: items one ask_agent goal asks for at most
    ask_any_count: 4,       // proposed: items asked for when it is not the agent's own work that is short of them
    ask_rotate_ms: 10 * 60 * 1000, // proposed: which of those items come up first changes this often
    offer_count: 8,         // proposed: items one offer_agent goal offers at most
    handoff_distance: 16,   // proposed: within this many blocks items are handed over directly, further away they go through the shared chest
    handoff_chest: 'shared',
});
