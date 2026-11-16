// Genesis: the world view of a real bot, in the shape the skill templates read
// (genesis/catalog/templates.js). Everything is read from the mineflayer bot through the
// same upstream helpers the skills use; nothing here changes the world.
//
// NOT RUN AGAINST A REAL MINECRAFT SERVER. The tests drive it with a stand-in bot and
// stand-ins for the upstream modules, which only shows that it calls them as written.
//
// Injected (the real ones are passed in by genesis/adapters/bot_agent.js):
//   world   src/agent/library/world.js   getInventoryCounts (line 262), getNearestBlocks (line 118)
//   mc      src/utils/mcdata.js           getItemId (158), getBlockId (174), getItemCraftingRecipes (248),
//                                         isSmeltable (286), getSmeltingFuel (291), getFuelSmeltOutput (301)
//   pf      mineflayer-pathfinder          Movements, goals.GoalNear
//   Vec3    vec3
// Depends on nothing else.

export const VIEW_DEFAULTS = Object.freeze({
    path_check_ms: 150,     // how long one path check may think (it blocks the process while it does)
    path_cache_ms: 10000,   // a path check for the same place is not repeated within this time
});

export function createBotView(bot, { world, mc, pf, Vec3, now = Date.now, ...options } = {}) {
    const config = { ...VIEW_DEFAULTS, ...options };
    const paths = new Map(); // "x,y,z,near" -> { at, from, answer }

    const seen = (block) => {
        if (!block) return null;
        const out = { name: block.name, x: block.position.x, y: block.position.y, z: block.position.z };
        // a crop's age: the block state's "age" property (prismarine-block getProperties()), else its metadata
        let age;
        try { age = block.getProperties?.().age; } catch { /* a block without properties */ }
        if (age === undefined && Number.isFinite(block.metadata)) age = block.metadata;
        if (Number.isFinite(Number(age))) out.age = Number(age);
        return out;
    };

    return {
        agent: bot.username,
        position: () => ({ x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z }),
        dimension: () => String(bot.game?.dimension ?? 'overworld'),
        health: () => Number(bot.health ?? 0),
        food: () => Number(bot.food ?? 0),
        inventory: () => world.getInventoryCounts(bot),
        freeSlots: () => bot.inventory.emptySlotCount(),
        // daylight left, in game ticks: the day runs from tick 0 to tick 12000 (src/agent/agent.js lines 434-441)
        dayTicksLeft: () => Math.max(0, 12000 - (Number(bot.time?.timeOfDay ?? 0) % 24000)),
        blockAt(pos) {
            return seen(bot.blockAt(new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z))));
        },
        findBlocks(names, distance, count) {
            const known = names.filter((name) => mc.getBlockId(name) != null); // a name this Minecraft version does not have
            if (known.length === 0) return [];
            return world.getNearestBlocks(bot, known, distance, count).filter(Boolean).map(seen);
        },
        // A path that breaks nothing: the search goes through the no-dig guard like every other.
        pathTo(pos, near = 2) {
            const key = `${Math.round(pos.x)},${Math.round(pos.y)},${Math.round(pos.z)},${near}`;
            const here = bot.entity.position;
            const cached = paths.get(key);
            if (cached && now() - cached.at < config.path_cache_ms && here.distanceTo(cached.from) < 4) return cached.answer;
            let answer = { status: 'unknown' };
            try {
                const goal = new pf.goals.GoalNear(pos.x, pos.y, pos.z, near);
                const found = bot.pathfinder.getPathTo(new pf.Movements(bot), goal, config.path_check_ms);
                const nodes = (found?.path ?? []).map((node) => ({ x: node.x, y: node.y, z: node.z }));
                if (found?.status === 'success') answer = { status: 'ok', nodes };
                else if (found?.status === 'noPath') answer = { status: 'none' };
                else if (nodes.length > 0) {
                    // the search ran out of time: did it get closer without digging?
                    const end = nodes[nodes.length - 1];
                    const closer = Math.hypot(end.x - pos.x, end.y - pos.y, end.z - pos.z) < Math.hypot(here.x - pos.x, here.y - pos.y, here.z - pos.z) - 2;
                    answer = closer ? { status: 'partial', nodes } : { status: 'unknown' };
                }
            } catch { /* a search that throws proves nothing */ }
            paths.set(key, { at: now(), from: here.clone(), answer });
            if (paths.size > 200) paths.delete(paths.keys().next().value);
            return answer;
        },
        // As upstream's craftRecipe decides it (src/agent/library/skills.js lines 49-58).
        recipe(item) {
            const id = mc.getItemId(item);
            const recipes = id == null ? null : mc.getItemCraftingRecipes(item);
            if (!recipes || recipes.length === 0) return null;
            if ((bot.recipesFor(id, null, 1, null) ?? []).length > 0) return { craftable: true, needs_table: false };
            if ((bot.recipesFor(id, null, 1, true) ?? []).length > 0) return { craftable: true, needs_table: true };
            return { craftable: false, needs_table: false };
        },
        // What prismarine-block's canHarvest checks: no harvest tools listed, or one of them held.
        canHarvest(block_name) {
            const tools = bot.registry?.blocksByName?.[block_name]?.harvestTools;
            if (!tools) return true;
            return bot.inventory.items().some((item) => tools[item.type]);
        },
        fuel() {
            const fuel = mc.getSmeltingFuel(bot);
            if (!fuel) return null;
            return { name: fuel.name, count: fuel.count, per_item: mc.getFuelSmeltOutput(fuel.name) };
        },
        isSmeltable: (item) => mc.isSmeltable(item),
    };
}
