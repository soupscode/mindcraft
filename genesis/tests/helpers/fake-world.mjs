// A small Minecraft stand-in for the catalog, executor, planning and routine tests.
// It gives each agent the world view the templates read (genesis/catalog/templates.js) and
// a step runner with the executor's `ops` shape, whose skills behave like the upstream ones
// they stand for, including what those do wrong on their own: placeBlock breaks whatever is
// in the cell, craftRecipe and smeltItem put down a table or furnace when none is near,
// breakBlockAt digs a crop at any age. The log lines are upstream's (src/agent/library/skills.js),
// so failures are named the same way as with a real bot.
// Node built-ins only. Time comes from the fake clock (helpers/fakes.mjs).

import { NO_SAFE_PATH } from '../../lib/no_dig_pathing.js';

const key = (x, y, z) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const EMPTY = ['air', 'water', 'lava', 'grass', 'short_grass', 'tall_grass', 'snow', 'dead_bush', 'fern'];

export const RECIPES = {
    oak_planks: { needs: { oak_log: 1 }, makes: 4, table: false },
    stick: { needs: { oak_planks: 2 }, makes: 4, table: false },
    crafting_table: { needs: { oak_planks: 4 }, makes: 1, table: false },
    torch: { needs: { coal: 1, stick: 1 }, makes: 4, table: false },
    wooden_pickaxe: { needs: { oak_planks: 3, stick: 2 }, makes: 1, table: true },
    wooden_axe: { needs: { oak_planks: 3, stick: 2 }, makes: 1, table: true },
    wooden_hoe: { needs: { oak_planks: 2, stick: 2 }, makes: 1, table: true },
    stone_pickaxe: { needs: { cobblestone: 3, stick: 2 }, makes: 1, table: true },
    chest: { needs: { oak_planks: 8 }, makes: 1, table: true },
    furnace: { needs: { cobblestone: 8 }, makes: 1, table: true },
    bread: { needs: { wheat: 3 }, makes: 1, table: true },
    // what the prefab ladder is built from beside planks and logs (the counts of Minecraft 1.21.6)
    oak_door: { needs: { oak_planks: 6 }, makes: 3, table: true },
    oak_slab: { needs: { oak_planks: 3 }, makes: 6, table: true },
    oak_fence: { needs: { oak_planks: 4, stick: 2 }, makes: 3, table: true },
    ladder: { needs: { stick: 7 }, makes: 3, table: true },
};
const DROPS = {
    stone: { cobblestone: 1 }, coal_ore: { coal: 1 }, iron_ore: { raw_iron: 1 }, grass_block: { dirt: 1 },
    carrots: { carrot: 2 }, potatoes: { potato: 2 }, beetroots: { beetroot: 1, beetroot_seeds: 1 },
};
const CROP_MAX = { wheat: 7, carrots: 7, potatoes: 7, beetroots: 3 };
const SEED_CROP = { wheat_seeds: 'wheat', carrot: 'carrots', potato: 'potatoes', beetroot_seeds: 'beetroots' };
const SMELTS = { raw_iron: 'iron_ingot', cobblestone: 'stone', potato: 'baked_potato', beef: 'cooked_beef', sand: 'glass' };
const NEEDS_PICKAXE = ['stone', 'cobblestone', 'coal_ore', 'iron_ore', 'deepslate_coal_ore', 'deepslate_iron_ore', 'furnace'];
const DAY_TICKS = 24000;
const TICK_MS = 50;

