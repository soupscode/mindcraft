// Genesis pre-flight: loads every Genesis module with the packages that are really installed
// and checks that everything the adapters call in upstream Mindcraft, mineflayer and
// mineflayer-pathfinder exists in the installed versions. No Minecraft server, MindServer,
// Redis, Postgres or model is needed, and nothing is changed anywhere.
//
//   node genesis/tools/preflight.js            run every check, print one line per check
//   node genesis/tools/preflight.js --quiet    print only what failed, and the totals
//
// Exit code 0: everything passed. 1: at least one check failed (each is printed with FAIL).
//
// What it does:
//   1. packages: the installed versions of the packages the patches in ./patches were made for
//      (a patch that does not apply is only a warning during npm install, easy to miss), and
//      that the two native packages every agent process loads (canvas, then gl) load together
//   2. modules: imports every .js file under genesis/ except the tests, this folder, the two
//      TypeScript services (dashboard, alerter) and the launcher (genesis/start.js starts the
//      agents when it is imported: check it with  node genesis/start.js --check)
//   3. upstream: every function and method the adapters call (genesis/adapters) is there
//   4. a real mineflayer bot, made the way upstream makes it (src/utils/mcdata.js, initBot) for
//      the Minecraft version in genesis/settings.json. It is pointed at a closed local port, so
//      it never connects: only what the plugins put on the bot is looked at, and the Genesis
//      guards and the world view are put on it.
//
// Depends on the installed packages of the repository root and of genesis/ (npm install in both).

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo_root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const genesis_root = path.join(repo_root, 'genesis');
const quiet = process.argv.includes('--quiet');
const require = createRequire(path.join(repo_root, 'package.json'));
process.chdir(repo_root); // upstream reads its files relative to the working directory

const results = []; // { group, name, ok, detail }
function record(group, name, ok, detail = '') {
    results.push({ group, name, ok, detail });
    if (!ok || !quiet) console.log(`${ok ? 'ok  ' : 'FAIL'}  ${group}: ${name}${detail ? `  (${detail})` : ''}`);
}
const brief = (err) => String(err?.stack ?? err).split('\n').slice(0, 4).join(' | ');

// Files this script does not import, and why.
export const NOT_IMPORTED = Object.freeze({
    'start.js': 'the launcher: it starts the agents when imported',
});
const SKIPPED_DIRS = new Set(['node_modules', 'tests', 'tools', 'dashboard', 'alerter']);

export function genesisModules(root = genesis_root) {
    const found = [];
    const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (entry.isDirectory()) {
                if (!SKIPPED_DIRS.has(entry.name)) walk(path.join(dir, entry.name));
            } else if (entry.name.endsWith('.js')) {
                const rel = path.relative(root, path.join(dir, entry.name)).split(path.sep).join('/');
                if (!Object.hasOwn(NOT_IMPORTED, rel)) found.push(rel);
            }
        }
    };
    walk(root);
    return found.sort();
}

// ---- 1. packages ----

function checkPackages() {
    const patches_dir = path.join(repo_root, 'patches');
    if (!existsSync(path.join(repo_root, 'node_modules'))) {
        record('packages', 'node_modules', false, 'run  npm install  in the repository root first');
        return false;
    }
    for (const file of existsSync(patches_dir) ? readdirSync(patches_dir).filter((name) => name.endsWith('.patch')).sort() : []) {
        const [, name, wanted] = /^(.+)\+([^+]+)\.patch$/.exec(file) ?? [];
        if (!name) continue;
        let installed = null;
        try { installed = JSON.parse(readFileSync(path.join(repo_root, 'node_modules', ...name.split('+'), 'package.json'), 'utf8')).version; } catch { /* not installed */ }
        if (installed === null) record('packages', name, false, `not installed, ${file} cannot apply`);
        else if (installed === wanted) record('packages', `${name}@${installed}`, true, 'the version its patch was made for');
        // minecraft-data only gets one added line (patches/minecraft-data+3.97.0.patch): any version it applies to will do
        else record('packages', `${name}@${installed}`, name === 'minecraft-data', `its patch was made for ${wanted}: read the patch-package lines of npm install`);
    }
    for (const dir of ['genesis']) {
        for (const name of Object.keys(JSON.parse(readFileSync(path.join(repo_root, dir, 'package.json'), 'utf8')).dependencies ?? {})) {
            const there = existsSync(path.join(repo_root, dir, 'node_modules', name, 'package.json'));
            record('packages', `${dir}: ${name}`, there, there ? '' : `run  npm install  in ${dir}/`);
        }
    }
    checkNativePackages();
    const node_major = Number(process.versions.node.split('.')[0]);
    record('packages', `node ${process.versions.node}`, node_major >= 22, node_major >= 22 ? '' : 'Node 22 or newer is needed');
    return true;
}

