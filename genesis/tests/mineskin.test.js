// Custom skins are signed by MineSkin (decided): the server uploads the operator's PNG, once, behind the
// signer interface of the skin service. NOTHING is sent anywhere in these tests: MineSkin is a stand-in
// for fetch that records what it was asked and answers as MineSkin's documentation says it does.
// Run from the repository root:  node --test genesis/tests/*.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { crc32 } from 'node:zlib';
import path from 'node:path';
import { fakeClock, settle } from './helpers/fakes.mjs';
import { REPO_ROOT } from './helpers/stubs.mjs';
import {
    createMineSkinSigner, mineSkinFromEnv, MineSkinError, MINESKIN_API_KEY_ENV, MINESKIN_VISIBILITY_ENV, MINESKIN_ENDPOINT, MINESKIN_DEFAULTS,
    MINESKIN_FAILURES, MINESKIN_VISIBILITIES, NO_KEY_MESSAGE,
} from '../skins/mineskin.js';
import { createSkinService } from '../skins/skins.js';
import { startSkins } from '../skins/server.js';
import { validateEvent } from '../shared/events.js';
import { ENV_KEYS, initEnvText, missingEnvText, checkEnv, redact } from '../tools/stack.js';

const read = (...parts) => readFileSync(path.join(REPO_ROOT, ...parts), 'utf8');
// a made-up key for the tests: never a real one
const KEY = 'test-key-0123456789abcdef';
const TEXTURE = `http://textures.minecraft.net/texture/${'ab12'.repeat(16)}`;

function png(width = 64, height = 64) {
    const chunk = (type, data) => {
        const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
        const out = Buffer.alloc(8 + data.length + 4);
        out.writeUInt32BE(data.length, 0);
        body.copy(out, 4);
        out.writeUInt32BE(crc32(body), 8 + data.length);
        return out;
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header.set([8, 6, 0, 0, 0], 8);
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', Buffer.alloc(16, 7)), chunk('IEND', Buffer.alloc(0))]);
}

const signedAnswer = (url = TEXTURE) => ({ success: true, skin: { uuid: 'f0e1d2c3b4a5968778695a4b3c2d1e0f', name: 'genesis_arthur', visibility: 'private', texture: { data: { value: 'dmFsdWU=', signature: 'c2lnbmF0dXJl' }, url: { skin: url } } } });
// MineSkin, as a stand-in for fetch: records every request; `answers` are taken in turn.
//   { status, body, headers }   an answer        an Error   the request fails        'hang'   no answer until the request is aborted
function fakeMineSkin(...answers) {
    const requests = [];
    const fetch = async (url, init = {}) => {
        const fields = {};
        for (const [name, value] of init.body.entries()) fields[name] = typeof value === 'string' ? value : { type: value.type, bytes: Buffer.from(await value.arrayBuffer()) };
        requests.push({ url, method: init.method, headers: { ...init.headers }, fields });
        const next = answers.length > 0 ? answers.shift() : { status: 200, body: signedAnswer() };
        if (next instanceof Error) throw next;
        if (next === 'hang') return new Promise((resolve, reject) => { init.signal.addEventListener('abort', () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }))); });
        return { status: next.status, headers: { get: (name) => (next.headers ?? {})[name.toLowerCase()] ?? null }, json: async () => { if (next.body === undefined) throw new Error('not JSON'); return next.body; } };
    };
    return { fetch, requests };
}

