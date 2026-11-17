// Genesis: what the bootstrap does to a new world, worked out from the world file alone.
// Nothing here talks to a server: buildBootstrapPlan(config) returns plain data, which
// genesis/world/bootstrap.js carries out over RCON and writes into the manifest.
//
// The plan:
//   rules            the game rules the server is told over RCON, each with the command that
//                    sets it, the command that reads it back, and whether it favours the agents
//   server_settings  rules that are server.properties / bukkit.yml settings: the bootstrap never
//                    edits server files, the operator must set these ({ file, key, value, lines, why })
//   zones            what is levelled (decided): the camp, the field and every plot, as flat boxes
//   areas            the levelling: boxes the bootstrap fills ONCE, before it places the camp:
//                    { id, zone, kind, min, max, block, purpose }, both corners included.
//                      kind "clear"  everything above a zone's floor, filled with air (one box per zone)
//                      kind "floor"  the layer the zone stands on, filled with the floor block
//                    No area holds more blocks than one fill command may change (FILL_LIMIT).
//   floor            the camp's floor: { y, min: [x, z], max: [x, z], accepts }
//   floors           what the check step verifies: every cell of each floor must be one of `accepts`
//                    (the camp's in EVERY run, a plot's in the run that levelled it)
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
// Depends only on genesis/world/world_config.js and genesis/world/survey.js (the list of reading commands).

import { FACINGS, CLOCKWISE, bedHead, seedText } from './world_config.js';
import { READ_COMMANDS } from './survey.js';
import { WORLDEDIT_COMMANDS } from './worldedit.js';

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
    { command: 'time set day', answer: 'not read: sent once, on the first bootstrap of a new world' },
    { command: 'execute if block <x> <y> <z> <block[states]>', answer: 'Test passed | Test failed' },
    { command: 'setblock <x> <y> <z> <block[states]>', answer: 'not read: checked with execute if block' },
    { command: 'fill <x1> <y1> <z1> <x2> <y2> <z2> <block>', answer: 'Successfully filled <n> block(s) | No blocks were filled' },
    { command: 'item replace block <x> <y> <z> container.<slot> with <item> <count>', answer: 'not read: checked with data get block' },
    { command: 'data get block <x> <y> <z> Items', answer: '<x>, <y>, <z> has the following block data: [{Slot: 0b, id: "minecraft:bread", count: 16}, ...]' },
    // reading the land before it is changed, and loading its chunks with no player online (genesis/world/survey.js)
    ...READ_COMMANDS,
    // levelling with WorldEdit from the console, when the plugin is there (genesis/world/worldedit.js)
    ...WORLDEDIT_COMMANDS,
]);

// The camp's defence (decided after the first night of the first run: mobs spawned inside the unlit,
// unwalled camp). The bootstrap LIGHTS and FENCES the starter camp.
//   torches  on a grid every 8 blocks, 4 in from the camp's edge. Since Minecraft 1.18 a hostile mob only
//            spawns at block light 0; a torch gives 14 and light falls by 1 per block walked (not diagonally),
//            so a cell is safe within 13 blocks of a torch. On this grid no cell of the camp is more than
//            8 blocks from one (light 6 or more): the margin is for what stands in the light's way.
//   fence    the outermost ring of the camp, on its floor, with a gate in the middle of each side.
// From general knowledge of the game; NOT RUN AGAINST A REAL SERVER. The light is not checked: only
// that every torch, fence and gate stands.
export const CAMP_DEFENCE = Object.freeze({ torch_spacing: 8, torch_inset: 4, torch: 'torch', fence: 'oak_fence', gate: 'oak_fence_gate' });

