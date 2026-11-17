// Genesis: the world bootstrap. It applies the world file (genesis.world.json, "v": 2) to a
// new Minecraft world over RCON and CHECKS every block it placed. The agents may only start
// planning once it has passed: the launcher asks for the manifest this script writes.
//
//   node genesis/world/bootstrap.js              pick the site when there is no world file yet, then apply the world file and check the world
//   node genesis/world/bootstrap.js --pick-site  dry run: pick the site and report, write nothing, change nothing
//   node genesis/world/bootstrap.js --validate   only check the world file (no server needed)
//   node genesis/world/bootstrap.js --plan       print what would be placed (no server needed)
//   options:  --settings <file>   the Genesis settings (default genesis/settings.json; GENESIS_SETTINGS_FILE)
//             --world <file>      the world file (default: GENESIS_WORLD_FILE, else "genesis_planning.world_file" of the settings)
//             --manifest <file>   the manifest (default: "genesis_planning.manifest_file", else ./bots/genesis_world/bootstrap.manifest.json)
//             --site-radius <n>   how far from the spawn the site may lie (default 48)      --site-step <n>    one column read every n blocks (default 4)
//             --site-from <x> <z> search around this column instead of the world spawn     --site-relief <n>  how uneven a zone may be (default 3)
//             --example <file>    the layout that is moved to the site (default ./genesis/genesis.world.example.json)
//             --no-worldedit      level with the game's own fill command even when WorldEdit is installed
//   GENESIS_WORLDEDIT_WORLD: the name of the world for WorldEdit's world override (default "world")
//   RCON:     GENESIS_RCON_PASSWORD (required), GENESIS_RCON_HOST (default: "host" of the settings),
//             GENESIS_RCON_PORT (default 25575). The password is never written anywhere.
//
// What it does, in this order, stopping at the first thing that fails:
//   0. the site (decided): while there is NO world file, the place is chosen from the land itself
//      (genesis/world/site.js: around the world spawn, flat, dry, no trees in the zones) and the
//      world file is written for it. A world file that is there is used as it is: that is the
//      manual override (genesis/tools/place_world.js --at <x> <y> <z> --seed <seed>).
//   1. checks the world file (genesis/world/world_config.js); nothing is sent while it has problems
//   2. asks the server for its seed: it must be the seed in the world file
//   3. game rules: reads each one, sets it only when it differs, and reads it back
//   4. levels the camp, the field and every plot, ONCE (decided). The site's chunks are
//      force-loaded for the run (no player needs to be online; they are released when the run
//      ends, however it ends) and the reading commands are probed. Each zone is cleared above
//      its floor and floored: with WorldEdit from the console when the plugin is there (decided;
//      genesis/world/worldedit.js: probed first, and every box is read back after it was set),
//      with the game's own fill command when it is not. A box that is already as it should be
//      is left alone and recorded so: a site the operator flattened himself passes untouched.
//      Never done again once the manifest records it, and never where the camp already stands.
//   5. the starter camp: looks at each block first and places it only when it is not there yet
//      (one shared double chest, a kits chest, four beds, a crafting table, a furnace, a 9 by 9
//      field of bare farmland with water: nothing is sown). The agents build every house.
//   6. the kits chest is filled, once
//   7. every block is checked again, and every cell of the camp's floor; a block that is not as
//      planned stops the run with its position
//   8. writes the manifest and, next to it, server-settings.required.txt with the settings that
//      cannot be set over RCON (they are reported as "operator must set")
//
// It can be run again at any time: on a bootstrapped world a second run places nothing and
// passes. What the agents change afterwards (what grows on the field, what is in the kits
// chest, a torch they put down in the camp) is left alone: the levelling, the cleared layer
// above the farmland and the kit are done once and never again.
//
// Levelling never runs over a camp that stands: when the manifest has no record of it and any
// block of the camp is already there (a lost manifest), nothing is cleared or floored, the run
// says so, and the floor check decides whether the camp is fit.
//
// Honesty: every block and item placed is in the manifest, attributed to "Operator", and so
// is every rule that favours the agents. The levelling is recorded per area with COUNTS
// (decided): how many blocks were not air before, the blocks by kind as WorldEdit's //distr
// gave them (when its answer could be read), what was laid and how many blocks changed, and
// which method did it. How the site was chosen is recorded too. The script never edits server
// files and never deletes anything in the world folder.
//
// COMMAND COUNTS for the full site (14 boxes: 7 zones, above the floor and the floor): at most
// 5 commands a box with WorldEdit (pos1, pos2, distr, set, and the reading back), 2 to 3 with
// fill, plus a few dozen for the floors' checks: some hundreds in all, seconds of server time.
//
// NOT RUN AGAINST A REAL MINECRAFT SERVER. The tests run it against an in-memory stand-in
// that answers the way the commands are documented to (genesis/tests/helpers/fake-rcon.mjs).
//
// Injected into runBootstrap: rcon { send(command) -> Promise<answer text> }, files
// (genesis/store/node_files.js shape), clock, blueprints.
// Depends only on Node built-ins and other Genesis files.

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkWorldConfig, describeProblem, worldHash, seedText } from './world_config.js';
import { buildBootstrapPlan, serverSettingsText } from './plan.js';
import { MANIFEST_KIND, MANIFEST_VERSION, OPERATOR, DEFAULT_MANIFEST_FILE, manifestPaths, parseManifest } from './manifest.js';
import { createReader, probe, loadChunks, checkBox, ReadError, READ_ANSWERS, WORLD_BOTTOM } from './survey.js';
import { probeWorldEdit, worldEditBox } from './worldedit.js';