export function fakeWorld({ clock, start_tick = 1000 } = {}) {
    const blocks = new Map();     // key -> { name, x, y, z, age?, planted_at?, contents? }
    const bodies = new Map();     // agent -> { position, inventory, health, food, spawn }
    const ground = [];            // dropped items: { x, y, z, item, count }
    const returning = [];         // blocks that grow back: { at, block }
    const t0 = clock.now();

    const world = {
        blocks, bodies, ground,
        placed: [],               // every block put down: { x, y, z, name, by, how }   how: skill | scaffold | station
        broken: [],               // every block broken: { x, y, z, name, by, command }
        calls: [],                // every skill call: { agent, command, args, permit }
        trail: [],                // where every agent stood after each skill: { agent, x, y, z }
        grow_ms: 60 * 1000,       // one crop age step
        regrow_ms: 0,             // > 0: a broken log or stone comes back after this long (for long runs)
        durations: null,          // (command, args, far) -> ms a skill takes on the fake clock (null: no time at all)
        blocked: () => false,     // (from, to) -> true when no dig-free path exists
        hang: null,               // (call) -> true: the skill never returns (a process that is about to be killed)
        fail: null,               // (call) -> { output } to make a skill fail, { interrupted: true } to interrupt it
        scaffold: null,           // (call) -> [{ x, y, z, name, sticky?, reflex_torch? }] blocks the walk puts down
                                  //   reflex_torch: a torch upstream's idle torch reflex placed (reported as such)
        stall: null,              // (call) -> true: the skill gets nowhere; it ends when it is interrupted, or times out after stall_ms
        stall_ms: 5 * 60 * 1000,
        boxed: () => false,       // (agent) -> true: the agent is shut in; the recovery moves below get nowhere either
        recoveries: [],           // every recovery move: { agent, name, at, ok?, ... }
        on_restart: null,         // (agent, reason) -> void: the watchdog asked for a restart of the process
        ticks: () => start_tick + Math.floor((clock.now() - t0) / TICK_MS),
        set(x, y, z, name, more = {}) {
            if (name === 'air') { blocks.delete(key(x, y, z)); return null; }
            const block = { name, x, y, z, ...more };
            if (CROP_MAX[name] !== undefined && block.age === undefined) block.age = 0;
            if (CROP_MAX[name] !== undefined) block.planted_at = clock.now() - block.age * world.grow_ms;
            blocks.set(key(x, y, z), block);
            return block;
        },
        fill(min, max, name, more) {
            for (let x = min[0]; x <= max[0]; x++) for (let y = min[1]; y <= max[1]; y++) for (let z = min[2]; z <= max[2]; z++) world.set(x, y, z, name, more);
        },
        get(x, y, z) { refresh(); return blocks.get(key(x, y, z)) ?? null; },
        addAgent(name, { position, inventory = {}, health = 20, food = 20 } = {}) {
            bodies.set(name, { position: { ...position }, spawn: { ...position }, inventory: { ...inventory }, health, food });
            return bodies.get(name);
        },
        body: (name) => bodies.get(name),
        // The agent dies: it loses what it carries and stands at its spawn point again.
        kill(name) {
            const body = bodies.get(name);
            const at = { ...body.position };
            body.lives = (body.lives ?? 0) + 1; // whatever skill was running is stopped (upstream stops the action on death)
            body.inventory = {};
            body.position = { ...body.spawn };
            body.health = 20;
            body.food = 20;
            return at;
        },
        // Stops whatever skill the agent is running (what upstream's action manager does when another action starts).
        interrupt(name) {
            const body = bodies.get(name);
            body.interrupts = (body.interrupts ?? 0) + 1;
            body.wake?.();
        },
        view, ops, recovery,
    };

    // What the watchdog's ladder moves an agent with (genesis/adapters/bot_recovery.js for a real bot).
    function recovery(agent) {
        const body = bodies.get(agent);
        const note = (name, more = {}) => { world.recoveries.push({ agent, name, at: clock.now(), ...more }); };
        return {
            async interrupt() { note('interrupt'); world.interrupt(agent); return true; },
            async moveAway(blocks) {
                world.interrupt(agent);
                const ok = !world.boxed(agent);
                if (ok) body.position = { ...body.position, x: body.position.x + blocks };
                note('moveAway', { blocks, ok });
                return ok;
            },
            async surfaceOrHome(home) {
                world.interrupt(agent);
                const ok = !world.boxed(agent) && Boolean(home);
                if (ok) body.position = { ...home };
                note('surfaceOrHome', { ok });
                return ok;
            },
            async restartProcess(reason) {
                note('restartProcess', { reason });
                world.on_restart?.(agent, reason);
            },
        };
    }

    function refresh() {
        const now = clock.now();
        for (let i = returning.length - 1; i >= 0; i--) {
            if (returning[i].at <= now) {
                const { block } = returning[i];
                if (!blocks.has(key(block.x, block.y, block.z))) blocks.set(key(block.x, block.y, block.z), block);
                returning.splice(i, 1);
            }
        }
    }

    function ageOf(block) {
        if (CROP_MAX[block.name] === undefined) return undefined;
        return Math.min(CROP_MAX[block.name], Math.floor((clock.now() - block.planted_at) / world.grow_ms));
    }

    const seen = (block) => (block ? { name: block.name, x: block.x, y: block.y, z: block.z, ...(ageOf(block) !== undefined ? { age: ageOf(block) } : {}) } : null);

    function nearest(body, names, distance, count) {
        refresh();
        return [...blocks.values()]
            .filter((block) => names.includes(block.name) && dist(block, body.position) <= distance)
            .sort((a, b) => dist(a, body.position) - dist(b, body.position))
            .slice(0, count);
    }

    const slotsUsed = (inventory) => Object.values(inventory).reduce((n, count) => n + Math.ceil(count / 64), 0);
    const give = (body, item, count) => { body.inventory[item] = (body.inventory[item] ?? 0) + count; };
    function take(body, item, count) {
        body.inventory[item] = (body.inventory[item] ?? 0) - count;
        if (body.inventory[item] <= 0) delete body.inventory[item];
    }

    function fuelOf(body) {
        const items = Object.keys(body.inventory);
        const pick = items.find((i) => ['coal', 'charcoal'].includes(i)) ?? items.find((i) => i.includes('log') || i.includes('planks'));
        if (!pick) return null;
        return { name: pick, count: body.inventory[pick], per_item: ['coal', 'charcoal'].includes(pick) ? 8 : 1.5 };
    }

    function view(agent) {
        const body = bodies.get(agent);
        return {
            agent,
            position: () => ({ ...body.position }),
            dimension: () => 'overworld',
            health: () => body.health,
            food: () => body.food,
            inventory: () => ({ ...body.inventory }),
            freeSlots: () => 36 - slotsUsed(body.inventory),
            dayTicksLeft: () => Math.max(0, 12000 - (world.ticks() % DAY_TICKS)),
            timeOfDay: () => world.ticks() % DAY_TICKS,
            daylightStopped: () => world.daylight_stopped === true,
            day: () => Math.floor(world.ticks() / DAY_TICKS),
            blockAt: (pos) => { refresh(); return seen(blocks.get(key(pos.x, pos.y, pos.z))) ?? { name: 'air' }; },
            findBlocks: (names, distance, count) => nearest(body, names, distance, count).map(seen),
            pathTo(pos) {
                if (world.blocked(body.position, pos)) return { status: 'none' };
                const steps = Math.max(1, Math.ceil(dist(body.position, pos) / 4));
                const nodes = Array.from({ length: steps + 1 }, (_, i) => ({
                    x: body.position.x + ((pos.x - body.position.x) * i) / steps,
                    y: body.position.y + ((pos.y - body.position.y) * i) / steps,
                    z: body.position.z + ((pos.z - body.position.z) * i) / steps,
                }));
                return { status: 'ok', nodes };
            },
            ingredients: (item) => (RECIPES[item] ? { ...RECIPES[item].needs } : null),
            recipe(item) {
                const recipe = RECIPES[item];
                if (!recipe) return null;
                const craftable = Object.entries(recipe.needs).every(([need, count]) => (body.inventory[need] ?? 0) >= count);
                return { craftable, needs_table: recipe.table };
            },
            canHarvest: (name) => !NEEDS_PICKAXE.includes(name) || Object.keys(body.inventory).some((item) => item.endsWith('_pickaxe')),
            // another agent is "in sight" within 48 blocks (a server's view distance, more or less)
            agentPosition(name) {
                const other = bodies.get(name);
                return other && name !== agent && dist(other.position, body.position) <= 48 ? { ...other.position } : null;
            },
            fuel: () => fuelOf(body),
            isSmeltable: (item) => Object.hasOwn(SMELTS, item),
            // what the learning step records: world.hostiles is a list of { x, y, z }, world.rain a flag
            hostilesNear: (distance = 16) => (world.hostiles ?? []).filter((mob) => dist(mob, body.position) <= distance).length,
            raining: () => world.rain === true,
            agentsNear: (names, distance = 16) => (names ?? []).filter((name) => name !== agent && bodies.has(name) && dist(bodies.get(name).position, body.position) <= distance)
                .map((name) => ({ name, dist: Math.round(dist(bodies.get(name).position, body.position) * 10) / 10 })).sort((a, b) => a.dist - b.dist || a.name.localeCompare(b.name)),
        };
    }

    // The step runner of one agent. on_place(pos) is told about every block the agent puts down
    // (what genesis/lib/bot_guards.js does for a real bot).
    function ops(agent, { on_place = () => {} } = {}) {
        const body = bodies.get(agent);
        const out = [];
        const log = (line) => out.push(line);
        // a wait that world.interrupt() ends early
        const wait = (ms) => (ms > 0 ? new Promise((resolve) => {
            const timer = clock.setTimeout(() => { body.wake = null; resolve(); }, ms);
            body.wake = () => { clock.clearTimeout(timer); body.wake = null; resolve(); };
        }) : Promise.resolve());

        function put(x, y, z, name, how) {
            world.set(x, y, z, name);
            world.placed.push({ x, y, z, name, by: agent, how });
            on_place({ x, y, z }, how);
        }

        function smash(x, y, z, command) {
            const block = blocks.get(key(x, y, z));
            if (!block) return null;
            blocks.delete(key(x, y, z));
            world.broken.push({ x, y, z, name: block.name, by: agent, command });
            const age = ageOf(block);
            let drops = DROPS[block.name] ?? { [block.name]: 1 };
            if (block.name === 'wheat') drops = age >= 7 ? { wheat: 1, wheat_seeds: 2 } : { wheat_seeds: 1 };
            else if (age !== undefined && age < CROP_MAX[block.name]) drops = { [Object.keys(drops)[0]]: 1 };
            for (const [item, count] of Object.entries(drops)) ground.push({ x, y, z, item, count });
            if (world.regrow_ms > 0 && (block.name.endsWith('_log') || block.name === 'stone')) {
                returning.push({ at: clock.now() + world.regrow_ms, block: { ...block } });
            }
            return block;
        }

        function walk(target, near, call) {
            if (world.blocked(body.position, target)) {
                log(`${NO_SAFE_PATH}: there is no way to the goal without breaking blocks. Not digging.`);
                return false;
            }
            for (const cell of world.scaffold?.(call) ?? []) {
                world.set(cell.x, cell.y, cell.z, cell.name ?? 'dirt', { sticky: cell.sticky === true });
                const how = cell.reflex_torch ? 'reflex_torch' : 'scaffold';
                world.placed.push({ x: cell.x, y: cell.y, z: cell.z, name: cell.name ?? 'dirt', by: agent, how });
                on_place({ x: cell.x, y: cell.y, z: cell.z }, how);
            }
            if (dist(body.position, target) > near) body.position = { x: target.x + 1, y: target.y, z: target.z };
            return true;
        }

        const skills = {
            goToPosition(call, x, y, z, near = 2) {
                if (!walk({ x, y, z }, near, call)) return false;
                log(`You have reached at ${x}, ${y}, ${z}.`);
                return true;
            },
            breakBlockAt(call, x, y, z) {
                const block = blocks.get(key(x, y, z));
                if (!block || EMPTY.includes(block.name)) {
                    log(`Skipping block at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)} because it is ${block?.name ?? 'air'}.`);
                    return false;
                }
                if (!walk({ x, y, z }, 4, call)) return false;
                if (block.sticky) throw new Error('Digging aborted');
                if (NEEDS_PICKAXE.includes(block.name) && !Object.keys(body.inventory).some((item) => item.endsWith('_pickaxe'))) {
                    log(`Don't have right tools to break ${block.name}.`);
                    return false;
                }
                smash(x, y, z, 'breakBlockAt');
                log(`Broke ${block.name} at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);
                return true;
            },
            pickupNearbyItems() {
                let picked = 0;
                for (let i = ground.length - 1; i >= 0; i--) {
                    if (dist(ground[i], body.position) <= 8) {
                        give(body, ground[i].item, ground[i].count);
                        ground.splice(i, 1);
                        picked++;
                    }
                }
                log(`Picked up ${picked} items.`);
                return true;
            },
            craftRecipe(call, item, num = 1) {
                const recipe = RECIPES[item];
                if (!recipe) { log(`${item} is either not an item, or it does not have a crafting recipe!`); return false; }
                if (!Object.entries(recipe.needs).every(([need, count]) => (body.inventory[need] ?? 0) >= count)) {
                    log(`You do not have the resources to craft a ${item}. It requires: ${Object.entries(recipe.needs).map(([k, v]) => `${k}: ${v}`).join(', ')}.`);
                    return false;
                }
                if (recipe.table && nearest(body, ['crafting_table'], 16, 1).length === 0) {
                    if (!(body.inventory.crafting_table > 0)) { log(`Crafting ${item} requires a crafting table.`); return false; }
                    put(body.position.x + 1, body.position.y, body.position.z, 'crafting_table', 'station'); // upstream places its own
                }
                let made = 0;
                while (made < num && Object.entries(recipe.needs).every(([need, count]) => (body.inventory[need] ?? 0) >= count)) {
                    for (const [need, count] of Object.entries(recipe.needs)) take(body, need, count);
                    give(body, item, recipe.makes);
                    made++;
                }
                log(`Successfully crafted ${item}, you now have ${body.inventory[item]} ${item}.`);
                return true;
            },
            putInChest(call, item, num = -1) {
                const chest = nearest(body, ['chest'], 32, 1)[0];
                if (!chest) { log('Could not find a chest nearby.'); return false; }
                if (!(body.inventory[item] > 0)) { log(`You do not have any ${item} to put in the chest.`); return false; }
                const count = num === -1 ? body.inventory[item] : Math.min(num, body.inventory[item]);
                if (!walk(chest, 2, call)) return false;
                chest.contents ??= {};
                chest.contents[item] = (chest.contents[item] ?? 0) + count;
                take(body, item, count);
                log(`Successfully put ${count} ${item} in the chest.`);
                return true;
            },
            takeFromChest(call, item, num = -1) {
                const chest = nearest(body, ['chest'], 32, 1)[0];
                if (!chest) { log('Could not find a chest nearby.'); return false; }
                if (!walk(chest, 2, call)) return false;
                const stock = chest.contents?.[item] ?? 0;
                if (stock === 0) { log(`Could not find any ${item} in the chest.`); return false; }
                const count = num === -1 ? stock : Math.min(num, stock);
                chest.contents[item] -= count;
                if (chest.contents[item] <= 0) delete chest.contents[item];
                give(body, item, count);
                log(`Successfully took ${count} ${item} from the chest.`);
                return true;
            },
            viewChest(call) {
                const chest = nearest(body, ['chest'], 32, 1)[0];
                if (!chest) { log('Could not find a chest nearby.'); return false; }
                if (!walk(chest, 2, call)) return false;
                const items = Object.entries(chest.contents ?? {});
                if (items.length === 0) log('The chest is empty.');
                else { log('The chest contains:'); for (const [item, count] of items) log(`${count} ${item}`); }
                return true;
            },
            tillAndSow(call, x, y, z, seed = null) {
                const soil = blocks.get(key(x, y, z));
                if (!soil || !['grass_block', 'dirt', 'farmland'].includes(soil.name)) { log(`Cannot till ${soil?.name ?? 'air'}, must be grass_block or dirt.`); return false; }
                const above = blocks.get(key(x, y + 1, z));
                if (above) {
                    if (soil.name === 'farmland') { log(`Land is already farmed with ${above.name}.`); return true; }
                    smash(x, y + 1, z, 'tillAndSow'); // upstream breaks whatever stands on the soil
                }
                if (!walk({ x, y, z }, 4, call)) return false;
                soil.name = 'farmland';
                if (seed) {
                    if (!(body.inventory[seed] > 0)) { log(`No ${seed} to plant.`); return false; }
                    take(body, seed, 1);
                    world.set(x, y + 1, z, SEED_CROP[seed] ?? seed, { age: 0 });
                    log(`Planted ${seed} at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);
                }
                return true;
            },
            placeBlock(call, type, x, y, z) {
                if (!(body.inventory[type] > 0)) { log(`Don't have any ${type} to place.`); return false; }
                const target = blocks.get(key(x, y, z));
                if (target && target.name === type) { log(`${type} already at (${x}, ${y}, ${z}).`); return false; }
                if (target && !EMPTY.includes(target.name)) {
                    log(`${target.name} in the way at (${x}, ${y}, ${z}).`);
                    smash(x, y, z, 'placeBlock'); // upstream breaks whatever is in the cell
                }
                if (!walk({ x, y, z }, 4, call)) return false;
                take(body, type, 1);
                put(x, y, z, type, 'skill');
                // a door is one item and two cells: the upper half comes with the lower (as in the game)
                if (type.endsWith('_door') && !blocks.get(key(x, y + 1, z))) world.set(x, y + 1, z, type);
                log(`Placed ${type} at (${x}, ${y}, ${z}).`);
                return true;
            },
            giveToPlayer(call, item, username, num = 1) {
                if (username === agent) { log('You cannot give items to yourself.'); return false; }
                const other = bodies.get(username);
                if (!other || dist(other.position, body.position) > 48) { log(`Could not find ${username}.`); return false; }
                if (!walk(other.position, 3, call)) return false;
                if (!(body.inventory[item] > 0)) { log(`You do not have any ${item} to discard.`); return false; }
                const count = Math.min(num, body.inventory[item]);
                take(body, item, count);
                log(`Discarded ${count} ${item}.`);
                if (world.butterfingers?.(call)) { ground.push({ ...other.position, item, count }); log(`Failed to give ${item} to ${username}, it was never received.`); return false; }
                give(other, item, count);
                log(`${username} received ${item}.`);
                return true;
            },
            smeltItem(call, item, num = 1) {
                if (!SMELTS[item]) { log(`Cannot smelt ${item}. Hint: make sure you are smelting the 'raw' item.`); return false; }
                if (nearest(body, ['furnace'], 16, 1).length === 0) {
                    if (!(body.inventory.furnace > 0)) { log('There is no furnace nearby and you have no furnace.'); return false; }
                    take(body, 'furnace', 1);
                    put(body.position.x + 1, body.position.y, body.position.z, 'furnace', 'station'); // upstream places its own
                }
                if ((body.inventory[item] ?? 0) < num) { log(`You do not have enough ${item} to smelt.`); return false; }
                const fuel = fuelOf(body);
                if (!fuel) { log(`You have no fuel to smelt ${item}, you need coal, charcoal, or wood.`); return false; }
                const need = Math.ceil(num / fuel.per_item);
                if (fuel.count < need) { log(`You don't have enough ${fuel.name} to smelt ${num} ${item}; you need ${need}.`); return false; }
                take(body, fuel.name, need);
                take(body, item, num);
                give(body, SMELTS[item], num);
                log(`Successfully smelted ${item}, got ${num} ${SMELTS[item]}.`);
                return true;
            },
        };

        return {
            agent,
            async run(command, args, context = {}) {
                refresh();
                const call = { agent, command, args: [...args], permit: context.permit ?? null, cleanup: context.cleanup === true, at: clock.now() };
                world.calls.push(call);
                if (world.hang?.(call)) return new Promise(() => {});
                const far = typeof args[0] === 'number' ? dist(body.position, { x: args[0], y: args[1], z: args[2] }) : 0;
                const life = body.lives;
                const cuts = body.interrupts ?? 0;
                if (world.stall?.(call)) {
                    // the skill gets nowhere: it ends when it is stopped, or when the action manager's timeout stops it
                    await wait(world.stall_ms);
                    const stopped = body.lives !== life || (body.interrupts ?? 0) !== cuts;
                    return { ok: false, interrupted: true, timedout: !stopped, output: stopped ? '' : 'Action output:\n' };
                }
                await wait(world.durations ? world.durations(command, args, far) : 0);
                if (body.lives !== life || (body.interrupts ?? 0) !== cuts) return { ok: false, interrupted: true, timedout: false, output: '' };
                const forced = world.fail?.(call);
                if (forced?.interrupted) return { ok: false, interrupted: true, timedout: false, output: '' };
                if (forced) return { ok: false, interrupted: false, timedout: forced.timedout === true, output: `Action output:\n${forced.output ?? ''}` };
                out.length = 0;
                if (!skills[command]) return { ok: false, interrupted: false, timedout: false, output: `!!Code threw exception!!\nError: unknown skill ${command}` };
                try {
                    const ok = skills[command](call, ...args) !== false;
                    world.trail.push({ agent, ...body.position });
                    return { ok, interrupted: false, timedout: false, output: `Action output:\n${out.join('\n')}\n` };
                } catch (err) {
                    return { ok: false, interrupted: false, timedout: false, output: `${out.join('\n')}\n!!Code threw exception!!\nError: ${err.message}\n` };
                }
            },
        };
    }

    return world;
}