test('mineskin: one upload, as its documentation has it: the PNG, the variant, a name and the least public visibility, with the key as a bearer token', async () => {
    assert.deepEqual([MINESKIN_ENDPOINT, MINESKIN_API_KEY_ENV, MINESKIN_VISIBILITY_ENV, MINESKIN_DEFAULTS.visibility, MINESKIN_DEFAULTS.timeout_ms],
        ['https://api.mineskin.org/v2/generate', 'GENESIS_MINESKIN_API_KEY', 'GENESIS_MINESKIN_VISIBILITY', 'private', 30000]);
    assert.deepEqual([...MINESKIN_VISIBILITIES], ['private', 'unlisted', 'public'], 'the least public comes first, and is the default');
    const service = fakeMineSkin();
    const signer = createMineSkinSigner({ api_key: KEY, fetch: service.fetch, timers: fakeClock() });
    assert.deepEqual([signer.configured(), signer.visibility()], [true, 'private']);
    const image = png();
    const signed = await signer.sign({ agent: 'Arthur', png: image, sha256: 'a'.repeat(64), variant: 'slim' });
    // what comes back: the texture's address on Mojang's texture server (as https), and nothing of the signature
    assert.deepEqual(signed, { url: TEXTURE.replace('http:', 'https:'), texture_url: TEXTURE.replace('http:', 'https:'), uuid: 'f0e1d2c3b4a5968778695a4b3c2d1e0f', visibility: 'private', signed: true });
    assert.equal(service.requests.length, 1);
    const [request] = service.requests;
    assert.deepEqual([request.url, request.method], ['https://api.mineskin.org/v2/generate', 'POST']);
    assert.deepEqual(request.headers, { Authorization: `Bearer ${KEY}`, 'User-Agent': 'genesis-skins/1.0', Accept: 'application/json' });
    assert.deepEqual(Object.keys(request.fields), ['file', 'variant', 'name', 'visibility']);
    assert.deepEqual([request.fields.file.type, request.fields.file.bytes.equals(image), request.fields.variant, request.fields.name, request.fields.visibility], ['image/png', true, 'slim', 'genesis_arthur', 'private']);
    assert.ok(request.fields.name.length <= 48);
    // the same image again: MineSkin is not asked a second time
    const again = await signer.sign({ agent: 'Arthur', png: image, sha256: 'a'.repeat(64), variant: 'slim' });
    assert.deepEqual([again.url, again.reused, service.requests.length], [signed.url, true, 1]);
    assert.deepEqual(signer.stats(), { requests: 1, signed: 1, failed: 0, reused: 1 });
    // what is asked of MineSkin's listing comes from the env file; anything else than its three words is "private"
    assert.equal(mineSkinFromEnv({ GENESIS_MINESKIN_API_KEY: KEY, GENESIS_MINESKIN_VISIBILITY: 'unlisted' }, { fetch: service.fetch }).visibility(), 'unlisted');
    assert.equal(mineSkinFromEnv({ GENESIS_MINESKIN_API_KEY: KEY, GENESIS_MINESKIN_VISIBILITY: 'everyone' }, { fetch: service.fetch }).visibility(), 'private');
    assert.equal(mineSkinFromEnv({ GENESIS_MINESKIN_API_KEY: KEY }, { fetch: service.fetch }).visibility(), 'private');
});