const xyz = (pos) => pos.join(' ');
const passed = (answer) => /Test passed/i.test(answer) && !/Test failed/i.test(answer);
const sameBox = (a, b) => a.min.join(',') === b.min.join(',') && a.max.join(',') === b.max.join(',');

// What the server said a value is, or null when the answer is not understood.
export const ANSWERS = Object.freeze({
    seed: (answer) => /Seed:\s*\[?\s*(-?\d+)\s*\]?/i.exec(answer)?.[1] ?? null,
    difficulty: (answer) => /difficulty is\s+([A-Za-z]+)/i.exec(answer)?.[1]?.toLowerCase() ?? null,
    gamerule: (answer) => /set to:\s*(\S+)/i.exec(answer)?.[1]?.toLowerCase() ?? null,
    worldborder: (answer) => {
        const found = /currently\s+(-?\d+(?:\.\d+)?)\s+block/i.exec(answer);
        return found ? String(Math.round(Number(found[1]))) : null;
    },
    // how many blocks a fill command changed: a number, 0 for "No blocks were filled", null when not understood
    fill: (answer) => {
        const found = /Successfully filled\s+(\d+)\s+block/i.exec(answer);
        if (found) return Number(found[1]);
        return /No blocks were filled/i.test(answer) ? 0 : null;
    },
});

// Splits the inside of an SNBT list or compound at its top-level commas.
function splitTop(text) {
    const parts = [];
    let depth = 0;
    let quote = null;
    let start = 0;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quote) {
            if (ch === '\\') i++;
            else if (ch === quote) quote = null;
        } else if (ch === '"' || ch === "'") quote = ch;
        else if (ch === '{' || ch === '[') depth++;
        else if (ch === '}' || ch === ']') depth--;
        else if (ch === ',' && depth === 0) { parts.push(text.slice(start, i)); start = i + 1; }
    }
    if (text.slice(start).trim().length > 0) parts.push(text.slice(start));
    return parts.map((part) => part.trim());
}

// One element of a container's Items list, as the server prints it:
//   {Slot: 0b, id: "minecraft:stone_axe", count: 1}
// Gives { slot, item, count }, or null when it is not understood (also when it was cut off).
export function parseItemCompound(text) {
    const compound = String(text ?? '').trim();
    if (!compound.startsWith('{') || !compound.endsWith('}')) return null;
    const fields = {};
    for (const pair of splitTop(compound.slice(1, -1))) {
        const colon = pair.indexOf(':');
        if (colon > 0) fields[pair.slice(0, colon).trim().replace(/^"|"$/g, '')] = pair.slice(colon + 1).trim();
    }
    const slot = /^(-?\d+)[bB]?$/.exec(fields.Slot ?? '')?.[1];
    const item = /^"?([a-z0-9_.:-]+)"?$/.exec(fields.id ?? '')?.[1];
    const count = /^(\d+)[bB]?$/.exec(fields.count ?? fields.Count ?? '1')?.[1];
    if (slot === undefined || item === undefined || count === undefined) return null;
    return { slot: Number(slot), item: item.includes(':') ? item : `minecraft:${item}`, count: Number(count) };
}

// Reads the answer of "data get block <pos> Items": Map(slot -> { item, count }), or null
// when the answer is not understood. A container with nothing in it gives an empty map.
// A real server cuts a long list off with "..." (seen on Paper 1.21.6 with eight stacks): that
// gives null here, and readContainer() below then asks for the stacks one at a time.
export function parseItems(answer) {
    const text = String(answer ?? '');
    if (/no elements matching/i.test(text)) return new Map();
    const open = text.indexOf('[');
    const close = text.lastIndexOf(']');
    if (open < 0 || close < open) return null;
    const slots = new Map();
    for (const compound of splitTop(text.slice(open + 1, close))) {
        const stack = parseItemCompound(compound);
        if (!stack) return null;
        slots.set(stack.slot, { item: stack.item, count: stack.count });
    }
    return slots;
}

// The most stacks a container is asked for one by one (a double chest holds 54).
export const CONTAINER_SLOTS = 54;
const BLOCK_DATA = /has the following block data:\s*([\s\S]*)$/;
const NO_ELEMENT = /no elements matching/i;
const NOT_LOADED = /not loaded/i;

// What a container holds: { slots: Map(slot -> { item, count }) or null, answer, not_loaded }.
// First the whole list in one command. When that answer is not understood (the server cuts a
// long list off), the stacks are read one at a time: "data get block <pos> Items[0]", [1], ...
// until the server says there is no such element. A single stack that is itself cut off is read
// field by field (Items[n].Slot, .id, .count). slots is null only when an answer is not understood;
// `answer` is then that answer.
export async function readContainer(send, pos, { max = CONTAINER_SLOTS } = {}) {
    const where = pos.join(' ');
    const whole = await send(`data get block ${where} Items`, false);
    if (NOT_LOADED.test(String(whole))) return { slots: null, answer: whole, not_loaded: true };
    const parsed = parseItems(whole);
    if (parsed) return { slots: parsed, answer: whole, not_loaded: false };
    if (!BLOCK_DATA.test(String(whole))) return { slots: null, answer: whole, not_loaded: false };

    const value = (answer) => BLOCK_DATA.exec(String(answer))?.[1]?.trim() ?? null;
    const slots = new Map();
    for (let index = 0; index < max; index++) {
        const answer = await send(`data get block ${where} Items[${index}]`, false);
        if (NO_ELEMENT.test(String(answer))) break;
        if (NOT_LOADED.test(String(answer))) return { slots: null, answer, not_loaded: true };
        let stack = parseItemCompound(value(answer));
        if (!stack && value(answer) !== null) {
            // the stack itself was cut off: its three fields, one command each
            const slot_answer = await send(`data get block ${where} Items[${index}].Slot`, false);
            const id_answer = await send(`data get block ${where} Items[${index}].id`, false);
            const count_answer = await send(`data get block ${where} Items[${index}].count`, false);
            const count = NO_ELEMENT.test(String(count_answer)) ? '1' : value(count_answer);
            stack = parseItemCompound(`{Slot: ${value(slot_answer)}, id: ${value(id_answer)}, count: ${count}}`);
        }
        if (!stack) return { slots: null, answer, not_loaded: false };
        slots.set(stack.slot, { item: stack.item, count: stack.count });
    }
    return { slots, answer: whole, not_loaded: false };
}

