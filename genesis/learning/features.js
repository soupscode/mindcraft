// Genesis learning: from one (agent, situation, option) to the network's 96 inputs.
// Everything here is available when the choice is made; nothing looks at the outcome.
//
// Feature version 1. The groups and their sizes are the plan's (section 1.4):
//   option 40 | target 6 | self 12 | time 5 | recent 11 | others 5 | place memory 8 | context 5 | priors 4
// FEATURE_NAMES gives every input its name, in order, so a weight can be read by a person.
//
// The situation is the raw snapshot of genesis/learning/experience.js (makeSituation). A
// change to this file that changes what an input means needs a new FEATURE_VERSION: the
// learner then retrains from the stored raw situations, never from old feature vectors.
//
// Depends only on genesis/learning/rng.js.

import { hashText } from './rng.js';

export const FEATURE_VERSION = 1;

export const SKILLS = Object.freeze([
    'travel', 'gather_blocks', 'craft_item', 'store_items', 'fetch_items', 'harvest_replant', 'sow_field', 'build_blueprint', 'smelt_item',
    'give_items', 'ask_agent', 'offer_agent', 'play',
]);
export const ITEM_GROUPS = Object.freeze(['wood', 'stone', 'ore', 'fuel', 'soil', 'crop_or_seed', 'food', 'tool', 'station', 'building_part', 'glass', 'other']);
export const PLACE_KINDS = Object.freeze(['home', 'zone', 'chest', 'plot', 'patrol', 'other']);
export const ITEM_BUCKETS = 8;
const CHOOSER_INPUTS = ['planner', 'routine', 'network'];
const FAILURE_GROUPS = ['path', 'materials', 'other'];
const MESSAGE_SKILLS = ['give_items', 'ask_agent', 'offer_agent'];

// The domains of the Learning view (display only, never a gate): the plan's section 1.3.
export const DOMAINS = Object.freeze({
    Building: ['build_blueprint'],
    Farming: ['harvest_replant', 'sow_field'],
    'Gathering and mining': ['gather_blocks'],
    'Crafting and smelting': ['craft_item', 'smelt_item'],
    'Travel and exploring': ['travel'],
    Trading: ['ask_agent', 'offer_agent', 'give_items', 'store_items', 'fetch_items'],
});

const TOOL = /_(pickaxe|axe|shovel|hoe|sword)$/;
const CROPS = new Set(['wheat', 'wheat_seeds', 'carrot', 'potato', 'beetroot', 'beetroot_seeds', 'sugar_cane', 'pumpkin', 'melon_slice',
    'melon', 'brown_mushroom', 'red_mushroom', 'carrots', 'potatoes', 'beetroots']);
const FOOD = new Set(['bread', 'baked_potato', 'apple', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'cooked_cod', 'cooked_salmon', 'pumpkin_pie', 'cookie']);
const STATIONS = new Set(['crafting_table', 'furnace', 'chest', 'barrel', 'smoker', 'blast_furnace']);
const SOIL = new Set(['dirt', 'grass_block', 'sand', 'gravel', 'clay', 'clay_ball', 'flint']);
const STONE = new Set(['stone', 'cobblestone', 'andesite', 'diorite', 'granite', 'deepslate', 'cobbled_deepslate', 'stone_bricks']);

// Which of the twelve groups an item belongs to.
export function itemGroup(item) {
    const name = String(item ?? '');
    if (name === '') return null;
    if (name === 'glass' || name.endsWith('glass_pane') || name.endsWith('_glass')) return 'glass';
    if (TOOL.test(name)) return 'tool';
    if (STATIONS.has(name)) return 'station';
    if (/_(door|slab|fence|stairs|trapdoor|fence_gate|wall)$/.test(name) || name === 'ladder' || name === 'torch' || name.endsWith('_bed')) return 'building_part';
    if (/_(log|planks|wood)$/.test(name) || name === 'stick') return 'wood';
    if (name === 'coal' || name === 'charcoal') return 'fuel';
    if (name.endsWith('_ore') || name.startsWith('raw_') || name.endsWith('_ingot')) return 'ore';
    if (FOOD.has(name) || name.startsWith('cooked_')) return 'food';
    if (CROPS.has(name)) return 'crop_or_seed';
    if (STONE.has(name)) return 'stone';
    if (SOIL.has(name)) return 'soil';
    return 'other';
}

