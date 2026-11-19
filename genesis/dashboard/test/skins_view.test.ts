// The Skins view's data handling: what each card shows, the header's counts, when the upload is
// disabled, and how the preview is cut from the skin's own layout. No DOM: src/web/skins_data.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIGURE, REASON_TEXT, fileProblem, skinCards, skinCounts, skinParts, uploadGate, type SkinsAnswer, type SkinRow } from '../src/web/skins_data.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROSTER = [{ name: 'Arthur', role: 'Builder' }, { name: 'Mira', role: 'Farmer' }, { name: 'Felix', role: 'Explorer' }, { name: 'Nova', role: 'Merchant' }];
const TEXTURE = `https://textures.minecraft.net/texture/${'ab12'.repeat(16)}`;
const row = (agent: string, more: Partial<SkinRow> = {}): SkinRow => ({
    agent, width: 64, height: 64, bytes: 1200, sha256: 'c0ffee'.repeat(10) + 'abcd', variant: 'classic', set_at: '2026-11-16T14:00:00.000Z', set_by: 'Operator',
    state: 'applied', state_at: '2026-11-16T14:02:00.000Z', detail: null, message: null, texture_url: null, ...more,
});
const KEY_SET = { service_connected: true, key_set: true, key_env: 'GENESIS_MINESKIN_API_KEY', visibility: 'private' };

test('cards: one per agent of the roster, with the state, its time, who set it, the skin\'s name and the preview\'s image', () => {
    const answer: SkinsAnswer = {
        limits: { max_bytes: 65536 }, signing: KEY_SET,
        skins: [
            row('Arthur', { texture_url: TEXTURE }),
            row('Mira', { variant: 'slim', height: 32, state_at: '2026-11-16T13:47:00.000Z' }),
            row('Felix', { state: 'failed', detail: 'mineskin_rate_limited', message: 'MineSkin\'s rate limit was reached (it says to wait 7 seconds)', state_at: '2026-11-16T14:10:00.000Z' }),
            row('Herobrine'), // not on the roster: never shown
        ],
    };
    const cards = skinCards(ROSTER, answer);
    assert.deepEqual(cards.map((card) => [card.agent, card.role, card.state, card.tag]), [
        ['Arthur', 'Builder', 'applied', 'Applied'], ['Mira', 'Farmer', 'applied', 'Applied'], ['Felix', 'Explorer', 'failed', 'Failed'], ['Nova', 'Merchant', 'none', 'None'],
    ]);
    const [arthur, mira, felix, nova] = cards;
    assert.deepEqual([arthur.when_label, arthur.at, arthur.set_by, arthur.skin_name, arthur.variant, arthur.height], ['Applied', '2026-11-16T14:02:00.000Z', 'Operator', 'genesis_arthur', 'classic', 64]);
    assert.equal(arthur.image_url, '/api/skins/Arthur/image?v=c0ffeec0ffee', 'the preview is the uploaded PNG itself (the address changes with the image)');
    // after a successful signing: the address the texture lives at outside (the view labels it Public)
    assert.equal(arthur.texture_url, TEXTURE);
    assert.deepEqual([mira.variant, mira.height, mira.texture_url], ['slim', 32, null]);
    // a failed state shows the named reason, and a plain sentence for it
    assert.deepEqual([felix.when_label, felix.reason, felix.reason_text, felix.set_by], ['Failed', 'mineskin_rate_limited', 'MineSkin\'s rate limit was reached. Upload again later.', 'Operator']);
    // no skin: an empty frame, "never", nobody, and nothing to clear
    assert.deepEqual([nova.at, nova.set_by, nova.skin_name, nova.image_url, nova.reason, nova.texture_url], [null, null, null, null, null, null]);
    // the header's pills
    assert.deepEqual(skinCounts(cards), { set: 2, failed: 1 });
    assert.deepEqual(skinCounts(skinCards(ROSTER, { limits: { max_bytes: 65536 }, skins: [] })), { set: 0, failed: 0 });
    assert.deepEqual(skinCards(ROSTER, null).map((card) => card.state), ['none', 'none', 'none', 'none'], 'before the list has arrived every card is empty, not missing');
});