// Runs the bootstrap. Never throws: resolves to
//   { ok, stage, problems, failed, commands, placed, manifest, operator_must_set, warnings }
//     stage     where it ended: validate | seed | rules | level | camp | kits | check | done
//     placed    { blocks, items, rules, cleared, floored }: cleared and floored are the blocks the
//               levelling changed (removed above the floor, placed in it), as the server counted them
//     failed    null, or { id, pos, expected, answer } of the check that failed
//     commands  every command sent: { command, changes } (changes: it can change the world)
export async function runBootstrap({
    config, rcon, files, clock = { now: Date.now }, manifest_file = DEFAULT_MANIFEST_FILE, world_file = 'genesis.world.json', blueprints = null,
    site = null, log = () => {}, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), load = {},
    worldedit = true, worldedit_world = 'world',
} = {}) {
    const result = {
        ok: false, stage: 'validate', problems: [], failed: null, commands: [], placed: { blocks: 0, items: 0, rules: 0, cleared: 0, floored: 0 },
        manifest: null, operator_must_set: [], warnings: [], survey: { commands: 0 }, levelling: null,
    };
    const config_problems = checkWorldConfig(config, { blueprints });
    if (config_problems.length > 0) {
        result.problems = config_problems.map(describeProblem);
        return result;
    }
    const plan = buildBootstrapPlan(config);
    const paths = manifestPaths(manifest_file);
    const now = () => new Date(clock.now()).toISOString();
    result.operator_must_set = plan.server_settings.map((setting) => `${setting.file}: ${setting.key}=${setting.value}`);

    const send = async (command, changes) => {
        result.commands.push({ command, changes });
        return String(await rcon.send(command) ?? '');
    };
    // A command that reads or changes a block. "That position is not loaded" is its own failure (seen on the
    // real server with no player online): the area is not loaded, which says nothing about the block.
    const look = async (command, changes = false) => {
        const answer = await send(command, changes);
        if (READ_ANSWERS.not_loaded(answer)) throw new ReadError('not_loaded', command, answer);
        return answer;
    };
    const clip = (text) => { const value = String(text ?? ''); return value.length > 300 ? `${value.slice(0, 300)}...` : value; };
    const stop = (stage, problem, failed = null) => {
        result.stage = stage;
        result.problems.push(problem);
        result.failed = failed;
    };

    // ---- what an earlier run recorded -------------------------------------------------------
    let previous = null;
    let previous_text = null;
    let after_reset = false;
    try {
        after_reset = (await files.read(paths.reset_marker)) !== null;
        previous_text = await files.read(paths.manifest);
        previous = parseManifest(previous_text);
    } catch (err) {
        stop('validate', `the manifest folder cannot be read (${err?.message ?? err})`);
        return result;
    }
    // after a full reset the world is new: nothing an earlier manifest says is true of it
    if (after_reset || (previous && previous.seed !== plan.seed)) previous = null;
    const run = (previous?.runs?.length ?? 0) + 1;
    const carried = (list, id, same) => (previous?.[list] ?? []).find((record) => record.id === id && same(record)) ?? null;
    const records = { blocks: [], items: [], rules: [], areas: [] };

    // reading the land (genesis/world/survey.js): nothing it sends can change the world
    const reader = createReader({ send: (command) => send(command, false) });
    let chunks = null; // the chunks force-loaded for this run, given back when it ends

    let failure = null;
    try {
        failure = await work();
    } catch (err) {
        if (err instanceof ReadError && err.code === 'not_loaded') {
            stop(result.stage, `the area is NOT LOADED: the server answered ${JSON.stringify(err.answer)} to "${err.command}". No block was read as missing or wrong because of it. `
                + 'The chunks force-loaded for this run did not stay loaded (or the command reached outside them): run the bootstrap again, and send this line if it repeats.',
            { id: 'not_loaded', pos: null, expected: 'a loaded position', answer: err.answer });
        } else stop(result.stage, `the server could not be asked (${err?.message ?? err})`);
        failure = true;
    }
    try { await chunks?.release(); } catch { /* the connection is gone: the report says which chunks stay marked */ }
    result.survey.commands = reader.stats().commands;

    async function work() {
        // ---- 2. the seed ----
        result.stage = 'seed';
        const seed_answer = await send('seed', false);
        const seed = ANSWERS.seed(seed_answer);
        if (seed !== plan.seed) {
            stop('seed', seed === null
                ? `the server's answer to "seed" was not understood: ${JSON.stringify(seed_answer)}`
                : `the world was generated from seed ${seed}, the world file says ${plan.seed}`);
            return true;
        }

        // ---- 3. the rules ----
        result.stage = 'rules';
        for (const rule of plan.rules) {
            const record = { id: rule.id, kind: rule.kind, value: rule.expect, favours_agents: rule.favours_agents, why: rule.why, by: OPERATOR, status: null, at: now(), run };
            if (rule.kind === 'time') continue; // only on the first bootstrap of a NEW world: decided below, once it is known whether a camp stands
            if (rule.query === null) {
                const before = carried('rules', rule.id, (old) => old.value === rule.expect);
                if (before) { records.rules.push(before); continue; }
                await send(rule.set, true);
                result.placed.rules++;
                record.status = 'set, cannot be read back';
                records.rules.push(record);
                continue;
            }
            const read = ANSWERS[rule.kind];
            let answer = await send(rule.query, false);
            if (read(answer) === rule.expect) {
                records.rules.push(carried('rules', rule.id, (old) => old.value === rule.expect) ?? { ...record, status: 'already set' });
                continue;
            }
            await send(rule.set, true);
            result.placed.rules++;
            answer = await send(rule.query, false);
            if (read(answer) !== rule.expect) {
                stop('rules', `the rule ${rule.id} is not ${rule.expect} after "${rule.set}": the server says ${JSON.stringify(answer)}`,
                    { id: rule.id, pos: null, expected: rule.expect, answer });
                return true;
            }
            records.rules.push({ ...record, status: 'set' });
        }

        // ---- 4. the site is levelled, once: the camp, the field and every plot (decided) ----
        result.stage = 'level';
        // with no player online only the chunks at the spawn are loaded: the site's are force-loaded for this run
        const land = { min: [Math.min(...plan.zones.map((zone) => zone.min[0])), Math.min(...plan.zones.map((zone) => zone.min[1]))],
            max: [Math.max(...plan.zones.map((zone) => zone.max[0])), Math.max(...plan.zones.map((zone) => zone.max[1]))] };
        chunks = await loadChunks({ send: (command) => send(command, false), reader, box: land, sleep, log, ...load });
        if (!chunks.ok) { stop('level', `the site's chunks could not be loaded: ${chunks.problem}`); return true; }
        // the probe: every reading command once, where the answer is known. Stops with the raw answer.
        const home_column = [config.home[0], config.home[2]];
        const probed = await probe(reader, home_column, { log, names: false });
        if (!probed.ok) { stop('level', probed.problem, { id: 'probe', pos: null, expected: 'the answers of genesis/world/survey.js', answer: probed.answer }); return true; }

        const to_level = [];
        for (const area of plan.areas) {
            const before = carried('areas', area.id, (old) => old.block === area.block && sameBox(old, area));
            if (before) records.areas.push(before); else to_level.push(area);
        }
        const levelled_zones = new Set();
        // the morning of the first run (decided): set ONCE, on the first bootstrap of a new world, never again
        const morning = plan.rules.find((rule) => rule.kind === 'time');
        const morning_before = morning ? carried('rules', morning.id, () => true) : null;
        const firstMorning = async (camp_stands) => {
            if (!morning) return;
            if (morning_before) { records.rules.push(morning_before); return; }
            const record = { id: morning.id, kind: morning.kind, value: morning.expect, favours_agents: morning.favours_agents, why: morning.why, by: OPERATOR, status: null, at: now(), run };
            if (camp_stands) { records.rules.push({ ...record, favours_agents: false, status: 'not set: the world was bootstrapped before' }); return; }
            await send(morning.set, true);
            result.placed.rules++;
            records.rules.push({ ...record, status: 'set, once' });
        };
        if (to_level.length === 0) await firstMorning(true);
        if (to_level.length > 0) {
            // never over a camp that stands: with no record of the levelling, a block of the camp that is
            // already there means the manifest was lost, not that the world is new
            const camp_cells = plan.blocks.filter((block) => block.pos[0] >= plan.floor.min[0] && block.pos[0] <= plan.floor.max[0]
                && block.pos[2] >= plan.floor.min[1] && block.pos[2] <= plan.floor.max[1] && block.pos[1] > plan.floor.y);
            let standing = null;
            for (const block of camp_cells) {
                if (passed(await look(`execute if block ${xyz(block.pos)} ${block.expect}`))) { standing = block; break; }
            }
            await firstMorning(standing !== null);
            const volume = (area) => (area.max[0] - area.min[0] + 1) * (area.max[1] - area.min[1] + 1) * (area.max[2] - area.min[2] + 1);
            const blank = (area) => ({ id: area.id, zone: area.zone, kind: area.kind, min: area.min, max: area.max, block: area.block, purpose: area.purpose, by: OPERATOR,
                method: null, cells: volume(area), before: null, laid: { block: area.block, count: 0 }, changed: 0, placed: false, status: null, at: now(), run });
            if (standing) {
                for (const area of to_level) records.areas.push({ ...blank(area), status: 'not levelled: the camp was already standing' });
                result.warnings.push(`The site was NOT levelled: the manifest has no record of the levelling, but the ${standing.purpose} already stands at ${standing.pos.join(', ')}. Nothing was cleared or floored; the floor check below decides whether the camp is fit.`);
            } else {
                // ---- how: WorldEdit from the console (decided), or the game's own fill command when the plugin is absent ----
                let edit = null;
                if (worldedit !== false) {
                    const found = await probeWorldEdit({ send: (command) => send(command, false), world: worldedit_world, at: [config.home[0], WORLD_BOTTOM, config.home[2]] });
                    if (found.present && !found.ok) { stop('level', found.problem, { id: 'worldedit.probe', pos: null, expected: 'the answers of genesis/world/worldedit.js', answer: JSON.stringify(found.answers) }); return true; }
                    if (found.present) {
                        edit = worldEditBox({ send: (command) => send(command, /^\/+set /.test(command)), prefix: found.prefix });
                        result.levelling = { method: 'worldedit', version: found.version, prefix: found.prefix, world: found.world };
                        log(`Levelling with WorldEdit ${found.version ?? ''} from the console (commands are sent as "${found.prefix}set ...", world "${found.world}").`);
                    } else {
                        result.warnings.push(`WorldEdit is not installed on this server (the answer to "worldedit version" was ${JSON.stringify(found.answer)}): the site was levelled with the game's own fill command instead.`);
                    }
                }
                if (!edit) {
                    result.levelling = { method: 'vanilla', version: null, why: worldedit === false ? 'WorldEdit was switched off for this run (--no-worldedit)' : 'WorldEdit is not installed' };
                    log('Levelling with the game\'s own fill command.');
                }
                const target = (area) => area.block.replace(/^minecraft:/, '');
                for (const [index, area] of to_level.entries()) {
                    const record = { ...blank(area), method: result.levelling.method };
                    // what is there, read with the game's own commands (probed above): the blocks that are not air,
                    // and whether anything needs to change at all. A site that is already flat and floored is left as it is.
                    const not_air = await reader.count(area);
                    const wrong = area.kind === 'clear' ? not_air > 0 : (await checkBox(reader, area, [area.block])) !== null;
                    record.before = { not_air, by_type: null };
                    if (!wrong) {
                        records.areas.push({ ...record, status: 'nothing to change' });
                        levelled_zones.add(area.zone);
                        log(`Levelled ${index + 1} of ${to_level.length}: ${area.purpose}: already as it should be, nothing changed`);
                        continue;
                    }
                    let changed = null;
                    if (edit) {
                        const unset = await edit.select(area);
                        if (unset) {
                            stop('level', `the ${area.purpose} could not be selected in WorldEdit: the answer to "${unset.command}" was not understood: ${JSON.stringify(unset.answer)}`,
                                { id: area.id, pos: area.min, expected: 'First/Second position set to (x, y, z)', answer: unset.answer });
                            return true;
                        }
                        // what was there before, by kind of block (decided: counts by block type per area)
                        const distribution = await edit.distribution();
                        record.before.by_type = distribution.counts;
                        if (!distribution.counts) record.before.not_read = clip(distribution.answer);
                        const done = await edit.set(area.block);
                        // WorldEdit's own word is not relied on: the box is read back
                        const left = area.kind === 'clear' ? ((await reader.count(area)) > 0 ? { found: 'blocks that are not air' } : null) : await checkBox(reader, area, [area.block]);
                        if (left) {
                            stop('level', `the ${area.purpose} is not ${area.block} after "${done.command}": the box still holds ${left.found}${left.pos ? ` at ${left.pos.join(', ')}` : ''}. WorldEdit answered ${JSON.stringify(clip(done.answer))}`,
                                { id: area.id, pos: left.pos ?? area.min, expected: area.block, answer: done.answer });
                            return true;
                        }
                        // the blocks that changed: every cell that was not the target block already
                        changed = area.kind === 'clear' ? not_air
                            : (distribution.counts ? record.cells - (distribution.counts[target(area)] ?? 0) : done.affected);
                        record.worldedit = { affected: done.affected };
                    } else {
                        const command = `fill ${xyz(area.min)} ${xyz(area.max)} ${area.block}`;
                        const answer = await send(command, true);
                        if (READ_ANSWERS.not_loaded(answer)) throw new ReadError('not_loaded', command, answer);
                        changed = ANSWERS.fill(answer);
                        if (changed === null) {
                            stop('level', `the ${area.purpose} could not be filled: the server's answer to "${command}" was not understood: ${JSON.stringify(answer)}`,
                                { id: area.id, pos: area.min, expected: area.block, answer });
                            return true;
                        }
                    }
                    result.placed[area.kind === 'floor' ? 'floored' : 'cleared'] += changed ?? 0;
                    records.areas.push({ ...record, laid: { block: area.block, count: changed }, changed: changed ?? 0, placed: true, status: 'filled' });
                    levelled_zones.add(area.zone);
                    log(`Levelled ${index + 1} of ${to_level.length}: ${area.purpose}: ${changed ?? 'an unknown number of'} blocks changed`);
                }
            }
        }

        // ---- 5. the starter camp: look first, place only what is not there ----
        result.stage = 'camp';
        const to_check = [];
        for (const block of plan.blocks) {
            const same = (old) => old.block === block.place && old.pos.join(',') === block.pos.join(',');
            const before = carried('blocks', block.id, same);
            if (block.once && before) { records.blocks.push(before); continue; } // the agents' business since the first run
            const there = passed(await look(`execute if block ${xyz(block.pos)} ${block.once ? block.place : block.expect}`));
            if (there) {
                records.blocks.push(before ?? { id: block.id, pos: block.pos, block: block.place, purpose: block.purpose, by: OPERATOR, placed: false, at: now(), run });
            } else {
                await look(`setblock ${xyz(block.pos)} ${block.place}`, true);
                result.placed.blocks++;
                records.blocks.push({ id: block.id, pos: block.pos, block: block.place, purpose: block.purpose, by: OPERATOR, placed: true, at: now(), run });
            }
            to_check.push(block);
        }

        // ---- 6. the kit, once ----
        result.stage = 'kits';
        const new_items = [];
        let in_chest = null;
        for (const item of plan.items) {
            const same = (old) => old.item === item.item && old.count === item.count && old.slot === item.slot && old.pos.join(',') === item.pos.join(',');
            const before = carried('items', item.id, same);
            if (before) { records.items.push(before); continue; }
            // (through look(): "not loaded" is the one named failure, whatever command met it)
            in_chest ??= (await readContainer(look, item.pos)).slots ?? new Map();
            const held = in_chest.get(item.slot);
            const record = { id: item.id, chest: item.chest, pos: item.pos, slot: item.slot, item: item.item, count: item.count, by: OPERATOR, placed: true, at: now(), run };
            if (held && held.item === item.item && held.count === item.count) {
                records.items.push({ ...record, placed: false });
            } else {
                await look(`item replace block ${xyz(item.pos)} container.${item.slot} with ${item.item} ${item.count}`, true);
                result.placed.items++;
                records.items.push(record);
            }
            new_items.push(item);
        }

        // ---- 7. check every block again, and the camp's floor ----
        result.stage = 'check';
        for (const floor of plan.floors) {
            // the camp's floor in every run; a plot's only in the run that levelled it (then it is its owner's)
            if (!floor.every_run && !levelled_zones.has(floor.zone)) continue;
            const wrong = await checkBox(reader, { min: [floor.min[0], floor.y, floor.min[1]], max: [floor.max[0], floor.y, floor.max[1]] }, floor.accepts);
            if (wrong) {
                stop('check', `floor check failed at ${wrong.pos.join(', ')}: the ${floor.label} floor should be ${floor.accepts.join(' or ')}, the server says it is ${wrong.found}`,
                    { id: floor.id, pos: wrong.pos, expected: floor.accepts.join(' | '), answer: wrong.found });
                return true;
            }
        }
        for (const block of to_check) {
            const expected = block.once ? block.place : block.expect;
            const answer = await look(`execute if block ${xyz(block.pos)} ${expected}`);
            if (!passed(answer)) {
                stop('check', `block check failed at ${block.pos.join(', ')}: ${block.purpose} should be ${expected}, the server says ${JSON.stringify(answer)}`,
                    { id: block.id, pos: block.pos, expected, answer });
                return true;
            }
        }
        if (new_items.length > 0) {
            const pos = new_items[0].pos;
            const { slots, answer, not_loaded } = await readContainer(look, pos);
            for (const item of new_items) {
                const held = slots?.get(item.slot);
                if (!held || held.item !== item.item || held.count !== item.count) {
                    const found = slots ? `it holds ${held ? `${held.count} ${held.item}` : 'nothing'}`
                        : not_loaded ? `the area is not loaded on the server (${JSON.stringify(answer)}): a player must be nearby, or the chunks force-loaded, while the bootstrap runs`
                            : `the server's answer was not understood: ${JSON.stringify(answer)}`;
                    stop('check', `item check failed at ${pos.join(', ')}: slot ${item.slot} of the kits chest should hold ${item.count} ${item.item}, ${found}`,
                        { id: item.id, pos, expected: `${item.count} ${item.item} in slot ${item.slot}`, answer });
                    return true;
                }
            }
        }
        return false;
    }

    if (result.stage === 'seed' && failure) return result; // nothing was touched: nothing to record
    if (!failure) result.stage = 'done';
    result.ok = !failure;
    if (after_reset && result.ok && !result.commands.some((entry) => entry.command.startsWith('setblock'))) {
        result.warnings.push('Every block of the camp was already there, straight after a full reset. Was the world folder really deleted and generated anew?');
    }

    // ---- 8. the manifest, whatever happened: what was placed is recorded even when a check failed ----
    // records of an earlier run that this run did not get to (it stopped early) are kept
    const merged = (list) => {
        const ids = new Set(records[list].map((record) => record.id));
        return [...records[list], ...(previous?.[list] ?? []).filter((record) => !ids.has(record.id))];
    };
    const must_set = plan.server_settings.map((setting) => ({
        id: `${setting.file}:${setting.key}`, kind: 'server_setting', value: setting.value, favours_agents: setting.favours_agents,
        why: setting.why, by: OPERATOR, status: 'operator must set', at: now(), run,
    }));
    const rules = [...merged('rules').filter((record) => record.kind !== 'server_setting'), ...must_set];
    const manifest = {
        v: MANIFEST_VERSION,
        kind: MANIFEST_KIND,
        world_file,
        world_sha256: worldHash(config),
        seed: plan.seed,
        attributed_to: OPERATOR,
        // how the site was chosen (decided: recorded): by genesis/world/site.js with its scores, or by hand
        site: site ?? (previous?.site && previous.world_sha256 === worldHash(config) ? previous.site : {
            method: 'manual', by: OPERATOR, at: now(), home: [...config.home],
            how: 'the operator gave the coordinates (genesis/tools/place_world.js --at, or a world file written by hand)',
        }),
        // how the site was levelled: WorldEdit from the console, or the game's own fill command
        levelling: result.levelling ?? previous?.levelling ?? null,
        verified: result.ok,
        verified_at: result.ok ? now() : null,
        runs: [...(previous?.runs ?? []), {
            run, at: now(), blocks_placed: result.placed.blocks, items_placed: result.placed.items, rules_set: result.placed.rules,
            blocks_cleared: result.placed.cleared, floor_blocks_placed: result.placed.floored, reading_commands: result.survey.commands,
            result: result.ok ? 'ok' : result.problems.join('; '),
        }],
        areas: merged('areas'),
        blocks: merged('blocks'),
        items: merged('items'),
        rules,
        favours_agents: [...plan.favours.map((entry) => entry.what), ...rules.filter((rule) => rule.favours_agents).map((rule) => rule.why)],
        operator_must_set: result.operator_must_set,
    };
    result.manifest = manifest;
    try {
        if (after_reset && previous_text !== null) {
            // the manifest of the world that was wiped is kept beside the new one, under another name
            await files.write(path.join(paths.dir, `bootstrap.manifest.before-reset-${now().replace(/[:.]/g, '-')}.json`), previous_text);
        }
        const text = `${JSON.stringify(manifest, null, 2)}\n`;
        await files.write(`${paths.manifest}.tmp`, text);
        await files.rename(`${paths.manifest}.tmp`, paths.manifest);
        await files.write(paths.server_settings, serverSettingsText(plan, { world_file }));
        if (after_reset && result.ok) await files.remove(paths.reset_marker);
    } catch (err) {
        result.ok = false;
        result.problems.push(`the manifest could not be written (${err?.message ?? err})`);
    }
    return result;
}