// A camp world used by most tests: a camp around (0, 64, 0), a field east of it, a wood
// west of it, two chests, a crafting table and a furnace in the camp, and one plot.
export const WORLD_CONFIG = {
    v: 1,
    dimension: 'overworld',
    camp: { min: [-8, -8], max: [8, 8] },
    field: { min: [12, -4], max: [20, 4] },
    plots: [{ id: 'plot-1', owner: 'Arthur', min: [-20, 64, 12], max: [-16, 67, 16], blueprint: 'hut' }],
    chests: { shared: [2, 64, 2], kits: [-2, 64, 2] },
    agents: {
        Arthur: { home: [0, 64, 0], range: 48 },
        Mira: { home: [0, 64, 0], range: 32 },
        Felix: { home: [0, 64, 0], range: 128 },
        Nova: { home: [0, 64, 0], range: 32 },
    },
};

export const HUT = {
    name: 'hut',
    blocks: [
        [['oak_planks', 'oak_planks', 'oak_planks'], ['oak_planks', 'oak_planks', 'oak_planks'], ['oak_planks', 'oak_planks', 'oak_planks']],
        [['oak_planks', 'air', 'oak_planks'], ['oak_planks', 'air', 'oak_planks'], ['oak_planks', 'oak_planks', 'oak_planks']],
    ],
};

export function campWorld(clock, options = {}) {
    const world = fakeWorld({ clock, ...options });
    world.set(2, 64, 2, 'chest', { contents: {} });
    world.set(-2, 64, 2, 'chest', { contents: {} });
    world.set(4, 64, -3, 'crafting_table');
    world.set(-4, 64, -3, 'furnace');
    // the field: farmland with wheat on it
    for (let x = 13; x <= 19; x++) {
        for (let z = -3; z <= 3; z++) {
            world.set(x, 63, z, 'farmland');
            world.set(x, 64, z, 'wheat', { age: 7 });
        }
    }
    // a wood west of the camp (outside it), and one tree inside the camp that must stay
    for (let i = 0; i < 12; i++) world.set(-24 - (i % 4), 64 + Math.floor(i / 4), -6, 'oak_log');
    for (let y = 64; y <= 66; y++) world.set(6, y, 6, 'oak_log');
    // stone north of the camp
    for (let i = 0; i < 12; i++) world.set(-3 + i, 63, -22, 'stone');
    return world;
}
