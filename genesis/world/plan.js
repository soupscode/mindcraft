// Genesis: what the bootstrap does to a new world, worked out from the world file alone.
// Nothing here talks to a server: buildBootstrapPlan(config) returns plain data, which
// genesis/world/bootstrap.js carries out over RCON and writes into the manifest.
//
// The plan:
//   rules            the game rules the server is told over RCON, each with the command that
//                    sets it, the command that reads it back, and whether it favours the agents
//   server_settings  rules that are server.properties / bukkit.yml settings: the bootstrap never
//                    edits server files, the operator must set these ({ file, key, value, lines, why })
//   blocks           every block of the starter camp: { id, pos, place, expect, purpose, once }
//                      place   the block as it is put down       "minecraft:chest[facing=south,type=left]"
//                      expect  what must be there afterwards (looser where the game changes the
//                              block by itself: farmland dries, a furnace lights, a bed is slept in)
//                      once    true: put down in the first run only and never looked at again,
//                              because the agents change it from then on (the crops)
//   items            what goes into the kits chest, once: { id, pos, slot, item, count }
//   favours          what favours the agents besides the rules (the camp itself, the kit, the crops)
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
    { command: 'item replace block <x> <y> <z> container.<slot> with <item> <count>', answer: 'not read: checked with data get block' },
    { command: 'data get block <x> <y> <z> Items', answer: '<x>, <y>, <z> has the following block data: [{Slot: 0b, id: "minecraft:bread", count: 16}, ...]' },
]);

export const GAME_RULES_USED = Object.freeze(['keepInventory', 'mobGriefing', 'doFireTick', 'disableRaids']);

const block = (name, states = {}) => {
    const list = Object.entries(states).map(([key, value]) => `${key}=${value}`);
    return `minecraft:${name}${list.length > 0 ? `[${list.join(',')}]` : ''}`;
};

export function buildBootstrapPlan(config) {
    const facing = config.camp.facing ?? 'south';
    const blocks = [];
    const put = (id, pos, place, purpose, { expect = place, once = false } = {}) => blocks.push({ id, pos: [...pos], place, expect, purpose, once });

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
    // layer above either sown or cleared so that the farmland stays farmland
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
            if (field.crop) put(`field.crop.${x}.${z}`, [x, field.y + 1, z], block(field.crop, { age: 0 }), `${field.crop} sown on the field (age 0)`, { once: true });
            else put(`field.clear.${x}.${z}`, [x, field.y + 1, z], block('air'), 'cleared above the farmland', { once: true });
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

    const favours = [
        { id: 'starter_camp', what: 'The starter camp was built by the operator: one shared double chest, a kits chest, four beds, a crafting table, a furnace and a 9 by 9 field with water. The agents built none of it.' },
        ...(items.length > 0 ? [{ id: 'kits', what: `The kits chest was filled once by the operator with ${config.kits.map((stack) => `${stack.count} ${stack.item}`).join(', ')}. The agents restock it themselves from then on.` }] : []),
        ...(field.crop ? [{ id: 'crops', what: `The field was sown once by the operator with ${field.crop} at age 0. The agents harvest and replant it themselves from then on.` }] : []),
    ];

    return { seed: seedText(config.seed), rules, server_settings, blocks, items, favours };
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