// What the run did, as lines for the operator.
export function reportLines(result, { manifest_file = DEFAULT_MANIFEST_FILE } = {}) {
    const lines = [];
    const changing = result.commands.filter((entry) => entry.changes).length;
    lines.push(`Bootstrap ${result.ok ? 'PASSED' : `FAILED at stage "${result.stage}"`}: ${result.commands.length} commands sent, ${changing} of them changing the world.`);
    lines.push(`Levelled the site (camp, field, plots)${result.levelling ? ` with ${result.levelling.method === 'worldedit' ? `WorldEdit ${result.levelling.version ?? ''}`.trim() : 'the game\'s fill command'}` : ''}: ${result.placed.cleared} blocks cleared, ${result.placed.floored} floor blocks placed (counts per area and by kind of block are in the manifest).`);
    lines.push(`Placed: ${result.placed.blocks} blocks, ${result.placed.items} item stacks; rules set: ${result.placed.rules}.`);
    for (const problem of result.problems) lines.push(`PROBLEM: ${problem}`);
    if (result.failed?.pos) lines.push(`Failed position: ${result.failed.pos.join(', ')}`);
    for (const warning of result.warnings) lines.push(`WARNING: ${warning}`);
    if (result.manifest) {
        lines.push(`Manifest: ${manifest_file} (everything placed is attributed to "${OPERATOR}")`);
        lines.push(`Operator must set (not settable over RCON, see ${manifestPaths(manifest_file).server_settings}):`);
        for (const line of result.operator_must_set) lines.push(`  operator must set: ${line}`);
    }
    if (result.ok) lines.push('The agents may start: the launcher will accept this manifest for this world file.');
    return lines;
}

