// The Learning and Town screens' data: the fold of the learner's and the town's events, the
// HTTP endpoints, and the same endpoints over the REAL learner and town code (fed made-up
// goals and builds by scripts/fixture-host.mjs: no MindServer, no Minecraft server, no model).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/server/app.js';
import { createLive } from '../src/server/live.js';
import { applyEvent, emptyState } from '../src/shared/fold.js';
import { validateEvent } from '../src/server/contract.js';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createTownLearning, UPLOAD_LIMIT_BYTES } from '../src/server/town_learning.js';
import { tryingText } from '../src/web/format.js';
import { eventMaker, fakeClock, memoryStore } from './fakes.js';
// @ts-ignore plain JavaScript, like the code it runs
import { makeFixtureHost } from '../scripts/fixture-host.mjs';
// @ts-ignore plain JavaScript
import { buildSchematic } from '../../build/schematic.js';

const ROSTER = ['Arthur', 'Mira', 'Felix', 'Nova'];
const json = { 'content-type': 'application/json' };

function fakeLink(answers: Record<string, any> = {}) {
    const asked: { event: string; arg: any }[] = [];
    const link = {
        up: true,
        connected: () => link.up,
        emit: () => {},
        ask: async (event: string, arg: any) => { asked.push({ event, arg }); if (!(event in answers)) throw new Error(`${event} did not answer`); return typeof answers[event] === 'function' ? answers[event](arg) : answers[event]; },
    };
    return { link, asked };
}
async function appWith(link: any) {
    const live = createLive({ roster: ROSTER });
    return buildApp({ live, store: memoryStore().store, controls: null, roster: [], town_learning: link ? createTownLearning({ link }) : null });
}

function rig() {
    const make = eventMaker(fakeClock());
    const state = emptyState(ROSTER);
    const feed = (...args: Parameters<typeof make>) => {
        const event = make(...args);
        assert.deepEqual(validateEvent(event).errors, [], 'the test only feeds events the shared contract accepts');
        applyEvent(state, event);
        return event;
    };
    return { state, feed };
}

test('fold: the learner\'s and the town\'s events move a tick each and never become agent cards', () => {
    const { state, feed } = rig();
    assert.deepEqual([state.learning.tick, state.town.tick], [0, 0]);
    feed('learner', 'agent.state', { state: 'experience', detail: { id: 'x1', agent: 'Arthur', option_id: 'gather_blocks:oak_log:16', outcome: 'completed' } });
    feed('learner', 'agent.state', { state: 'learning_update', detail: { version: 3, examples: 750, frozen: false, error: 0.41, table_error: 0.44, explore_rate: 0.25 } });
    feed('town', 'agent.state', { state: 'plot_proposed', detail: { id: 'town-1' } });
    feed('town', 'agent.state', { state: 'build_verified', detail: { plot: 'arthur-1' } });
    feed('town', 'agent.state', { state: 'something_else', detail: {} });
    assert.equal(state.learning.tick, 2);
    assert.deepEqual(state.learning.summary, { version: 3, examples: 750, frozen: false, error: 0.41, table_error: 0.44, explore_rate: 0.25 });
    assert.deepEqual([state.town.tick, state.town.last], [2, 'build_verified']);
    assert.deepEqual(Object.keys(state.agents).sort(), [...ROSTER].sort(), 'no card for the learner or the town');
});

test('fold: a goal the learner chose while the model was away is marked learned, or trying when it was exploration', () => {
    const { state, feed } = rig();
    const decide = (agent: string, option: string, id: string) => {
        feed(agent, 'agent.decision', { decision_id: id, summary: option, trigger: 'routine', command: 'gather_blocks', args: [option], goal_id: `g-${id}`, call_id: null, steps: ['!collectBlocks'], steps_from: 'template' }, { corr: id });
        feed(agent, 'agent.state', { state: 'goal_started', detail: { goal_id: `g-${id}`, option_id: option, steps: 1, source: 'routine' } }, { corr: id });
    };
    feed('Mira', 'agent.state', { state: 'learned_choice', detail: { option_id: 'harvest_replant:field', explore: false } });
    decide('Mira', 'harvest_replant:field', 'd1');
    feed('Felix', 'agent.state', { state: 'learned_choice', detail: { option_id: 'gather_blocks:coal_ore:8', explore: true } });
    decide('Felix', 'gather_blocks:coal_ore:8', 'd2');
    decide('Arthur', 'craft_item:oak_planks:32', 'd3');
    assert.equal(state.agents.Mira.plan?.learned, 'learned');
    assert.equal(state.agents.Felix.plan?.learned, 'trying');
    assert.equal(state.agents.Arthur.plan?.learned, null, 'the routine\'s own pick is not marked');
    assert.equal(state.agents.Mira.learned_choice, null, 'used once');
});

