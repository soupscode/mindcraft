// A stand-in for a mineflayer bot with the mineflayer-pathfinder plugin, for the
// no-dig pathing tests. Node built-ins only.
//
// The fake pathfinder is modelled on mineflayer-pathfinder 2.4.5 (index.js, lib/goto.js):
//   - getPathTo() calls bot.pathfinder.getPathFromTo(), looked up at call time
//   - setGoal() makes the movement loop compute a path with the movements last given
//     to setMovements(), again through bot.pathfinder.getPathTo(), and announce it
//     with a "path_update" event; a path that needs blocks broken is dug while walking
//   - goto() resolves on "goal_reached" and also on any path_update with an empty path,
//     and rejects with NoPath / Timeout / GoalChanged / PathStopped
//
// The world is one function, search({ movements, can_dig, timeout, call }), that answers
// what a path search finds: { status, steps, breaks }.
//   status: 'success' | 'partial' | 'noPath' | 'timeout'
//   steps:  number of steps in the path found (0 = none)
//   breaks: number of blocks that path breaks

import { EventEmitter } from 'node:events';

export function pos(x, y, z) {
    return {
        x, y, z,
        distanceTo(o) { return Math.hypot(x - o.x, y - o.y, z - o.z); },
        clone() { return pos(x, y, z); },
        floored() { return pos(Math.floor(x), Math.floor(y), Math.floor(z)); },
        offset(dx, dy, dz) { return pos(x + dx, y + dy, z + dz); },
        plus(o) { return pos(x + o.x, y + o.y, z + o.z); },
        toString() { return `(${x}, ${y}, ${z})`; },
    };
}

// Stand-ins for what src/agent/library/skills.js imports, so the real file can be loaded
// without installing mineflayer. Pass to stubModules() before importing skills.js.
export const SKILLS_STUBS = {
    'mineflayer-pathfinder': `
        class Movements {
            constructor(bot) {
                this.bot = bot;
                this.canDig = true; // the real default
                this.digCost = 1;
                this.placeCost = 1;
                this.allow1by1towers = true;
                this.blocksCantBreak = new Set();
            }
            safeToBreak() { return this.canDig; }
        }
        class GoalNear { constructor(x, y, z, range) { Object.assign(this, { x, y, z, range }); } }
        class GoalFollow { constructor(entity, range) { Object.assign(this, { entity, range }); } }
        class GoalInvert { constructor(goal) { this.goal = goal; } }
        export default { Movements, goals: { GoalNear, GoalFollow, GoalInvert } };`,
    'vec3': `
        export default function Vec3(x, y, z) {
            if (!(this instanceof Vec3)) return new Vec3(x, y, z);
            Object.assign(this, { x, y, z });
        }
        Vec3.prototype.distanceTo = function (o) { return Math.hypot(this.x - o.x, this.y - o.y, this.z - o.z); };
        Vec3.prototype.clone = function () { return new Vec3(this.x, this.y, this.z); };
        Vec3.prototype.floored = function () { return new Vec3(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z)); };
        Vec3.prototype.offset = function (dx, dy, dz) { return new Vec3(this.x + dx, this.y + dy, this.z + dz); };
        Vec3.prototype.plus = function (o) { return new Vec3(this.x + o.x, this.y + o.y, this.z + o.z); };`,
    'src/utils/mcdata.js': `
        export function getBlockId(name) { return 'id:' + name; }
        export function mustCollectManually() { return false; }
        export function isHostile() { return false; }`,
    'src/agent/library/world.js': `
        export function getPosition(bot) { return bot.entity.position; }
        export function shouldPlaceTorch() { return false; }
        export function getNearestBlock(bot) { return bot.test_blocks[0] ?? null; }
        export function getNearestBlocksWhere(bot, predicate) { return bot.test_blocks.filter(predicate); }
        export function getNearestEntityWhere() { return null; }`,
};

