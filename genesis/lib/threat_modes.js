// Genesis: what an agent does about hostile mobs (decided after the live run, where agents on their
// routines fought everything and one was blown up twice).
//   on a ROUTINE goal, or with nothing in hand while the model is away: the agent FLEES hostile mobs.
//   on a goal the planner or the operator chose: as upstream has it for that agent.
// It uses upstream's own two modes and only switches them, in this one file:
//   "cowardice"    src/agent/modes.js 147-160: a hostile within 16 blocks that can be walked to
//                  -> skills.avoidEnemies(bot, 24) (src/agent/library/skills.js 1459-1487)
//   "self_defense" src/agent/modes.js 163-176: a hostile within 8 blocks that can be walked to
//                  -> skills.defendSelf(bot, 8)
//   setOn(name, on) / isOn(name): src/agent/modes.js 359-365. The modes are one set per process, and an
//   agent is one process.
// No profile is edited: what the agent's profile had is read when this is installed, and put back
// whenever the agent is not on its routine. No other mode is touched: the idle reflexes stay on.
//
// What follows from upstream's code (read, not run against a server):
//   - both modes ask world.isClearPath (src/agent/library/world.js 390-404), a path search that opens no
//     door or gate: a mob behind the camp's closed fence sets neither off, so an agent sheltering in
//     the camp stays in it.
//   - avoidEnemies builds its own Movements; the Genesis no-dig guard (genesis/lib/no_dig_pathing.js) covers
//     every path search, so fleeing digs through nothing.
//   - avoidEnemies still hits a mob that gets within 3 blocks of the fleeing agent (skills.js 1480-1482).
//     That is upstream's flight; it is not changed here.
// Fleeing must not take an agent away for good: once it is further from home than its range, cowardice
// is switched off (the routine's walk home is then not cut short) and self_defense is as the profile
// has it, until the agent is back inside its range.
// UNVERIFIED ON A REAL SERVER: how far a flight takes an agent in practice, and how it looks at night.
// Depends on nothing.

export const THREAT_MODES = Object.freeze(['cowardice', 'self_defense']);

// The two switches for the moment: { cowardice, self_defense }.
export function threatModes({ on_routine, home_distance = 0, range = Infinity, upstream = { cowardice: false, self_defense: true } } = {}) {
    if (!on_routine) return { cowardice: upstream.cowardice, self_defense: upstream.self_defense };
    if (home_distance > range) return { cowardice: false, self_defense: upstream.self_defense };
    return { cowardice: true, self_defense: false };
}

// Keeps the bot's two modes as threatModes() says. onRoutine() and homeDistance() are asked every second.
// timers: { setTimeout, clearTimeout } (the clock in tests).
export function installThreatModes(bot, { onRoutine, homeDistance = () => 0, range = Infinity, timers = globalThis, every_ms = 1000 } = {}) {
    const modes = bot.modes;
    const upstream = { cowardice: modes.isOn('cowardice') === true, self_defense: modes.isOn('self_defense') === true };
    const stats = { switches: 0, errors: 0 };
    const now = { ...upstream };
    let timer = null;
    let stopped = false;
    const look = () => {
        try {
            const want = threatModes({ on_routine: onRoutine() === true, home_distance: Number(homeDistance()) || 0, range, upstream });
            for (const name of THREAT_MODES) {
                if (want[name] !== now[name]) { modes.setOn(name, want[name]); now[name] = want[name]; stats.switches++; }
            }
        } catch { stats.errors++; }
        return { ...now };
    };
    const tick = () => {
        if (stopped) return;
        look();
        timer = timers.setTimeout(tick, every_ms);
        timer?.unref?.();
    };
    const stop = () => { stopped = true; if (timer !== null) timers.clearTimeout(timer); };
    tick();
    bot.once?.('end', stop);
    return { look, upstream, current: () => ({ ...now }), stats: () => ({ ...stats }), stop };
}
