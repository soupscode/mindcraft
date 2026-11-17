// A stand-in for a Minecraft server behind RCON, for the bootstrap tests. It keeps a world
// in memory and answers the few commands the bootstrap sends, in the words the real server
// is documented to use. It is NOT a Minecraft server: it shows that the bootstrap asks,
// places and checks in the right order, not that a real server understands it.
//
//   const server = fakeMinecraft({ seed: '4815162342' });
//   await server.send('setblock 0 64 0 minecraft:chest[facing=south,type=single]')
//   server.blocks        Map("x,y,z" -> { name, states })
//   server.log           every command received
//   server.refuse        (command) -> true: the command is answered but changes nothing
//   server.break_after   Map("x,y,z" -> { name, states }): what a block turns into right after it is set
//   server.fill_limit    how many blocks one fill command may cover (the game's default)
//   server.data_reply_limit  how many characters of block data a "data get" answer shows before "..."
//   server.unloaded      (command) -> true: a "data get" is answered "That position is not loaded"
//
// fill <x1> <y1> <z1> <x2> <y2> <z2> <block> is answered as the game is documented to: with the
// number of blocks that CHANGED ("Successfully filled 37 block(s)"), with "No blocks were filled"
// when none did, and with a refusal when the box holds more blocks than the limit.

const key = (x, y, z) => `${x},${y},${z}`;

export function parseBlock(text) {
    const match = /^(?:minecraft:)?([a-z0-9_]+)(?:\[([^\]]*)\])?$/.exec(text);
    if (!match) return null;
    const states = {};
    for (const pair of (match[2] ?? '').split(',').filter(Boolean)) {
        const [name, value] = pair.split('=');
        states[name.trim()] = String(value).trim();
    }
    return { name: match[1], states };
}