// Where the camp's torches, fence and gates go: { torches: [pos], fence: [pos], gates: [{ pos, facing }] }.
// A cell that holds a block of the camp or an agent's home is passed over (a torch moves one cell diagonally).
export function campDefence(config) {
    const [x1, z1] = config.camp.min;
    const [x2, z2] = config.camp.max;
    const y = config.home[1];
    const taken = new Set([
        config.chests.shared, config.camp.shared_chest_second_half, config.chests.kits, config.camp.crafting_table, config.camp.furnace,
        ...config.camp.beds.flatMap((bed) => [bed.foot, bedHead(bed)]), config.home, ...Object.values(config.agents ?? {}).map((agent) => agent.home),
    ].map((pos) => `${pos[0]},${pos[2]}`));
    const edge = (x, z) => x === x1 || x === x2 || z === z1 || z === z2;
    const mid = [Math.floor((x1 + x2) / 2), Math.floor((z1 + z2) / 2)];
    // a gate in the middle of each side; one on the north or south side is walked through along z ("facing south")
    const gates = [
        { pos: [mid[0], y, z1], facing: 'south' }, { pos: [mid[0], y, z2], facing: 'south' },
        { pos: [x1, y, mid[1]], facing: 'east' }, { pos: [x2, y, mid[1]], facing: 'east' },
    ].filter((gate) => !taken.has(`${gate.pos[0]},${gate.pos[2]}`));
    const gate_cells = new Set(gates.map((gate) => `${gate.pos[0]},${gate.pos[2]}`));
    const fence = [];
    for (let x = x1; x <= x2; x++) {
        for (let z = z1; z <= z2; z++) {
            if (edge(x, z) && !gate_cells.has(`${x},${z}`) && !taken.has(`${x},${z}`)) fence.push([x, y, z]);
        }
    }
    const torches = [];
    for (let x = x1 + CAMP_DEFENCE.torch_inset; x < x2; x += CAMP_DEFENCE.torch_spacing) {
        for (let z = z1 + CAMP_DEFENCE.torch_inset; z < z2; z += CAMP_DEFENCE.torch_spacing) {
            const free = [[0, 0], [1, 1], [-1, -1], [1, -1], [-1, 1]].map(([dx, dz]) => [x + dx, z + dz])
                .find(([tx, tz]) => !taken.has(`${tx},${tz}`) && !edge(tx, tz) && tx > x1 && tx < x2 && tz > z1 && tz < z2);
            if (free) { torches.push([free[0], y, free[1]]); taken.add(`${free[0]},${free[1]}`); }
        }
    }
    return { torches, fence, gates };
}

export const GAME_RULES_USED = Object.freeze(['keepInventory', 'mobGriefing', 'doFireTick', 'disableRaids']);

// Levelling (decided: the bootstrap clears and floors the camp, the field and every plot before it
// places the camp). The floor is the layer under the home point; the camp's blocks stand on it.
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

// The zones the bootstrap levels (decided: the camp, the field AND every plot): flat boxes
// { id, label, y, min: [x, z], max: [x, z] } where y is the zone's floor layer: under the home
// point for the camp, the farmland's layer for the field, under its lowest layer for a plot.
// With automatic siting the plots must be buildable as the land lies.
export function levelZones(config) {
    return [
        { id: 'camp', label: 'camp', y: config.home[1] - 1, min: [...config.camp.min], max: [...config.camp.max] },
        { id: 'field', label: 'field', y: config.field.y, min: [...config.field.min], max: [...config.field.max] },
        ...(config.plots ?? []).map((plot) => ({ id: `plot.${plot.id}`, label: `plot ${plot.id}`, y: plot.min[1] - 1, min: [plot.min[0], plot.min[2]], max: [plot.max[0], plot.max[2]] })),
    ];
}

