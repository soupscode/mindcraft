// The one-command start (genesis/up.sh, down.sh, status.sh): everything it decides without
// Docker is in genesis/tools/stack.js and is checked here. The scripts themselves need Docker
// and a Minecraft server and are NOT run here beyond their syntax and the paths that need neither.
// Run from the repository root:  node --test genesis/tests/*.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { REPO_ROOT } from './helpers/stubs.mjs';
import { ENV_KEYS, AGENT_NAMES, MODEL_OFF, initEnvText, checkEnv, renderRuntime, doneAfter, redact, setModelLine, operatorsOf } from '../tools/stack.js';
import { checkSettings, checkProfiles, buildSettings, PLACEHOLDERS } from '../lib/config.js';

const GOOD = {
    GENESIS_MINECRAFT_EULA: 'TRUE', GENESIS_MINECRAFT_SEED: '20261116', GENESIS_MINECRAFT_BIND: '192.0.2.10', GENESIS_OPERATORS: 'TheOperator',
    GENESIS_MODEL: 'off', GENESIS_RCON_PASSWORD: 'rcon-PLACEHOLDER-0001', GENESIS_POSTGRES_PASSWORD: 'pg-PLACEHOLDER-0002', GENESIS_NTFY_TOPIC: 'genesis-PLACEHOLDER-0003',
};
const parse = (text) => Object.fromEntries(text.split('\n').filter((line) => /^[A-Z_]+=/.test(line)).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
const templates = () => ({
    settings: JSON.parse(readFileSync(path.join(REPO_ROOT, 'genesis', 'settings.json'), 'utf8')),
    profiles: Object.fromEntries(readdirSync(path.join(REPO_ROOT, 'genesis', 'profiles')).map((name) => [name, JSON.parse(readFileSync(path.join(REPO_ROOT, 'genesis', 'profiles', name), 'utf8'))])),
});

test('--init: a new env file has generated secrets, empty values for what only the operator can supply, and never an EULA value', () => {
    let n = 0;
    const text = initEnvText({ random: (bytes) => `${'ab'.repeat(bytes - 1)}${String(++n).padStart(2, '0')}` });
    const env = parse(text);
    assert.deepEqual(Object.keys(env), ENV_KEYS.map(([key]) => key), 'every key the scripts read is in the file, in order');
    // never written, never defaulted: the EULA is the operator's to accept
    assert.equal(env.GENESIS_MINECRAFT_EULA, '');
    assert.ok(!/EULA=TRUE/i.test(text));
    for (const key of ['GENESIS_MINECRAFT_SEED', 'GENESIS_MINECRAFT_BIND', 'GENESIS_OPERATORS', 'GENESIS_MODEL_URL', 'GENESIS_MODEL_NAME']) assert.equal(env[key], '', key);
    assert.deepEqual([env.GENESIS_RCON_PASSWORD.length, env.GENESIS_POSTGRES_PASSWORD.length, /^genesis-[0-9a-f]{24}$/.test(initEnvText().match(/GENESIS_NTFY_TOPIC=(.*)/)[1])], [48, 48, true]);
    assert.notEqual(env.GENESIS_RCON_PASSWORD, env.GENESIS_POSTGRES_PASSWORD);
    assert.deepEqual([env.GENESIS_MODEL, env.GENESIS_MINECRAFT_MEMORY, env.GENESIS_MINECRAFT_VIEW_DISTANCE, env.GENESIS_DASHBOARD_BIND, env.GENESIS_DASHBOARD_ALLOW], ['off', '6G', '10', '0.0.0.0', '']);
    // a fresh file is refused, with a plain list of exactly what is missing
    assert.deepEqual(checkEnv(env).map((problem) => problem.split(' ')[0]), ['GENESIS_MINECRAFT_EULA', 'GENESIS_MINECRAFT_SEED', 'GENESIS_MINECRAFT_BIND', 'GENESIS_OPERATORS']);
    assert.match(checkEnv(env)[0], /read the Minecraft EULA .* set it to TRUE yourself\. No script sets it\./);
    // no real address, name or secret in the scripts or the helper
    for (const file of ['up.sh', 'down.sh', 'status.sh', 'tools/stack.js']) {
        const source = readFileSync(path.join(REPO_ROOT, 'genesis', file), 'utf8');
        assert.ok(!/192\.168\.|10\.0\.0\.|soups|tailscale\.net/i.test(source), `${file} holds an address or a name`);
    }
});

test('the env file: complete passes; every wrong value is named without repeating a secret', () => {
    assert.deepEqual(checkEnv(GOOD), []);
    const wrong = (edit) => checkEnv({ ...GOOD, ...edit }).join('\n');
    assert.match(wrong({ GENESIS_MINECRAFT_EULA: 'true' }), /GENESIS_MINECRAFT_EULA must be exactly TRUE/);
    assert.match(wrong({ GENESIS_MINECRAFT_SEED: 'lucky' }), /GENESIS_MINECRAFT_SEED must be a whole number/);
    assert.match(wrong({ GENESIS_MINECRAFT_BIND: 'my-vm' }), /GENESIS_MINECRAFT_BIND must be an address/);
    assert.match(wrong({ GENESIS_OPERATORS: 'TheOperator, x' }), /holds "x", which is not a Minecraft name/);
    assert.match(wrong({ GENESIS_OPERATORS: 'Arthur' }), /an agent is never the operator/);
    assert.match(wrong({ GENESIS_RCON_PASSWORD: '' }), /GENESIS_RCON_PASSWORD is empty/);
    assert.match(wrong({ GENESIS_MINECRAFT_VIEW_DISTANCE: '64' }), /GENESIS_MINECRAFT_VIEW_DISTANCE must be a whole number from 2 to 32/);
    assert.match(wrong({ GENESIS_DASHBOARD_ALLOW: '192.0.2.20, desktop' }), /GENESIS_DASHBOARD_ALLOW holds "desktop"/);
    assert.match(wrong({ GENESIS_MODEL: 'maybe' }), /GENESIS_MODEL must be on or off/);
    // the model's address and name are needed only while the model is on
    assert.deepEqual(checkEnv({ ...GOOD, GENESIS_MODEL: 'on' }).map((problem) => problem.split(' ')[0]), ['GENESIS_MODEL_URL', 'GENESIS_MODEL_NAME']);
    assert.deepEqual(checkEnv({ ...GOOD, GENESIS_MODEL: 'on', GENESIS_MODEL_URL: 'http://192.0.2.50:11434', GENESIS_MODEL_NAME: 'some-model:27b' }), []);
    assert.match(wrong({ GENESIS_MODEL: 'on', GENESIS_MODEL_URL: '192.0.2.50:11434', GENESIS_MODEL_NAME: 'm' }), /GENESIS_MODEL_URL must be an http/);
    assert.ok(!checkEnv({ ...GOOD, GENESIS_MINECRAFT_SEED: '' }).join(' ').includes('PLACEHOLDER'), 'a problem repeated a secret');
    assert.deepEqual(operatorsOf({ GENESIS_OPERATORS: ' One_Name ,Two_Name,' }), ['One_Name', 'Two_Name']);
});

test('run-time files: built from the tracked templates and the env file, valid by the launcher\'s own checks, and the templates keep their placeholders', () => {
    const before = JSON.stringify(templates());
    const off = renderRuntime({ ...templates(), env: GOOD });
    assert.deepEqual(off.problems, []);
    // what the guide made the operator edit by hand
    assert.deepEqual([off.settings.host, off.settings.port, off.settings.genesis_events.enabled, off.settings.genesis_events.redis_url, off.settings.genesis_planning.enabled, off.settings.genesis_planning.operators],
        ['minecraft', 25600, true, 'redis://redis:6379', true, ['TheOperator']]);
    // model off ("stage 1"): an address nothing listens on, so the agents reach no model and run on routines
    assert.deepEqual(off.settings.genesis_planning.model, MODEL_OFF);
    assert.ok(Object.values(off.profiles).every((profile) => profile.model.url === MODEL_OFF.url && profile.embedding.url === MODEL_OFF.url));
    // model on: the env file's address and name, in the three places the placeholders stood
    const on = renderRuntime({ ...templates(), env: { ...GOOD, GENESIS_MODEL: 'on', GENESIS_MODEL_URL: 'http://192.0.2.50:11434/', GENESIS_MODEL_NAME: 'some-model:27b', GENESIS_EMBEDDING_MODEL: 'some-embedder' } });
    assert.deepEqual(on.problems, []);
    assert.deepEqual(on.settings.genesis_planning.model, { url: 'http://192.0.2.50:11434', model: 'some-model:27b' });
    assert.deepEqual([on.profiles['arthur.json'].model.url, on.profiles['arthur.json'].model.model, on.profiles['nova.json'].embedding.model, on.profiles['nova.json'].model.params.request_timeout_ms],
        ['http://192.0.2.50:11434', 'some-model:27b', 'some-embedder', 90000]);
    assert.deepEqual(on.settings.profiles, ['./genesis/profiles/arthur.json', './genesis/profiles/mira.json', './genesis/profiles/felix.json', './genesis/profiles/nova.json']);
    // no placeholder is left, the safety settings are untouched, and no secret is in the settings
    const text = JSON.stringify(on);
    for (const placeholder of [...PLACEHOLDERS, 'OPERATOR_NAME', 'REDIS_HOST']) assert.ok(!text.includes(placeholder), placeholder);
    assert.ok(!text.includes('PLACEHOLDER-000'), 'a secret of the env file got into the run-time settings');
    assert.equal(on.settings.allow_insecure_coding, false);
    for (const action of ['!newAction', '!startConversation', '!endConversation']) assert.ok(on.settings.blocked_actions.includes(action));
    assert.deepEqual(checkSettings(buildSettings(on.settings)), []);
    // written to a folder, they pass the launcher's profile check as files too
    const dir = mkdtempSync(path.join(tmpdir(), 'genesis-run-'));
    const done = spawnSync(process.execPath, [path.join(REPO_ROOT, 'genesis', 'tools', 'stack.js'), 'render', '--out', dir], { env: { ...process.env, ...GOOD }, encoding: 'utf8' });
    assert.equal(done.status, 0, done.stdout + done.stderr);
    assert.match(done.stdout, /model off, operators 1, 4 profiles/);
    const written = JSON.parse(readFileSync(path.join(dir, 'settings.json'), 'utf8'));
    assert.deepEqual(checkProfiles({ ...written, profiles: written.profiles.map((profile) => path.join(dir, 'profiles', path.basename(profile))) }, '/'), []);
    // the tracked templates were not touched: they keep their placeholders
    assert.equal(JSON.stringify(templates()), before);
    assert.ok(before.includes('DESKTOP_IP') && before.includes('GENESIS_MODEL') && before.includes('OPERATOR_NAME'));
    // an incomplete environment renders nothing usable and says why
    assert.match(renderRuntime({ ...templates(), env: { ...GOOD, GENESIS_OPERATORS: '' } }).problems.join('\n'), /genesis_planning\.operators/);
});

test('"Done (" counts only when it was logged AFTER the server\'s last start', () => {
    const log = [
        '2026-11-16T21:40:02.118273645Z [21:40:02 INFO]: Starting minecraft server version 1.21.6',
        '2026-11-16T21:40:31.902113004Z [21:40:31 INFO]: Done (28.412s)! For help, type "help"',
        '2026-11-16T21:52:10.000000001Z [21:52:10 INFO]: Stopping server',
        '2026-11-16T21:52:20.441000000Z [21:52:20 INFO]: Starting minecraft server version 1.21.6',
    ];
    // the restart was at 21:52:15: the "Done (" of the first start is still in the log and must not count
    assert.equal(doneAfter(log, '2026-11-16T21:52:15.300000000Z'), false);
    assert.equal(doneAfter([...log, '2026-11-16T21:52:44.730000000Z [21:52:44 INFO]: Done (24.1s)! For help, type "help"'], '2026-11-16T21:52:15.300000000Z'), true);
    assert.equal(doneAfter(log, '2026-11-16T21:40:00.000000000Z'), true);
    // lines that only look like it, or carry no time, never count
    assert.equal(doneAfter(['[21:52:44 INFO]: Done (24.1s)! For help, type "help"'], '2026-11-16T21:52:15Z'), false);
    assert.equal(doneAfter(['2026-11-16T21:52:44.7Z [21:52:44 INFO]: <Someone> Done (with the build)'], '2026-11-16T21:52:15Z'), false);
    assert.equal(doneAfter(log, 'not a time'), false);
    const piped = spawnSync(process.execPath, [path.join(REPO_ROOT, 'genesis', 'tools', 'stack.js'), 'done-after', '2026-11-16T21:52:15.300000000Z'], { input: log.join('\n'), encoding: 'utf8' });
    assert.equal(piped.status, 1);
});

test('the support bundle: every value of the env file is replaced by its key name', () => {
    const env = { ...GOOD, GENESIS_OPERATORS: 'TheOperator,Second_Op', GENESIS_MODEL: 'on', GENESIS_MODEL_URL: 'http://192.0.2.50:11434', GENESIS_MODEL_NAME: 'some-model:27b', GENESIS_DASHBOARD_ALLOW: '192.0.2.20', PATH: '/usr/bin' };
    const raw = [
        'RCON_PASSWORD=rcon-PLACEHOLDER-0001', 'postgres://genesis:pg-PLACEHOLDER-0002@postgres:5432/genesis', 'ntfy topic genesis-PLACEHOLDER-0003',
        'TheOperator joined the game', 'Second_Op was opped', 'listening on 192.0.2.10:25600', 'probe http://192.0.2.50:11434/api/version failed', 'model some-model:27b', 'refused 192.0.2.20', 'seed 20261116', 'PATH /usr/bin stays', 'model on',
    ].join('\n');
    const safe = redact(raw, env);
    for (const value of ['PLACEHOLDER', 'TheOperator', 'Second_Op', '192.0.2.10', '192.0.2.50', 'some-model', '192.0.2.20', '20261116']) assert.ok(!safe.includes(value), `${value} is still in the bundle`);
    assert.match(safe, /RCON_PASSWORD=<GENESIS_RCON_PASSWORD>\npostgres:\/\/genesis:<GENESIS_POSTGRES_PASSWORD>@postgres:5432\/genesis\nntfy topic <GENESIS_NTFY_TOPIC>\n<GENESIS_OPERATORS> joined the game\n<GENESIS_OPERATORS> was opped\nlistening on <GENESIS_MINECRAFT_BIND>:25600\nprobe <GENESIS_MODEL_URL>\/api\/version failed/);
    assert.match(safe, /PATH \/usr\/bin stays\nmodel on$/, 'what is not from the env file, and values too short to be told apart, stay readable');
    assert.equal(spawnSync(process.execPath, [path.join(REPO_ROOT, 'genesis', 'tools', 'stack.js'), 'redact'], { input: raw, env: { ...process.env, ...env }, encoding: 'utf8' }).stdout, safe);
});

test('--model on|off rewrites one line of the env file; the scripts parse, and refuse without Docker what they must', () => {
    assert.equal(setModelLine('A=1\nGENESIS_MODEL=off\nB=2\n', 'on'), 'A=1\nGENESIS_MODEL=on\nB=2\n');
    assert.equal(setModelLine('A=1', 'on'), 'A=1\nGENESIS_MODEL=on\n');
    assert.deepEqual(AGENT_NAMES, ['Arthur', 'Mira', 'Felix', 'Nova']);
    const dir = mkdtempSync(path.join(tmpdir(), 'genesis-up-'));
    const script = (name) => path.join(REPO_ROOT, 'genesis', name);
    for (const name of ['up.sh', 'down.sh', 'status.sh']) {
        assert.equal(spawnSync('bash', ['-n', script(name)]).status, 0, `${name} does not parse`);
        const source = readFileSync(script(name), 'utf8');
        assert.ok(!/\brm -rf? [^"$]*\/(opt|data|bots)\b|docker (volume|system) (rm|prune)|down -v|--volumes/.test(source), `${name} can delete data`);
    }
    // --init never overwrites an env file that is there
    const env_file = path.join(dir, 'env');
    writeFileSync(env_file, 'GENESIS_MINECRAFT_EULA=\n');
    const init = spawnSync('bash', [script('up.sh'), '--init', '--env-file', env_file], { encoding: 'utf8', env: { ...process.env, GENESIS_RUN_DIR: path.join(dir, 'run') } });
    assert.deepEqual([init.status, init.stdout.trim()], [1, `${env_file} is already there. Nothing was written.`]);
    assert.equal(readFileSync(env_file, 'utf8'), 'GENESIS_MINECRAFT_EULA=\n');
    // no env file: one plain line, nothing started
    const none = spawnSync('bash', [script('up.sh'), '--env-file', path.join(dir, 'missing')], { encoding: 'utf8', env: { ...process.env, GENESIS_RUN_DIR: path.join(dir, 'run') } });
    assert.deepEqual([none.status, none.stdout.trim()], [1, `${path.join(dir, 'missing')} does not exist. Run: genesis/up.sh --init`]);
    assert.equal(existsSync(path.join(dir, 'run')), false);
    assert.equal(spawnSync('bash', [script('up.sh'), '--help'], { encoding: 'utf8' }).status, 0);
    // down.sh has no flag that deletes anything
    const down = spawnSync('bash', [script('down.sh'), '--wipe', '--env-file', env_file], { encoding: 'utf8' });
    assert.deepEqual([down.status, /Nothing was stopped/.test(down.stdout)], [2, true]);
    // the steps of up.sh, in order
    assert.deepEqual([...readFileSync(script('up.sh'), 'utf8').matchAll(/^step "([^"]+)"/gm)].map((found) => found[1]), [
        'Docker', 'Env file', 'Run-time settings (no tracked file edited)', 'Docker network', 'Minecraft server (Done after this start)', 'bukkit.yml (End off, no login throttle)',
        'Whitelist and operators', 'Images', 'Site, levelling and bootstrap', 'Redis, Postgres, dashboard, alerter', 'Agents', 'Four agents in the game',
    ]);
});
