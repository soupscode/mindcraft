// Genesis: WorldEdit from the console (decided: the bootstrap flattens the site with WorldEdit,
// run over RCON; the plugin ships with the server, genesis/compose.minecraft.yaml).
//
// WHAT IS KNOWN, AND FROM WHERE
//   From WorldEdit's documentation (worldedit.enginehub.org, "commands"):
//     //world [world]          "Sets the world override" (so that commands work without a player)
//     //pos1 [coordinates]     "Set position 1"        //pos2 [coordinates]   "Set position 2"
//     //set <pattern>          "Sets all the blocks in the region"
//     //distr                  "Get the distribution of blocks in the selection"
//     /worldedit version       "Get WorldEdit version"
//   Seen in the game on the operator's Paper 1.21.6 server, typed by an operator player:
//     //pos1 234,67,-48   //pos2 313,67,11   //set grass_block   //set air
//     coordinates are comma-separated with NO spaces; a space-separated form was rejected.
//   NOT in the documentation, and NOT run from a console anywhere: how a double-slash command
//   is sent over RCON, whether the world override is enough for the console to hold a
//   selection, and how the answers are worded. The documentation has no page on console use.
//
// THE READING HERE: the game takes ONE leading slash off a command before it looks it up, and
// WorldEdit's commands are registered under names that themselves begin with a slash
// ("/pos1"). So the command is sent as typed in the game, with both slashes ("//pos1 0,64,0"),
// and the single-slash form is the second try. Nothing is assumed silently: probeWorldEdit()
// first sends the harmless "worldedit version", then the world override and one position, in
// both forms if needed, and the bootstrap stops with the raw answers when none is understood.
// What WorldEdit says it changed is never trusted on its own either: after every //set the
// box is read back with the vanilla reading commands (genesis/world/survey.js).
//
// Expected answers (general knowledge of WorldEdit 7; only what is marked * is relied on):
//   worldedit version   * a text that contains "WorldEdit"; "Unknown ... command" when the plugin is absent
//   //world world         "Set the world override to world. ..."
//   //pos1 x,y,z        * "First position set to (x, y, z)."         the three numbers are read back
//   //pos2 x,y,z        * "Second position set to (x, y, z) (n)."
//   //distr               lines "<count>  (<percent>%) <block name>": read when they look like that, else recorded as not read
//   //set <block>         "Operation completed (<n> blocks affected)."   read when it looks like that; the box is read back anyway
//
// Injected: send(command) -> Promise<answer text>.
// No imports.

export const WORLDEDIT_COMMANDS = Object.freeze([
    { command: 'worldedit version', answer: 'a text containing "WorldEdit" (the plugin is there) | "Unknown ... command" (it is not)' },
    { command: '//world <world name>', answer: 'not read: the next command shows whether it worked' },
    { command: '//pos1 <x>,<y>,<z>', answer: 'First position set to (<x>, <y>, <z>).' },
    { command: '//pos2 <x>,<y>,<z>', answer: 'Second position set to (<x>, <y>, <z>) (<n>).' },
    { command: '//distr', answer: 'lines "<count> (<percent>%) <block name>"; recorded as not read when they are not found' },
    { command: '//set <block>', answer: 'Operation completed (<n> blocks affected). Not relied on: the box is read back with the vanilla commands' },
]);

export const WORLDEDIT_PREFIXES = Object.freeze(['//', '/']);

export const WORLDEDIT_ANSWERS = Object.freeze({
    present: (answer) => /worldedit/i.test(String(answer ?? '')) && !/unknown (or incomplete )?command/i.test(String(answer ?? '')),
    absent: (answer) => /unknown (or incomplete )?command/i.test(String(answer ?? '')),
    version: (answer) => /version\s+([0-9][^\s;,)]*)/i.exec(String(answer ?? ''))?.[1] ?? null,
    // the position WorldEdit says it set, or null
    position: (answer) => {
        const found = /position set to\s*\(?\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)/i.exec(String(answer ?? ''));
        return found ? [Number(found[1]), Number(found[2]), Number(found[3])] : null;
    },
    // how many blocks WorldEdit says it affected, or null
    affected: (answer) => {
        const found = /([\d][\d,.  ]*)\s+blocks?\s+(?:affected|changed|have been changed)/i.exec(String(answer ?? ''));
        return found ? Number(found[1].replace(/[^\d]/g, '')) : null;
    },
});