// The land (optional): terrain(x, y, z) -> a block name, or null for air, wherever no block was
// set by a command. Without it the world is air, over one layer of bedrock at y -64.
// Chunks (optional, `chunks: true`): only the chunk of the spawn can be read until
// "forceload add" marks more, which become readable `load_after` commands later; elsewhere
// every reading or changing command answers "That position is not loaded", as the game does.
//   execute if blocks <begin> <end> <destination> masked|all   "Test passed, count: <n>" | "Test failed"
//   forceload add|remove <x1> <z1> [<x2> <z2>], forceload query ~ ~
//   server.unknown_blocks   Set of names this server does not know (it answers with a syntax error)
// WorldEdit (optional, `worldedit: { version, prefix }`): the plugin's console commands as its
// documentation names them and as they were seen to work in the game (coordinates comma-separated,
// no spaces). `prefix` is how this stand-in wants them sent: "//" (the default) or "/".
//   worldedit version | //world <name> | //pos1 x,y,z | //pos2 x,y,z | //distr | //set <block>
//   server.worldedit.distr = false   makes //distr answer in words nobody can read
//   server.worldedit.set = false     makes //set answer as if done, and change nothing
export function fakeMinecraft({ seed = '0', difficulty = 'normal', gamerules = {}, border = 59999968, terrain = null, chunks = false, spawn = [0, 64, 0], load_after = 2, worldedit = null } = {}) {
    const server = {
        seed: String(seed),
        difficulty,
        gamerules: { keepInventory: 'false', mobGriefing: 'true', doFireTick: 'true', disableRaids: 'false', ...gamerules },
        border,
        border_center: [0, 0],
        spawn: [...spawn],
        terrain,
        chunks,
        loaded: new Set([`${Math.floor(spawn[0] / 16)},${Math.floor(spawn[2] / 16)}`]),
        forced: new Set(),
        loading: new Map(),     // "cx,cz" -> the number of the command from which it can be read
        load_after,
        unknown_blocks: new Set(),
        blocks: new Map(),      // air where nothing is set
        containers: new Map(),  // "x,y,z" -> Map(slot -> { item, count })
        log: [],
        refuse: () => false,
        break_after: new Map(),
        fill_limit: 32768,
        data_reply_limit: 70,
        unloaded: () => false,
        down: false,
        blockAt(x, y, z) {
            const set = server.blocks.get(key(x, y, z));
            if (set) return set;
            const name = server.terrain ? server.terrain(x, y, z) : (y === -64 ? 'bedrock' : null);
            return name ? { name, states: {} } : { name: 'air', states: {} };
        },
        // can the column be read? (always, unless the stand-in was made with chunks: true)
        isLoaded(x, z) {
            if (!server.chunks) return true;
            const chunk = `${Math.floor(x / 16)},${Math.floor(z / 16)}`;
            if (server.loaded.has(chunk)) return true;
            if (server.loading.has(chunk) && server.log.length >= server.loading.get(chunk)) { server.loaded.add(chunk); server.loading.delete(chunk); return true; }
            return false;
        },
        worldedit: worldedit ? { version: '7.4.6', prefix: '//', world: 'world', distr: true, set: true, override: null, pos1: null, pos2: null, ...worldedit } : null,
        // Answers a WorldEdit command, or null when the command is none.
        worldEdit(command) {
            const unknown = `Unknown or incomplete command, see below for error\n${command}<--[HERE]`;
            if (/^worldedit\b/.test(command)) return server.worldedit ? `WorldEdit version ${server.worldedit.version}\nPlatforms:\n * Bukkit-Official` : unknown;
            if (!command.startsWith('/')) return null;
            const we = server.worldedit;
            if (!we || !command.startsWith(we.prefix) || command.slice(we.prefix.length).startsWith('/')) return unknown;
            const [name, ...args] = command.slice(we.prefix.length).trim().split(/\s+/);
            if (name === 'world') { if (args[0] !== we.world) return `World ${args[0]} was not found`; we.override = args[0]; return `Set the world override to ${args[0]}. (Use //world to go back to default)`; }
            if (!['pos1', 'pos2', 'distr', 'set'].includes(name)) return unknown;
            if (!we.override) return 'You need to provide a world (Try //world)';
            if (name === 'pos1' || name === 'pos2') {
                if (args.length !== 1 || !/^-?\d+,-?\d+,-?\d+$/.test(args[0])) return 'Too many arguments.\nUsage: //pos1 [coordinates]';
                we[name] = args[0].split(',').map(Number);
                const both = we.pos1 && we.pos2;
                const cells = both ? [0, 1, 2].reduce((n, axis) => n * (Math.abs(we.pos1[axis] - we.pos2[axis]) + 1), 1) : null;
                return `${name === 'pos1' ? 'First' : 'Second'} position set to (${we[name].join(', ')})${both ? ` (${cells})` : ''}.`;
            }
            if (!we.pos1 || !we.pos2) return 'Make a region selection first.';
            const min = [0, 1, 2].map((axis) => Math.min(we.pos1[axis], we.pos2[axis]));
            const max = [0, 1, 2].map((axis) => Math.max(we.pos1[axis], we.pos2[axis]));
            const each = (fn) => { for (let x = min[0]; x <= max[0]; x++) for (let y = min[1]; y <= max[1]; y++) for (let z = min[2]; z <= max[2]; z++) fn(x, y, z); };
            if (name === 'distr') {
                if (!we.distr) return 'Block distribution: see the chat window.';
                const counts = new Map();
                let total = 0;
                each((x, y, z) => { const block = server.blockAt(x, y, z).name; counts.set(block, (counts.get(block) ?? 0) + 1); total++; });
                const title = (block) => block.split('_').map((word) => word[0].toUpperCase() + word.slice(1)).join(' ');
                return [`Total Block Count: ${total.toLocaleString('en-US')}`, ...[...counts].sort((a, b) => b[1] - a[1]).map(([block, n]) => `${n.toLocaleString('en-US')}  (${((n / total) * 100).toFixed(3)}%) ${title(block)}`)].join('\n');
            }
            const block = parseBlock(args[0] ?? '');
            if (!block) return 'Unknown block';
            let affected = 0;
            each((x, y, z) => {
                affected++;
                if (!we.set) return;
                if (block.name === 'air' && !server.terrain && y !== -64) server.blocks.delete(key(x, y, z)); else server.blocks.set(key(x, y, z), { name: block.name, states: {} });
                server.containers.delete(key(x, y, z));
            });
            return `Operation completed (${affected.toLocaleString('en-US')} blocks affected).`;
        },
        changing: () => server.log.filter((command) => /^(setblock|fill|\/+set |item replace|gamerule \S+ \S+|difficulty \S+|worldborder (set|center)|setworldspawn|time set)/.test(command)),
        async send(command) {
            if (server.down) throw new Error('RCON: the connection was closed');
            server.log.push(command);
            const plugin = server.worldEdit(command);
            if (plugin !== null) return plugin;
            const words = command.trim().split(/\s+/);
            const numbers = (from, count) => words.slice(from, from + count).map(Number);
            switch (words[0]) {
            case 'seed': return `Seed: [${server.seed}]`;
            case 'difficulty': {
                if (words.length === 1) return `The difficulty is ${server.difficulty[0].toUpperCase()}${server.difficulty.slice(1)}`;
                if (server.refuse(command)) return 'The difficulty did not change';
                server.difficulty = words[1];
                return `The difficulty has been set to ${words[1]}`;
            }
            case 'gamerule': {
                if (!Object.hasOwn(server.gamerules, words[1])) return `Incorrect argument for command\ngamerule ${words[1]}<--[HERE]`;
                if (words.length === 2) return `Gamerule ${words[1]} is currently set to: ${server.gamerules[words[1]]}`;
                if (!server.refuse(command)) server.gamerules[words[1]] = words[2];
                return `Gamerule ${words[1]} is now set to: ${server.gamerules[words[1]]}`;
            }
            case 'worldborder': {
                if (words[1] === 'get') return `The world border is currently ${server.border} block(s) wide`;
                if (words[1] === 'set') { if (!server.refuse(command)) server.border = Number(words[2]); return `Set the world border to ${words[2]} block(s) wide`; }
                if (words[1] === 'center') { server.border_center = numbers(2, 2); return `Set the center of the world border to ${words[2]}, ${words[3]}`; }
                return 'Unknown or incomplete command';
            }
            case 'time': if (words[1] === 'set' && words[2] === 'day') { server.time = 1000; return 'Set the time to 1000'; } return 'Unknown or incomplete command';
            case 'setworldspawn': server.spawn = numbers(1, 3); return `Set the world spawn point to ${words.slice(1, 4).join(', ')}`;
            case 'setblock': {
                const [x, y, z] = numbers(1, 3);
                const block = parseBlock(words[4]);
                if (!block) return 'Unknown block type';
                if (server.refuse(command)) return 'Could not set the block';
                const after = server.break_after.get(key(x, y, z));
                if (!server.isLoaded(x, z)) return 'That position is not loaded';
                if (block.name === 'air' && server.blockAt(x, y, z).name !== 'air' && !server.blocks.has(key(x, y, z))) server.blocks.set(key(x, y, z), { name: 'air', states: {} });
                else if (block.name === 'air') { if (server.terrain || y === -64) server.blocks.set(key(x, y, z), { name: 'air', states: {} }); else server.blocks.delete(key(x, y, z)); }
                else server.blocks.set(key(x, y, z), after ?? block);
                if (block.name === 'chest' && !server.containers.has(key(x, y, z))) server.containers.set(key(x, y, z), new Map());
                return `Changed the block at ${x}, ${y}, ${z}`;
            }
            case 'fill': {
                const [x1, y1, z1, x2, y2, z2] = numbers(1, 6);
                const block = parseBlock(words[7] ?? '');
                if (!block || words.length !== 8 || [x1, y1, z1, x2, y2, z2].some((n) => !Number.isInteger(n))) return 'Unknown or incomplete command';
                const volume = (Math.abs(x2 - x1) + 1) * (Math.abs(y2 - y1) + 1) * (Math.abs(z2 - z1) + 1);
                if (volume > server.fill_limit) return `Too many blocks in the specified area (maximum ${server.fill_limit}, specified ${volume})`;
                if (server.refuse(command)) return 'That position is not loaded';
                if (!server.isLoaded(x1, z1) || !server.isLoaded(x2, z2)) return 'That position is not loaded';
                const natural = server.terrain !== null;
                let changed = 0;
                for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) {
                    for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) {
                        for (let z = Math.min(z1, z2); z <= Math.max(z1, z2); z++) {
                            const there = server.blockAt(x, y, z);
                            if (there.name === block.name && JSON.stringify(there.states) === JSON.stringify(block.states)) continue;
                            if (block.name === 'air' && !natural && y !== -64) server.blocks.delete(key(x, y, z)); else server.blocks.set(key(x, y, z), { name: block.name, states: { ...block.states } });
                            server.containers.delete(key(x, y, z));
                            changed++;
                        }
                    }
                }
                return changed > 0 ? `Successfully filled ${changed} block(s)` : 'No blocks were filled';
            }
            case 'execute': {
                // execute if blocks <begin> <end> <destination> masked|all
                if (words[1] === 'if' && words[2] === 'blocks') {
                    const [x1, y1, z1, x2, y2, z2, dx, dy, dz] = numbers(3, 9);
                    const mode = words[12];
                    if (words.length !== 13 || !['masked', 'all'].includes(mode) || [x1, y1, z1, x2, y2, z2, dx, dy, dz].some((n) => !Number.isInteger(n))) return 'Unknown or incomplete command';
                    if (!server.isLoaded(x1, z1) || !server.isLoaded(x2, z2) || !server.isLoaded(dx, dz)) return 'That position is not loaded';
                    const min = [Math.min(x1, x2), Math.min(y1, y2), Math.min(z1, z2)];
                    const max = [Math.max(x1, x2), Math.max(y1, y2), Math.max(z1, z2)];
                    const cells = (max[0] - min[0] + 1) * (max[1] - min[1] + 1) * (max[2] - min[2] + 1);
                    if (cells > 32768) return `Too many blocks in the specified area (maximum 32768, specified ${cells})`;
                    const off = [dx - min[0], dy - min[1], dz - min[2]];
                    let count = 0;
                    for (let x = min[0]; x <= max[0]; x++) {
                        for (let y = min[1]; y <= max[1]; y++) {
                            for (let z = min[2]; z <= max[2]; z++) {
                                const here = server.blockAt(x, y, z);
                                if (mode === 'masked' && here.name === 'air') continue;
                                const there = off[0] === 0 && off[1] === 0 && off[2] === 0 ? here : server.blockAt(x + off[0], y + off[1], z + off[2]);
                                if (here !== there && (here.name !== there.name || JSON.stringify(here.states) !== JSON.stringify(there.states))) return 'Test failed';
                                count++;
                            }
                        }
                    }
                    return `Test passed, count: ${count}`;
                }
                // execute if block <x> <y> <z> <block[states]>
                if (words[1] !== 'if' || words[2] !== 'block') return 'Unknown or incomplete command';
                const [x, y, z] = numbers(3, 3);
                if (!server.isLoaded(x, z)) return 'That position is not loaded';
                const wanted = parseBlock(words[6]);
                if (wanted && server.unknown_blocks.has(wanted.name)) return `Unknown block type 'minecraft:${wanted.name}'\n...${words[6]}<--[HERE]`;
                const there = server.blockAt(x, y, z);
                const same = wanted && there.name === wanted.name && Object.entries(wanted.states).every(([name, value]) => there.states[name] === value);
                return same ? 'Test passed' : 'Test failed';
            }
            case 'forceload': {
                // forceload query ~ ~ | forceload add|remove <x1> <z1> [<x2> <z2>]
                if (words[1] === 'query') {
                    const [x, z] = words[2] === '~' ? [server.spawn[0], server.spawn[2]] : numbers(2, 2);
                    const chunk = [Math.floor(x / 16), Math.floor(z / 16)];
                    return `Chunk at [${chunk[0]}, ${chunk[1]}] in minecraft:overworld is ${server.forced.has(chunk.join(',')) ? '' : 'not '}marked for force loading`;
                }
                if (words[1] !== 'add' && words[1] !== 'remove') return 'Unknown or incomplete command';
                const [x1, z1] = numbers(2, 2);
                const [x2, z2] = words.length >= 6 ? numbers(4, 2) : [x1, z1];
                if ([x1, z1, x2, z2].some((n) => !Number.isInteger(n))) return 'Unknown or incomplete command';
                const [cx1, cx2] = [Math.floor(Math.min(x1, x2) / 16), Math.floor(Math.max(x1, x2) / 16)];
                const [cz1, cz2] = [Math.floor(Math.min(z1, z2) / 16), Math.floor(Math.max(z1, z2) / 16)];
                const total = (cx2 - cx1 + 1) * (cz2 - cz1 + 1);
                if (total > 256) return `Too many chunks in the specified area (maximum 256, specified ${total})`;
                let marked = 0;
                for (let cx = cx1; cx <= cx2; cx++) {
                    for (let cz = cz1; cz <= cz2; cz++) {
                        const chunk = `${cx},${cz}`;
                        if (words[1] === 'add') {
                            if (server.forced.has(chunk)) continue;
                            server.forced.add(chunk);
                            if (!server.loaded.has(chunk)) server.loading.set(chunk, server.log.length + server.load_after);
                        } else {
                            if (!server.forced.delete(chunk)) continue;
                        }
                        marked++;
                    }
                }
                const verb = words[1] === 'add' ? 'Marked' : 'Unmarked';
                if (marked === 0) return words[1] === 'add' ? 'No chunks were marked for force loading' : 'No chunks were removed from force loading';
                return marked === 1 ? `${verb} chunk [${cx1}, ${cz1}] in minecraft:overworld ${words[1] === 'add' ? 'to be' : 'for'} force loaded`
                    : `${verb} ${marked} chunks in minecraft:overworld from [${cx1}, ${cz1}] to [${cx2}, ${cz2}] ${words[1] === 'add' ? 'to be' : 'for'} force loaded`;
            }
            case 'item': {
                // item replace block <x> <y> <z> container.<slot> with <item> <count>
                const [x, y, z] = numbers(3, 3);
                const slots = server.containers.get(key(x, y, z));
                if (!slots) return 'The target block is not a container';
                const slot = Number(words[6].replace('container.', ''));
                if (!server.refuse(command)) slots.set(slot, { item: words[8], count: Number(words[9] ?? 1) });
                return `Replaced a slot at ${x}, ${y}, ${z} with [${words[8]}]`;
            }
            case 'data': {
                // data get block <x> <y> <z> Items | Items[<n>] | Items[<n>].Slot | .id | .count
                // As a real server (Paper 1.21.6) answers: a stack prints as {Slot: 0b, id: "...", count: 1},
                // and a long answer is cut off with "..." (server.data_reply_limit characters of data;
                // the real rule is not known, only that eight stacks did not fit).
                const [x, y, z] = numbers(3, 3);
                const path = words[6] ?? '';
                if (server.unloaded(command)) return 'That position is not loaded';
                const slots = server.containers.get(key(x, y, z));
                if (!slots) return 'The target block is not a block entity';
                const stacks = [...slots].sort((a, b) => a[0] - b[0]);
                const print = ([slot, stack]) => `{Slot: ${slot}b, id: "${stack.item}", count: ${stack.count}}`;
                const reply = (data) => `${x}, ${y}, ${z} has the following block data: ${data.length > server.data_reply_limit ? `${data.slice(0, server.data_reply_limit - 3)}...` : data}`;
                const element = /^Items\[(\d+)\](?:\.(Slot|id|count))?$/.exec(path);
                if (path === 'Items') return stacks.length === 0 ? 'Found no elements matching Items' : reply(`[${stacks.map(print).join(', ')}]`);
                if (!element) return 'Unknown or incomplete command';
                const entry = stacks[Number(element[1])];
                if (!entry) return `Found no elements matching ${path}`;
                if (element[2] === 'Slot') return reply(`${entry[0]}b`);
                if (element[2] === 'id') return reply(`"${entry[1].item}"`);
                if (element[2] === 'count') return reply(`${entry[1].count}`);
                return reply(print(entry));
            }
            default: return `Unknown or incomplete command, see below for error\n${command}<--[HERE]`;
            }
        },
    };
    return server;
}
