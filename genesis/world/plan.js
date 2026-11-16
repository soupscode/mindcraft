// Genesis: what the bootstrap does to a new world, worked out from the world file alone.
// Nothing here talks to a server: buildBootstrapPlan(config) returns plain data, which
// genesis/world/bootstrap.js carries out over RCON and writes into the manifest.
//
// The plan:
//   rules            the game rules the server is told over RCON, each with the command that
//                    sets it, the command that reads it back, and whether it favours the agents
//   server_settings  rules that are server.properties / bukkit.yml settings: the bootstrap never
//                    edits server files, the operator must set these ({ file, key, value, lines, why })
//   areas            the levelling of the camp (decided): whole layers the bootstrap fills ONCE, before
//                    it places the camp: { id, kind, min, max, block, purpose }, both corners included.
//                      kind "clear"  a layer above the floor, filled with air (the highest layer first)
//                      kind "floor"  the layer the camp stands on, filled with the floor block
//                    No area holds more blocks than one fill command may change (FILL_LIMIT).
//   floor            what the check step verifies in EVERY run: { y, min: [x, z], max: [x, z], accepts }
//                    every cell of the floor layer must be one of `accepts`
//   blocks           every block of the starter camp: { id, pos, place, expect, purpose, once }
//                      place   the block as it is put down       "minecraft:chest[facing=south,type=left]"
//                      expect  what must be there afterwards (looser where the game changes the
//                              block by itself: farmland dries, a furnace lights, a bed is slept in)
//                      once    true: put down in the first run only and never looked at again,
//                              because the agents change it from then on (the layer the crops grow in)
//   items            what goes into the kits chest, once: { id, pos, slot, item, count }
//   favours          what favours the agents besides the rules (the levelled camp, the camp itself,
//                    the kit, the tilled field)
//
// The field is left BARE (decided): tilled farmland with its water, and nothing sown. The
// field is Operator-built; every crop on it is agent-planted, from the seeds in the kit.
//
// MINECRAFT COMMANDS: written for Java Edition 1.21.6 from general knowledge of the game,
// not from a source file in this repository, and NOT RUN AGAINST A REAL SERVER. The list,
// with what each is expected to answer, is in COMMANDS_USED below.
//
// Depends only on genesis/world/world_config.js.

import { FACINGS, CLOCKWISE, bedHead, seedText } from './world_config.js';

// Every command the bootstrap sends, and the answer it looks for.
export const COMMANDS_USED = Object.freeze([
    { command: 'seed', answer: 'Seed: [<number>]' },
    { command: 'difficulty', answer: 'The difficulty is <Name>' },
    { command: 'difficulty <easy>', answer: 'not read: checked by asking again' },
    { command: 'gamerule <rule>', answer: 'Gamerule <rule> is currently set to: <value>' },
    { command: 'gamerule <rule> <value>', answer: 'not read: checked by asking again' },
    { command: 'worldborder get', answer: 'The world border is currently <n> block(s) wide' },
    { command: 'worldborder set <size>', answer: 'not read: checked by asking again' },
    { command: 'worldborder center <x> <z>', answer: 'not read: the centre cannot be asked for' },
    { command: 'setworldspawn <x> <y> <z>', answer: 'not read: the spawn point cannot be asked for' },
    { command: 'execute if block <x> <y> <z> <block[states]>', answer: 'Test passed | Test failed' },
    { command: 'setblock <x> <y> <z> <block[states]>', answer: 'not read: checked with execute if block' },
    { command: 'fill <x1> <y1> <z1> <x2> <y2> <z2> <block>', answer: 'Successfully filled <n> block(s) | No blocks were filled' },
    { command: 'item replace block <x> <y> <z> container.<slot> with <item> <count>', answer: 'not read: checked with data get block' },
    { command: 'data get block <x> <y> <z> Items', answer: '<x>, <y>, <z> has the following block data: [{Slot: 0b, id: "minecraft:bread", count: 16}, ...]' },
]);

export const GAME_RULES_USED = Object.freeze(['keepInventory', 'mobGriefing', 'doFireTick', 'disableRaids']);

// Levelling the camp (decided: the bootstrap clears and floors the camp area before it places
// the camp). The floor is the layer under the home point; the camp's blocks stand on it.
// The numbers are proposed starting values.
export const CAMP_LEVELLING = Object.freeze({
    floor_block: 'grass_block',                             // proposed: what the floor is made of
    // grass under a full block (the crafting table, the furnace) turns to dirt by itself
    floor_accepts: Object.freeze(['grass_block', 'dirt']),
    clear_height: 24,                                       // proposed: layers cleared above the floor (tall trees included)
});
// How many blocks ONE fill command may change: the vanilla default of the game rule
// commandModificationBlockLimit. From general knowledge of the game, not from a source file here.
export const FILL_LIMIT = 32768;
const BUILD_TOP = 319; // the highest layer of the overworld

const block = (name, states = {}) => {
    const list = Object.entries(states).map(([key, value]) => `${key}=${value}`);
    return `minecraft:${name}${list.length > 0 ? `[${list.join(',')}]` : ''}`;
};

