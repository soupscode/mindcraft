// Step 1: the Genesis configuration loads, the effective settings are the
// intended ones, and nothing in it can switch model-written code on.
//
// "Effective settings" are read from the real main.js: it is run in a child
// process with the Mindcraft runtime replaced by a recorder (see
// helpers/preload-main-stubs.mjs), so nothing connects anywhere.
// Run from the repository root:  node --test genesis/tests/*.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT, captureConsole } from './helpers/stubs.mjs';
import { buildSettings, checkProfiles, checkSettings, checkWorld, REQUIRED_BLOCKED_ACTIONS, MINDSERVER_HOSTS } from '../lib/config.js';
import { WORLD_CONFIG } from './helpers/fake-world.mjs';
import { bootstrappedWorld } from './helpers/bootstrapped.mjs';

const GENESIS = path.join(REPO_ROOT, 'genesis');
const PRELOAD = pathToFileURL(path.join(GENESIS, 'tests', 'helpers', 'preload-main-stubs.mjs')).href;
const NAMES = ['Arthur', 'Mira', 'Felix', 'Nova'];
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const genesis_settings = readJson(path.join(GENESIS, 'settings.json'));

// Runs `node <script>` with the recorder in place. `env` replaces the variables main.js reads.
function run(script, env = {}, args = []) {
    const clean_env = { ...process.env };
    for (const key of ['SETTINGS_JSON', 'INSECURE_CODING', 'PROFILES', 'BLOCKED_ACTIONS', 'MINECRAFT_PORT',
        'MINDSERVER_PORT', 'MAX_MESSAGES', 'NUM_EXAMPLES', 'LOG_ALL', 'GENESIS_SETTINGS_FILE']) {
        delete clean_env[key];
    }
    const child = spawnSync(process.execPath, ['--import', PRELOAD, script, ...args], {
        cwd: REPO_ROOT, env: { ...clean_env, ...env }, encoding: 'utf8', timeout: 30000,
    });
    const recorded = (tag) => child.stdout.split('\n')
        .filter((line) => line.startsWith(tag + ' '))
        .map((line) => JSON.parse(line.slice(tag.length + 1)));
    return {
        status: child.status, stdout: child.stdout, stderr: child.stderr,
        init: recorded('GENESIS_TEST_INIT'), agents: recorded('GENESIS_TEST_AGENT'),
        event_sinks: recorded('GENESIS_TEST_EVENT_SINK'),
    };
}

function assertGenesisSettings(settings) {
    assert.equal(settings.minecraft_version, '1.21.6');
    assert.equal(settings.host, '192.168.1.190');
    assert.equal(settings.port, 25600);
    assert.equal(settings.auth, 'offline');
    assert.equal(settings.mindserver_port, 8081);
    assert.equal(settings.mindserver_host, '0.0.0.0'); // reachable from the Docker network
    assert.equal(settings.pathfinding_no_dig, true);   // agents never dig to get somewhere
    assert.equal(settings.auto_open_ui, false);
    assert.ok(!settings.init_message, 'there must be no start-up prompt');
    assert.equal(settings.allow_insecure_coding, false);
    for (const action of REQUIRED_BLOCKED_ACTIONS) {
        assert.ok(settings.blocked_actions.includes(action), `${action} is not blocked`);
    }
    assert.deepEqual(settings.profiles.map((p) => path.basename(p)),
        ['arthur.json', 'mira.json', 'felix.json', 'nova.json']);
}

// A copy of the Genesis settings and profiles with the placeholders filled in.
function filledInCopy() {
    const dir = mkdtempSync(path.join(tmpdir(), 'genesis-config-'));
    const profiles = [];
    for (const name of NAMES) {
        const text = readFileSync(path.join(GENESIS, 'profiles', `${name.toLowerCase()}.json`), 'utf8')
            .replaceAll('DESKTOP_IP', '192.0.2.10').replaceAll('GENESIS_MODEL', 'some-model:latest');
        const file = path.join(dir, `${name.toLowerCase()}.json`);
        writeFileSync(file, text);
        profiles.push(file);
    }
    const settings_file = path.join(dir, 'settings.json');
    writeFileSync(settings_file, JSON.stringify({ ...genesis_settings, profiles }));
    return { settings_file, profiles };
}