// ---- command line ---------------------------------------------------------------------------

function option(argv, name) {
    const index = argv.indexOf(name);
    return index >= 0 && index + 1 < argv.length ? argv[index + 1] : null;
}

// The site stage: no world file yet, so the place is chosen from the land itself and the world
// file is written for it. Resolves to { ok, config, site, lines }. `files` as for runBootstrap.
export async function runSiteStage({
    rcon, files, example, world_file, manifest_file = DEFAULT_MANIFEST_FILE, blueprints = null, options = {}, from = null,
    dry_run = false, clock = { now: Date.now }, log = () => {}, sleep,
} = {}) {
    const { pickSite, siteReportLines, SITE_RECORD_FILE } = await import('./site.js');
    const seed_answer = String(await rcon.send('seed') ?? '');
    const seed = ANSWERS.seed(seed_answer);
    if (seed === null) {
        return { ok: false, config: null, site: null, lines: [`Site selection FAILED: the server's answer to "seed" was not understood: ${JSON.stringify(seed_answer)}. Nothing was changed.`] };
    }
    const picked = await pickSite({ send: (command) => rcon.send(command), example, seed, blueprints, options, from, clock, log, ...(sleep ? { sleep } : {}) });
    const lines = siteReportLines(picked, { dry_run });
    if (!picked.ok || dry_run) return { ok: picked.ok, config: picked.world, site: picked.record, lines, picked };
    try {
        await files.write(world_file, `${JSON.stringify(picked.world, null, 4)}\n`);
        await files.write(path.join(manifestPaths(manifest_file).dir, SITE_RECORD_FILE), `${JSON.stringify(picked.record, null, 2)}\n`);
    } catch (err) {
        return { ok: false, config: null, site: null, lines: [...lines, `PROBLEM: the world file could not be written (${err?.message ?? err})`], picked };
    }
    lines.push(`Wrote ${world_file} (seed ${picked.world.seed}) and the record of the selection next to the manifest.`);
    return { ok: true, config: picked.world, site: picked.record, lines, picked };
}

