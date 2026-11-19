// The agents' skins: the PNG check, the store, the three endpoints, and what is handed to the
// skin service. No Minecraft server, no outside service: the MindServer link is a stand-in.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';
import { buildApp } from '../src/server/app.js';
import { createLive } from '../src/server/live.js';
import { createSkins, SKIN_LIMITS } from '../src/server/skins.js';
import { fakeClock, memoryStore } from './fakes.js';

// A PNG file of the given size: a real signature, a real IHDR with its checksum, one data chunk, IEND.
export function png(width = 64, height = 64, extra = 0): Buffer {
    const chunk = (type: string, data: Buffer) => {
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
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', Buffer.alloc(16 + extra, 7)), chunk('IEND', Buffer.alloc(0))]);
}

const KEY_SET = { ok: true, signer: 'mineskin', key_set: true, key_env: 'GENESIS_MINESKIN_API_KEY', visibility: 'private' };
const TEXTURE = `https://textures.minecraft.net/texture/${'ab12'.repeat(16)}`;

// The MindServer link is a stand-in: `answer` is the skin service's answer to an upload, `status` its answer to
// "can a skin be signed?" (whether the MineSkin API key is set: never the key).
function rig({ connected = true, status = KEY_SET as any, answer = (message: any) => ({ ok: true, agent: message.agent, skin_name: `genesis_${message.agent.toLowerCase()}` }) as any } = {}) {
    const clock = fakeClock();
    const pg = memoryStore();
    const asked: [string, any][] = [];
    const emitted: [string, any][] = [];
    const link = {
        connected: () => connected,
        emit: (event: string, arg: any) => { emitted.push([event, arg]); },
        ask: async (event: string, arg: any) => {
            if (event === 'genesis-skin-status') { if (status instanceof Error) throw status; return status; }
            asked.push([event, arg]);
            return answer(arg);
        },
    };
    const roster = ['Arthur', 'Mira', 'Felix', 'Nova'].map((name) => ({ name, role: '' }));
    const skins = createSkins({ store: pg.store, link, roster, clock });
    return { clock, pg, asked, emitted, skins, roster };
}

test('a skin must be a real 64x64 or 64x32 PNG within the size cap; anything else is refused with a plain reason', async () => {
    const { skins, pg, asked } = rig();
    assert.equal(SKIN_LIMITS.max_bytes, 64 * 1024);
    const refused = async (body: unknown) => { const result = await skins.upload('Arthur', body); return result.ok ? 'accepted' : `${result.status} ${result.error}`; };
    assert.equal(await refused(Buffer.from('<html>not an image</html>'.repeat(4))), '400 this is not a PNG file');
    assert.equal(await refused(Buffer.alloc(0)), '400 a PNG image is expected as the body');
    assert.equal(await refused('text'), '400 a PNG image is expected as the body');
    assert.equal(await refused(png(128, 128)), '400 a skin is 64 by 64 or 64 by 32 pixels');
    assert.equal(await refused(png(64, 64, 70 * 1024)), `413 the image is larger than ${64 * 1024} bytes`);
    const bad_sum = png(); bad_sum[30] ^= 0xff;
    assert.equal(await refused(bad_sum), '400 the PNG file is damaged');
    assert.equal(await refused(png().subarray(0, 60)), '400 the PNG file is damaged');
    assert.deepEqual(await skins.upload('Herobrine', png()), { ok: false, status: 404, error: 'unknown agent' });
    assert.deepEqual(await skins.upload('Arthur', png(), 'wide'), { ok: false, status: 400, error: 'the variant must be classic or slim' });
    assert.equal(pg.skin_rows.size, 0, 'something that was refused was stored');
    assert.deepEqual(asked, [], 'something that was refused was handed to the skin service');
    assert.equal((await skins.upload('Arthur', png(64, 32))).ok, true, 'the old 64 by 32 layout is a skin too');
});

test('an upload is stored per agent (the image, when, by whom: always Operator), handed to the skin service, and its outcome kept', async () => {
    const { skins, pg, asked, clock } = rig();
    const image = png();
    const result = await skins.upload('Mira', image, 'slim');
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual([result.applied, result.reason], [true, null]);
    assert.deepEqual({ ...result.skin, sha256: result.skin!.sha256.length }, {
        agent: 'Mira', width: 64, height: 64, bytes: image.length, sha256: 64, variant: 'slim',
        set_at: new Date(clock.now()).toISOString(), set_by: 'Operator', state: 'applied', state_at: new Date(clock.now()).toISOString(), detail: null,
        message: null, texture_url: null,
    });
    assert.ok(!('png' in result.skin!), 'the list carries the image');
    assert.deepEqual(asked, [['genesis-skin-apply', { agent: 'Mira', png_base64: image.toString('base64'), variant: 'slim' }]]);
    assert.ok((await skins.image('Mira'))!.equals(image));
    assert.deepEqual((await skins.list()).map((skin) => [skin.agent, skin.state]), [['Mira', 'applied']]);
    assert.equal(pg.skin_rows.get('Mira').set_by, 'Operator');
    // clearing removes the image and asks the service to take the skin off
    const cleared = await skins.clear('Mira');
    assert.deepEqual([cleared.ok, asked.at(-1)], [true, ['genesis-skin-clear', { agent: 'Mira' }]]);
    assert.equal(await skins.image('Mira'), null);
    assert.deepEqual(await skins.clear('Mira'), { ok: false, status: 404, error: 'no skin is set for this agent' });
});

test('a skin the service could not apply stays stored, marked failed with the service\'s reason; a MindServer that is away is a reason too', async () => {
    const no_signer = rig({ answer: () => ({ ok: false, reason: 'no_signer' }) });
    const result = await no_signer.skins.upload('Felix', png());
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual([result.applied, result.reason, result.skin?.state, result.skin?.detail], [false, 'no_signer', 'failed', 'no_signer']);
    const away = rig({ connected: false });
    const later = await away.skins.upload('Nova', png());
    if (later.ok) assert.deepEqual([later.applied, later.reason, later.skin?.state], [false, 'mindserver_not_connected', 'failed']);
    assert.deepEqual(away.asked, []);
    assert.equal(away.pg.skin_rows.has('Nova'), true, 'the image was lost because the MindServer was away');
    // after a start the service is told what is stored (it applies a skin again when its agent logs in)
    const told = rig();
    await told.skins.upload('Arthur', png());
    assert.equal(await told.skins.announce(), 1);
    assert.equal(told.emitted[0][0], 'genesis-skin-known');
    assert.deepEqual(Object.keys(told.emitted[0][1]), ['agent', 'sha256']);
});

test('signing: without the MineSkin API key an upload is refused with a sentence that names the env key, and nothing is stored or sent', async () => {
    const no_key = rig({ status: { ...KEY_SET, key_set: false } });
    assert.deepEqual(await no_key.skins.signing(), { service_connected: true, key_set: false, key_env: 'GENESIS_MINESKIN_API_KEY', visibility: 'private' });
    const refused = await no_key.skins.upload('Arthur', png());
    assert.deepEqual(refused, {
        ok: false, status: 409,
        error: 'Custom skins are signed by MineSkin and need its API key: set GENESIS_MINESKIN_API_KEY in the env file, then run genesis/up.sh. Nothing was stored or sent.',
    });
    assert.equal(no_key.pg.skin_rows.size, 0, 'the image was stored although it cannot be signed');
    assert.deepEqual(no_key.asked, [], 'the image was handed on although it cannot be signed');
    // over HTTP: 409 with the same sentence; the list says the key is missing and names it; the key itself is never there
    const app = await buildApp({ live: createLive({ roster: no_key.roster.map((agent) => agent.name) }), store: no_key.pg.store, controls: null, skins: no_key.skins, roster: no_key.roster });
    const put = await app.inject({ method: 'PUT', url: '/api/skins/Arthur', headers: { 'content-type': 'image/png' }, payload: png() });
    assert.deepEqual([put.statusCode, put.json().ok], [409, false]);
    assert.match(put.json().error, /set GENESIS_MINESKIN_API_KEY in the env file/);
    const list = (await app.inject({ url: '/api/skins' })).json();
    assert.deepEqual(list.signing, { service_connected: true, key_set: false, key_env: 'GENESIS_MINESKIN_API_KEY', visibility: 'private' });
    assert.deepEqual(Object.keys(list).sort(), ['limits', 'signing', 'skins']);
    await app.close();
    // a skin service that does not say (an older one, or one that is away): not known, and the upload goes on as before
    const silent = rig({ status: new Error('the MindServer did not answer') });
    assert.deepEqual(await silent.skins.signing(), { service_connected: true, key_set: null, key_env: 'GENESIS_MINESKIN_API_KEY', visibility: null });
    assert.equal((await silent.skins.upload('Arthur', png())).ok, true);
    assert.deepEqual(await rig({ connected: false }).skins.signing(), { service_connected: false, key_set: null, key_env: 'GENESIS_MINESKIN_API_KEY', visibility: null });
    // what the service says its key is called is only believed when it looks like the name of an env key
    assert.equal((await rig({ status: { ...KEY_SET, key_env: '<script>' } }).skins.signing()).key_env, 'GENESIS_MINESKIN_API_KEY');
});

test('signing: the address the texture lives at outside is kept with the skin; a failed signing keeps its named reason and the service\'s words', async () => {
    const signed = rig({ answer: (message: any) => ({ ok: true, agent: message.agent, texture_url: TEXTURE, texture_public: true, visibility_asked: 'private' }) });
    const done = await signed.skins.upload('Mira', png());
    assert.equal(done.ok, true);
    if (done.ok) assert.deepEqual([done.applied, done.skin?.state, done.skin?.texture_url, done.skin?.detail, done.skin?.message], [true, 'applied', TEXTURE, null, null]);
    assert.equal((await signed.skins.list())[0].texture_url, TEXTURE);
    // only an address on Mojang's texture server is ever kept (it is shown as a link)
    for (const bad of ['javascript:alert(1)', 'https://elsewhere.example/texture/abc', `${TEXTURE}?x=1`, 'http://textures.minecraft.net/texture/abcdef0123456789abcdef']) {
        const odd = rig({ answer: (message: any) => ({ ok: true, agent: message.agent, texture_url: bad }) });
        const result = await odd.skins.upload('Mira', png());
        if (result.ok) assert.equal(result.skin?.texture_url, null, bad);
    }
    // MineSkin's rate limit: the reason by name, the service's sentence beside it; nothing is asked a second time
    const limited = rig({ answer: () => ({ ok: false, reason: 'mineskin_rate_limited', answer: "MineSkin's rate limit was reached (it says to wait 7 seconds): rate_limit: Too many requests. Nothing is tried again by itself: upload the skin again later" }) });
    const failed = await limited.skins.upload('Felix', png());
    assert.equal(failed.ok, true);
    if (failed.ok) {
        assert.deepEqual([failed.applied, failed.reason, failed.skin?.state, failed.skin?.detail, failed.skin?.texture_url], [false, 'mineskin_rate_limited', 'failed', 'mineskin_rate_limited', null]);
        assert.match(String(failed.skin?.message), /rate limit was reached \(it says to wait 7 seconds\)/);
    }
    assert.equal(limited.asked.length, 1, 'the upload was tried again by itself');
    // a new upload for the same agent starts clean
    const again = rig({ answer: (message: any) => ({ ok: true, agent: message.agent }) });
    again.pg.skin_rows.set('Felix', { agent: 'Felix', png: png(), state: 'failed', detail: 'mineskin_timeout', message: 'old words', texture_url: TEXTURE });
    const fresh = await again.skins.upload('Felix', png());
    if (fresh.ok) assert.deepEqual([fresh.skin?.state, fresh.skin?.detail, fresh.skin?.message, fresh.skin?.texture_url], ['applied', null, null, null]);
});

test('HTTP: PUT a PNG, list, fetch the image, DELETE; only image/png bodies are taken', async () => {
    const { skins, pg, roster } = rig();
    const app = await buildApp({ live: createLive({ roster: roster.map((agent) => agent.name) }), store: pg.store, controls: null, skins, roster });
    const image = png();
    const put = await app.inject({ method: 'PUT', url: '/api/skins/Arthur', headers: { 'content-type': 'image/png' }, payload: image });
    assert.equal(put.statusCode, 200, put.body);
    assert.deepEqual([put.json().ok, put.json().applied, put.json().skin.agent, put.json().skin.set_by], [true, true, 'Arthur', 'Operator']);
    const list = (await app.inject({ url: '/api/skins' })).json();
    assert.deepEqual([list.limits.max_bytes, list.skins.length, list.skins[0].state, 'png' in list.skins[0]], [64 * 1024, 1, 'applied', false]);
    const got = await app.inject({ url: '/api/skins/Arthur/image' });
    assert.deepEqual([got.statusCode, got.headers['content-type']], [200, 'image/png']);
    assert.ok(got.rawPayload.equals(image));
    assert.equal((await app.inject({ url: '/api/skins/Mira/image' })).statusCode, 404);
    assert.equal((await app.inject({ method: 'PUT', url: '/api/skins/Arthur', headers: { 'content-type': 'application/json' }, payload: '{}' })).statusCode, 415);
    assert.equal((await app.inject({ method: 'PUT', url: '/api/skins/Arthur', headers: { 'content-type': 'image/png' }, payload: Buffer.from('nope, not a picture at all, just words') })).statusCode, 400);
    assert.equal((await app.inject({ method: 'PUT', url: '/api/skins/Arthur', headers: { 'content-type': 'image/png' }, payload: png(64, 64, 70 * 1024) })).statusCode, 413);
    assert.equal((await app.inject({ method: 'PUT', url: '/api/skins/Stranger', headers: { 'content-type': 'image/png' }, payload: image })).statusCode, 404);
    // a page of another site cannot use it from the operator's browser
    assert.equal((await app.inject({ method: 'DELETE', url: '/api/skins/Arthur', headers: { origin: 'https://elsewhere.example', host: 'dashboard.local' } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'DELETE', url: '/api/skins/Arthur' })).statusCode, 200);
    assert.equal((await app.inject({ method: 'DELETE', url: '/api/skins/Arthur' })).statusCode, 404);
    await app.close();
});

test('the allow-list: with one, only the listed addresses and this machine itself are answered', async () => {
    const { skins, pg, roster } = rig();
    const live = createLive({ roster: roster.map((agent) => agent.name) });
    const open = await buildApp({ live, store: pg.store, controls: null, skins, roster });
    assert.equal((await open.inject({ url: '/api/health', remoteAddress: '198.51.100.7' })).statusCode, 200, 'without a list whoever reaches the port is answered');
    await open.close();
    const app = await buildApp({ live, store: pg.store, controls: null, skins, roster, allow: ['192.0.2.20'] });
    assert.equal((await app.inject({ url: '/api/health', remoteAddress: '192.0.2.20' })).statusCode, 200);
    assert.equal((await app.inject({ url: '/api/health', remoteAddress: '::ffff:192.0.2.20' })).statusCode, 200);
    assert.equal((await app.inject({ url: '/api/health', remoteAddress: '127.0.0.1' })).statusCode, 200);
    const refused = await app.inject({ method: 'PUT', url: '/api/skins/Arthur', headers: { 'content-type': 'image/png' }, payload: png(), remoteAddress: '198.51.100.7' });
    assert.deepEqual([refused.statusCode, refused.json().error], [403, "this address is not on the dashboard's allow-list (seen: 198.51.100.7)"]);
    await app.close();
});