// The areas that level the camp: the layers above the floor, highest first (so nothing that
// falls, sand or gravel, drops into a layer that was already cleared), then the floor itself.
// A layer larger than one fill command may change is cut into slabs along x.
function levellingAreas(config) {
    const [x1, z1] = config.camp.min;
    const [x2, z2] = config.camp.max;
    const floor_y = config.home[1] - 1;
    const depth = z2 - z1 + 1;
    const slab = Math.max(1, Math.floor(FILL_LIMIT / depth)); // columns along x in one fill
    const slabs = [];
    for (let x = x1; x <= x2; x += slab) slabs.push([x, Math.min(x2, x + slab - 1)]);
    const areas = [];
    const add = (id, kind, y, block_name, purpose) => slabs.forEach(([from, to], n) => areas.push({
        id: slabs.length > 1 ? `${id}.${n + 1}` : id, kind, min: [from, y, z1], max: [to, y, z2], block: block(block_name), purpose,
    }));
    const top = Math.min(BUILD_TOP, floor_y + CAMP_LEVELLING.clear_height);
    for (let y = top; y > floor_y; y--) add(`camp.clear.${y}`, 'clear', y, 'air', `camp cleared (layer ${y})`);
    add('camp.floor', 'floor', floor_y, CAMP_LEVELLING.floor_block, `camp floor (layer ${floor_y})`);
    return areas;
}