test('main.js with the Genesis settings: effective settings are the intended ones', () => {
    const { status, stderr, init, agents } = run('main.js', { SETTINGS_JSON: JSON.stringify(genesis_settings) });
    assert.equal(status, 0, stderr);
    assert.deepEqual(init, [{ host_public: false, port: 8081, auto_open_ui: false, mindserver_host: '0.0.0.0' }]);
    assert.deepEqual(agents.map((a) => a.profile.name), NAMES);
    for (const settings of agents) assertGenesisSettings(settings);
});

test('main.js: only the exact value "true" of the environment switch enables coding', () => {
    for (const value of ['false', 'False', '0', '1', 'no', 'yes', 'TRUE', 'True', ' true', 'true ']) {
        const { status, stderr, agents } = run('main.js', { INSECURE_CODING: value });
        assert.equal(status, 0, stderr);
        assert.ok(agents.length > 0);
        for (const settings of agents) {
            assert.equal(settings.allow_insecure_coding, false, `INSECURE_CODING=${JSON.stringify(value)} switched coding on`);
        }
    }
    const { agents } = run('main.js', { INSECURE_CODING: 'true' });
    assert.ok(agents.length > 0);
    for (const settings of agents) assert.equal(settings.allow_insecure_coding, true);
});

test('launcher: refuses to start while the profiles hold placeholders', () => {
    const { status, stderr, init, agents } = run('genesis/start.js');
    assert.equal(status, 1);
    assert.match(stderr, /still holds a placeholder/);
    assert.deepEqual(init, []);
    assert.deepEqual(agents, []);
});

test('launcher: --check prints the settings and the problems without starting anything', () => {
    const { status, stdout, init, agents } = run('genesis/start.js', {}, ['--check']);
    assert.equal(status, 1); // placeholders are still in the repo's profiles
    const report = JSON.parse(stdout);
    assertGenesisSettings(report.settings);
    assert.equal(report.problems.length, 12); // 4 profiles x (model.url, model.model, embedding.url)
    assert.deepEqual(init, []);
    assert.deepEqual(agents, []);
});

test('launcher: with the placeholders filled in, starts the four agents with the Genesis settings', () => {
    const { settings_file } = filledInCopy();
    const { status, stderr, init, agents } = run('genesis/start.js', { GENESIS_SETTINGS_FILE: settings_file });
    assert.equal(status, 0, stderr);
    assert.deepEqual(init, [{ host_public: false, port: 8081, auto_open_ui: false, mindserver_host: '0.0.0.0' }]);
    assert.deepEqual(agents.map((a) => a.profile.name), NAMES);
    for (const settings of agents) {
        assertGenesisSettings(settings);
        assert.equal(settings.profile.model.url, 'http://192.0.2.10:11434');
        assert.equal(settings.profile.embedding.url, 'http://192.0.2.10:11434');
    }
});

test('launcher: coding stays off whatever the environment says', () => {
    const { settings_file } = filledInCopy();
    const { status, stderr, agents } = run('genesis/start.js', {
        GENESIS_SETTINGS_FILE: settings_file,
        INSECURE_CODING: 'true',
        SETTINGS_JSON: JSON.stringify({ allow_insecure_coding: true, blocked_actions: [], host: '10.0.0.5' }),
        BLOCKED_ACTIONS: '[]',
    });
    assert.equal(status, 0, stderr);
    assert.equal(agents.length, 4);
    for (const settings of agents) {
        assert.equal(settings.allow_insecure_coding, false);
        for (const action of REQUIRED_BLOCKED_ACTIONS) assert.ok(settings.blocked_actions.includes(action));
        assert.equal(settings.host, '10.0.0.5'); // ordinary one-off overrides still apply
    }
});

test('main.js without Genesis: upstream defaults are unchanged (MindServer on localhost, digging as before)', () => {
    const { status, stderr, init, agents } = run('main.js');
    assert.equal(status, 0, stderr);
    assert.deepEqual(init, [{ host_public: false, port: 8080, auto_open_ui: true, mindserver_host: 'localhost' }]);
    assert.ok(agents.length > 0);
    for (const settings of agents) {
        assert.equal(settings.mindserver_host, 'localhost');
        assert.equal(settings.pathfinding_no_dig, false);
    }
    // a settings override that does not mention the new settings leaves them alone
    const overridden = run('main.js', { SETTINGS_JSON: JSON.stringify({ mindserver_port: 9000 }) });
    assert.deepEqual(overridden.init, [{ host_public: false, port: 9000, auto_open_ui: true, mindserver_host: 'localhost' }]);
    for (const settings of overridden.agents) assert.equal(settings.pathfinding_no_dig, false);
});