// Every agent process imports src/agent/vision/camera.js, which loads canvas and then gl
// (node-canvas-webgl/lib/index.js), also with vision off. On Linux the prebuilt canvas 3 brings its
// own, older libstdc++.so.6; once that one is loaded the prebuilt gl cannot load ("GLIBCXX_3.4.29 not
// found") and the agent process ends before it logs anything of its own. Checked in a process of its
// own, because a library that is loaded stays loaded.
export const CANVAS_LIBSTDCPP = 'node_modules/canvas/build/Release/libstdc++.so.6';

function checkNativePackages() {
    const run = spawnSync(process.execPath, ['-e', "require('node-canvas-webgl/lib/index.js')"], { cwd: repo_root, encoding: 'utf8', timeout: 60000 });
    if (run.status === 0) { record('packages', 'canvas and gl load together', true); return; }
    const text = `${run.stderr ?? ''}${run.error ?? ''}`;
    const clash = /GLIBCXX/.test(text) && existsSync(path.join(repo_root, CANVAS_LIBSTDCPP));
    record('packages', 'canvas and gl load together', false, clash
        ? `no agent process can start: delete ${CANVAS_LIBSTDCPP} (the system's libstdc++ is then used; genesis/Dockerfile does this) and run this again`
        : text.split('\n').filter((line) => /Error|not found|Cannot/.test(line)).slice(0, 2).join(' | ') || `exit ${run.status}`);
}

// ---- 2. modules ----

async function checkModules() {
    for (const rel of genesisModules()) {
        try {
            await import(pathToFileURL(path.join(genesis_root, rel)).href);
            record('modules', rel, true);
        } catch (err) {
            record('modules', rel, false, brief(err));
        }
    }
    for (const [rel, why] of Object.entries(NOT_IMPORTED)) if (!quiet) console.log(`skip  modules: ${rel}  (${why})`);
}

// ---- 3. upstream ----

const fromRoot = (rel) => import(pathToFileURL(path.join(repo_root, rel)).href);

async function checkUpstream() {
    const has = (group, owner, names, where) => {
        for (const name of names) record(group, `${where}.${name}`, typeof owner?.[name] === 'function', typeof owner?.[name] === 'function' ? '' : `is ${typeof owner?.[name]}`);
    };
    try {
        const { UPSTREAM_OPS } = await fromRoot('genesis/catalog/ops.js');
        const skills = await fromRoot('src/agent/library/skills.js');
        // every skill a template step may call (genesis/adapters/bot_ops.js) and the three of the recovery ladder (bot_recovery.js)
        has('upstream', skills, [...Object.keys(UPSTREAM_OPS), 'moveAway', 'goToPosition', 'goToSurface'], 'skills');
        has('upstream', await fromRoot('src/agent/library/world.js'), ['getInventoryCounts', 'getNearestBlocks'], 'world');
        has('upstream', await fromRoot('src/utils/mcdata.js'), ['initBot', 'getItemId', 'getBlockId', 'getItemCraftingRecipes', 'isSmeltable', 'getSmeltingFuel', 'getFuelSmeltOutput'], 'mcdata');
        const { Agent } = await fromRoot('src/agent/agent.js');
        has('upstream', Agent.prototype, ['isIdle', 'cleanKill', 'openChat'], 'Agent');
        const { ActionManager } = await fromRoot('src/agent/action_manager.js');
        has('upstream', ActionManager.prototype, ['runAction', 'stop'], 'ActionManager');
        has('upstream', await fromRoot('src/agent/commands/index.js'), ['addCommand'], 'commands');
        const { serverProxy } = await fromRoot('src/agent/mindserver_proxy.js');
        has('upstream', serverProxy, ['getSocket'], 'serverProxy');
        has('upstream', await fromRoot('src/mindcraft/mindserver.js'), ['setEventSink', 'setSocketExtension'], 'mindserver');
        has('upstream', await fromRoot('src/process/agent_process.js'), ['setRestartSupervisor'], 'agent_process');
        const pf = (await import('mineflayer-pathfinder')).default;
        has('upstream', pf, ['pathfinder', 'Movements'], 'mineflayer-pathfinder');
        has('upstream', pf?.goals, ['GoalNear'], 'mineflayer-pathfinder.goals');
        const Vec3 = (await import('vec3')).default;
        const point = new Vec3(1.5, 2, 3);
        record('upstream', 'vec3 default export builds a point', point?.x === 1.5 && typeof point?.distanceTo === 'function' && typeof point?.clone === 'function');
        const { buildBotRuntime } = await fromRoot('genesis/adapters/bot_agent.js');
        record('upstream', 'genesis/adapters/bot_agent.js exports buildBotRuntime', typeof buildBotRuntime === 'function');
    } catch (err) {
        record('upstream', 'load', false, brief(err));
    }
}

// ---- 4. a real bot ----

function closedPort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