export function buildBootstrapPlan(config) {
    const facing = config.camp.facing ?? 'south';
    const blocks = [];
    const put = (id, pos, place, purpose, { expect = place, once = false } = {}) => blocks.push({ id, pos: [...pos], place, expect, purpose, once });
    const areas = levellingAreas(config);
    const floor = {
        y: config.home[1] - 1, min: [...config.camp.min], max: [...config.camp.max],
        accepts: CAMP_LEVELLING.floor_accepts.map((name) => block(name)),
    };

    // ---- the shared double chest: two chests that face the same way, typed as its halves.
    // A chest of type "left" is joined to the block clockwise of the way it faces.
    const shared = config.chests.shared;
    const second = config.camp.shared_chest_second_half;
    const sideways = FACINGS[CLOCKWISE[facing]];
    const second_is_clockwise = second[0] - shared[0] === sideways.x && second[2] - shared[2] === sideways.z;
    put('chest.shared.1', shared, block('chest', { facing, type: second_is_clockwise ? 'left' : 'right' }), 'shared chest (half 1 of 2)');
    put('chest.shared.2', second, block('chest', { facing, type: second_is_clockwise ? 'right' : 'left' }), 'shared chest (half 2 of 2)');
    put('chest.kits', config.chests.kits, block('chest', { facing, type: 'single' }), 'kits chest');
    put('crafting_table', config.camp.crafting_table, block('crafting_table'), 'crafting table');
    put('furnace', config.camp.furnace, block('furnace', { facing, lit: 'false' }), 'furnace', { expect: block('furnace', { facing }) });
    config.camp.beds.forEach((bed, index) => {
        const name = `${bed.color ?? 'red'}_bed`;
        const n = index + 1;
        put(`bed.${n}.foot`, bed.foot, block(name, { facing: bed.facing, part: 'foot', occupied: 'false' }), `bed ${n} (foot)`,
            { expect: block(name, { facing: bed.facing, part: 'foot' }) });
        put(`bed.${n}.head`, bedHead(bed), block(name, { facing: bed.facing, part: 'head', occupied: 'false' }), `bed ${n} (head)`,
            { expect: block(name, { facing: bed.facing, part: 'head' }) });
    });

    // ---- the field: farmland with water in it, something solid under the water, and the
    // layer above cleared so that the farmland stays farmland. Nothing is sown (decided): the
    // field is left bare, and the agents plant it from the seeds in the kit.
    const field = config.field;
    const is_water = (x, z) => field.water.some(([wx, wz]) => wx === x && wz === z);
    for (const [x, z] of field.water) {
        put(`field.under_water.${x}.${z}`, [x, field.y - 1, z], block('dirt'), 'dirt under the field\'s water');
        put(`field.water.${x}.${z}`, [x, field.y, z], block('water', { level: 0 }), 'water of the field');
    }
    for (let x = field.min[0]; x <= field.max[0]; x++) {
        for (let z = field.min[1]; z <= field.max[1]; z++) {
            if (is_water(x, z)) continue;
            put(`field.farmland.${x}.${z}`, [x, field.y, z], block('farmland', { moisture: 7 }), 'farmland of the field', { expect: block('farmland') });
        }
    }
    for (let x = field.min[0]; x <= field.max[0]; x++) {
        for (let z = field.min[1]; z <= field.max[1]; z++) {
            if (is_water(x, z)) continue;
            // once: from the first run on this layer is the agents' (what they sow grows here)
            put(`field.clear.${x}.${z}`, [x, field.y + 1, z], block('air'), 'cleared above the farmland', { once: true });
        }
    }

    const items = config.kits.map((stack, slot) => ({
        id: `kit.${slot}`, chest: 'kits', pos: [...config.chests.kits], slot, item: `minecraft:${stack.item}`, count: stack.count,
    }));

    const rule = (id, kind, set, query, expect, favours_agents, why) => ({ id, kind, set, query, expect, favours_agents, why });
    const [cx, cz] = config.border.center;
    const [hx, hy, hz] = config.home;
    const rules = [
        rule('difficulty', 'difficulty', `difficulty ${config.rules.difficulty}`, 'difficulty', config.rules.difficulty, true,
            'Easy difficulty: mobs hit for less, and hunger cannot kill.'),
        rule('keepInventory', 'gamerule', `gamerule keepInventory ${config.rules.keep_inventory}`, 'gamerule keepInventory', String(config.rules.keep_inventory), false,
            'keepInventory is off: an agent that dies loses what it carried. This does not favour the agents.'),
        rule('mobGriefing', 'gamerule', `gamerule mobGriefing ${config.rules.mob_griefing}`, 'gamerule mobGriefing', String(config.rules.mob_griefing), true,
            'No mob griefing: creepers, endermen and other mobs cannot destroy or take blocks, so nothing the agents build is lost to them.'),
        rule('doFireTick', 'gamerule', `gamerule doFireTick ${config.rules.fire_spread}`, 'gamerule doFireTick', String(config.rules.fire_spread), true,
            'No fire spread: fire does not spread and does not burn blocks away, so builds cannot burn down.'),
        rule('disableRaids', 'gamerule', `gamerule disableRaids ${!config.rules.raids}`, 'gamerule disableRaids', String(!config.rules.raids), true,
            'No raids: no raid ever starts.'),
        rule('worldborder.size', 'worldborder', `worldborder set ${config.border.size}`, 'worldborder get', String(config.border.size), false,
            `World border ${config.border.size} blocks wide: the world the agents can reach is limited.`),
        rule('worldborder.center', 'worldborder', `worldborder center ${cx} ${cz}`, null, `${cx} ${cz}`, false,
            'The centre of the world border. It cannot be read back over RCON: set once and recorded.'),
        rule('worldspawn', 'spawn', `setworldspawn ${hx} ${hy} ${hz}`, null, `${hx} ${hy} ${hz}`, true,
            'The world spawn is the home point: an agent that dies comes back next to the camp. It cannot be read back over RCON: set once and recorded.'),
    ];

    const server_settings = [
        { file: 'server.properties', key: 'level-seed', value: seedText(config.seed), lines: [`level-seed=${seedText(config.seed)}`], favours_agents: false,
            why: 'the world is generated from the seed in the world file (set it before the world folder is created)' },
        { file: 'server.properties', key: 'difficulty', value: config.rules.difficulty, lines: [`difficulty=${config.rules.difficulty}`], favours_agents: true,
            why: 'Easy difficulty, also for a world that is generated anew' },
        { file: 'server.properties', key: 'allow-nether', value: String(config.rules.nether), lines: [`allow-nether=${config.rules.nether}`], favours_agents: false,
            why: 'the Nether is disabled' },
        { file: 'bukkit.yml', key: 'settings.allow-end', value: String(config.rules.end), lines: ['settings:', `  allow-end: ${config.rules.end}`], favours_agents: false,
            why: 'the End is disabled (the key "allow-end" under "settings")' },
    ];

    const clear_layers = new Set(areas.filter((area) => area.kind === 'clear').map((area) => area.min[1])).size;
    const favours = [
        { id: 'levelled_camp', what: `The camp area was levelled by the operator before anything was placed: ${clear_layers} layers above the floor were cleared and the floor was laid with ${CAMP_LEVELLING.floor_block.replaceAll('_', ' ')}. Every block that changed is counted in this manifest, layer by layer. The agents levelled none of it.` },
        { id: 'starter_camp', what: 'The starter camp was built by the operator: one shared double chest, a kits chest, four beds, a crafting table, a furnace and a 9 by 9 field of tilled farmland with water. The agents built none of it.' },
        ...(items.length > 0 ? [{ id: 'kits', what: `The kits chest was filled once by the operator with ${config.kits.map((stack) => `${stack.count} ${stack.item}`).join(', ')}. The agents restock it themselves from then on.` }] : []),
        { id: 'field', what: 'The field is Operator-built and was left bare: the operator tilled and watered it and sowed nothing. Every crop on it is agent-planted, from the seeds in the kit.' },
    ];

    return { seed: seedText(config.seed), rules, server_settings, areas, floor, blocks, items, favours };
}

// The text of server-settings.required.txt.
export function serverSettingsText(plan, { world_file = 'genesis.world.json' } = {}) {
    const lines = [
        '# Genesis: server settings the operator must set.',
        `# Worked out from ${world_file} by genesis/world/bootstrap.js, which never edits server files.`,
        '# These cannot be set or checked over RCON. Set them, then restart the Minecraft server.',
        '',
    ];
    for (const file of [...new Set(plan.server_settings.map((setting) => setting.file))]) {
        lines.push(`## ${file}`);
        for (const setting of plan.server_settings.filter((entry) => entry.file === file)) {
            lines.push(`# ${setting.why}`);
            lines.push(...setting.lines);
        }
        lines.push('');
    }
    return `${lines.join('\n')}`;
}