export function fakeBot(search) {
    const bot = new EventEmitter();
    bot.output = '';
    bot.interrupt_code = false;
    bot.entity = { position: pos(0, 64, 0) };
    bot.modes = { isOn: () => false, pause() {}, unpause() {} };
    bot.game = { gameMode: 'survival' };
    bot.players = {};
    bot.test_blocks = [];   // what the world stand-in finds
    bot.searches = [];      // one entry per path search: { can_dig, timeout }
    bot.walks = [];         // one entry per path walked: { steps, breaks }
    bot.dug = [];           // every block broken: 'path' (by the pathfinder) or a block (by bot.dig)
    bot.gotos = 0;          // how often the original goto was called
    bot.blockAt = (p) => ({ name: 'stone', position: pos(p.x, p.y, p.z), canHarvest: () => true });
    bot.dig = async (block) => { bot.dug.push(block); };
    bot.tool = { equipForBlock: async () => {} };
    bot.heldItem = null;
    bot.nearestEntity = () => null;
    bot.activateBlock = async () => {};

    // What the bot's default movements look like before anyone calls setMovements().
    let state_movements = { canDig: true, blocksCantBreak: new Set(), safeToBreak() { return this.canDig; } };
    let state_goal = null;
    let call = 0;

    const destination = (goal) => {
        if (goal.entity) return goal.entity.position;
        if (goal.goal) return bot.entity.position.offset(10, 0, 0); // GoalInvert: somewhere else
        return goal;
    };

    function tick() {
        if (!state_goal) return;
        const goal = state_goal;
        const results = bot.pathfinder.getPathTo(state_movements, goal);
        bot.emit('path_update', results);
        if (state_goal !== goal) return;
        if (results.status === 'partial') {
            setImmediate(tick); // the search goes on in the next tick
        } else if (results.status === 'success') {
            const breaks = results.path.reduce((n, step) => n + step.toBreak.length, 0);
            bot.walks.push({ steps: results.path.length, breaks });
            for (let i = 0; i < breaks; i++) bot.dug.push('path');
            const d = destination(goal);
            bot.entity.position = pos(d.x, d.y, d.z);
            state_goal = null;
            bot.emit('goal_reached', goal);
        }
    }

    bot.pathfinder = {
        * getPathFromTo(movements, start, goal, options = {}) {
            bot.searches.push({ can_dig: movements.canDig, timeout: options.timeout });
            const found = search({ movements, can_dig: movements.canDig, timeout: options.timeout, call: call++ });
            const path = [];
            for (let i = 0; i < (found.steps ?? 0); i++) {
                path.push({ toBreak: i === 0 ? Array.from({ length: found.breaks ?? 0 }, () => pos(1, 64, 0)) : [] });
            }
            yield { result: { status: found.status, path }, astarContext: {} };
        },
        getPathTo(movements, goal, timeout) {
            const generator = bot.pathfinder.getPathFromTo(movements, bot.entity.position, goal, { timeout });
            return generator.next().value.result;
        },
        setMovements(movements) { state_movements = movements; },
        get movements() { return state_movements; },
        get goal() { return state_goal; },
        setGoal(goal) {
            state_goal = goal;
            bot.emit('goal_updated', goal, false);
            if (goal) setImmediate(tick);
        },
        stop() {
            if (!state_goal) return;
            state_goal = null;
            bot.emit('path_stop');
        },
        isMoving: () => false,
        // lib/goto.js of mineflayer-pathfinder 2.4.5
        goto(goal) {
            bot.gotos++;
            return new Promise((resolve, reject) => {
                const error = (name, message) => Object.assign(new Error(message), { name });
                const cleanup = (err) => {
                    bot.removeListener('goal_reached', goalReached);
                    bot.removeListener('path_update', noPathListener);
                    bot.removeListener('goal_updated', goalChangedListener);
                    bot.removeListener('path_stop', pathStopped);
                    setTimeout(() => (err ? reject(err) : resolve()), 0);
                };
                const goalReached = () => cleanup();
                const noPathListener = (results) => {
                    if (results.path.length === 0) cleanup();
                    else if (results.status === 'noPath') cleanup(error('NoPath', 'No path to the goal!'));
                    else if (results.status === 'timeout') cleanup(error('Timeout', 'Took to long to decide path to goal!'));
                };
                const goalChangedListener = (new_goal) => {
                    if (new_goal !== goal) cleanup(error('GoalChanged', 'The goal was changed before it could be completed!'));
                };
                const pathStopped = () => cleanup(error('PathStopped', 'Path was stopped before it could be completed! Thus, the desired goal was not reached.'));
                bot.on('path_stop', pathStopped);
                bot.on('goal_reached', goalReached);
                bot.on('path_update', noPathListener);
                bot.on('goal_updated', goalChangedListener);
                bot.pathfinder.setGoal(goal);
            });
        },
    };

    // mineflayer-collectblock 1.4.1, the part that walks to a block and mines it (lib/CollectBlock.js)
    bot.collect_calls = 0;
    bot.collectBlock = {
        movements: { canDig: true, blocksCantBreak: new Set(), safeToBreak() { return this.canDig; } },
        async collect(block) {
            bot.collect_calls++;
            bot.pathfinder.setMovements(this.movements);
            await bot.pathfinder.goto({ x: block.position.x, y: block.position.y, z: block.position.z, look_at: true });
            if (!bot.pathfinder.movements.safeToBreak(block)) return; // the plugin skips the block without an error
            await bot.dig(block);
        },
    };
    return bot;
}

// Worlds.
export const OPEN = () => ({ status: 'success', steps: 3, breaks: 0 });
// The goal is behind a wall: reachable only by breaking two blocks.
export const WALLED = ({ can_dig }) => (can_dig
    ? { status: 'success', steps: 3, breaks: 2 }
    : { status: 'noPath', steps: 0 });
// The same, with a glass wall: upstream's "non-destructive" movements may not break glass.
export const GLASS_WALLED = ({ movements, can_dig }) => (can_dig && movements.blocksCantBreak.size === 0
    ? { status: 'success', steps: 3, breaks: 2 }
    : { status: 'noPath', steps: 1 });
// Too far to finish searching: digging gets there, without digging the search times out on the way.
export const WALLED_FAR = ({ can_dig }) => (can_dig
    ? { status: 'success', steps: 9, breaks: 2 }
    : { status: 'timeout', steps: 4 });
// Without digging the search times out before it found a single step.
export const WALLED_NO_STEP = ({ can_dig }) => (can_dig
    ? { status: 'success', steps: 9, breaks: 2 }
    : { status: 'timeout', steps: 0 });
// Nothing gets there, digging or not.
export const UNREACHABLE = () => ({ status: 'noPath', steps: 1 });
// A dig-free way exists, but it starts by leading away from the goal: the first rounds of
// the search have no step to offer yet (status "partial"), then the path is found.
export function detour() {
    let rounds = 0;
    return ({ timeout }) => {
        if (timeout !== undefined) return { status: 'timeout', steps: 0 }; // the quick check before walking
        return rounds++ < 2 ? { status: 'partial', steps: 0 } : { status: 'success', steps: 12, breaks: 0 };
    };
}
