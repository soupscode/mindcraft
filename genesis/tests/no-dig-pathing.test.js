// Fix 3: with the pathfinding_no_dig setting on, agents never dig to get somewhere.
//
// Uses the real genesis/lib/no_dig_pathing.js and the real src/agent/library/skills.js.
// mineflayer-pathfinder and the other imports of skills.js are replaced by stand-ins
// (helpers/fake-pathfinder.mjs), whose pathfinder follows mineflayer-pathfinder 2.4.5.
// "Guarded" below means: the plugin the setting loads was put on the bot.
// Run from the repository root:  node --test genesis/tests/*.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { stubModules } from './helpers/stubs.mjs';
import {
    SKILLS_STUBS, fakeBot, pos,
    OPEN, WALLED, GLASS_WALLED, WALLED_FAR, WALLED_NO_STEP, UNREACHABLE, detour,
} from './helpers/fake-pathfinder.mjs';
import {
    NO_SAFE_PATH, noDigView, isNoDigPathing, enforceNoDigPathing, noDigPathingPlugin, goToGoalWithoutDigging,
} from '../lib/no_dig_pathing.js';

stubModules(SKILLS_STUBS);
const skills = await import('../../src/agent/library/skills.js');
const pf = (await import('mineflayer-pathfinder')).default;

const LIMIT = { timeout: 15000 };
const GOAL = () => new pf.goals.GoalNear(20, 64, 0, 2);

function guardedBot(search) {
    const bot = fakeBot(search);
    noDigPathingPlugin(bot);
    return bot;
}

// Runs a call that may throw. Returns { value } or { error }.
async function outcome(fn) {
    try { return { value: await fn() }; } catch (error) { return { error }; }
}

function assertNeverDug(bot) {
    assert.deepEqual(bot.dug, [], 'a block was broken');
    assert.ok(bot.searches.length > 0, 'no path search ran');
    for (const search of bot.searches) assert.equal(search.can_dig, false, 'a path search was allowed to dig');
    for (const walk of bot.walks) assert.equal(walk.breaks, 0);
}

const noSafePathLines = (bot) => bot.output.split('\n').filter((line) => line.includes(NO_SAFE_PATH));

// ---- the setting on -------------------------------------------------------------------

test('guarded: a dig-free path is walked, and every search ran with digging disabled', LIMIT, async () => {
    const bot = guardedBot(OPEN);
    assert.equal(isNoDigPathing(bot), true);
    assert.equal(await skills.goToGoal(bot, GOAL()), true);
    assert.equal(bot.walks.length, 1);
    assertNeverDug(bot);
    assert.equal(noSafePathLines(bot).length, 0);
    assert.doesNotMatch(bot.output, /destructive/);
});

test('guarded: goal behind a wall: goToGoal returns false with no_safe_path and does not dig', LIMIT, async () => {
    for (const world of [WALLED, GLASS_WALLED]) {
        const bot = guardedBot(world);
        const start = bot.entity.position;
        assert.equal(await skills.goToGoal(bot, GOAL()), false);
        assert.equal(noSafePathLines(bot).length, 1, bot.output);
        assertNeverDug(bot);
        // the dig fallback is gone: one search, nothing after it, the bot did not move
        assert.equal(bot.searches.length, 1);
        assert.equal(bot.gotos, 0);
        assert.equal(bot.walks.length, 0);
        assert.equal(bot.entity.position, start);
        assert.equal(bot.pathfinder.goal, null);
        assert.doesNotMatch(bot.output, /destructive/);
    }
});

test('guarded: a search that times out without digging: false with no_safe_path, no dig', LIMIT, async () => {
    for (const world of [WALLED_FAR, WALLED_NO_STEP]) {
        const bot = guardedBot(world);
        assert.equal(await skills.goToGoal(bot, GOAL()), false);
        assert.equal(noSafePathLines(bot).length, 1, bot.output);
        assertNeverDug(bot);
        assert.equal(bot.walks.length, 0);
    }
});

test('guarded: a detour whose first steps lead away from the goal is waited for and walked', LIMIT, async () => {
    const bot = guardedBot(detour());
    assert.equal(await skills.goToGoal(bot, GOAL()), true);
    assert.deepEqual(bot.walks, [{ steps: 12, breaks: 0 }]);
    assert.equal(bot.entity.position.x, 20); // it is there when the skill returns
    assertNeverDug(bot);
    assert.equal(noSafePathLines(bot).length, 0);
});