// "Grass Block", "minecraft:grass_block" and "block.minecraft.grass_block" are all grass_block.
export const blockKey = (name) => String(name ?? '').trim().toLowerCase().replace(/^block\.minecraft\./, '').replace(/^minecraft:/, '').replace(/\[.*$/, '').replace(/\s+/g, '_');

// Reads the answer of //distr: { name: count } (names as blockKey makes them), or null when no line looks like one.
export function parseDistribution(answer) {
    const counts = {};
    let lines = 0;
    for (const line of String(answer ?? '').split(/\r?\n/)) {
        const found = /^\s*([\d][\d,.  ]*?)\s*\(\s*[\d.,]+\s*%\s*\)\s*(.+?)\s*$/.exec(line);
        if (!found) continue;
        const name = blockKey(found[2]);
        if (!/^[a-z0-9_]+$/.test(name)) continue;
        counts[name] = (counts[name] ?? 0) + Number(found[1].replace(/[^\d]/g, ''));
        lines++;
    }
    return lines > 0 ? counts : null;
}

// Is WorldEdit there, and how does this console take its commands? Resolves to
//   { present: false, answer }                           the plugin is absent: the vanilla path is used
//   { present: true, ok: true, prefix, version, world }  commands are sent as `${prefix}pos1 ...`
//   { present: true, ok: false, problem, answers }       it is there but not understood: the caller stops, with the raw answers
// `at` is a position ([x, y, z]) the probe may set as position 1: that selects nothing and changes nothing.
export async function probeWorldEdit({ send, world = 'world', at }) {
    const first = String(await send('worldedit version') ?? '');
    if (WORLDEDIT_ANSWERS.absent(first)) return { present: false, answer: first };
    if (!WORLDEDIT_ANSWERS.present(first)) {
        return { present: true, ok: false, answers: [['worldedit version', first]],
            problem: `the server's answer to "worldedit version" was not understood: ${JSON.stringify(first)}. Nothing was changed. (To level with the game's own fill command instead: --no-worldedit.)` };
    }
    const answers = [['worldedit version', first]];
    for (const prefix of WORLDEDIT_PREFIXES) {
        const override = `${prefix}world ${world}`;
        answers.push([override, String(await send(override) ?? '')]);
        const position = `${prefix}pos1 ${at.join(',')}`;
        const said = String(await send(position) ?? '');
        answers.push([position, said]);
        const set = WORLDEDIT_ANSWERS.position(said);
        if (set && set.join(',') === at.join(',')) return { present: true, ok: true, prefix, version: WORLDEDIT_ANSWERS.version(first), world };
    }
    return { present: true, ok: false, answers,
        problem: `WorldEdit is installed but its console commands were not understood. Nothing was changed. The commands and their raw answers: ${answers.map(([command, answer]) => `"${command}" -> ${JSON.stringify(answer)}`).join('; ')}. `
            + `Send these lines. (Is the world's name "${world}"? GENESIS_WORLDEDIT_WORLD says otherwise. To level with the game's own fill command instead: --no-worldedit.)` };
}

// The commands for one box, as the probe found they must be sent.
export function worldEditBox({ send, prefix }) {
    const run = async (text) => { const command = `${prefix}${text}`; return { command, answer: String(await send(command) ?? '') }; };
    return {
        // Selects the box. Resolves to null, or to { command, answer } of the position that was not set as asked.
        async select(box) {
            for (const [name, corner] of [['pos1', box.min], ['pos2', box.max]]) {
                const said = await run(`${name} ${corner.join(',')}`);
                const set = WORLDEDIT_ANSWERS.position(said.answer);
                if (!set || set.join(',') !== corner.join(',')) return said;
            }
            return null;
        },
        // What the selection holds, by kind of block: { counts | null, answer }.
        async distribution() { const said = await run('distr'); return { counts: parseDistribution(said.answer), ...said }; },
        // Sets every block of the selection: { affected | null, command, answer }.
        async set(block) { const said = await run(`set ${block.replace(/^minecraft:/, '')}`); return { affected: WORLDEDIT_ANSWERS.affected(said.answer), ...said }; },
    };
}