test('mineskin: without the key nothing is sent; every failure has its own name, is never tried again, and never holds the key', async () => {
    // no key: refused with the sentence that names the env key, and MineSkin is never contacted
    const untouched = fakeMineSkin();
    for (const env of [{}, { GENESIS_MINESKIN_API_KEY: '' }, { GENESIS_MINESKIN_API_KEY: '   ' }]) {
        const none = mineSkinFromEnv(env, { fetch: untouched.fetch });
        assert.equal(none.configured(), false);
        await assert.rejects(none.sign({ agent: 'Arthur', png: png() }), (err) => err instanceof MineSkinError && err.code === 'no_api_key' && err.message === NO_KEY_MESSAGE);
    }
    assert.match(NO_KEY_MESSAGE, /set GENESIS_MINESKIN_API_KEY in the env file/);
    assert.equal(untouched.requests.length, 0, 'something was sent without a key');

    const failing = async (answer, { timers = fakeClock(), advance = 0 } = {}) => {
        const service = fakeMineSkin(answer);
        const signer = createMineSkinSigner({ api_key: KEY, fetch: service.fetch, timers });
        const outcome = signer.sign({ agent: 'Mira', png: png(), sha256: 'b'.repeat(64) }).then(() => null, (err) => err);
        if (advance > 0) { await settle(); await timers.advance(advance); }
        const err = await outcome;
        assert.ok(err instanceof MineSkinError, 'the upload did not fail');
        assert.equal(service.requests.length, 1, `${err.code}: the request was sent again`);
        assert.ok(!err.message.includes(KEY) && !JSON.stringify(err).includes(KEY), `${err.code}: the key is in the error`);
        assert.ok(MINESKIN_FAILURES.includes(err.code), err.code);
        assert.deepEqual(signer.stats(), { requests: 1, signed: 0, failed: 1, reused: 0 });
        return err;
    };
    // 429: rate limited, with what MineSkin says about waiting; nothing waits and tries again
    const limited = await failing({ status: 429, headers: { 'retry-after': '7' }, body: { success: false, errors: [{ code: 'rate_limit', message: 'Too many requests' }] } });
    assert.deepEqual([limited.code, limited.status, limited.retry_after], ['mineskin_rate_limited', 429, 7]);
    assert.match(limited.message, /rate limit was reached \(it says to wait 7 seconds\): rate_limit: Too many requests\. Nothing is tried again by itself/);
    // the key is refused (or may not do what was asked): named, with the env key, and without the key itself even when the service repeats it
    const refused_key = await failing({ status: 401, body: { success: false, errors: [{ code: 'invalid_api_key', message: `The key ${KEY} is not valid` }] } });
    assert.deepEqual([refused_key.code, refused_key.mineskin_code], ['mineskin_key_refused', 'invalid_api_key']);
    assert.match(refused_key.message, /MineSkin refused the API key \(GENESIS_MINESKIN_API_KEY\).*The key <key> is not valid/);
    // a request MineSkin does not take (a visibility the key may not ask for, a bad image): its own code is passed on
    const refused = await failing({ status: 400, body: { success: false, errors: [{ code: 'invalid_visibility', message: 'private skins need a paid plan' }] } });
    assert.deepEqual([refused.code, refused.status, refused.mineskin_code], ['mineskin_refused', 400, 'invalid_visibility']);
    assert.equal(refused.message, 'MineSkin refused the skin: invalid_visibility: private skins need a paid plan');
    assert.equal((await failing({ status: 500, body: { success: false, errors: [{ code: 'generator_error', message: 'boom' }] } })).code, 'mineskin_error');
    assert.equal((await failing({ status: 502, body: undefined })).message, 'MineSkin failed: HTTP 502');
    // no answer in 30 seconds: given up, by name
    const slow = await failing('hang', { advance: 31 * 1000 });
    assert.deepEqual([slow.code, slow.message], ['mineskin_timeout', 'MineSkin did not answer within 30 seconds']);
    assert.equal((await failing(new Error('getaddrinfo ENOTFOUND api.mineskin.org'))).code, 'mineskin_unreachable');
    // an answer without a signed texture, or with an address that is not Mojang's texture server
    assert.equal((await failing({ status: 200, body: { success: true, skin: { texture: { data: {}, url: {} } } } })).code, 'mineskin_bad_answer');
    assert.equal((await failing({ status: 200, body: signedAnswer('https://elsewhere.example/texture/abcdefabcdefabcdefabcdef') })).code, 'mineskin_bad_answer');
    assert.equal((await failing({ status: 200, body: signedAnswer('https://textures.minecraft.net/texture/abcdefabcdefabcdefabcdef" classic; op Arthur') })).code, 'mineskin_bad_answer');
});