// The item an option is about, or null (travel and build have none).
export function optionItem(option) {
    const args = option?.args ?? {};
    for (const key of ['item', 'type', 'seed', 'crop']) if (typeof args[key] === 'string') return args[key];
    return null;
}

// The place kind of a travel or chest goal, from the place id the catalog gives ("ring-3", "chest-shared", "plot-arthur-1").
export function placeKind(option, situation) {
    if (situation?.target?.kind && PLACE_KINDS.includes(situation.target.kind)) return situation.target.kind;
    const args = option?.args ?? {};
    if (typeof args.chest === 'string') return 'chest';
    const place = typeof args.place === 'string' ? args.place : null;
    if (place === null) return null;
    if (place === 'home') return 'home';
    if (place === 'camp' || place === 'field') return 'zone';
    if (place.startsWith('chest-')) return 'chest';
    if (place.startsWith('plot-')) return 'plot';
    if (place.startsWith('ring-')) return 'patrol';
    return 'other';
}

const names = [];
const group = (prefix, list) => list.forEach((name) => names.push(`${prefix}:${name}`));
group('skill', SKILLS);                                                              // 13
group('item_group', ITEM_GROUPS);                                                    // 12
group('item_bucket', Array.from({ length: ITEM_BUCKETS }, (_, i) => String(i)));     // 8
group('option', ['count']);                                                          // 1
group('place_kind', PLACE_KINDS);                                                    // 6   -> 40
group('target', ['distance', 'height_difference', 'height_size', 'home_distance', 'in_site', 'path']);   // 6
group('self', ['health', 'food', 'free_slots', 'pickaxe', 'axe', 'sword', 'hoe', 'torches', 'food_items', 'home_distance', 'height', 'held_of_item']); // 12
group('time', ['sin', 'cos', 'daylight_left', 'night', 'rain']);                     // 5
group('recent', ['outcome_1', 'outcome_2', 'outcome_3', 'streak_option', 'streak_skill', 'death_recency', 'deaths_hour', 'incidents_hour',
    'failed_path', 'failed_materials', 'failed_other']);                             // 11
group('others', ['agents_near', 'nearest_agent', 'hostiles_near', 'recipient_kept', 'recipient_near']);   // 5
group('place_here', ['ok', 'fail', 'death', 'stuck']);                               // 4
group('place_target', ['ok', 'fail', 'death', 'stuck']);                             // 4   -> 8
group('context', ['by_planner', 'by_routine', 'by_network', 'model_available', 'queue_length']);          // 5
group('prior', ['p_ok', 'p_danger', 'secs', 'examples']);                            // 4
export const FEATURE_NAMES = Object.freeze(names);
export const FEATURE_COUNT = FEATURE_NAMES.length;     // 96

const INDEX = Object.fromEntries(FEATURE_NAMES.map((name, i) => [name, i]));
const clamp = (value, lo = 0, hi = 1) => (Number.isFinite(value) ? Math.min(hi, Math.max(lo, value)) : 0);
const soft = (n, k) => n / (n + k);                     // 0 at nothing, towards 1 with many
const OUTCOME_VALUE = { completed: 1, failed: -1, dropped: -1, abandoned: 0 };

// The count an option goes for (items, or cells for a build).
export function optionCount(option, situation) {
    const args = option?.args ?? {};
    if (Number.isFinite(args.count)) return args.count;
    if (Number.isFinite(situation?.target?.cells)) return situation.target.cells;
    return 0;
}