test('launcher: no digging while walking stays on whatever the environment says', () => {
    const { settings_file } = filledInCopy();
    const { status, stderr, agents } = run('genesis/start.js', {
        GENESIS_SETTINGS_FILE: settings_file,
        SETTINGS_JSON: JSON.stringify({ pathfinding_no_dig: false }),
    });
    assert.equal(status, 0, stderr);
    assert.equal(agents.length, 4);
    for (const settings of agents) assert.equal(settings.pathfinding_no_dig, true);
});

test('buildSettings: forces no digging while walking on', () => {
    assert.equal(buildSettings({}).pathfinding_no_dig, true);
    assert.equal(buildSettings({ pathfinding_no_dig: false }).pathfinding_no_dig, true);
    assert.equal(buildSettings({}, '{"pathfinding_no_dig":false}').pathfinding_no_dig, true);
    assert.equal(buildSettings(genesis_settings, '{"pathfinding_no_dig":"no"}', 'false').pathfinding_no_dig, true);
});

test('launcher: the MindServer address can be put back to localhost, but not to one the agents cannot reach', () => {
    const { settings_file } = filledInCopy();
    const local = run('genesis/start.js', {
        GENESIS_SETTINGS_FILE: settings_file, SETTINGS_JSON: JSON.stringify({ mindserver_host: 'localhost' }),
    });
    assert.equal(local.status, 0, local.stderr);
    assert.deepEqual(local.init, [{ host_public: false, port: 8081, auto_open_ui: false, mindserver_host: 'localhost' }]);

    const elsewhere = run('genesis/start.js', {
        GENESIS_SETTINGS_FILE: settings_file, SETTINGS_JSON: JSON.stringify({ mindserver_host: '172.18.0.5' }),
    });
    assert.equal(elsewhere.status, 1);
    assert.match(elsewhere.stderr, /"mindserver_host" must be one of/);
    assert.deepEqual(elsewhere.init, []);
    assert.deepEqual(elsewhere.agents, []);
});

test('checkSettings: accepts only loopback and wildcard MindServer addresses', () => {
    for (const host of MINDSERVER_HOSTS) assert.deepEqual(checkSettings({ mindserver_host: host }), []);
    assert.deepEqual(checkSettings({}), []); // not set: upstream listens on localhost
    assert.deepEqual(checkSettings(genesis_settings), []);
    for (const host of ['172.18.0.5', 'agents', '', null, 8081, true]) {
        const problems = checkSettings({ mindserver_host: host });
        assert.equal(problems.length, 1, `accepted ${JSON.stringify(host)}`);
        assert.match(problems[0], /mindserver_host/);
    }
});

const EVENTS_ON = { enabled: true, redis_url: 'redis://192.0.2.20:6379', stream: 'genesis:events', stream_maxlen: 20000, buffer_size: 2000 };