test('skins with MineSkin: the upload happens when the operator uploads, the texture address goes to SkinsRestorer over RCON, and every outcome is an event that says where the texture is', async () => {
    const service = fakeMineSkin({ status: 200, body: signedAnswer() }, { status: 429, headers: {}, body: { success: false, errors: [{ code: 'rate_limit', message: 'Too many requests' }] } });
    const sent = [];
    const events = [];
    const rcon = { async send(command) { sent.push(command); return 'Done.'; } };
    const skins = createSkinService({ rcon, signer: createMineSkinSigner({ api_key: KEY, fetch: service.fetch, timers: fakeClock() }), agents: ['Arthur', 'Mira'], clock: fakeClock(), emit: (type, data, opts) => events.push({ type, data, ...opts }) });
    assert.equal(service.requests.length, 0, 'MineSkin was contacted before any upload');

    const done = await skins.apply({ agent: 'Arthur', png: png() });
    const address = TEXTURE.replace('http:', 'https:');
    assert.deepEqual([done.ok, done.texture_url, done.texture_public, done.visibility_asked], [true, address, true, 'private']);
    // the documented SkinsRestorer route: a custom skin from the address MineSkin returned (no command takes a value and signature)
    assert.deepEqual(sent, [`sr createcustom genesis_arthur "${address}" classic`, 'skin set genesis_arthur Arthur']);
    const applied = events.at(-1);
    assert.deepEqual([applied.data.state, applied.data.detail.texture_url, applied.data.detail.texture_public, applied.data.detail.by], ['skin_applied', address, true, 'Operator']);
    // the agent logs in again: SkinsRestorer applies what it has; MineSkin is NOT asked again
    await skins.onLogin('Arthur');
    assert.deepEqual([sent.at(-1), service.requests.length], ['sr applyskin Arthur', 1]);

    // MineSkin's rate limit: skin_failed with that name, nothing sent to the game, nothing tried again
    const before = sent.length;
    const failed = await skins.apply({ agent: 'Mira', png: png(64, 32), variant: 'slim' });
    assert.deepEqual([failed.ok, failed.reason], [false, 'mineskin_rate_limited']);
    assert.match(failed.answer, /rate limit was reached/);
    assert.deepEqual([events.at(-1).data.state, events.at(-1).data.detail.reason, events.at(-1).severity], ['skin_failed', 'mineskin_rate_limited', 'warn']);
    assert.equal(sent.length, before, 'a command was sent to the game for a skin that was not signed');
    assert.equal(service.requests.length, 2);
    // no event, answer or statistic ever holds the key, the texture value or its signature
    const everything = JSON.stringify([events, done, failed, skins.stats()]);
    for (const secret of [KEY, 'dmFsdWU=', 'c2lnbmF0dXJl']) assert.ok(!everything.includes(secret), `${secret} got out`);

    // without the key: skin_failed "no_api_key", in words that name the env key; nothing is sent anywhere
    const untouched = fakeMineSkin();
    const out = [];
    const keyless = startSkins({ event_sink: (event) => out.push(event), agents: ['Felix'], rcon, signer: mineSkinFromEnv({}, { fetch: untouched.fetch }) });
    const handlers = new Map();
    keyless.attach({ on: (event, handler) => handlers.set(event, handler) });
    const refused = await new Promise((resolve) => handlers.get('genesis-skin-apply')({ agent: 'Felix', png_base64: png().toString('base64') }, resolve));
    assert.deepEqual([refused.ok, refused.reason], [false, 'no_api_key']);
    assert.match(refused.answer, /set GENESIS_MINESKIN_API_KEY in the env file/);
    assert.equal(untouched.requests.length, 0);
    assert.deepEqual(out.map((event) => [event.agent, event.data.state, event.data.detail.reason]), [['skins', 'skin_failed', 'no_api_key']]);
    assert.deepEqual(validateEvent(out[0]).errors, []);
    // what the dashboard is told: whether a key is set and what its env key is called. Never the key.
    const status = await new Promise((resolve) => handlers.get('genesis-skin-status')({}, resolve));
    assert.deepEqual(status, { ok: true, signer: 'mineskin', key_set: false, key_env: 'GENESIS_MINESKIN_API_KEY', visibility: 'private' });
    const keyed = startSkins({ agents: ['Felix'], rcon, signer: mineSkinFromEnv({ GENESIS_MINESKIN_API_KEY: KEY }, { fetch: untouched.fetch }) });
    const keyed_handlers = new Map();
    keyed.attach({ on: (event, handler) => keyed_handlers.set(event, handler) });
    const with_key = await new Promise((resolve) => keyed_handlers.get('genesis-skin-status')({}, resolve));
    assert.deepEqual([with_key.key_set, JSON.stringify(with_key).includes(KEY)], [true, false]);
});