test('Trying is worded from the scorer\'s rate, never typed in', () => {
    assert.equal(tryingText(0.25), '1 in 4');
    assert.equal(tryingText(0.1), '1 in 10');
    assert.equal(tryingText(0), 'Off');
    assert.equal(tryingText(null), '–');
    assert.equal(tryingText(Number.NaN), '–');
});

test('HTTP: without the MindServer the two screens say so; nothing is made up', async () => {
    const none = await appWith(null);
    for (const url of ['/api/learning', '/api/town']) assert.equal((await none.inject({ url })).statusCode, 503);
    const { link } = fakeLink();
    link.up = false;
    const down = await appWith(link);
    const answer = await down.inject({ url: '/api/learning' });
    assert.equal(answer.statusCode, 503);
    assert.equal(answer.json().error, 'mindserver_not_connected');
    link.up = true;       // connected, but learning is switched off there: nobody answers
    const silent = await down.inject({ url: '/api/town' });
    assert.equal(silent.statusCode, 502);
    assert.match(silent.json().error, /did not answer/);
});

test('HTTP: controls and operator moves are checked before anything is asked of the MindServer', async () => {
    const { link, asked } = fakeLink({
        'genesis-learning-control': (arg: any) => (arg.action === 'rollback' ? { ok: true, version: arg.v ?? 2 } : { ok: true, frozen: arg.action === 'freeze' }),
        'genesis-town-operator': (op: any) => (op.id === 'town-9' ? { ok: false, reason: 'a_build_was_started_there' } : { ok: true, id: op.id, titles: op.titles }),
    });
    const app = await appWith(link);
    const post = (url: string, body: unknown) => app.inject({ method: 'POST', url, headers: json, payload: JSON.stringify(body) });

    assert.equal((await post('/api/learning/control', { action: 'retrain' })).statusCode, 400);
    assert.equal((await post('/api/learning/control', { action: 'rollback', v: -1 })).statusCode, 400);
    assert.equal(asked.length, 0);
    assert.deepEqual((await post('/api/learning/control', { action: 'freeze' })).json(), { ok: true, frozen: true });
    assert.equal((await post('/api/learning/control', { action: 'rollback', v: 3 })).json().version, 3);
    assert.deepEqual(asked.map((a) => a.arg), [{ action: 'freeze' }, { action: 'rollback', v: 3 }]);

    asked.length = 0;
    assert.equal((await post('/api/town/proposals/town-1', { action: 'approve' })).statusCode, 400);
    assert.equal((await post('/api/town/proposals/town-1', { action: 'move', min: [1.5, 64, 2] })).statusCode, 400);
    assert.equal((await post('/api/town/proposals/town-1', { action: 'move', min: [1, 64] })).statusCode, 400);
    assert.equal((await post('/api/town/proposals/bad%20id', { action: 'remove' })).statusCode, 400);
    assert.equal(asked.length, 0);
    assert.equal((await post('/api/town/proposals/town-1', { action: 'move', min: [8, 64, -36] })).statusCode, 200);
    assert.equal((await post('/api/town/proposals/span-2', { action: 'remove' })).statusCode, 200);
    const refused = await post('/api/town/proposals/town-9', { action: 'remove' });
    assert.deepEqual([refused.statusCode, refused.json().error], [409, 'a_build_was_started_there']);
    assert.deepEqual(asked.map((a) => a.arg), [{ kind: 'move', id: 'town-1', min: [8, 64, -36] }, { kind: 'remove', id: 'span-2' }, { kind: 'remove', id: 'town-9' }]);

    asked.length = 0;
    assert.equal((await post('/api/town/goals/Arthur', { titles: [] })).statusCode, 400);
    assert.equal((await post('/api/town/goals/Arthur', { titles: ['a', 'b', 'c', 'd'] })).statusCode, 400);
    assert.equal((await post('/api/town/goals/Art hur', { titles: ['a'] })).statusCode, 400);
    assert.equal(asked.length, 0);
    assert.equal((await post('/api/town/goals/Arthur', { titles: ['Wall the village'] })).statusCode, 200);
    assert.equal((await post('/api/town/goals/Arthur', { titles: null })).statusCode, 200);
    assert.deepEqual(asked.map((a) => a.arg), [{ kind: 'goal', agent: 'Arthur', titles: ['Wall the village'] }, { kind: 'goal', agent: 'Arthur', titles: null }]);
});

