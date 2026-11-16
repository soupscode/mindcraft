import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createControls, namesNewAction, originOf, type MindLink } from '../src/server/controls.js';
import { createLive } from '../src/server/live.js';
import { buildApp } from '../src/server/app.js';
import { fakeClock, memoryStore } from './fakes.js';

const SETTINGS = {
    profile: { name: 'Felix' }, narrate_behavior: true, chat_ingame: true, log_all_prompts: false, max_messages: 15,
    allow_insecure_coding: false, blocked_actions: ['!newAction', '!startConversation'], host: 'mc', port: 25600,
};

function rig({ connected = true } = {}) {
    const clock = fakeClock();
    const pg = memoryStore();
    const live = createLive({ roster: ['Arthur', 'Mira', 'Felix', 'Nova'] });
    const sent: any[][] = [];
    const link: MindLink = {
        connected: () => connected,
        emit: (event, ...args) => { sent.push([event, ...args]); },
        ask: async (event, arg) => { sent.push([event, arg]); return event === 'get-settings' ? { settings: JSON.parse(JSON.stringify(SETTINGS)) } : null; },
    };
    live.setProcesses([
        { name: 'Arthur', in_game: true, socket_connected: true, pos: null, health: null, food: null, action: null },
        { name: 'Felix', in_game: true, socket_connected: true, pos: null, health: null, food: null, action: null },
        { name: 'Nova', in_game: false, socket_connected: false, pos: null, health: null, food: null, action: null },
    ]);
    let n = 0;
    const controls = createControls({ link, store: pg.store, live, clock, ids: () => `c-${++n}` });
    return { controls, sent, pg, live };
}
const everything = (sent: any[][]) => JSON.stringify(sent);

test('commands use the calls the MindServer already has, with no confirmation', async () => {
    const { controls, sent } = rig();
    assert.equal((await controls.execute({ action: 'start', agent: 'Nova' })).ok, true);
    assert.equal((await controls.execute({ action: 'stop', agent: 'Felix' })).ok, true);
    assert.equal((await controls.execute({ action: 'restart', agent: 'Felix' })).ok, true);
    assert.equal((await controls.execute({ action: 'message', agent: 'Felix', text: ' Bake bread before dark. ' })).ok, true);
    assert.equal((await controls.execute({ action: 'message', agent: 'Felix', text: '!goToPlayer("Soup", 3)' })).ok, true);
    assert.equal((await controls.execute({ action: 'halt', agent: 'Felix' })).ok, true);
    assert.equal((await controls.execute({ action: 'stay', agent: 'Felix' })).ok, true);
    assert.equal((await controls.execute({ action: 'stop_all' })).ok, true);
    assert.deepEqual(sent, [
        ['start-agent', 'Nova'], ['stop-agent', 'Felix'], ['restart-agent', 'Felix'],
        ['send-message', 'Felix', { from: 'ADMIN', message: 'Bake bread before dark.' }],
        ['send-message', 'Felix', { from: 'ADMIN', message: '!goToPlayer("Soup", 3)' }],
        ['send-message', 'Felix', { from: 'ADMIN', message: '!stop' }],
        ['send-message', 'Felix', { from: 'ADMIN', message: '!stay(-1)' }],
        ['stop-all-agents'],
    ]);
});

test('Controls never sends !newAction, however it is written', async () => {
    const { controls, sent } = rig();
    const attempts = [
        '!newAction("build a tower")', '!NEWACTION(x)', 'please run !newAction now', '! new Action("x")', '!new​Action("x")',
        '!newAction', 'do this:\n!newAction("mine")', '！newAction("fullwidth mark")',
    ];
    for (const text of attempts) {
        const result = await controls.execute({ action: 'message', agent: 'Felix', text });
        assert.equal(result.ok, false, text);
        assert.match(result.error ?? '', /!newAction is never sent/);
    }
    assert.deepEqual(sent, [], 'nothing left the dashboard');
    for (const text of attempts) assert.equal(namesNewAction(text), true);
    assert.equal(namesNewAction('start a new action plan'), false);

    // every other route out is checked too: no action, however odd, carries it
    for (const action of ['halt', 'stay', 'start', 'stop', 'restart', 'stop_all']) await controls.execute({ action, agent: 'Felix', text: '!newAction("x")' });
    assert.ok(!everything(sent).toLowerCase().includes('!newaction'));
});

