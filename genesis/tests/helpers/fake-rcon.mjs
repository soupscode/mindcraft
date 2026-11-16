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

export function fakeMinecraft({ seed = '0', difficulty = 'normal', gamerules = {}, border = 59999968 } = {}) {
    const server = {
        seed: String(seed),
        difficulty,
        gamerules: { keepInventory: 'false', mobGriefing: 'true', doFireTick: 'true', disableRaids: 'false', ...gamerules },
        border,
        border_center: [0, 0],
        spawn: [0, 64, 0],
        blocks: new Map(),      // air where nothing is set
        containers: new Map(),  // "x,y,z" -> Map(slot -> { item, count })
        log: [],
        refuse: () => false,
        break_after: new Map(),
        fill_limit: 32768,
        down: false,
        blockAt(x, y, z) { return server.blocks.get(key(x, y, z)) ?? { name: 'air', states: {} }; },
        changing: () => server.log.filter((command) => /^(setblock|fill|item replace|gamerule \S+ \S+|difficulty \S+|worldborder (set|center)|setworldspawn)/.test(command)),
        async send(command) {
            if (server.down) throw new Error('RCON: the connection was closed');
            server.log.push(command);
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
            case 'setworldspawn': server.spawn = numbers(1, 3); return `Set the world spawn point to ${words.slice(1, 4).join(', ')}`;
            case 'setblock': {
                const [x, y, z] = numbers(1, 3);
                const block = parseBlock(words[4]);
                if (!block) return 'Unknown block type';
                if (server.refuse(command)) return 'Could not set the block';
                const after = server.break_after.get(key(x, y, z));
                if (block.name === 'air') server.blocks.delete(key(x, y, z));
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
                let changed = 0;
                for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) {
                    for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) {
                        for (let z = Math.min(z1, z2); z <= Math.max(z1, z2); z++) {
                            const there = server.blockAt(x, y, z);
                            if (there.name === block.name && JSON.stringify(there.states) === JSON.stringify(block.states)) continue;
                            if (block.name === 'air') server.blocks.delete(key(x, y, z)); else server.blocks.set(key(x, y, z), { name: block.name, states: { ...block.states } });
                            server.containers.delete(key(x, y, z));
                            changed++;
                        }
                    }
                }
                return changed > 0 ? `Successfully filled ${changed} block(s)` : 'No blocks were filled';
            }
            case 'execute': {
                // execute if block <x> <y> <z> <block[states]>
                if (words[1] !== 'if' || words[2] !== 'block') return 'Unknown or incomplete command';
                const [x, y, z] = numbers(3, 3);
                const wanted = parseBlock(words[6]);
                const there = server.blockAt(x, y, z);
                const same = wanted && there.name === wanted.name && Object.entries(wanted.states).every(([name, value]) => there.states[name] === value);
                return same ? 'Test passed' : 'Test failed';
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
                // data get block <x> <y> <z> Items
                const [x, y, z] = numbers(3, 3);
                const slots = server.containers.get(key(x, y, z));
                if (!slots) return 'The target block is not a block entity';
                if (slots.size === 0) return `Found no elements matching Items`;
                const list = [...slots].sort((a, b) => a[0] - b[0]).map(([slot, stack]) => `{Slot: ${slot}b, count: ${stack.count}, id: "${stack.item}"}`);
                return `${x}, ${y}, ${z} has the following block data: [${list.join(', ')}]`;
            }
            default: return `Unknown or incomplete command, see below for error\n${command}<--[HERE]`;
            }
        },
    };
    return server;
}