test('HTTP: a prefab upload is the file as the body; its size, name and swaps are checked here', async () => {
    const { link, asked } = fakeLink({ 'genesis-prefab-import': (arg: any) => ({ ok: true, report: { buildable: true, unobtainable: {} }, prefab: { name: arg.name, tier: 1 }, saved: arg.save }) });
    const app = await appWith(link);
    const send = (query: string, payload: Buffer | string, type = 'application/octet-stream') => app.inject({ method: 'POST', url: `/api/prefabs/import?${query}`, headers: { 'content-type': type }, payload });
    const file = Buffer.from([1, 2, 3, 4]);
    assert.equal((await send('name=stall', '{}', 'application/json')).statusCode, 415);
    assert.equal((await send('name=bad%20name', file)).statusCode, 400);
    assert.equal((await send('name=stall&substitute=oak_stairs', file)).statusCode, 400);
    assert.equal((await send('name=stall', Buffer.alloc(UPLOAD_LIMIT_BYTES + 4096))).statusCode, 413);
    assert.equal(asked.length, 0);
    const looked = await send('name=stall&substitute=oak_stairs:oak_planks,stone_bricks:cobblestone', file);
    assert.equal(looked.statusCode, 200);
    assert.equal(looked.json().saved, false);
    const saved = await send('name=stall&kind=home&title=Market%20stall&save=1', file);
    assert.equal(saved.json().saved, true);
    assert.deepEqual(asked.map((a) => ({ ...a.arg })), [
        { name: 'stall', kind: 'shared', title: null, file_base64: file.toString('base64'), substitute: { oak_stairs: 'oak_planks', stone_bricks: 'cobblestone' }, save: false },
        { name: 'stall', kind: 'home', title: 'Market stall', file_base64: file.toString('base64'), substitute: {}, save: true },
    ]);
});

