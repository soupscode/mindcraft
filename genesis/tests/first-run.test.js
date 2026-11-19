// What the first run with real packages turned up (the pre-flight of genesis/FIRST_RUN.md), as
// checks that need no packages, no Docker and no server:
//   - the package a patch in ./patches was made for is installed in exactly that version
//     (mineflayer had moved on, its patch no longer applied, and npm install only warned)
//   - the agents image takes away the libstdc++ the prebuilt canvas brings (with it no agent
//     process on Linux got past its imports)
//   - the pre-flight script imports every Genesis module, the adapters first of all
//   - the three compose files meet on the one named network, the Minecraft server never
//     accepts the EULA by itself, and RCON and the MindServer are not published
// Run from the repository root:  node --test genesis/tests/*.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './helpers/stubs.mjs';
import { genesisModules, NOT_IMPORTED, CANVAS_LIBSTDCPP } from '../tools/preflight.js';

const GENESIS = path.join(REPO_ROOT, 'genesis');
const read = (...parts) => readFileSync(path.join(REPO_ROOT, ...parts), 'utf8');
// the lines of a compose file that are not comments
const configLines = (file) => read('genesis', file).split('\n').map((line) => line.replace(/\s+#.*$/, '')).filter((line) => line.trim() && !line.trim().startsWith('#'));

test('packages: mineflayer is installed in the version its patch was made for', () => {
    const root = JSON.parse(read('package.json'));
    const patch = readdirSync(path.join(REPO_ROOT, 'patches')).find((name) => /^mineflayer\+[^+]+\.patch$/.test(name));
    assert.ok(patch, 'patches/ has no patch for mineflayer');
    const version = /^mineflayer\+([^+]+)\.patch$/.exec(patch)[1];
    // a range ("^4.33.0") installs whatever is newest, and a patch made for another version is then skipped
    assert.equal(root.dependencies.mineflayer, version, 'the root package.json must name the exact version of patches/' + patch);
    // the installed copy cannot be looked at here (the tests run without node_modules): node genesis/tools/preflight.js does
});

test('agents image: the libstdc++ of the prebuilt canvas is removed, and canvas and gl are loaded once at build time', () => {
    const dockerfile = read('genesis', 'Dockerfile');
    assert.equal(CANVAS_LIBSTDCPP, 'node_modules/canvas/build/Release/libstdc++.so.6');
    const install = dockerfile.split('\n\n').find((block) => block.includes('COPY patches ./patches'));
    assert.ok(install.includes(`rm -f ${CANVAS_LIBSTDCPP}`), 'the bundled libstdc++ is not removed after npm install');
    // every agent process loads this file through src/agent/vision/camera.js: a build that cannot load it must fail
    assert.match(install, /node -e "require\('node-canvas-webgl\/lib\/index\.js'\)"/);
    assert.equal(read('src', 'agent', 'vision', 'camera.js').includes("from 'node-canvas-webgl/lib/index.js'"), true);
    assert.ok(dockerfile.indexOf(`rm -f ${CANVAS_LIBSTDCPP}`) < dockerfile.indexOf('COPY . .'));
});

test('pre-flight: every Genesis module is imported, except the launcher, the tests and the two services', () => {
    const modules = genesisModules();
    for (const rel of ['adapters/bot_agent.js', 'adapters/bot_world.js', 'adapters/bot_ops.js', 'adapters/bot_recovery.js', 'adapters/pg_stores.js',
        'adapters/redis_stream.js', 'lib/bot_guards.js', 'agent/hooks.js', 'planning/server.js', 'recovery/server.js', 'relay/server.js',
        'events/server.js', 'world/bootstrap.js', 'world/reset.js']) {
        assert.ok(modules.includes(rel), `${rel} is not imported by the pre-flight`);
    }
    assert.deepEqual(Object.keys(NOT_IMPORTED), ['start.js']);
    assert.ok(!modules.includes('start.js'));
    assert.ok(modules.every((rel) => !/^(tests|tools|dashboard|alerter|node_modules)\//.test(rel)), 'a folder that is not the agents\' code is imported');
    // nothing is left out by accident: every folder of genesis/ that holds .js files is either walked or named above
    const folders = readdirSync(GENESIS, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    const walked = new Set(modules.filter((rel) => rel.includes('/')).map((rel) => rel.split('/')[0]));
    for (const folder of folders) {
        if (['tests', 'tools', 'dashboard', 'alerter', 'node_modules'].includes(folder)) continue;
        const has_js = readdirSync(path.join(GENESIS, folder)).some((name) => name.endsWith('.js'));
        assert.equal(walked.has(folder), has_js, `genesis/${folder}`);
    }
});

test('compose: the agents, the dashboard stack and the Minecraft server meet on the one named network', () => {
    for (const file of ['compose.agents.yaml', 'compose.dashboard.yaml', 'compose.minecraft.yaml']) {
        const lines = configLines(file);
        const at = lines.indexOf('networks:');
        assert.ok(at > 0, `${file}: no top-level networks`);
        // no file owns the network, so the three can be started and stopped in any order
        assert.deepEqual(lines.slice(at, at + 4).map((line) => line.trim()), ['networks:', 'genesis:', 'name: genesis', 'external: true'], file);
        assert.match(read('genesis', file), /docker network create genesis/, `${file} does not say how the network is made`);
    }
    // every service is on it
    const agents = configLines('compose.agents.yaml');
    assert.ok(agents.some((line, i) => line === '    networks:' && agents[i + 1] === '      - genesis'));
    const minecraft = configLines('compose.minecraft.yaml');
    assert.ok(minecraft.some((line, i) => line === '    networks:' && minecraft[i + 1] === '      - genesis'));
    assert.equal(configLines('compose.dashboard.yaml').filter((line) => line === '      - genesis').length, 4);
});

test('compose: the Minecraft server is offline, whitelisted, never accepts the EULA by itself and does not publish RCON', () => {
    const text = read('genesis', 'compose.minecraft.yaml');
    const lines = configLines('compose.minecraft.yaml').map((line) => line.trim());
    // the EULA is the operator's to accept: no default, and no literal "TRUE" in the file's settings
    const eula = lines.find((line) => line.startsWith('EULA:'));
    assert.match(eula, /^EULA: "\$\{GENESIS_MINECRAFT_EULA:\?[^}]+\}"$/);
    assert.ok(!lines.some((line) => /^EULA:\s*"?(true|TRUE)"?$/.test(line)));
    for (const line of ['TYPE: "PAPER"', 'VERSION: "1.21.6"', 'ONLINE_MODE: "FALSE"', 'ENABLE_WHITELIST: "true"', 'ENABLE_RCON: "true"',
        'ALLOW_NETHER: "false"', 'DIFFICULTY: "easy"', 'SPAWN_PROTECTION: "0"', 'SERVER_PORT: "25600"']) {
        assert.ok(lines.includes(line), `compose.minecraft.yaml: ${line}`);
    }
    const settings = JSON.parse(read('genesis', 'settings.json'));
    assert.equal(settings.minecraft_version, '1.21.6');
    assert.equal(settings.port, 25600, 'the agents connect to the port the server listens on');
    // one published port: the game, 25600 on both sides, on an address the operator must name (never every interface by default)
    const ports = lines.slice(lines.indexOf('ports:') + 1).filter((line) => line.startsWith('- ')).slice(0, 1);
    assert.equal(lines.filter((line) => /^- .*:\d+:\d+"?$/.test(line)).length, 1);
    assert.match(ports[0], /^- "\$\{GENESIS_MINECRAFT_BIND:\?[^}]+\}:25600:25600"$/);
    assert.ok(!lines.some((line) => line.startsWith('- ') && line.includes('25575')), 'RCON is published');
    // no password, seed or path is written into the file
    for (const name of ['GENESIS_RCON_PASSWORD', 'GENESIS_MINECRAFT_SEED', 'GENESIS_MINECRAFT_DATA']) {
        assert.match(text, new RegExp(`\\$\\{${name}:\\?[^}]+\\}`), `${name} must be required, without a default`);
    }
    assert.ok(!lines.some((line) => line.startsWith('WHITELIST:')), 'WHITELIST makes the image look names up online; this server is offline');
});

test('ignore files: an .env file is never committed and never copied into the agents image', () => {
    assert.match(read('.gitignore'), /^\.env$/m);
    const docker = read('.dockerignore');
    for (const line of ['.env', '**/.env', 'genesis/node_modules', 'genesis/dashboard/node_modules', 'genesis/alerter/node_modules']) {
        assert.ok(docker.split('\n').includes(line), `.dockerignore: ${line}`);
    }
});

// ---- the world file helper (genesis/tools/place_world.js) ----

test('place_world: the example moved to another spot is a valid world file, with every coordinate moved alike', async () => {
    const { moveWorld, landUsed } = await import('../tools/place_world.js');
    const { checkWorldConfig } = await import('../world/world_config.js');
    const { buildBlueprints } = await import('../catalog/blueprints.js');
    const example = JSON.parse(read('genesis', 'genesis.world.example.json'));
    const blueprints = buildBlueprints({ root: REPO_ROOT });
    assert.deepEqual(checkWorldConfig(example, { blueprints }), []);

    const d = { x: 1203, y: 7, z: -488 };
    const world = moveWorld(example, d, '-4815162342');
    assert.deepEqual(checkWorldConfig(world, { blueprints }), []);
    assert.equal(world.seed, '-4815162342');
    assert.deepEqual(world.home, [1203, 71, -488]);
    assert.deepEqual(world.border.center, [1203, -488]);
    assert.equal(world.field.y, example.field.y + 7);
    // every number that is a coordinate moved; nothing else changed
    const flat = (value, out = []) => {
        if (Array.isArray(value) && value.every((n) => typeof n === 'number')) out.push(value);
        else if (value && typeof value === 'object') for (const inner of Object.values(value)) flat(inner, out);
        return out;
    };
    const before = flat(example);
    const after = flat(world);
    assert.equal(before.length, after.length);
    before.forEach((pos, i) => {
        const want = pos.length === 3 ? [pos[0] + d.x, pos[1] + d.y, pos[2] + d.z] : [pos[0] + d.x, pos[1] + d.z];
        assert.deepEqual(after[i], want, `coordinate ${i}: ${JSON.stringify(pos)}`);
    });
    const strip = (config) => JSON.stringify(config, (key, value) => (Array.isArray(value) && value.every((n) => typeof n === 'number') ? null : value));
    assert.equal(strip({ ...world, seed: example.seed, field: { ...world.field, y: example.field.y } }), strip(example));
    assert.deepEqual(example.home, [0, 64, 0], 'the example itself was changed');
    // the land the operator has to find flat
    assert.deepEqual(landUsed(example), { min: [-34, -30], max: [45, 29] });
});