// The record of an automatic selection for exactly this world file, or null (the site was given by hand).
export async function readSiteRecord({ files, manifest_file = DEFAULT_MANIFEST_FILE, config }) {
    try {
        const { SITE_RECORD_FILE, SITE_RECORD_KIND } = await import('./site.js');
        const record = JSON.parse(await files.read(path.join(manifestPaths(manifest_file).dir, SITE_RECORD_FILE)) ?? 'null');
        return record?.kind === SITE_RECORD_KIND && record.world_sha256 === worldHash(config) ? record : null;
    } catch {
        return null;
    }
}

async function main(argv) {
    const { readFileSync, existsSync } = await import('node:fs');
    const { nodeFiles } = await import('../store/node_files.js');
    const { fileBlueprints } = await import('../catalog/blueprints.js');
    const { createRconClient, RCON_DEFAULT_PORT } = await import('./rcon.js');
    const repo_root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    process.chdir(repo_root);

    const settings_file = option(argv, '--settings') ?? process.env.GENESIS_SETTINGS_FILE ?? path.join(repo_root, 'genesis', 'settings.json');
    let settings = {};
    try { settings = JSON.parse(readFileSync(settings_file, 'utf8')); } catch (err) {
        console.error(`The Genesis settings cannot be read (${settings_file}): ${err.message}`);
        return 1;
    }
    const world_file = option(argv, '--world') ?? process.env.GENESIS_WORLD_FILE ?? settings.genesis_planning?.world_file ?? './genesis/genesis.world.json';
    const manifest_file = option(argv, '--manifest') ?? settings.genesis_planning?.manifest_file ?? DEFAULT_MANIFEST_FILE;
    const blueprints = fileBlueprints();
    const pick_only = argv.includes('--pick-site');
    const have_world = existsSync(world_file);
    const log = (line) => console.log(line); // progress, as it happens

    let config = null;
    if (have_world && !pick_only) {
        try { config = JSON.parse(readFileSync(world_file, 'utf8')); } catch (err) {
            console.error(`The world file cannot be read (${world_file}): ${err.message}`);
            return 1;
        }
        const problems = checkWorldConfig(config, { blueprints });
        if (problems.length > 0) {
            for (const problem of problems) console.error(`World file problem: ${describeProblem(problem)}`);
            console.error(`Nothing was sent to the server. Fix ${world_file} first.`);
            return 1;
        }
    }
    if (argv.includes('--validate') || argv.includes('--plan')) {
        if (!config) {
            console.error(`The world file cannot be read (${world_file}): the file does not exist. Run the bootstrap without --validate: it picks the site and writes the file.`);
            return 1;
        }
        if (argv.includes('--validate')) console.log(`${world_file} is valid (seed ${seedText(config.seed)}, sha256 ${worldHash(config)}).`);
        else console.log(JSON.stringify(buildBootstrapPlan(config), null, 2));
        return 0;
    }
    const password = process.env.GENESIS_RCON_PASSWORD;
    if (!password) {
        console.error('GENESIS_RCON_PASSWORD is not set. The bootstrap needs the RCON password of the Minecraft server (rcon.password in server.properties).');
        return 1;
    }
    const rcon = createRconClient({
        host: process.env.GENESIS_RCON_HOST ?? settings.host ?? '127.0.0.1',
        port: Number(process.env.GENESIS_RCON_PORT ?? RCON_DEFAULT_PORT),
        password,
    });
    try {
        await rcon.connect();
    } catch (err) {
        console.error(`RCON: could not connect and log in (${err.message}). Nothing was changed.`);
        rcon.end();
        return 1;
    }
    const files = nodeFiles();
    let site = null;
    if (!config) {
        // ---- the site stage: no world file, so the bootstrap picks the place itself (decided) ----
        const whole = (name) => { const value = option(argv, name); return value !== null && /^-?\d+$/.test(value) ? Number(value) : null; };
        const from_at = argv.indexOf('--site-from');
        const from = from_at >= 0 ? [Number(argv[from_at + 1]), Number(argv[from_at + 2])] : null;
        if (from && !from.every(Number.isInteger)) {
            console.error('--site-from needs two whole numbers: <x> <z>');
            rcon.end();
            return 1;
        }
        const options = {};
        if (whole('--site-radius') !== null) options.radius = whole('--site-radius');
        if (whole('--site-step') !== null) options.step = Math.max(1, whole('--site-step'));
        if (whole('--site-relief') !== null) options.max_relief = whole('--site-relief');
        let example;
        const example_file = option(argv, '--example') ?? './genesis/genesis.world.example.json';
        try { example = JSON.parse(readFileSync(example_file, 'utf8')); } catch (err) {
            console.error(`The example world file cannot be read (${example_file}): ${err.message}`);
            rcon.end();
            return 1;
        }
        if (have_world && pick_only) console.log(`${world_file} is already there: this dry run does not look at it and does not replace it.`);
        const stage = await runSiteStage({ rcon, files, example, world_file, manifest_file, blueprints, options, from, dry_run: pick_only, log });
        for (const line of stage.lines) console.log(line);
        if (!stage.ok || pick_only) { rcon.end(); return stage.ok ? 0 : 1; }
        config = stage.config;
        site = stage.site;
    } else {
        site = await readSiteRecord({ files, manifest_file, config });
    }
    const result = await runBootstrap({
        config, rcon, files, manifest_file, world_file, blueprints, site, log,
        worldedit: !argv.includes('--no-worldedit'), worldedit_world: process.env.GENESIS_WORLDEDIT_WORLD || 'world',
    });
    rcon.end();
    for (const line of reportLines(result, { manifest_file })) console.log(line);
    return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    main(process.argv.slice(2)).then((code) => process.exit(code), (err) => { console.error(err); process.exit(1); });
}