test('the real learner and town behind the endpoints: what the two screens show, moves, goals and an uploaded schematic', async () => {
    const host = await makeFixtureHost({ goals: 320 });
    const app = await appWith(host.link);
    const get = async (url: string) => (await app.inject({ url })).json();
    const post = (url: string, body: unknown) => app.inject({ method: 'POST', url, headers: json, payload: JSON.stringify(body) });

    // ---- Learning ----
    const learning = (await get('/api/learning')).view;
    assert.equal(learning.header.examples, 320);
    assert.equal(learning.header.trying.rate, 0.25, 'the exploration setting the scorer uses (decided: about 1 in 4)');
    assert.equal(tryingText(learning.header.trying.rate), '1 in 4');
    assert.deepEqual(learning.agents.map((a: any) => a.name), ROSTER);
    for (const agent of learning.agents) {
        assert.equal(agent.examples.own + agent.examples.from_others, 320);
        assert.ok(['In use', 'Table'].includes(agent.state));
        assert.equal(agent.calibration.length, 3);
        assert.ok(agent.calibration.reduce((n: number, row: any) => n + row.n, 0) > 0);
    }
    assert.deepEqual([learning.lessons.list, learning.plays.list], [[], []], 'lessons and plays are not built: none are shown');
    assert.ok(learning.versions.length >= 1 && learning.versions.some((v: any) => v.state === 'In use'));
    assert.equal((await post('/api/learning/control', { action: 'freeze' })).statusCode, 200);
    assert.equal((await get('/api/learning')).view.header.frozen, true);
    assert.equal((await post('/api/learning/control', { action: 'unfreeze' })).statusCode, 200);
    assert.equal((await get('/api/learning')).view.header.frozen, false);
    assert.equal((await post('/api/learning/control', { action: 'rollback', v: 0 })).json().version, 0);
    assert.equal((await get('/api/learning')).view.header.version, 0);

    // ---- Town ----
    const town = (await get('/api/town')).view;
    assert.deepEqual(town.plots.filter((p: any) => p.world).map((p: any) => p.id), ['arthur-1', 'mira-1', 'felix-1', 'nova-1', 'spare-1']);
    assert.deepEqual(town.plots.filter((p: any) => !p.world).map((p: any) => [p.id, p.kind, p.by]), [['span-1', 'bridge', 'Code'], ['span-2', 'bridge', 'Code']]);
    assert.deepEqual([town.project.title, town.project.state, town.project.plot, town.project.cells], ['Footbridge', 'Building', 'span-1', { done: 19, total: 45 }]);
    assert.deepEqual(town.project.materials.find((m: any) => m.item === 'oak_fence'), { item: 'oak_fence', need: 14, have: 8, short: 6, state: 'Short' });
    assert.equal(town.ladder.generated.list.length, 8);
    assert.deepEqual(town.homes.map((h: any) => [h.agent, h.home?.title ?? null]), [['Arthur', 'Cabin'], ['Mira', 'Lean-to'], ['Felix', 'Lean-to'], ['Nova', null]]);
    assert.equal(town.long_term.Arthur.candidates[0].pinned, true, 'Arthur\'s first long-term goal is the next rung');

    // decided: the operator can move or remove what code proposed, but not once a build stands on it
    const started = await post('/api/town/proposals/span-1', { action: 'remove' });
    assert.deepEqual([started.statusCode, started.json().error], [409, 'a_build_was_started_there']);
    const into_camp = await post('/api/town/proposals/span-2', { action: 'move', min: [0, 63, 0] });
    assert.equal(into_camp.statusCode, 409);
    assert.match(into_camp.json().error, /too_close_to_camp/);
    assert.equal((await post('/api/town/proposals/span-2', { action: 'move', min: [-20, 63, 2] })).statusCode, 200);
    const moved = (await get('/api/town')).view.plots.find((p: any) => p.id === 'span-2');
    assert.deepEqual([moved.min, moved.by], [[-20, 63, 2], 'Operator']);
    assert.equal((await post('/api/town/proposals/span-2', { action: 'remove' })).statusCode, 200);
    assert.equal((await get('/api/town')).view.plots.some((p: any) => p.id === 'span-2'), false);
    assert.equal((await post('/api/town/proposals/arthur-1', { action: 'remove' })).statusCode, 409, 'a plot of the world file is the operator\'s own: not a proposal');

    // decided: the operator can override an agent's long-term goals, and give them back
    assert.equal((await post('/api/town/goals/Mira', { titles: ['Fill the shared chest with bread'] })).statusCode, 200);
    assert.deepEqual((await get('/api/town')).view.long_term.Mira.override, ['Fill the shared chest with bread']);
    assert.equal((await post('/api/town/goals/Mira', { titles: null })).statusCode, 200);
    assert.equal((await get('/api/town')).view.long_term.Mira.override, null);
    assert.equal((await post('/api/town/goals/Herobrine', { titles: ['x'] })).statusCode, 409);

    // decided: operator prefabs arrive by upload. Looked at first, saved only when asked and when it holds.
    const P = 'minecraft:oak_planks', A = 'minecraft:air';
    const stall = Buffer.from(buildSchematic({ blocks: [[[P, P, P], [P, P, P]], [[P, A, P], [P, A, P]], [[P, P, P], [P, P, P]]] }));
    const upload = (query: string, payload: Buffer) => app.inject({ method: 'POST', url: `/api/prefabs/import?${query}`, headers: { 'content-type': 'application/octet-stream' }, payload });
    const looked = (await upload('name=stall&title=Market%20stall', stall)).json();
    assert.deepEqual([looked.ok, looked.saved, looked.prefab.cells, looked.report.buildable, looked.report.unobtainable], [true, false, 16, true, {}]);
    assert.ok(Number.isInteger(looked.prefab.tier), 'tiered by cells and footprint');
    assert.equal((await get('/api/town')).view.ladder.operator.list.length, 0, 'looking saves nothing');
    const D = 'minecraft:diamond_block';
    const rich = (await upload('name=vault', Buffer.from(buildSchematic({ blocks: [[[D, P]], [[D, P]]] })))).json();
    assert.deepEqual([rich.report.buildable, rich.report.unobtainable], [false, { diamond_block: 2 }], 'a block the agents cannot get is named');
    const swapped = (await upload('name=vault&substitute=diamond_block:cobblestone', Buffer.from(buildSchematic({ blocks: [[[D, P]], [[D, P]]] })))).json();
    assert.equal(swapped.report.buildable, true);
    assert.equal((await upload('name=lean_to', stall)).statusCode, 422, 'a name of the generated ladder is refused');
    assert.equal((await upload('name=junk', Buffer.from('not a schematic'))).statusCode, 422);
    const saved = (await upload('name=stall&title=Market%20stall&save=1', stall)).json();
    assert.equal(saved.saved, true);
    assert.ok(existsSync(path.join(host.operator_dir, 'stall.json')), 'written to the operator\'s prefab folder');
    const ladder = (await get('/api/town')).view.ladder.operator.list;
    assert.deepEqual(ladder.map((e: any) => [e.name, e.title, e.by]), [['stall', 'Market stall', 'Operator']], 'read back by the code that reads the ladder');
    host.close();
});