// The areas that level the site, zone by zone: everything above the floor (one fill command for
// the whole box where the game allows it: nothing is left inside that could fall), then the
// floor itself. A box larger than one fill command may change is cut into slabs along x, and
// into runs of layers, the highest first.
function levellingAreas(config) {
    const areas = [];
    for (const zone of levelZones(config)) {
        const floor_y = zone.y;
        const top = Math.min(BUILD_TOP, floor_y + CAMP_LEVELLING.clear_height);
        const [x1, z1] = zone.min;
        const [x2, z2] = zone.max;
        const depth = z2 - z1 + 1;
        const slab = Math.max(1, Math.floor(FILL_LIMIT / depth)); // columns along x in one fill
        const slabs = [];
        for (let x = x1; x <= x2; x += slab) slabs.push([x, Math.min(x2, x + slab - 1)]);
        const clears = [];
        for (const [from, to] of slabs) {
            const layers = Math.max(1, Math.floor(FILL_LIMIT / ((to - from + 1) * depth)));
            for (let y = top; y > floor_y; y -= layers) clears.push({ min: [from, Math.max(floor_y + 1, y - layers + 1), z1], max: [to, y, z2] });
        }
        clears.forEach((box, n) => areas.push({
            id: clears.length > 1 ? `${zone.id}.clear.${n + 1}` : `${zone.id}.clear`, zone: zone.id, kind: 'clear', ...box, block: block('air'),
            purpose: `${zone.label} cleared (layers ${box.min[1]} to ${box.max[1]})`,
        }));
        slabs.forEach(([from, to], n) => areas.push({
            id: slabs.length > 1 ? `${zone.id}.floor.${n + 1}` : `${zone.id}.floor`, zone: zone.id, kind: 'floor', min: [from, floor_y, z1], max: [to, floor_y, z2],
            block: block(CAMP_LEVELLING.floor_block), purpose: `${zone.label} floor (layer ${floor_y})`,
        }));
    }
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
    // the floors that are checked: the camp's in EVERY run; a plot's only in the run that levelled it
    // (from then on the plot is its owner's). The field has no floor check: every cell of it is a
    // block of the camp plan (farmland or water) and is checked as one.
    const floors = levelZones(config).filter((zone) => zone.id !== 'field').map((zone) => ({
        id: `${zone.id}.floor`, zone: zone.id, label: zone.label, y: zone.y, min: zone.min, max: zone.max, accepts: floor.accepts, every_run: zone.id === 'camp',
    }));

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

    // ---- the camp's defence (decided): torches so that nothing hostile spawns inside, a fence with gates around it
    const defence = campDefence(config);
    defence.torches.forEach((pos, n) => put(`torch.${n + 1}`, pos, block(CAMP_DEFENCE.torch), `camp torch ${n + 1} of ${defence.torches.length}`));
    // (a fence joins its neighbours by itself, and an agent opens and closes a gate: only the kind of block is checked)
    for (const pos of defence.fence) put(`fence.${pos[0]}.${pos[2]}`, pos, block(CAMP_DEFENCE.fence), 'camp fence');
    defence.gates.forEach((gate, n) => put(`gate.${n + 1}`, gate.pos, block(CAMP_DEFENCE.gate, { facing: gate.facing, open: 'false' }), `camp gate ${n + 1} of ${defence.gates.length}`, { expect: block(CAMP_DEFENCE.gate) }));

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
        // decided: on the FIRST bootstrap of a new world, never again, so that a first run starts in daylight
        // (the first live run began at midnight). Like every rule that cannot be read back, it is set once and carried.
        rule('time.first_morning', 'time', 'time set day', null, 'day', true,
            'The time was set to morning once, on the first bootstrap of the new world, so that the first run starts in daylight. It is never set again.'),
    ];

    const server_settings = [
        { file: 'server.properties', key: 'level-seed', value: seedText(config.seed), lines: [`level-seed=${seedText(config.seed)}`], favours_agents: false,
            why: 'the world is generated from the seed in the world file (set it before the world folder is created)' },
        { file: 'server.properties', key: 'difficulty', value: config.rules.difficulty, lines: [`difficulty=${config.rules.difficulty}`], favours_agents: true,
            why: 'Easy difficulty, also for a world that is generated anew' },
        { file: 'server.properties', key: 'allow-nether', value: String(config.rules.nether), lines: [`allow-nether=${config.rules.nether}`], favours_agents: false,
            why: 'the Nether is disabled' },
        // The camp stands at the world spawn (setworldspawn above). While the server has an operator, nobody
        // else may place, break or open anything within spawn-protection blocks of it (default 16): the
        // agents are never operators, so the chests, the beds and the field would be closed to them.
        { file: 'server.properties', key: 'spawn-protection', value: '0', lines: ['spawn-protection=0'], favours_agents: false,
            why: 'no spawn protection: the camp is at the world spawn, and the agents (never operators) must be able to place, break and open things there' },
        { file: 'bukkit.yml', key: 'settings.allow-end', value: String(config.rules.end), lines: ['settings:', `  allow-end: ${config.rules.end}`], favours_agents: false,
            why: 'the End is disabled (the key "allow-end" under "settings")' },
        // seen on the real server: Paper answers several logins from one address within 4 seconds with
        // "connection throttled! please wait before reconnecting." The agents all log in from one address.
        { file: 'bukkit.yml', key: 'settings.connection-throttle', value: '-1', lines: ['  connection-throttle: -1'], favours_agents: false,
            why: 'no login throttle (the key "connection-throttle" under "settings"): the agents all log in from one address' },
    ];

    const clear_layers = Math.min(BUILD_TOP, config.home[1] - 1 + CAMP_LEVELLING.clear_height) - (config.home[1] - 1);
    const favours = [
        { id: 'levelled_site', what: `The camp, the field and every plot were levelled by the operator before anything was placed: ${clear_layers} layers above the floor were cleared and the floor was laid with ${CAMP_LEVELLING.floor_block.replaceAll('_', ' ')}. What stood there before and what was laid is counted in this manifest, area by area. The agents levelled none of it.` },
        { id: 'camp_defence', what: `The starter camp was lit and fenced by the operator: ${defence.torches.length} torches, so that no hostile mob can spawn inside it, and a fence with ${defence.gates.length} gates around it. The agents built none of it.` },
        { id: 'starter_camp', what: 'The starter camp was built by the operator: one shared double chest, a kits chest, four beds, a crafting table, a furnace and a 9 by 9 field of tilled farmland with water. The agents built none of it.' },
        ...(items.length > 0 ? [{ id: 'kits', what: `The kits chest was filled once by the operator with ${config.kits.map((stack) => `${stack.count} ${stack.item}`).join(', ')}. The agents restock it themselves from then on.` }] : []),
        { id: 'field', what: 'The field is Operator-built and was left bare: the operator tilled and watered it and sowed nothing. Every crop on it is agent-planted, from the seeds in the kit.' },
    ];

    return { seed: seedText(config.seed), rules, server_settings, zones: levelZones(config), areas, floor, floors, blocks, items, favours };
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