test('checkSettings: structured events are off in the repo, and checked only when switched on', () => {
    assert.equal(genesis_settings.genesis_events.enabled, false);
    assert.deepEqual(checkSettings({ genesis_events: { enabled: false } }), []);
    assert.deepEqual(checkSettings({ genesis_events: EVENTS_ON }), []);
    assert.deepEqual(checkSettings({ genesis_events: { ...EVENTS_ON, stream_per_agent: true } }), []);

    // switching on what the repo ships must first ask for the Redis address
    const shipped_on = checkSettings({ genesis_events: { ...genesis_settings.genesis_events, enabled: true } });
    assert.equal(shipped_on.length, 1);
    assert.match(shipped_on[0], /redis_url" still holds a placeholder/);

    const bad = [
        'yes', null, [], {}, { enabled: 'true' },
        { ...EVENTS_ON, redis_url: 'http://192.0.2.20:6379' }, { ...EVENTS_ON, redis_url: '192.0.2.20:6379' },
        { ...EVENTS_ON, redis_url: undefined }, { ...EVENTS_ON, stream: '' }, { ...EVENTS_ON, stream_maxlen: 0 },
        { ...EVENTS_ON, stream_maxlen: '20000' }, { ...EVENTS_ON, buffer_size: 1 }, { ...EVENTS_ON, buffer_size: 2.5 },
        { ...EVENTS_ON, stream_per_agent: 'yes' },
    ];
    for (const genesis_events of bad) {
        const problems = checkSettings({ genesis_events });
        assert.equal(problems.length, 1, `accepted ${JSON.stringify(genesis_events)}`);
        assert.match(problems[0], /genesis_events/);
    }
});

test('launcher: events stay off by default, and the agents start whatever happens to Redis when they are on', () => {
    const { settings_file } = filledInCopy();
    const off = run('genesis/start.js', { GENESIS_SETTINGS_FILE: settings_file });
    assert.equal(off.status, 0, off.stderr);
    assert.deepEqual(off.event_sinks, []);
    for (const settings of off.agents) assert.equal(settings.genesis_events.enabled, false);

    // switched on, with no "redis" package installed and no Redis anywhere: one log line, four agents
    const on = run('genesis/start.js', { GENESIS_SETTINGS_FILE: settings_file, SETTINGS_JSON: JSON.stringify({ genesis_events: EVENTS_ON }) });
    assert.equal(on.status, 0, on.stderr);
    assert.deepEqual(on.event_sinks, [{ is_function: true }]);
    assert.equal(on.stderr.split('\n').filter((line) => line.includes('genesis_events_redis_unusable')).length, 1, on.stderr);
    assert.deepEqual(on.agents.map((a) => a.profile.name), NAMES);
    for (const settings of on.agents) assert.deepEqual(settings.genesis_events, EVENTS_ON); // the agent processes get it too

    const unfilled = run('genesis/start.js', {
        GENESIS_SETTINGS_FILE: settings_file, SETTINGS_JSON: JSON.stringify({ genesis_events: { ...EVENTS_ON, redis_url: 'redis://REDIS_HOST:6379' } }),
    });
    assert.equal(unfilled.status, 1);
    assert.match(unfilled.stderr, /redis_url" still holds a placeholder/);
    assert.deepEqual(unfilled.agents, []);
    assert.deepEqual(unfilled.event_sinks, []);
});

// ---- the Genesis decision loop (genesis_planning) ----

// 127.0.0.1:9 refuses connections at once: the broker's one probe at start-up fails without any network.
const PLANNING_ON = {
    enabled: true, operators: ['TheOperator'], world_file: './genesis/genesis.world.json', checkpoint_dir: './bots/genesis_checkpoints',
    model: { url: 'http://127.0.0.1:9', model: 'some-model:latest' }, postgres_url: '',
};

test('checkSettings: the decision loop is off in the repo, and checked only when switched on', () => {
    assert.equal(genesis_settings.genesis_planning.enabled, false, 'the repo ships with planning on, but there is no world config yet');
    assert.deepEqual(checkSettings({}), []);
    assert.deepEqual(checkSettings({ genesis_planning: { enabled: false, model: 'nonsense' } }), []);
    assert.deepEqual(checkSettings({ genesis_planning: PLANNING_ON }), []);
    assert.deepEqual(checkSettings({ genesis_planning: { ...PLANNING_ON, postgres_url: 'postgres://genesis:secret@192.0.2.30:5432/genesis' } }), []);

    // switching on what the repo ships must first ask for the model's address and name, and for the operator's name
    const shipped_on = checkSettings({ genesis_planning: { ...genesis_settings.genesis_planning, enabled: true } });
    assert.deepEqual(shipped_on.map((problem) => problem.replace(/ \(.*/, '')), [
        'settings: "genesis_planning.model.url" still holds a placeholder',
        'settings: "genesis_planning.model.model" still holds a placeholder',
        'settings: "genesis_planning.operators" still holds a placeholder',
    ]);

    const bad = [
        'yes', null, [], {}, { enabled: 'true' },
        { ...PLANNING_ON, world_file: '' }, { ...PLANNING_ON, checkpoint_dir: undefined }, { ...PLANNING_ON, model: 'llama3' },
        { ...PLANNING_ON, model: { url: 'http://127.0.0.1:9' } }, { ...PLANNING_ON, model: { url: '127.0.0.1:11434', model: 'm' } },
        { ...PLANNING_ON, postgres_url: 'mysql://db/genesis' }, { ...PLANNING_ON, postgres_url: 'postgres://POSTGRES_HOST:5432/genesis' },
        { ...PLANNING_ON, postgres_url: 5432 },
        // the operator's Minecraft username: required, and a real one
        { ...PLANNING_ON, operators: undefined }, { ...PLANNING_ON, operators: [] }, { ...PLANNING_ON, operators: 'TheOperator' },
        { ...PLANNING_ON, operators: ['OPERATOR_NAME'] }, { ...PLANNING_ON, operators: ['no spaces allowed'] }, { ...PLANNING_ON, operators: ['ab'] },
        { ...PLANNING_ON, manifest_file: '' }, { ...PLANNING_ON, ledger_file: 7 },
    ];
    for (const genesis_planning of bad) {
        const problems = checkSettings({ genesis_planning });
        assert.equal(problems.length, 1, `accepted ${JSON.stringify(genesis_planning)}: ${JSON.stringify(problems)}`);
        assert.match(problems[0], /genesis_planning/);
    }
});

test('checkWorld: with planning on, the world config must exist, be valid, and know every agent with its decided range', () => {
    const { profiles } = filledInCopy();
    const dir = path.dirname(profiles[0]);
    const world_file = path.join(dir, 'genesis.world.json');
    const settings = { profiles, genesis_planning: { ...PLANNING_ON, world_file } };

    assert.deepEqual(checkWorld({ profiles }, REPO_ROOT), [], 'no planning: the world file is not looked at');
    assert.deepEqual(checkWorld({ profiles, genesis_planning: { ...PLANNING_ON, enabled: false, world_file } }, REPO_ROOT), []);
    assert.match(checkWorld(settings, REPO_ROOT)[0], /the world config cannot be read as JSON \(the file does not exist\)/);

    writeFileSync(world_file, JSON.stringify(WORLD_CONFIG));
    assert.deepEqual(checkWorld(settings, REPO_ROOT), []);

    writeFileSync(world_file, '{ "v": 1, ');
    assert.match(checkWorld(settings, REPO_ROOT)[0], /cannot be read as JSON/);
    writeFileSync(world_file, JSON.stringify({ ...WORLD_CONFIG, camp: undefined }));
    assert.match(checkWorld(settings, REPO_ROOT)[0], /genesis\.world\.json: camp must be/);
    // an agent without a home, and a range that is not the decided one
    const agents = { ...WORLD_CONFIG.agents, Arthur: { home: [0, 64, 0], range: 100 } };
    delete agents.Nova;
    writeFileSync(world_file, JSON.stringify({ ...WORLD_CONFIG, agents }));
    assert.deepEqual(checkWorld(settings, REPO_ROOT).map((problem) => problem.slice(problem.indexOf('genesis.world.json: ') + 20)), [
        'agents.Arthur.range is 100, the routine "Site upkeep" was decided for 48 blocks',
        'agents.Nova is missing (home and range)',
    ]);
});

test('launcher: planning stays off by default; switched on it needs the world config and its bootstrap, then starts the broker and the agents', async () => {
    const { settings_file, profiles } = filledInCopy();
    const sockets = (result) => result.stdout.split('\n').filter((line) => line.startsWith('GENESIS_TEST_SOCKET_EXTENSION '));
    const off = run('genesis/start.js', { GENESIS_SETTINGS_FILE: settings_file });
    assert.equal(off.status, 0, off.stderr);
    assert.deepEqual(sockets(off), []);
    for (const settings of off.agents) assert.equal(settings.genesis_planning.enabled, false);

    // on, but the world config does not exist yet: nothing starts
    const dir = path.dirname(profiles[0]);
    const world_file = path.join(dir, 'genesis.world.json');
    const manifest_file = path.join(dir, 'genesis_world', 'bootstrap.manifest.json');
    const on = { genesis_planning: { ...PLANNING_ON, world_file, manifest_file } };
    const no_world = run('genesis/start.js', { GENESIS_SETTINGS_FILE: settings_file, SETTINGS_JSON: JSON.stringify(on) });
    assert.equal(no_world.status, 1);
    assert.match(no_world.stderr, /genesis\.world\.json: the world config cannot be read as JSON \(the file does not exist\)/);
    assert.deepEqual(no_world.agents, []);
    assert.deepEqual(sockets(no_world), []);

    // with the world file and its bootstrap manifest: the planner host is added to the MindServer
    // before any agent is created, and every agent gets the setting
    // (the refusals without a matching manifest are in world.test.js)
    await bootstrappedWorld(dir);
    const started = run('genesis/start.js', { GENESIS_SETTINGS_FILE: settings_file, SETTINGS_JSON: JSON.stringify(on) });
    assert.equal(started.status, 0, started.stderr);
    assert.deepEqual(sockets(started), ['GENESIS_TEST_SOCKET_EXTENSION {"is_function":true}']);
    assert.ok(started.stdout.indexOf('GENESIS_TEST_SOCKET_EXTENSION') < started.stdout.indexOf('GENESIS_TEST_AGENT'));
    assert.deepEqual(started.agents.map((a) => a.profile.name), NAMES);
    for (const settings of started.agents) {
        assert.deepEqual(settings.genesis_planning, on.genesis_planning);
        assert.equal(settings.allow_insecure_coding, false);
        assert.equal(settings.pathfinding_no_dig, true);
        for (const action of REQUIRED_BLOCKED_ACTIONS) assert.ok(settings.blocked_actions.includes(action));
    }

    // a database that is configured but whose client package is not installed: one log line, and everything still starts
    const with_db = { genesis_planning: { ...on.genesis_planning, postgres_url: 'postgres://genesis@192.0.2.30:5432/genesis' } };
    const no_pg = run('genesis/start.js', { GENESIS_SETTINGS_FILE: settings_file, SETTINGS_JSON: JSON.stringify(with_db) });
    assert.equal(no_pg.status, 0, no_pg.stderr);
    assert.equal(no_pg.stderr.split('\n').filter((line) => line.includes('genesis_planning_no_database')).length, 1, no_pg.stderr);
    assert.deepEqual(no_pg.agents.map((a) => a.profile.name), NAMES);
});

test('packages: genesis/package.json lists the clients the adapters import, and the image installs them', () => {
    const pkg = readJson(path.join(GENESIS, 'package.json'));
    assert.equal(pkg.type, 'module');
    assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['pg', 'redis']);
    const adapters = ['pg_stores.js', 'redis_stream.js'].map((file) => readFileSync(path.join(GENESIS, 'adapters', file), 'utf8')).join('\n');
    for (const name of Object.keys(pkg.dependencies)) assert.match(adapters, new RegExp(`import\\('${name}'\\)`), `${name} is listed but not imported`);
    const root = readJson(path.join(REPO_ROOT, 'package.json'));
    for (const name of Object.keys(pkg.dependencies)) assert.equal(root.dependencies[name], undefined, 'the root package.json was changed');
    const dockerfile = readFileSync(path.join(GENESIS, 'Dockerfile'), 'utf8');
    // installed with npm ci from the committed lockfiles (decided), on the Node 22 image (decided)
    assert.match(dockerfile, /COPY genesis\/package\.json genesis\/package-lock\.json \.\/genesis\/\nRUN npm ci --prefix genesis/);
    assert.ok(dockerfile.indexOf('npm ci --prefix genesis') < dockerfile.indexOf('COPY . .'));
    assert.match(dockerfile, /^FROM node:22-/m);
    assert.doesNotMatch(dockerfile, /npm install/, 'an npm install in the image ignores the lockfile');
    for (const lock of [path.join(REPO_ROOT, 'package-lock.json'), path.join(GENESIS, 'package-lock.json')]) {
        assert.ok(readFileSync(lock, 'utf8').length > 0, `${lock} is not committed`);
    }
    assert.equal(readJson(path.join(REPO_ROOT, 'package-lock.json')).packages['node_modules/mineflayer'].version, readJson(path.join(REPO_ROOT, 'package.json')).dependencies.mineflayer);
    assert.match(readFileSync(path.join(REPO_ROOT, '.dockerignore'), 'utf8'), /^genesis\/node_modules$/m);
});

test('compose file: the MindServer port is not published, and the comment says how the dashboard reaches it', () => {
    const text = readFileSync(path.join(GENESIS, 'compose.agents.yaml'), 'utf8');
    const config_lines = text.split('\n').filter((line) => !line.trim().startsWith('#'));
    for (const key of ['ports:', 'expose:', 'network_mode:']) {
        assert.ok(!config_lines.some((line) => line.trim().startsWith(key)), `compose file has "${key}"`);
    }
    assert.match(text, /# .*http:\/\/agents:8081/);
    assert.equal(genesis_settings.mindserver_host, '0.0.0.0');
    assert.equal(genesis_settings.mindserver_port, 8081);
});

test('buildSettings: forces coding off and keeps the required actions blocked', () => {
    const built = buildSettings({ allow_insecure_coding: true, blocked_actions: ['!stay'] }, undefined);
    assert.equal(built.allow_insecure_coding, false);
    assert.deepEqual(built.blocked_actions, ['!stay', ...REQUIRED_BLOCKED_ACTIONS]);
    assert.equal(buildSettings({}, '{"allow_insecure_coding":true}').allow_insecure_coding, false);
});

test('checkProfiles: rejects the short string forms that fall back to localhost', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'genesis-config-'));
    const file = path.join(dir, 'short.json');
    writeFileSync(file, JSON.stringify({ name: 'Short', model: 'ollama/some-model', embedding: 'ollama' }));
    const problems = checkProfiles({ profiles: [file] }, REPO_ROOT);
    assert.equal(problems.length, 2);
    assert.match(problems[0], /"model" must be an object/);
    assert.match(problems[1], /"embedding" must be an object/);
    assert.deepEqual(checkProfiles({ profiles: filledInCopy().profiles }, REPO_ROOT), []);
});