test('the MineSkin key: one env key, added empty by --init, kept in the launcher\'s process only, replaced in the support bundle, never in a tracked file', () => {
    // --init: the key is there, empty, with a line that says what it is for
    const fresh = initEnvText({ random: (bytes) => 'ab'.repeat(bytes) });
    assert.match(fresh, /^# optional: the API key of MineSkin \(account\.mineskin\.org\/keys\)\. Only for custom skins: an uploaded skin is sent to MineSkin to be signed\. Empty: uploads are refused\.\nGENESIS_MINESKIN_API_KEY=$/m);
    assert.ok(ENV_KEYS.some(([key, kind]) => key === 'GENESIS_MINESKIN_API_KEY' && kind !== 'secret'), 'the key is generated, or not an env key');
    // an env file that is already there: only what it lacks is added, empty; no secret is made, no line changed
    const old = fresh.split('\n').filter((line) => !/MINESKIN/.test(line)).join('\n');
    const missing = missingEnvText(old);
    assert.deepEqual(missing.keys, ['GENESIS_MINESKIN_API_KEY']);
    assert.match(missing.text, /^# optional: the API key of MineSkin[^\n]*\nGENESIS_MINESKIN_API_KEY=\n$/);
    assert.deepEqual(missingEnvText(fresh), { keys: [], text: '' });
    assert.ok(!missingEnvText('').keys.some((key) => /PASSWORD|TOPIC/.test(key)), 'a secret would be generated into a file that exists');
    // it is optional: an env file without it is fine; the visibility, when set, is one of MineSkin's three words
    const env = Object.fromEntries(fresh.split('\n').filter((line) => /^[A-Z_]+=/.test(line)).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
    const filled = { ...env, GENESIS_MINECRAFT_EULA: 'TRUE', GENESIS_MINECRAFT_SEED: '1', GENESIS_MINECRAFT_BIND: '192.0.2.10', GENESIS_OPERATORS: 'Operator_1' };
    assert.deepEqual(checkEnv(filled), []);
    assert.deepEqual(checkEnv({ ...filled, GENESIS_MINESKIN_VISIBILITY: 'hidden' }), ['GENESIS_MINESKIN_VISIBILITY must be private, unlisted or public (empty: private)']);
    // the support bundle: the key's value is replaced by its name
    assert.equal(redact(`Authorization: Bearer ${KEY} went out`, { ...filled, GENESIS_MINESKIN_API_KEY: KEY }), 'Authorization: Bearer <GENESIS_MINESKIN_API_KEY> went out');

    // the launcher: read once, taken out of the environment before the agents' processes start, handed to the signer only
    const start = read('genesis', 'start.js');
    assert.match(start, /const mineskin_env = \{ GENESIS_MINESKIN_API_KEY: process\.env\.GENESIS_MINESKIN_API_KEY \|\| '', GENESIS_MINESKIN_VISIBILITY: process\.env\.GENESIS_MINESKIN_VISIBILITY \|\| '' \};\ndelete process\.env\.GENESIS_MINESKIN_API_KEY;/);
    assert.match(start, /signer: mineSkinFromEnv\(mineskin_env\),/);
    assert.doesNotMatch(start, /console\.[a-z]+\([^\n]*mineskin_env/);
    // compose: the agents' container gets the key from the env file; the dashboard's and the others never do
    assert.match(read('genesis', 'compose.agents.yaml'), /GENESIS_MINESKIN_API_KEY: "\$\{GENESIS_MINESKIN_API_KEY:-\}"\n[^\n]*\n\s+GENESIS_MINESKIN_VISIBILITY: "\$\{GENESIS_MINESKIN_VISIBILITY:-private\}"/);
    for (const file of ['compose.dashboard.yaml', 'compose.minecraft.yaml']) assert.doesNotMatch(read('genesis', file), /MINESKIN/, `${file} is given the MineSkin key`);
    // no tracked file holds a value for it
    for (const file of ['settings.json', 'up.sh', 'status.sh', 'down.sh', 'FIRST_RUN.md', 'compose.agents.yaml']) {
        assert.doesNotMatch(read('genesis', file), /GENESIS_MINESKIN_API_KEY=[^\s`"$)]/, `${file} holds a value for the key`);
    }
    // the only place in Genesis that names MineSkin's address is the signer (and the words about it)
    assert.doesNotMatch(read('genesis', 'skins', 'skins.js') + read('genesis', 'skins', 'server.js') + start, /api\.mineskin\.org/);
    // FIRST_RUN says the four things the operator must know
    const doc = read('genesis', 'FIRST_RUN.md');
    assert.match(doc, /\*\*A custom skin leaves your network\.\*\*/);
    assert.match(doc, /\*\*Where it goes:\*\* MineSkin uploads it to a Mojang account of its own/);
    assert.match(doc, /\*\*The texture's address is public\.\*\*/);
    assert.match(doc, /\*\*The key:\*\* make an API key at `account\.mineskin\.org\/keys`, put it into the env file as\s+`GENESIS_MINESKIN_API_KEY=`/);
});
