// Fix 3, the switch: the pathfinding_no_dig setting decides whether a bot gets the no-dig guard.
//
// Uses the real src/utils/mcdata.js (where upstream creates the bot and loads its plugins)
// and the real src/agent/settings.js. mineflayer and its plugins are replaced by stand-ins.
// Run from the repository root:  node --test genesis/tests/*.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { stubModules } from './helpers/stubs.mjs';
import { isNoDigPathing, noDigPathingPlugin } from '../lib/no_dig_pathing.js';

stubModules({
    'mineflayer': `
        export function createBot(options) {
            const bot = {
                options, plugins: [],
                _client: { write() {}, emit() {} },
                loadPlugin(plugin) { bot.plugins.push(plugin); },
                once() {},
            };
            return bot;
        }`,
    'mineflayer-pathfinder': `
        export function pathfinder(bot) {
            bot.pathfinder = {
                * getPathFromTo(movements) { yield { result: { status: 'success', path: [], can_dig: movements.canDig } }; },
                getPathTo(movements, goal, timeout) { return bot.pathfinder.getPathFromTo(movements).next().value.result; },
                goto() {}, setGoal() {}, setMovements() {},
            };
        }`,
    'mineflayer-pvp': 'export function plugin(bot) { bot.pvp = {}; }',
    'mineflayer-collectblock': 'export function plugin(bot) { bot.collectBlock = {}; }',
    'mineflayer-auto-eat': 'export function plugin(bot) {}',
    'mineflayer-armor-manager': 'export default function armorManager(bot) {}',
    'minecraft-data': 'export default function minecraftData() { return {}; }',
    'prismarine-item': 'export default function prismarineItem() { return {}; }',
});

const { setSettings } = await import('../../src/agent/settings.js');
const { initBot } = await import('../../src/utils/mcdata.js');
const { pathfinder } = await import('mineflayer-pathfinder');

// mineflayer runs the plugins in the order they were loaded, once the bot may be changed
function inject(bot) {
    for (const plugin of bot.plugins) plugin(bot);
    return bot;
}

const BASE = { host: '127.0.0.1', port: 25565, auth: 'offline', minecraft_version: '1.21.6' };

test('setting on: the guard is loaded right after the pathfinder, and path searches cannot dig', () => {
    setSettings({ ...BASE, pathfinding_no_dig: true });
    const bot = initBot('Tester');
    assert.equal(bot.plugins.indexOf(noDigPathingPlugin), bot.plugins.indexOf(pathfinder) + 1);
    assert.equal(isNoDigPathing(bot), false); // nothing is wrapped before the plugins run
    inject(bot);
    assert.equal(isNoDigPathing(bot), true);
    assert.equal(bot.pathfinder.getPathTo({ canDig: true }, {}, 100).can_dig, false);
});

test('setting off or absent (upstream default): the guard is not loaded and searches are untouched', () => {
    for (const settings of [{ ...BASE, pathfinding_no_dig: false }, { ...BASE }]) {
        setSettings(settings);
        const bot = inject(initBot('Tester'));
        assert.ok(!bot.plugins.includes(noDigPathingPlugin));
        assert.equal(bot.plugins.length, 5); // the five plugins upstream loads
        assert.equal(isNoDigPathing(bot), false);
        assert.equal(bot.pathfinder.getPathTo({ canDig: true }, {}, 100).can_dig, true);
    }
});