test('profiles: object-form Ollama model and embedding with the same explicit url, and a personality', () => {
    const default_prompt = readJson(path.join(REPO_ROOT, 'profiles', 'defaults', '_default.json')).conversing;
    const traits = {
        Arthur: [/ambitious/, /impatient/, /builder/],
        Mira: [/cooperative/, /cautious/, /farmer/],
        Felix: [/curious/, /risk/, /explorer/],
        Nova: [/strategic/, /competitive/, /merchant/],
    };
    for (const name of NAMES) {
        const profile = readJson(path.join(GENESIS, 'profiles', `${name.toLowerCase()}.json`));
        assert.equal(profile.name, name);
        assert.match(profile.name, /^[a-zA-Z0-9_]{3,16}$/); // upstream's rule for agent names
        assert.deepEqual(
            { api: profile.model.api, url: profile.model.url, model: profile.model.model },
            { api: 'ollama', url: 'http://DESKTOP_IP:11434', model: 'GENESIS_MODEL' },
        );
        assert.equal(typeof profile.embedding, 'object');
        assert.equal(profile.embedding.api, 'ollama');
        assert.equal(profile.embedding.url, profile.model.url);
        assert.ok(profile.embedding.model);
        for (const trait of traits[name]) assert.match(profile.conversing, trait);
        // every placeholder upstream's default prompt fills in must still be there
        for (const placeholder of default_prompt.match(/\$[A-Z_]+/g)) {
            assert.ok(profile.conversing.includes(placeholder), `${name}: prompt lost ${placeholder}`);
        }
    }
});

