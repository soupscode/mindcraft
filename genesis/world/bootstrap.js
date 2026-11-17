// Genesis: the world bootstrap. It applies the world file (genesis.world.json, "v": 2) to a
// new Minecraft world over RCON and CHECKS every block it placed. The agents may only start
// planning once it has passed: the launcher asks for the manifest this script writes.
//
//   node genesis/world/bootstrap.js              apply the world file and check the world
//   node genesis/world/bootstrap.js --validate   only check the world file (no server needed)
//   node genesis/world/bootstrap.js --plan       print what would be placed (no server needed)
//   options:  --settings <file>   the Genesis settings (default genesis/settings.json; GENESIS_SETTINGS_FILE)
//             --world <file>      the world file (default: "genesis_planning.world_file" of the settings)
//             --manifest <file>   the manifest (default: "genesis_planning.manifest_file", else ./bots/genesis_world/bootstrap.manifest.json)
//   RCON:     GENESIS_RCON_PASSWORD (required), GENESIS_RCON_HOST (default: "host" of the settings),
//             GENESIS_RCON_PORT (default 25575). The password is never written anywhere.
//
// What it does, in this order, stopping at the first thing that fails:
//   1. checks the world file (genesis/world/world_config.js); nothing is sent while it has problems
//   2. asks the server for its seed: it must be the seed in the world file
//   3. game rules: reads each one, sets it only when it differs, and reads it back
//   4. levels the camp, ONCE (decided): the layers above the camp's floor are cleared, highest
//      first, and the floor is laid, each layer with one fill command. Never done again once the
//      manifest records it, and never where the camp already stands (see below).
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
// is every rule that favours the agents. The levelling is recorded layer by layer with the
// number of blocks the server reported as changed (removed or placed): a fill command does
// not say which blocks they were. The script never edits server files and never deletes
// anything in the world folder.
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
} = {}) {
    const result = {
        ok: false, stage: 'validate', problems: [], failed: null, commands: [], placed: { blocks: 0, items: 0, rules: 0, cleared: 0, floored: 0 },
        manifest: null, operator_must_set: [], warnings: [],
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

    let failure = null;
    try {
        failure = await work();
    } catch (err) {
        stop(result.stage, `the server could not be asked (${err?.message ?? err})`);
        failure = true;
    }

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

        // ---- 4. the camp is levelled, once: cleared above the floor (highest layer first), then floored ----
        result.stage = 'level';
        const to_level = [];
        for (const area of plan.areas) {
            const before = carried('areas', area.id, (old) => old.block === area.block && sameBox(old, area));
            if (before) records.areas.push(before); else to_level.push(area);
        }
        if (to_level.length > 0) {
            // never over a camp that stands: with no record of the levelling, a block of the camp that is
            // already there means the manifest was lost, not that the world is new
            const camp_cells = plan.blocks.filter((block) => block.pos[0] >= plan.floor.min[0] && block.pos[0] <= plan.floor.max[0]
                && block.pos[2] >= plan.floor.min[1] && block.pos[2] <= plan.floor.max[1] && block.pos[1] > plan.floor.y);
            let standing = null;
            for (const block of camp_cells) {
                if (passed(await send(`execute if block ${xyz(block.pos)} ${block.expect}`, false))) { standing = block; break; }
            }
            for (const area of to_level) {
                const record = { id: area.id, kind: area.kind, min: area.min, max: area.max, block: area.block, purpose: area.purpose, by: OPERATOR, changed: 0, placed: false, status: null, at: now(), run };
                if (standing) {
                    records.areas.push({ ...record, status: 'not levelled: the camp was already standing' });
                    continue;
                }
                const command = `fill ${xyz(area.min)} ${xyz(area.max)} ${area.block}`;
                const answer = await send(command, true);
                const changed = ANSWERS.fill(answer);
                if (changed === null) {
                    stop('level', `the ${area.purpose} could not be filled: the server's answer to "${command}" was not understood: ${JSON.stringify(answer)}`,
                        { id: area.id, pos: area.min, expected: area.block, answer });
                    return true;
                }
                result.placed[area.kind === 'floor' ? 'floored' : 'cleared'] += changed;
                records.areas.push({ ...record, changed, placed: changed > 0, status: changed > 0 ? 'filled' : 'nothing to change' });
            }
            if (standing) {
                result.warnings.push(`The camp was NOT levelled: the manifest has no record of the levelling, but the ${standing.purpose} already stands at ${standing.pos.join(', ')}. Nothing was cleared or floored; the floor check below decides whether the camp is fit.`);
            }
        }

        // ---- 5. the starter camp: look first, place only what is not there ----
        result.stage = 'camp';
        const to_check = [];
        for (const block of plan.blocks) {
            const same = (old) => old.block === block.place && old.pos.join(',') === block.pos.join(',');
            const before = carried('blocks', block.id, same);
            if (block.once && before) { records.blocks.push(before); continue; } // the agents' business since the first run
            const there = passed(await send(`execute if block ${xyz(block.pos)} ${block.once ? block.place : block.expect}`, false));
            if (there) {
                records.blocks.push(before ?? { id: block.id, pos: block.pos, block: block.place, purpose: block.purpose, by: OPERATOR, placed: false, at: now(), run });
            } else {
                await send(`setblock ${xyz(block.pos)} ${block.place}`, true);
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
            in_chest ??= (await readContainer(send, item.pos)).slots ?? new Map();
            const held = in_chest.get(item.slot);
            const record = { id: item.id, chest: item.chest, pos: item.pos, slot: item.slot, item: item.item, count: item.count, by: OPERATOR, placed: true, at: now(), run };
            if (held && held.item === item.item && held.count === item.count) {
                records.items.push({ ...record, placed: false });
            } else {
                await send(`item replace block ${xyz(item.pos)} container.${item.slot} with ${item.item} ${item.count}`, true);
                result.placed.items++;
                records.items.push(record);
            }
            new_items.push(item);
        }

        // ---- 7. check every block again, and the camp's floor ----
        result.stage = 'check';
        for (let x = plan.floor.min[0]; x <= plan.floor.max[0]; x++) {
            for (let z = plan.floor.min[1]; z <= plan.floor.max[1]; z++) {
                const pos = [x, plan.floor.y, z];
                let answer = '';
                let fits = false;
                for (const accepted of plan.floor.accepts) {
                    answer = await send(`execute if block ${xyz(pos)} ${accepted}`, false);
                    if (passed(answer)) { fits = true; break; }
                }
                if (!fits) {
                    stop('check', `floor check failed at ${pos.join(', ')}: the camp floor should be ${plan.floor.accepts.join(' or ')}, the server says ${JSON.stringify(answer)}`,
                        { id: 'camp.floor', pos, expected: plan.floor.accepts.join(' | '), answer });
                    return true;
                }
            }
        }
        for (const block of to_check) {
            const expected = block.once ? block.place : block.expect;
            const answer = await send(`execute if block ${xyz(block.pos)} ${expected}`, false);
            if (!passed(answer)) {
                stop('check', `block check failed at ${block.pos.join(', ')}: ${block.purpose} should be ${expected}, the server says ${JSON.stringify(answer)}`,
                    { id: block.id, pos: block.pos, expected, answer });
                return true;
            }
        }
        if (new_items.length > 0) {
            const pos = new_items[0].pos;
            const { slots, answer, not_loaded } = await readContainer(send, pos);
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
        verified: result.ok,
        verified_at: result.ok ? now() : null,
        runs: [...(previous?.runs ?? []), {
            run, at: now(), blocks_placed: result.placed.blocks, items_placed: result.placed.items, rules_set: result.placed.rules,
            blocks_cleared: result.placed.cleared, floor_blocks_placed: result.placed.floored,
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
    lines.push(`Levelled the camp: ${result.placed.cleared} blocks cleared, ${result.placed.floored} floor blocks placed.`);
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

async function main(argv) {
    const { readFileSync } = await import('node:fs');
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
    const world_file = option(argv, '--world') ?? settings.genesis_planning?.world_file ?? './genesis/genesis.world.json';
    const manifest_file = option(argv, '--manifest') ?? settings.genesis_planning?.manifest_file ?? DEFAULT_MANIFEST_FILE;
    let config;
    try { config = JSON.parse(readFileSync(world_file, 'utf8')); } catch (err) {
        console.error(`The world file cannot be read (${world_file}): ${err.code === 'ENOENT' ? 'the file does not exist' : err.message}`);
        return 1;
    }
    const blueprints = fileBlueprints();
    const problems = checkWorldConfig(config, { blueprints });
    if (problems.length > 0) {
        for (const problem of problems) console.error(`World file problem: ${describeProblem(problem)}`);
        console.error(`Nothing was sent to the server. Fix ${world_file} first.`);
        return 1;
    }
    if (argv.includes('--validate')) {
        console.log(`${world_file} is valid (seed ${seedText(config.seed)}, sha256 ${worldHash(config)}).`);
        return 0;
    }
    if (argv.includes('--plan')) {
        console.log(JSON.stringify(buildBootstrapPlan(config), null, 2));
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
    const result = await runBootstrap({ config, rcon, files: nodeFiles(), manifest_file, world_file, blueprints });
    rcon.end();
    for (const line of reportLines(result, { manifest_file })) console.log(line);
    return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    main(process.argv.slice(2)).then((code) => process.exit(code), (err) => { console.error(err); process.exit(1); });
}
