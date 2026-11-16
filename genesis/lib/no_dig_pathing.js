// Genesis: agents never dig through blocks to get somewhere (they destroyed their own builds).
// Switched on by the pathfinding_no_dig setting, which the Genesis launcher forces to true.
// Upstream leaves it off, and then nothing in this file runs.
//
// How it works. Every path mineflayer-pathfinder computes, for any caller, goes through
// bot.pathfinder.getPathFromTo(movements, ...): the skills, the pathfinder's own movement
// loop (setGoal), mineflayer-pvp and mineflayer-collectblock all end up there. The guard
// wraps that one function and hands the search a view of `movements` whose canDig is
// always false, so no computed path ever holds a block to break. It does not matter how
// the caller configured its Movements, or what was passed to setMovements earlier.
//
// The caller's Movements object itself is left alone on purpose: mineflayer-collectblock
// asks bot.pathfinder.movements.safeToBreak(block) whether it may mine the block it was
// sent to collect. Mining a target block is not digging to get somewhere and still works.
//
// One exception, the pathing permit (withPathingPermit below). The Genesis executor gives
// it to a gather step only: a buried block may be tunnelled to. While a permit is on a bot,
// path searches may dig, except in the cells the permit forbids (the camp, the field and
// the plots): those cost what mineflayer-pathfinder treats as "cannot break" (its
// Movements.safeToBreak() refuses a block whose exclusionAreasBreak weight is 100 or more,
// lib/movements.js of 2.4.5). A permit can also forbid placing blocks while walking
// (scaffolding): the search then starts with no scaffolding blocks to spend
// (index.js: `new Move(..., movements.countScaffoldingItems(), 0)`).
// Without a permit nothing changes: no digging at all.
//
// Depends only on Node built-ins and on the bot it is given, so it can be imported from
// upstream files and from tests.

export const NO_SAFE_PATH = 'no_safe_path';

const guarded_bots = new WeakSet();
const views = new WeakMap(); // Movements object -> its no-dig view
const known_views = new WeakSet();

// A view of `movements` that reads every setting from it, except that it cannot dig.
export function noDigView(movements) {
    if (movements === null || typeof movements !== 'object') return movements;
    if (known_views.has(movements)) return movements;
    let view = views.get(movements);
    if (!view) {
        view = Object.create(movements);
        Object.defineProperty(view, 'canDig', { get: () => false, set: () => {}, enumerable: true });
        views.set(movements, view);
        known_views.add(view);
    }
    return view;
}

export function isNoDigPathing(bot) {
    return guarded_bots.has(bot);
}

// ---- the pathing permit ----

const permits = new WeakMap(); // bot -> { dig_forbidden: (position) -> boolean, or null; no_place: boolean }

// The weight mineflayer-pathfinder reads as "this block cannot be broken".
export const CANNOT_BREAK = 100;

// permit: { dig: (position) -> true where digging stays forbidden   (omit: no digging at all, as without a permit)
//           no_place: true to walk without placing any block }
export function setPathingPermit(bot, permit) {
    if (!permit) { permits.delete(bot); return; }
    permits.set(bot, {
        dig_forbidden: typeof permit.dig === 'function' ? permit.dig : null,
        no_place: permit.no_place === true,
    });
}

export function clearPathingPermit(bot) {
    permits.delete(bot);
}

export function pathingPermit(bot) {
    return permits.get(bot) ?? null;
}

// Runs fn with the permit on the bot, and takes the permit away again whatever happens.
export async function withPathingPermit(bot, permit, fn) {
    const before = permits.get(bot);
    setPathingPermit(bot, permit);
    try {
        return await fn();
    } finally {
        if (before) permits.set(bot, before); else permits.delete(bot);
    }
}

// The view of `movements` a path search gets while `permit` is on the bot.
export function permitView(movements, permit) {
    if (movements === null || typeof movements !== 'object') return movements;
    const base = permit.dig_forbidden ? movements : noDigView(movements);
    if (!permit.dig_forbidden && !permit.no_place) return base;
    const view = Object.create(base);
    if (permit.dig_forbidden) {
        const forbidden = (block) => {
            try {
                return block?.position && permit.dig_forbidden(block.position) ? CANNOT_BREAK : 0;
            } catch {
                return CANNOT_BREAK; // a zone check that fails must never open a zone
            }
        };
        Object.defineProperty(view, 'exclusionAreasBreak', {
            get: () => [...(movements.exclusionAreasBreak ?? []), forbidden], set: () => {}, enumerable: true,
        });
    }
    if (permit.no_place) {
        Object.defineProperty(view, 'countScaffoldingItems', { value: () => 0, enumerable: true });
        Object.defineProperty(view, 'allow1by1towers', { get: () => false, set: () => {}, enumerable: true });
    }
    return view;
}

// What a path search of this bot is given instead of the caller's Movements.
function searchView(bot, movements) {
    const permit = permits.get(bot);
    return permit ? permitView(movements, permit) : noDigView(movements);
}

// Appends the no_safe_path line to the action log the model reads (same place as skills.log).
function report(bot, detail) {
    const line = `${NO_SAFE_PATH}: ${detail} Not digging.`;
    if (typeof bot.output === 'string') bot.output += line + '\n';
    return line;
}