test('cards: a reason without a sentence of its own shows the service\'s words; a stored skin is neither applied nor failed; only Mojang\'s texture server is ever linked', () => {
    const answer: SkinsAnswer = {
        limits: { max_bytes: 65536 },
        skins: [
            row('Arthur', { state: 'failed', detail: 'some_new_reason', message: 'the service said this' }),
            row('Mira', { state: 'failed', detail: 'another_one', message: null }),
            row('Felix', { state: 'stored', state_at: '2026-11-16T14:00:00.000Z' }),
            row('Nova', { texture_url: 'javascript:alert(1)' }),
        ],
    };
    const [arthur, mira, felix, nova] = skinCards(ROSTER, answer);
    assert.deepEqual([arthur.reason, arthur.reason_text], ['some_new_reason', 'the service said this']);
    assert.deepEqual([mira.reason, mira.reason_text], ['another_one', null]);
    assert.deepEqual([felix.state, felix.tag, felix.when_label], ['stored', 'Stored', 'Stored']);
    assert.equal(nova.texture_url, null);
    for (const bad of ['http://textures.minecraft.net/texture/abcdefabcdefabcdefabcdef', 'https://textures.minecraft.net.evil.example/texture/abcdefabcdefabcdefabcdef', `${TEXTURE}/../x`]) {
        assert.equal(skinCards(ROSTER, { limits: { max_bytes: 1 }, skins: [row('Arthur', { texture_url: bad })] })[0].texture_url, null, bad);
    }
    // every reason the signer and the skin service name has its sentence
    for (const reason of ['no_api_key', 'mineskin_rate_limited', 'mineskin_timeout', 'mineskin_unreachable', 'mineskin_key_refused', 'mineskin_refused', 'mineskin_error', 'mineskin_bad_answer', 'no_rcon', 'refused']) {
        assert.ok(REASON_TEXT[reason]?.length > 10, reason);
    }
    const signer = readFileSync(path.join(here, '../../skins/mineskin.js'), 'utf8');
    const named = /export const MINESKIN_FAILURES = Object\.freeze\(\[([^\]]+)\]\)/.exec(signer)![1].match(/'[a-z_]+'/g)!.map((name) => name.slice(1, -1));
    for (const reason of named) assert.ok(REASON_TEXT[reason], `the signer's reason ${reason} has no sentence in the view`);
});

test('upload: disabled with the env key\'s name when the signing key is missing; a file is looked at before it is sent', () => {
    assert.deepEqual(uploadGate(KEY_SET), { enabled: true, note: null, key_env: null });
    assert.deepEqual(uploadGate({ ...KEY_SET, key_set: false }), { enabled: false, note: 'GENESIS_MINESKIN_API_KEY is not set', key_env: 'GENESIS_MINESKIN_API_KEY' });
    // not known (the skin service did not say): the control stays usable and the server decides
    assert.equal(uploadGate({ ...KEY_SET, key_set: null }).enabled, true);
    assert.equal(uploadGate(undefined).enabled, true);
    // a name that does not look like an env key is never shown
    assert.equal(uploadGate({ ...KEY_SET, key_set: false, key_env: '<img src=x>' }).note, 'GENESIS_MINESKIN_API_KEY is not set');
    const limits = { max_bytes: 64 * 1024 };
    assert.equal(fileProblem({ type: 'image/png', size: 1200, name: 'arthur.png' }, limits), null);
    assert.equal(fileProblem({ type: '', size: 1200, name: 'ARTHUR.PNG' }, limits), null, 'some systems give no type for a .png');
    assert.equal(fileProblem({ type: 'image/jpeg', size: 1200, name: 'arthur.jpg' }, limits), 'A PNG file is expected.');
    assert.equal(fileProblem({ type: 'image/png', size: 0, name: 'empty.png' }, limits), 'The file is empty.');
    assert.equal(fileProblem({ type: 'image/png', size: 70 * 1024, name: 'big.png' }, limits), 'The file is larger than 64 KiB.');
    assert.equal(fileProblem({ type: 'image/png', size: 70 * 1024, name: 'big.png' }, null), 'The file is larger than 64 KiB.');
});