test('profiles: upstream builds Ollama clients that point at the profile url, not localhost', async () => {
    const { result } = await captureConsole(async () => {
        const { selectAPI, createModel } = await import('../../src/models/_model_map.js');
        const { Ollama } = await import('../../src/models/ollama.js');
        const built = [];
        for (const name of NAMES) {
            const profile = readJson(path.join(GENESIS, 'profiles', `${name.toLowerCase()}.json`));
            for (const key of ['model', 'embedding']) {
                const client = createModel(selectAPI(profile[key]));
                assert.ok(client instanceof Ollama);
                built.push({ name, key, url: client.url, model: client.model_name, timeout_ms: client.timeout_ms });
            }
        }
        return built;
    });
    assert.equal(result.length, 8);
    for (const client of result) {
        assert.equal(client.url, 'http://DESKTOP_IP:11434');
        assert.ok(client.model, `${client.name} ${client.key}: model name was dropped`);
        assert.equal(client.timeout_ms, 90000);
    }
});

test('no Genesis config file sets the environment switch for coding', () => {
    const files = ['Dockerfile', 'compose.agents.yaml', 'settings.json',
        ...readdirSync(path.join(GENESIS, 'profiles')).map((f) => path.join('profiles', f))];
    for (const file of files) {
        const text = readFileSync(path.join(GENESIS, file), 'utf8');
        assert.ok(!text.includes('INSECURE_CODING'), `${file} mentions the coding switch`);
        assert.ok(!/allow_insecure_coding"?\s*[:=]\s*true/.test(text), `${file} enables coding`);
    }
    assert.equal(genesis_settings.allow_insecure_coding, false);
});