test('a settings change replaces only the editable keys: allow_insecure_coding and blocked_actions go back exactly as read', async () => {
    const { controls, sent } = rig();
    const ok = await controls.execute({ action: 'settings', agent: 'Felix', settings: { log_all_prompts: true, max_messages: 20 } });
    assert.equal(ok.ok, true);
    const [event, agent, written] = sent[sent.length - 1];
    assert.equal(event, 'set-agent-settings');
    assert.equal(agent, 'Felix');
    assert.deepEqual(written, { ...SETTINGS, log_all_prompts: true, max_messages: 20 });
    assert.equal(written.allow_insecure_coding, false);
    assert.deepEqual(written.blocked_actions, ['!newAction', '!startConversation'], 'the block on !newAction stays in place');

    const before = sent.length;
    for (const settings of [{ allow_insecure_coding: true }, { blocked_actions: [] }, { narrate_behavior: false, allow_insecure_coding: true }, { host: 'elsewhere' }, { max_messages: 0 }, { chat_ingame: 'yes' }, {}]) {
        const refused = await controls.execute({ action: 'settings', agent: 'Felix', settings: settings as any });
        assert.equal(refused.ok, false, JSON.stringify(settings));
    }
    assert.equal(sent.filter((call) => call[0] === 'set-agent-settings').length, 1, 'no refused change reached the MindServer');
    assert.ok(sent.length >= before);

    assert.deepEqual(await controls.readSettings('Felix'), { narrate_behavior: true, chat_ingame: true, log_all_prompts: false, max_messages: 15 },
        'the panel is shown the editable settings only');
});

test('Shut down asks for one confirmation; nothing else does', async () => {
    const { controls, sent } = rig();
    const first = await controls.execute({ action: 'shutdown' });
    assert.equal(first.ok, false);
    assert.deepEqual(sent, []);
    assert.equal((await controls.execute({ action: 'shutdown', confirm: true })).ok, true);
    assert.deepEqual(sent, [['shutdown']]);
});

test('what would make the MindServer throw is refused here: restart, message or settings for a process that is not connected', async () => {
    const { controls, sent } = rig();
    for (const command of [{ action: 'restart', agent: 'Nova' }, { action: 'message', agent: 'Nova', text: 'hi' }, { action: 'settings', agent: 'Nova', settings: { chat_ingame: false } },
        { action: 'restart', agent: 'Ghost' }, { action: 'restart', agent: '../x' }, { action: 'nonsense', agent: 'Felix' }]) {
        assert.equal((await controls.execute(command)).ok, false, JSON.stringify(command));
    }
    assert.deepEqual(sent, []);
    const offline = rig({ connected: false });
    const result = await offline.controls.execute({ action: 'stop', agent: 'Felix' });
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /MindServer is not connected/);
});

test('every command is logged, also a refused one; the log survives Postgres being down', async () => {
    const { controls, pg } = rig();
    await controls.execute({ action: 'stop', agent: 'Felix' }, 'tailscale');
    await controls.execute({ action: 'restart', agent: 'Nova' }, 'lan');
    assert.deepEqual(pg.controls.map((record) => [record.actor, record.origin, record.action, record.target, record.ok]),
        [['Operator', 'lan', 'Restart', 'Nova', false], ['Operator', 'tailscale', 'Stop', 'Felix', true]]);
    pg.down = true;
    await controls.execute({ action: 'start', agent: 'Nova' }, 'local');
    const log = await controls.log();
    assert.equal(log.source, 'memory');
    assert.equal(log.records.length, 3);
    assert.equal(log.records[0].action, 'Start');
    assert.equal(originOf('100.101.102.103'), 'tailscale');
    assert.equal(originOf('::ffff:192.168.1.20'), 'lan');
    assert.equal(originOf('127.0.0.1'), 'local');
});

test('HTTP: the command endpoint runs a command and answers 409 for a refused one', async () => {
    const { controls, live, pg, sent } = rig();
    const app = await buildApp({ live, store: pg.store, controls, roster: [] });
    const post = (payload: unknown) => app.inject({ method: 'POST', url: '/api/controls/command', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(payload) });
    assert.equal((await post({ action: 'stop', agent: 'Felix' })).statusCode, 200);
    const refused = await post({ action: 'message', agent: 'Felix', text: '!newAction("x")' });
    assert.equal(refused.statusCode, 409);
    assert.equal(refused.json().ok, false);
    assert.equal((await post([1, 2])).statusCode, 400);
    assert.deepEqual(sent, [['stop-agent', 'Felix']]);
    const page = (await app.inject({ url: '/api/controls' })).json();
    assert.equal(page.log.records.length, 2);
    assert.ok(!JSON.stringify(page).includes('allow_insecure_coding'));
    await app.close();
});