test('preview: the front of the head, body, arms and legs is cut from the 64 by 64 layout; the old 64 by 32 layout mirrors the right limbs; slim arms are 3 wide', () => {
    assert.deepEqual({ ...FIGURE }, { width: 16, height: 32 });
    const base = (parts: ReturnType<typeof skinParts>) => parts.filter((part) => !part.overlay).map((part) => [part.part, part.sx, part.sy, part.w, part.h, part.dx, part.dy, part.mirror === true]);
    // the front faces, where the skin layout has them (the 64 by 64 format of Minecraft 1.8 and later)
    assert.deepEqual(base(skinParts(64, 'classic')), [
        ['head', 8, 8, 8, 8, 4, 0, false], ['body', 20, 20, 8, 12, 4, 8, false], ['right_arm', 44, 20, 4, 12, 0, 8, false], ['right_leg', 4, 20, 4, 12, 4, 20, false],
        ['left_arm', 36, 52, 4, 12, 12, 8, false], ['left_leg', 20, 52, 4, 12, 8, 20, false],
    ]);
    assert.deepEqual(base(skinParts(32, 'classic')).slice(4), [['left_arm', 44, 20, 4, 12, 12, 8, true], ['left_leg', 4, 20, 4, 12, 8, 20, true]]);
    assert.deepEqual(base(skinParts(64, 'slim')).filter((part) => String(part[0]).endsWith('arm')), [['right_arm', 44, 20, 3, 12, 1, 8, false], ['left_arm', 36, 52, 3, 12, 12, 8, false]]);
    // the outer layer is drawn over it: the hat in both layouts, the rest only where the 64 by 64 layout has it
    assert.deepEqual(skinParts(64, 'classic').filter((part) => part.overlay).map((part) => part.part), ['hat', 'jacket', 'right_sleeve', 'left_sleeve', 'right_trouser', 'left_trouser']);
    assert.deepEqual(skinParts(32, 'classic').filter((part) => part.overlay).map((part) => part.part), ['hat']);
    for (const [height, variant] of [[64, 'classic'], [64, 'slim'], [32, 'classic'], [32, 'slim']] as const) {
        const parts = skinParts(height, variant);
        // every source rectangle lies inside the image, every part inside the figure
        for (const part of parts) {
            assert.ok(part.sx >= 0 && part.sy >= 0 && part.sx + part.w <= 64 && part.sy + part.h <= height, `${height} ${variant} ${part.part} reads outside the image`);
            assert.ok(part.dx >= 0 && part.dy >= 0 && part.dx + part.w <= FIGURE.width && part.dy + part.h <= FIGURE.height, `${height} ${variant} ${part.part} is drawn outside the figure`);
        }
        // the base layer covers the figure without two parts on one pixel
        const covered = new Set<string>();
        for (const part of parts.filter((p) => !p.overlay)) {
            for (let x = part.dx; x < part.dx + part.w; x++) for (let y = part.dy; y < part.dy + part.h; y++) { assert.ok(!covered.has(`${x},${y}`), `${part.part} overlaps at ${x},${y}`); covered.add(`${x},${y}`); }
        }
        assert.equal(covered.size, 8 * 8 + 8 * 12 + 2 * (variant === 'slim' ? 3 : 4) * 12 + 2 * 4 * 12);
    }
});

test('the view is in the navigation, has no sample data, and never names or asks for the key itself', () => {
    const ui = readFileSync(path.join(here, '../src/web/ui.tsx'), 'utf8');
    assert.match(ui, /\{ path: '\/skins', label: 'Skins' \}/);
    assert.match(readFileSync(path.join(here, '../src/web/main.tsx'), 'utf8'), /\{path === '\/skins' && <Skins \/>\}/);
    const view = readFileSync(path.join(here, '../src/web/views/Skins.tsx'), 'utf8');
    assert.doesNotMatch(view, /Sample data/);
    assert.doesNotMatch(view, /type="(password|text)"/, 'the page has a field a key could be typed into');
    assert.match(view, /<span class="tag">Public<\/span>/);
    assert.match(view, /disabled=\{!gate\.enabled \|\| busy !== null\}/);
    assert.match(view, /\{!gate\.enabled && <p class="skin-key">\{gate\.note\}<\/p>\}/, 'the env key\'s name is not shown, whole, when the upload is disabled');
    // the upload goes to the dashboard's own endpoint, as a PNG body
    assert.match(view, /fetch\(`\/api\/skins\/\$\{encodeURIComponent\(card\.agent\)\}\?variant=\$\{variant\}`, \{ method: 'PUT', headers: \{ 'content-type': 'image\/png' \}, body: file \}\)/);
    assert.doesNotMatch(view + readFileSync(path.join(here, '../src/web/skins_data.ts'), 'utf8'), /mineskin\.org/, 'the browser is pointed at the outside service');
});