test('guarded: skills that walk stop and return false, with no_safe_path in the action log', LIMIT, async () => {
    const calls = {
        goToPosition: (bot) => skills.goToPosition(bot, 20, 64, 0, 2),
        goToNearestBlock: (bot) => skills.goToNearestBlock(bot, 'oak_log', 2, 64),
        goToPlayer: (bot) => skills.goToPlayer(bot, 'steve', 3),
        moveAway: (bot) => skills.moveAway(bot, 8),
        breakBlockAt: (bot) => skills.breakBlockAt(bot, 20, 64, 0),
        pickupNearbyItems: null, // below: it returns true upstream whatever happens
    };
    for (const [name, call] of Object.entries(calls)) {
        if (!call) continue;
        const bot = guardedBot(WALLED);
        bot.test_blocks = [{ name: 'oak_log', position: pos(20, 64, 0) }];
        bot.players = { steve: { entity: { position: pos(20, 64, 0) } } };
        const result = await outcome(() => call(bot));
        assert.equal(result.error, undefined, `${name} threw ${result.error}`);
        assert.equal(result.value, false, `${name} returned ${result.value}`);
        assert.ok(noSafePathLines(bot).length >= 1, `${name}: ${bot.output}`);
        assertNeverDug(bot); // also: breakBlockAt did not break its block from where it stood
        assert.equal(bot.walks.length, 0, name);
    }
});

test('guarded: pickupNearbyItems gives up on an item it cannot reach without digging', LIMIT, async () => {
    const bot = guardedBot(WALLED);
    const item = { name: 'item', position: pos(5, 64, 0) };
    bot.nearestEntity = () => item;
    assert.equal(await skills.pickupNearbyItems(bot), true); // as upstream: it reports how many it picked up
    assert.match(bot.output, /Picked up 0 items\./);
    assert.equal(noSafePathLines(bot).length, 1);
    assertNeverDug(bot);
});

test('guarded: collecting a block that needs a dug path fails once; a reachable block is still mined', LIMIT, async () => {
    const walled = guardedBot(WALLED);
    walled.test_blocks = [{ name: 'iron_ore', position: pos(20, 60, 0), canHarvest: () => true }];
    assert.equal(await skills.collectBlock(walled, 'iron_ore', 5), false);
    assert.equal(walled.collect_calls, 1, 'the same unreachable block was tried again');
    assert.equal(noSafePathLines(walled).length, 1, walled.output);
    assert.match(walled.output, /Collected 0 iron_ore\./);
    assertNeverDug(walled);

    // Mining the block it was sent for is not digging to get somewhere: that still works.
    const open = guardedBot(OPEN);
    const ore = { name: 'iron_ore', position: pos(20, 60, 0), canHarvest: () => true };
    open.test_blocks = [ore];
    assert.equal(await skills.collectBlock(open, 'iron_ore', 1), true);
    assert.deepEqual(open.dug, [ore]); // by bot.dig on the target, none by the pathfinder
    for (const search of open.searches) assert.equal(search.can_dig, false);
    assert.equal(open.walks.every((walk) => walk.breaks === 0), true);
});

test('guarded: callers that set their own Movements and call the pathfinder directly cannot dig either', LIMIT, async () => {
    // goto, as defendSelf, moveAwayFromEntity and placeBlock do
    const direct = guardedBot(WALLED);
    const result = await outcome(() => skills.moveAwayFromEntity(direct, { position: pos(1, 64, 0) }, 8));
    assert.equal(result.error?.name, 'NoPath'); // upstream lets this error end the action
    assert.equal(result.error.no_safe_path, true);
    assert.equal(noSafePathLines(direct).length, 1);
    assertNeverDug(direct);

    // setGoal, as followPlayer, avoidEnemies and mineflayer-pvp do, with digging asked for explicitly
    const follow = guardedBot(WALLED);
    const movements = new pf.Movements(follow);
    movements.canDig = true;
    follow.pathfinder.setMovements(movements);
    follow.pathfinder.setGoal(new pf.goals.GoalFollow({ position: pos(20, 64, 0) }, 2), true);
    await new Promise((resolve) => follow.once('path_update', resolve));
    assertNeverDug(follow);
    assert.equal(follow.walks.length, 0);

    // setGoal with the movements the bot starts with (nobody called setMovements), as useDoor does
    const untouched = guardedBot(WALLED);
    untouched.pathfinder.setGoal(GOAL());
    await new Promise((resolve) => untouched.once('path_update', resolve));
    assertNeverDug(untouched);

    // the caller's object is not changed: mineflayer-collectblock asks it whether it may mine its target
    assert.equal(movements.canDig, true);
    assert.equal(follow.pathfinder.movements, movements);
    assert.equal(follow.pathfinder.movements.safeToBreak({}), true);
});

test('guarded: other pathfinder errors are passed on unchanged', LIMIT, async () => {
    const changed = guardedBot(detour());
    const walking = outcome(() => skills.goToGoal(changed, GOAL()));
    changed.once('path_update', () => changed.pathfinder.setGoal(new pf.goals.GoalNear(0, 64, 9, 1)));
    const first = await walking;
    assert.equal(first.error?.name, 'GoalChanged');
    assert.equal(first.error.no_safe_path, undefined);
    assert.equal(noSafePathLines(changed).length, 0);

    const stopped = guardedBot(detour());
    const walking_too = outcome(() => skills.goToGoal(stopped, GOAL()));
    stopped.once('path_update', () => stopped.pathfinder.stop());
    assert.equal((await walking_too).error?.name, 'PathStopped');
    assert.equal(noSafePathLines(stopped).length, 0);
});