// An error with the names and messages mineflayer-pathfinder's own goto uses.
function pathError(name, message) {
    const err = new Error(message);
    err.name = name;
    return err;
}

function noSafePathError(bot, name, message, detail) {
    const err = pathError(name, message);
    err.no_safe_path = true;
    report(bot, detail);
    return err;
}

// Stands in for bot.pathfinder.goto while the guard is on. Same events and same errors as
// mineflayer-pathfinder's lib/goto.js, with two differences:
//   - a search that ends without a path (status "noPath" or "timeout") always rejects.
//     The original resolves, as if the goal was reached, when that search had not found a
//     single step to take, and the caller then carried on as if it had arrived.
//   - an unfinished search (status "partial") that has no step yet is waited for, instead
//     of being reported as arrival. With digging forbidden the first steps of a detour
//     often lead away from the goal, so this case is common.
// Each rejection for a missing path is tagged err.no_safe_path and logged once.
function gotoWithoutDigging(bot, goal) {
    return new Promise((resolve, reject) => {
        let finished = false;
        const finish = (err) => {
            if (finished) return;
            finished = true;
            bot.removeListener('goal_reached', onGoalReached);
            bot.removeListener('path_update', onPathUpdate);
            bot.removeListener('goal_updated', onGoalUpdated);
            bot.removeListener('path_stop', onPathStop);
            // next turn of the event loop, as the original does, so the pathfinder cleans up first
            setTimeout(() => (err ? reject(err) : resolve()), 0);
        };
        const onGoalReached = () => finish();
        const onPathUpdate = (results) => {
            const status = results?.status;
            const steps = Array.isArray(results?.path) ? results.path.length : 0;
            if (status === 'noPath') {
                finish(noSafePathError(bot, 'NoPath', 'No path to the goal!',
                    'there is no way to the goal without breaking blocks.'));
            } else if (status === 'timeout') {
                finish(noSafePathError(bot, 'Timeout', 'Took to long to decide path to goal!',
                    'no way to the goal without breaking blocks was found in the time allowed.'));
            } else if (steps === 0 && status !== 'partial') {
                finish(); // a finished search with nothing left to walk
            }
        };
        const onGoalUpdated = (new_goal) => {
            if (new_goal !== goal) finish(pathError('GoalChanged', 'The goal was changed before it could be completed!'));
        };
        const onPathStop = () => finish(pathError('PathStopped',
            'Path was stopped before it could be completed! Thus, the desired goal was not reached.'));
        bot.on('path_stop', onPathStop);
        bot.on('goal_reached', onGoalReached);
        bot.on('path_update', onPathUpdate);
        bot.on('goal_updated', onGoalUpdated);
        bot.pathfinder.setGoal(goal);
    });
}

// Puts the guard on a bot whose pathfinder plugin is loaded. Throws when it cannot,
// so an agent never runs unguarded while the setting says it is guarded.
export function enforceNoDigPathing(bot) {
    const pathfinder = bot?.pathfinder;
    for (const name of ['getPathFromTo', 'getPathTo', 'goto', 'setGoal']) {
        if (typeof pathfinder?.[name] !== 'function') {
            throw new Error(`pathfinding_no_dig: bot.pathfinder.${name} is missing, the no-dig guard cannot be installed`);
        }
    }
    if (guarded_bots.has(bot)) return;
    const getPathFromTo = pathfinder.getPathFromTo;
    const getPathTo = pathfinder.getPathTo;
    pathfinder.getPathFromTo = function (movements, ...rest) {
        return getPathFromTo.call(this, searchView(bot, movements), ...rest);
    };
    // getPathTo calls getPathFromTo itself; wrapped as well so the guard does not depend on that
    pathfinder.getPathTo = function (movements, ...rest) {
        return getPathTo.call(this, searchView(bot, movements), ...rest);
    };
    pathfinder.goto = (goal) => gotoWithoutDigging(bot, goal);
    guarded_bots.add(bot);
}

// The mineflayer plugin form. Load it after the pathfinder plugin: bot.loadPlugin(noDigPathingPlugin).
export function noDigPathingPlugin(bot) {
    enforceNoDigPathing(bot);
}

// What skills.goToGoal does while the guard is on: one attempt without digging, and no
// fallback to movements that dig. `movements` is the caller's Movements object.
// Returns true when the goal was reached. Returns false, after a no_safe_path line in the
// action log, when there is no dig-free path; the bot is not moved at all when the quick
// check already proves that. Other pathfinder errors (goal changed, path stopped) are thrown.
export async function goToGoalWithoutDigging(bot, goal, movements, check_timeout_ms = 1000) {
    const found = bot.pathfinder.getPathTo(movements, goal, check_timeout_ms);
    if (found?.status === 'noPath') {
        report(bot, 'there is no way to the goal without breaking blocks.');
        return false;
    }
    // "timeout" here only means the quick check ran out of time: the full search below decides.
    bot.pathfinder.setMovements(movements);
    try {
        await bot.pathfinder.goto(goal);
        return true;
    } catch (err) {
        if (err?.no_safe_path) return false;
        throw err;
    }
}