async function checkBot() {
    let bot = null;
    try {
        const file_settings = JSON.parse(readFileSync(process.env.GENESIS_SETTINGS_FILE || path.join(genesis_root, 'settings.json'), 'utf8'));
        const version = String(file_settings.minecraft_version ?? '');
        const mineflayer = require('mineflayer');
        record('bot', `mineflayer ${require('mineflayer/package.json').version} lists Minecraft ${version} as tested`, mineflayer.testedVersions.includes(version),
            mineflayer.testedVersions.includes(version) ? '' : `tested: ${mineflayer.testedVersions.slice(-6).join(', ')}`);

        const { default: settings } = await fromRoot('src/agent/settings.js');
        // as the launcher forces it (genesis/lib/config.js): the no-dig guard is loaded by initBot
        Object.assign(settings, { host: '127.0.0.1', port: await closedPort(), auth: 'offline', pathfinding_no_dig: true });
        const { createBot } = mineflayer;
        const pf = (await import('mineflayer-pathfinder')).default;
        const { noDigPathingPlugin, isNoDigPathing } = await fromRoot('genesis/lib/no_dig_pathing.js');

        // upstream's initBot leaves the version to the server's answer; with no server the plugins are never
        // loaded. Same plugins, same order, with the version given, so they load without a connection.
        bot = createBot({ username: 'Preflight', host: settings.host, port: settings.port, auth: 'offline', version, logErrors: false, hideErrors: true });
        bot.on('error', () => {}); // the refused connection
        bot.loadPlugin(pf.pathfinder);
        bot.loadPlugin(noDigPathingPlugin);
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('the plugins were not loaded within 10 seconds')), 10000);
            bot.once('inject_allowed', () => setTimeout(() => { clearTimeout(timer); resolve(); }, 50));
        });

        for (const name of ['dig', 'placeBlock', 'blockAt', 'recipesFor', 'chat', 'loadPlugin']) record('bot', `bot.${name}`, typeof bot[name] === 'function');
        for (const name of ['getPathFromTo', 'getPathTo', 'goto', 'setGoal', 'setMovements']) record('bot', `bot.pathfinder.${name}`, typeof bot.pathfinder?.[name] === 'function');
        record('bot', 'bot.inventory.emptySlotCount', typeof bot.inventory?.emptySlotCount === 'function');
        record('bot', 'bot.inventory.items', typeof bot.inventory?.items === 'function');
        record('bot', 'bot.registry.blocksByName', typeof bot.registry?.blocksByName?.stone === 'object');
        record('bot', 'the no-dig guard is on the bot', isNoDigPathing(bot));
        const movements = new pf.Movements(bot);
        record('bot', 'new Movements(bot)', typeof movements.safeToBreak === 'function' && typeof movements.countScaffoldingItems === 'function' && 'canDig' in movements && Array.isArray(movements.exclusionAreasBreak));

        const { installBotGuards } = await fromRoot('genesis/lib/bot_guards.js');
        const guards = installBotGuards(bot, { zones: { protectedAt: () => null } });
        record('bot', 'installBotGuards wraps bot.dig and bot.placeBlock', bot.dig.name === 'guardedDig' && bot.placeBlock.name === 'trackedPlaceBlock' && typeof guards.allowBreak === 'function');

        const { createBotView } = await fromRoot('genesis/adapters/bot_world.js');
        const world = await fromRoot('src/agent/library/world.js');
        const mc = await fromRoot('src/utils/mcdata.js');
        const Vec3 = (await import('vec3')).default;
        const view = createBotView(bot, { world, mc, pf, Vec3 });
        const reads = {
            freeSlots: () => Number.isInteger(view.freeSlots()),
            inventory: () => typeof view.inventory() === 'object',
            dayTicksLeft: () => Number.isFinite(view.dayTicksLeft()),
            dimension: () => typeof view.dimension() === 'string',
            'canHarvest(stone) is false with empty hands': () => view.canHarvest('stone') === false,
            'canHarvest(dirt) is true with empty hands': () => view.canHarvest('dirt') === true,
            agentPosition: () => view.agentPosition('Nobody') === null,
        };
        for (const [name, read] of Object.entries(reads)) {
            try { record('bot', `view.${name}`, read() === true); } catch (err) { record('bot', `view.${name}`, false, brief(err)); }
        }
    } catch (err) {
        record('bot', 'a real mineflayer bot', false, brief(err));
    } finally {
        try { bot?.end(); } catch { /* never connected */ }
    }
}

async function main() {
    if (checkPackages()) {
        await checkModules();
        await checkUpstream();
        await checkBot();
    }
    const failed = results.filter((result) => !result.ok);
    console.log(`\nGenesis pre-flight: ${results.length - failed.length} passed, ${failed.length} failed.`);
    if (failed.length > 0) console.log('Failed:\n' + failed.map((result) => `  ${result.group}: ${result.name}  ${result.detail}`).join('\n'));
    return failed.length > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    main().then((code) => process.exit(code), (err) => { console.error(err); process.exit(1); });
}
