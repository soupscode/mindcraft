// Genesis: fence gates are closed behind the agents (decided: the bootstrap fences the camp).
//
// What the code does with gates, read in the source:
//   - the pathfinder OPENS a closed fence gate on its way: mineflayer-pathfinder lib/movements.js
//     lines 107-110 (every block whose name holds "gate" or "door" is "openable"), line 114
//     (canOpenDoors = true by default; Genesis's no-dig movements do not change it), lines 420-421
//     ("Open fence gates and doors": the gate becomes a block to use), index.js lines 536-538 (it is
//     activated on the way through);
//   - upstream's goToGoal also activates a fence gate next to a bot that is stuck (src/agent/library/skills.js lines 1173-1183);
//   - NOTHING ever closes one. An open gate lets mobs in, so the fence would be open after the first walk.
// So each agent closes an open gate of the camp once it is through: this plugin looks once a second.
// The decision is the plain function gateToClose() below, which the tests cover.
// UNVERIFIED ON A REAL SERVER: that the pathfinder's own opening works on Paper with these movements,
// and that closing behind does not fight an agent that is about to walk through (a gate is left
// alone while anybody stands within 1.5 blocks of it, and while this agent walks towards it).
// Depends only on Node built-ins.

export const GATE_RULES = Object.freeze({ reach: 4.5, clear: 1.5, every_ms: 1000 });

const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

// The gate this agent should close now, or null.
//   gates     [{ x, y, z, open }] the camp's gates the agent can see
//   here      the agent's position; before: where it was at the last look (null: unknown)
//   others    positions of everybody else nearby
export function gateToClose({ gates = [], here, before = null, others = [], rules = GATE_RULES } = {}) {
    for (const gate of gates) {
        if (gate.open !== true) continue;
        const centre = { x: gate.x + 0.5, z: gate.z + 0.5 };
        const far = flat(here, centre);
        if (far > rules.reach || far < rules.clear) continue;                      // out of reach, or standing in it
        if (before && flat(before, centre) - far > 0.05) continue;                 // walking towards it: it is about to be used
        if (others.some((other) => flat(other, centre) < rules.clear)) continue;   // somebody is in it, or right at it
        return gate;
    }
    return null;
}

// Installs the keeper on a bot. `inCamp(pos)` says whether a block belongs to the camp (the zones know).
export function installGateKeeper(bot, { inCamp, rules = GATE_RULES, timers = { setInterval, clearInterval } } = {}) {
    let before = null;
    const stats = { looks: 0, closed: 0, errors: 0 };
    const look = () => {
        try {
            if (!bot.entity) return;
            stats.looks++;
            const here = bot.entity.position;
            const ids = Object.values(bot.registry?.blocksByName ?? {}).filter((block) => block.name.endsWith('fence_gate')).map((block) => block.id);
            const gates = (ids.length > 0 ? bot.findBlocks({ matching: ids, maxDistance: Math.ceil(rules.reach) + 1, count: 8 }) : [])
                .filter((pos) => inCamp(pos))
                .map((pos) => { const block = bot.blockAt(pos); return { x: pos.x, y: pos.y, z: pos.z, open: block?.getProperties?.().open === true, block }; });
            const others = Object.values(bot.entities ?? {}).filter((entity) => entity !== bot.entity && entity.type === 'player' && entity.position).map((entity) => entity.position);
            const gate = gateToClose({ gates, here, before, others, rules });
            before = { x: here.x, z: here.z };
            if (gate?.block) { stats.closed++; Promise.resolve(bot.activateBlock(gate.block)).catch(() => { stats.errors++; }); }
        } catch { stats.errors++; }
    };
    const timer = timers.setInterval(look, rules.every_ms);
    timer?.unref?.();
    bot.once?.('end', () => timers.clearInterval(timer));
    return { look, stats: () => ({ ...stats }), stop: () => timers.clearInterval(timer) };
}