test('the guard needs the pathfinder plugin, and installs once', LIMIT, async () => {
    assert.throws(() => enforceNoDigPathing({}), /no-dig guard cannot be installed/);
    assert.throws(() => noDigPathingPlugin({ pathfinder: { goto() {} } }), /no-dig guard cannot be installed/);
    const bot = fakeBot(OPEN);
    enforceNoDigPathing(bot);
    const wrapped = bot.pathfinder.getPathFromTo;
    enforceNoDigPathing(bot);
    assert.equal(bot.pathfinder.getPathFromTo, wrapped);
    bot.pathfinder.getPathTo(new pf.Movements(bot), GOAL(), 100);
    assert.deepEqual(bot.searches, [{ can_dig: false, timeout: 100 }]);
});

test('noDigView: every setting is read from the original, except that it cannot dig', () => {
    const movements = new pf.Movements({});
    movements.digCost = 7;
    const view = noDigView(movements);
    assert.equal(view.canDig, false);
    assert.equal(view.safeToBreak({}), false);
    assert.equal(view.digCost, 7);
    movements.placeCost = 9; // later changes by the caller are seen
    assert.equal(view.placeCost, 9);
    assert.equal(view.blocksCantBreak, movements.blocksCantBreak);
    view.canDig = true; // cannot be switched back on
    assert.equal(view.canDig, false);
    assert.equal(movements.canDig, true); // the original is left alone
    assert.equal(noDigView(movements), view);
    assert.equal(noDigView(view), view);
    assert.equal(noDigView(null), null);
    assert.equal(noDigView(undefined), undefined);
});

test('goToGoalWithoutDigging: the quick check decides only when it proves there is no path', LIMIT, async () => {
    const bot = guardedBot(OPEN);
    assert.equal(await goToGoalWithoutDigging(bot, GOAL(), new pf.Movements(bot), 250), true);
    assert.deepEqual(bot.searches.map((s) => s.timeout), [250, undefined]); // quick check, then the full search
});

// ---- the setting off: upstream behaviour ----------------------------------------------

test('unguarded: a dig-free path is found as before', LIMIT, async () => {
    const bot = fakeBot(OPEN);
    assert.equal(isNoDigPathing(bot), false);
    assert.equal(await skills.goToGoal(bot, GOAL()), true);
    assert.match(bot.output, /Found non-destructive path\./);
    assert.deepEqual(bot.dug, []);
});

test('unguarded: upstream digs through a wall, also with its "non-destructive" movements', LIMIT, async () => {
    const stone = fakeBot(WALLED);
    assert.equal(await skills.goToGoal(stone, GOAL()), true);
    assert.match(stone.output, /Found non-destructive path\./);
    assert.deepEqual(stone.dug, ['path', 'path']);
    assert.ok(stone.searches.every((search) => search.can_dig === true));

    const glass = fakeBot(GLASS_WALLED);
    assert.equal(await skills.goToGoal(glass, GOAL()), true);
    assert.match(glass.output, /Found destructive path\./); // the fallback
    assert.deepEqual(glass.dug, ['path', 'path']);
});

test('unguarded: with no path at all upstream still tries with destructive movements, then throws', LIMIT, async () => {
    const bot = fakeBot(UNREACHABLE);
    const result = await outcome(() => skills.goToGoal(bot, GOAL()));
    assert.equal(result.error?.name, 'NoPath');
    assert.equal(result.error.no_safe_path, undefined);
    assert.match(bot.output, /Path not found, but attempting to navigate anyway using destructive movements\./);
    assert.equal(bot.gotos, 1);
    assert.equal(noSafePathLines(bot).length, 0);

    const other = fakeBot(UNREACHABLE);
    assert.equal(await skills.goToPosition(other, 20, 64, 0, 2), false);
    assert.match(other.output, /Pathfinding stopped: No path to the goal!\./);
});

test('unguarded: results of the skills are as before', LIMIT, async () => {
    const reached = fakeBot(WALLED);
    assert.equal(await skills.goToPosition(reached, 20, 64, 0, 2), true);
    assert.match(reached.output, /You have reached at 20, 64, 0\./);

    // upstream reports success for goToNearestBlock even when the block was not reached
    const unreachable = fakeBot(UNREACHABLE);
    unreachable.test_blocks = [{ name: 'oak_log', position: pos(20, 64, 0) }];
    assert.equal(await skills.goToNearestBlock(unreachable, 'oak_log', 2, 64), true);

    const away = fakeBot(WALLED);
    assert.equal(await skills.moveAway(away, 8), true);
    assert.match(away.output, /Moved away from/);

    // collecting retries after a failure, as before
    const collecting = fakeBot(UNREACHABLE);
    collecting.test_blocks = [{ name: 'iron_ore', position: pos(20, 60, 0), canHarvest: () => true }];
    assert.equal(await skills.collectBlock(collecting, 'iron_ore', 3), false);
    assert.equal(collecting.collect_calls, 3);
});