// The 96 inputs. `table` is the count table's estimate for this option (count_table.js predict()).
// Which agent it is does not enter here: that is what the per-agent head is for.
export function featurize({ option, situation, table, chooser = 'routine' }) {
    const x = new Float32Array(FEATURE_COUNT);
    const set = (name, value) => { x[INDEX[name]] = value; };
    const s = situation;

    // ---- option (40)
    if (SKILLS.includes(option.skill)) set(`skill:${option.skill}`, 1);
    const item = optionItem(option);
    if (item !== null) {
        set(`item_group:${itemGroup(item)}`, 1);
        set(`item_bucket:${hashText(item) % ITEM_BUCKETS}`, 1);
    }
    set('option:count', clamp(optionCount(option, s) / 64));
    const kind = placeKind(option, s);
    if (kind !== null) set(`place_kind:${kind}`, 1);

    // ---- target (6)
    const t = s.target;
    if (t) {
        set('target:distance', clamp(Math.log1p(t.dist) / Math.log1p(128)));
        set('target:height_difference', clamp(t.dy / 16, -1, 1));
        set('target:height_size', clamp(Math.abs(t.dy) / 16));
        set('target:home_distance', clamp(t.home_distance / s.range, 0, 2));
        set('target:in_site', t.in_site ? 1 : 0);
        set('target:path', { ok: 1, partial: 0.5, unknown: 0.25, none: 0 }[t.path] ?? 0.25);
    } else {
        set('target:path', 1);      // nothing to walk to
    }

    // ---- self (12)
    set('self:health', clamp(s.health / 20));
    set('self:food', clamp(s.food / 20));
    set('self:free_slots', clamp(s.free_slots / 36));
    set('self:pickaxe', clamp(s.tools.pickaxe / 5));
    set('self:axe', clamp(s.tools.axe / 5));
    set('self:sword', s.tools.sword > 0 ? 1 : 0);
    set('self:hoe', s.tools.hoe > 0 ? 1 : 0);
    set('self:torches', clamp((s.inventory.torch ?? 0) / 16));
    let food_items = 0;
    for (const [name, n] of Object.entries(s.inventory)) if (itemGroup(name) === 'food') food_items += n;
    set('self:food_items', clamp(food_items / 16));
    set('self:home_distance', clamp(s.home_distance / s.range, 0, 2));
    set('self:height', clamp((s.position.y - 64) / 64, -1, 1));
    // for a build: the share of the stage's materials in hand
    set('self:held_of_item', item !== null ? clamp((s.inventory[item] ?? 0) / 64) : clamp(t?.materials_share ?? 0));

    // ---- time (5)
    const angle = 2 * Math.PI * (((s.day_tick % 24000) + 24000) % 24000) / 24000;
    set('time:sin', Math.sin(angle));
    set('time:cos', Math.cos(angle));
    set('time:daylight_left', clamp(s.daylight_left / 12000));
    set('time:night', s.daylight_left <= 0 ? 1 : 0);
    set('time:rain', s.rain ? 1 : 0);

    // ---- recent (11)
    const r = s.recent;
    for (let i = 0; i < 3; i++) set(`recent:outcome_${i + 1}`, OUTCOME_VALUE[r.outcomes[i]] ?? 0);
    set('recent:streak_option', clamp(r.streak_option / 5));
    set('recent:streak_skill', clamp(r.streak_skill / 5));
    set('recent:death_recency', r.mins_since_death === null ? 0 : Math.exp(-r.mins_since_death / 30));
    set('recent:deaths_hour', clamp(r.deaths_hour / 3));
    set('recent:incidents_hour', clamp(r.incidents_hour / 3));
    if (FAILURE_GROUPS.includes(r.last_failure_group)) set(`recent:failed_${r.last_failure_group}`, 1);

    // ---- others (5)
    const near = s.agents_near.filter((a) => a.dist <= 16);
    set('others:agents_near', clamp(near.length / 3));
    const nearest = s.agents_near.reduce((d, a) => Math.min(d, a.dist), Infinity);
    set('others:nearest_agent', Number.isFinite(nearest) ? clamp(Math.log1p(nearest) / Math.log1p(128)) : 1);
    set('others:hostiles_near', clamp(s.hostiles_near / 4));
    if (MESSAGE_SKILLS.includes(option.skill)) {
        set('others:recipient_kept', s.recipient?.kept_share ?? 0.5);
        set('others:recipient_near', s.recipient?.near ? 1 : 0);
    }

    // ---- place memory (8)
    for (const [where, counts] of [['place_here', s.place.here], ['place_target', s.place.target]]) {
        for (const k of ['ok', 'fail', 'death', 'stuck']) set(`${where}:${k}`, soft(Math.max(0, counts[k]), 2));
    }

    // ---- context (5)
    if (CHOOSER_INPUTS.includes(chooser)) set(`context:by_${chooser}`, 1);
    set('context:model_available', s.model_available ? 1 : 0);
    set('context:queue_length', clamp(s.queue_length / 3));

    // ---- priors (4)
    set('prior:p_ok', clamp(table.p_ok));
    set('prior:p_danger', clamp(table.p_danger));
    set('prior:secs', clamp(Math.log(Math.max(1, table.secs)) / Math.log(3600)));
    set('prior:examples', clamp(Math.log1p(table.n ?? 0) / Math.log1p(1000)));
    return x;
}
