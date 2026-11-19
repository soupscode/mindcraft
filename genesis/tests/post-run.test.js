// What the first real run asked for: the planner's thought as a field of its own, long-term
// goals and the routine's phase and bounds as events, the model gate saying its state at
// start, the world as events, and the agents' skins through SkinsRestorer.
// Nothing here talks to a Minecraft server, a model or an outside service.
// Run from the repository root:  node --test genesis/tests/*.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import { REPO_ROOT } from './helpers/stubs.mjs';
import { fakeClock, fakeFiles } from './helpers/fakes.mjs';
import { fakeMinecraft } from './helpers/fake-rcon.mjs';
import { makeTown } from './helpers/town.mjs';
import { exampleWorld } from './helpers/bootstrapped.mjs';
import { validateEvent, checkEventData } from '../shared/events.js';
import { createEmitter } from '../events/agent_emit.js';
import { runBootstrap } from '../world/bootstrap.js';
import { worldZonesDetail, bootstrapSummary, announceWorld, WORLD_EVENT_AGENT } from '../world/announce.js';
import { worldHash } from '../world/world_config.js';
import { buildBlueprints } from '../catalog/blueprints.js';
import { checkSkinPng, createSkinService, SKIN_LIMITS, SKIN_COMMANDS } from '../skins/skins.js';
import { startSkins } from '../skins/server.js';

const SECOND = 1000;

test('the planner\'s decision carries the model\'s sentence as a field of its own, and an agent\'s goals are an event when it starts', async () => {
    const clock = fakeClock();
    const t = makeTown({ clock, agents: ['Arthur'], inventories: { Arthur: { oak_log: 6 } } });
    await t.start({ available: true });
    t.run();
    await clock.advance(30 * SECOND);
    const arthur = t.agents.Arthur;
    for (const event of arthur.events) assert.deepEqual(validateEvent(event).errors, [], event.type);
    // decided: `thought` on the goal change that carries the planner's decision
    const planned = arthur.changes().filter((change) => change.source === 'planner');
    assert.ok(planned.length >= 1, 'the planner changed no goal');
    assert.ok(planned.every((change) => change.thought === 'First things first.' && typeof change.call_id === 'string'));
    // what code decided has no thought, and the field is checked by the contract
    assert.ok(arthur.changes().filter((change) => change.source !== 'planner').every((change) => !('thought' in change)));
    assert.deepEqual(checkEventData('goal.changed', { ...planned[0], thought: 7 }), ['data.thought must be a string']);
    // decided: long-term goals are emitted as events: the agent's goals as it starts, before any has changed
    const goals = arthur.eventsOf('agent.state').filter((event) => event.data.state === 'goals');
    assert.equal(goals.length, 1);
    assert.deepEqual(goals[0].data.detail, { long_term: [], short_term: [] });
    assert.ok(arthur.events.indexOf(goals[0]) < arthur.events.findIndex((event) => event.type === 'goal.changed'));
    await t.stop();
});

test('the routine tells its phase and bounds when they change, and the model gate says its state at start', async () => {
    const clock = fakeClock();
    const t = makeTown({ clock, agents: ['Mira'] });
    await t.start({ available: false });
    // decided: the gate emits its state at start (the dashboard showed "unknown"): the model is away, and that is said once
    const gate = t.broker_events.filter((event) => event.type === 'agent.state' && event.data.state.startsWith('model_'));
    assert.deepEqual(gate.map((event) => [event.data.state, event.data.detail.reason, event.data.detail.at_start, event.severity]), [['model_away', 'not_reachable_at_start', true, 'info']]);
    t.run();
    await clock.advance(3 * 60 * SECOND);
    const reports = t.agents.Mira.eventsOf('agent.state').filter((event) => event.data.state === 'routine');
    assert.ok(reports.length >= 2, 'the routine did not tell its phase');
    for (const event of reports) assert.deepEqual(validateEvent(event).errors, []);
    const first = reports[0].data.detail;
    assert.deepEqual([first.name, first.phases, first.away, first.parked], ['Field round', ['Kit check', 'Harvest', 'Bake', 'Stock', 'Shelter'], true, false]);
    assert.ok(first.phases.includes(first.phase));
    assert.deepEqual(Object.keys(first.bounds).sort(), ['breached', 'daylight_ticks_left', 'food', 'free_slots', 'health', 'home_distance', 'limits']);
    assert.deepEqual(first.bounds.limits, { min_health: 10, min_food: 8, min_free_slots: 3, max_deaths: 2, range: 32 });
    // not on every look: only when the phase or a bound changes, and once a minute otherwise
    assert.ok(reports.length <= 30, `${reports.length} reports in three minutes`);
    assert.ok(new Set(reports.map((event) => event.data.detail.phase)).size >= 2, 'no report on a change of phase');
    await t.stop();

    // a model that IS there at start is announced by the probe itself, once
    const up = makeTown({ clock: fakeClock(), agents: [] });
    await up.start({ available: true });
    assert.deepEqual(up.broker_events.filter((event) => event.data.state?.startsWith('model_')).map((event) => event.data.state), ['model_available']);
    up.host.stop();
});

test('the world is announced as events: the zones of the world file and the summary of the bootstrap manifest', async () => {
    const config = exampleWorld();
    const files = fakeFiles();
    const server = fakeMinecraft({ seed: '20261116', worldedit: {} });
    server.blocks.set('3,64,3', { name: 'oak_log', states: {} });
    const done = await runBootstrap({ config, rcon: server, files, clock: fakeClock(), manifest_file: '/w/bootstrap.manifest.json', blueprints: buildBlueprints({ root: REPO_ROOT }), sleep: async () => {} });
    assert.equal(done.ok, true, done.problems.join('; '));

    const zones = worldZonesDetail(config);
    assert.deepEqual([zones.world_sha256, zones.home, zones.floor_y, zones.camp, zones.land], [worldHash(config), [0, 64, 0], 63, { min: [-12, -12], max: [12, 12] }, { min: [-34, -30], max: [45, 29] }]);
    assert.deepEqual(zones.plots.map((plot) => [plot.id, plot.owner]), [['arthur-1', 'Arthur'], ['mira-1', 'Mira'], ['felix-1', 'Felix'], ['nova-1', 'Nova'], ['spare-1', null]]);
    assert.deepEqual(zones.agents.Felix, { home: [0, 64, 4], range: 128 });
    const summary = bootstrapSummary(done.manifest, config);
    assert.deepEqual([summary.verified, summary.attributed_to, summary.world_matches, summary.runs, summary.site.method, summary.blocks_placed, summary.items_placed], [true, 'Operator', true, 1, 'manual', 200, 8]);
    assert.deepEqual([summary.levelling.boxes, summary.levelling.blocks_changed], [22, 1 + 625 + 81 + 1280 + 104]); // 104: the strip one block outside the fence
    assert.deepEqual(summary.levelling.zones[0], { zone: 'camp', cleared: 1, floored: 625, status: 'filled' });
    assert.ok(summary.favours_agents.length >= 8 && summary.operator_must_set.length === 6);
    assert.equal(bootstrapSummary(done.manifest, { ...config, seed: '1' }).world_matches, false);

    // emitted under the name "world", valid by the contract, small enough for one event each, and again later
    const events = [];
    let repeat = null;
    const emitter = createEmitter({ agent: WORLD_EVENT_AGENT, send: (event) => events.push(event) });
    const read = (file) => (file.endsWith('world.json') ? JSON.stringify(config) : files.store.get('/w/bootstrap.manifest.json'));
    const announced = announceWorld({ planning: { world_file: 'w/world.json', manifest_file: '/w/bootstrap.manifest.json' }, repo_root: '/', emitter, read, clock: { setInterval: (fn) => { repeat = fn; return 1; }, clearInterval() {} } });
    assert.deepEqual(announced.emitted, ['world_zones', 'world_bootstrap']);
    assert.deepEqual(events.map((event) => [event.agent, event.type, event.data.state]), [['world', 'agent.state', 'world_zones'], ['world', 'agent.state', 'world_bootstrap']]);
    for (const event of events) assert.deepEqual(validateEvent(event).errors, []);
    assert.deepEqual(events[1].data.detail, JSON.parse(JSON.stringify(summary)));
    repeat();
    assert.equal(events.length, 4);
    // no world file yet: nothing is announced and nothing throws
    assert.deepEqual(announceWorld({ planning: { world_file: 'none.json' }, repo_root: '/', emitter, read: () => { throw new Error('ENOENT'); }, repeat_ms: 0 }).emitted, []);
});

// A PNG file of the given size: a real signature, a real IHDR with its checksum, one data chunk, IEND.
function png(width = 64, height = 64, extra = 0) {
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
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', Buffer.alloc(16 + extra, 7)), chunk('IEND', Buffer.alloc(0))]);
}

test('skins: a real 64x64 or 64x32 PNG is applied through SkinsRestorer over RCON, and every outcome is an event', async () => {
    assert.deepEqual([checkSkinPng(png()).ok, checkSkinPng(png(64, 32)).ok], [true, true]);
    assert.deepEqual([checkSkinPng(png(32, 32)).reason, checkSkinPng(Buffer.from('GIF89a'.repeat(20))).reason, checkSkinPng(png(64, 64, SKIN_LIMITS.max_bytes)).reason, checkSkinPng('x').reason],
        ['wrong_size', 'not_a_png', 'too_large', 'not_an_image']);
    assert.equal(SKIN_COMMANDS.length, 4);

    const sent = [];
    const events = [];
    const signed = [];
    const rcon = { answers: [], async send(command) { sent.push(command); return this.answers.shift() ?? 'Done.'; } };
    // the signer stands in for the outside service that signs a skin: nothing leaves this process in the tests
    const signer = { async sign(request) { signed.push(request); return { url: 'https://textures.example.invalid/texture/abc123' }; } };
    const service = createSkinService({ rcon, signer, agents: ['Arthur', 'Mira'], clock: fakeClock(), emit: (type, data, opts) => events.push({ type, data, ...opts }) });

    const done = await service.apply({ agent: 'Arthur', png: png() });
    assert.deepEqual([done.ok, done.skin_name, done.variant], [true, 'genesis_arthur', 'classic']);
    // console commands, without the leading slash (SkinsRestorer's documentation), the address quoted
    assert.deepEqual(sent, ['sr createcustom genesis_arthur "https://textures.example.invalid/texture/abc123" classic', 'skin set genesis_arthur Arthur']);
    assert.deepEqual([signed.length, signed[0].agent, signed[0].sha256, signed[0].png.length], [1, 'Arthur', done.sha256, png().length]);
    assert.deepEqual(events.map((event) => [event.type, event.data.state, event.data.detail.agent, event.data.detail.by, event.severity]), [['agent.state', 'skin_applied', 'Arthur', 'Operator', 'info']]);
    // the agent reconnects: SkinsRestorer is asked to apply its skin again; an agent with no skin is left alone
    await service.onLogin('Arthur');
    await service.onLogin('Mira');
    assert.deepEqual(sent.slice(2), ['sr applyskin Arthur']);
    assert.equal(events.at(-1).data.detail.on, 'login');

    // failures are events too, with a named reason and never the address
    rcon.answers.push('Unknown or incomplete command, see below for error');
    const refused = await service.apply({ agent: 'Mira', png: png(), variant: 'slim' });
    assert.deepEqual([refused.ok, refused.reason, refused.command], [false, 'refused', 'sr createcustom genesis_mira "<address>" slim']);
    assert.deepEqual([events.at(-1).data.state, events.at(-1).severity], ['skin_failed', 'warn']);
    assert.ok(!JSON.stringify(events).includes('textures.example.invalid'));
    assert.equal((await service.apply({ agent: 'Herobrine', png: png() })).reason, 'unknown_agent');
    assert.equal((await service.apply({ agent: 'Mira', png: Buffer.from('not a png, whatever it says it is') })).reason, 'not_a_png');
    // without a way to the signing service nothing is sent anywhere: stored by the dashboard, not applied
    const lone = [];
    const unsigned = createSkinService({ rcon: { async send(command) { lone.push(command); return ''; } }, signer: null, agents: ['Arthur'] });
    assert.equal((await unsigned.apply({ agent: 'Arthur', png: png() })).reason, 'no_signer');
    assert.equal((await createSkinService({ rcon: null, signer, agents: ['Arthur'] }).apply({ agent: 'Arthur', png: png() })).reason, 'no_rcon');
    assert.deepEqual(lone, []);
    // clearing
    const cleared = await service.clear('Arthur');
    assert.deepEqual([cleared.ok, sent.at(-1), events.at(-1).data.state], [true, 'skin clear Arthur', 'skin_cleared']);
    for (const event of events) assert.deepEqual(checkEventData(event.type, event.data), []);
});

test('skins: the service is reached over the MindServer\'s socket, never through an agent, and its events go out under the name "skins"', async () => {
    const out = [];
    const sent = [];
    const skins = startSkins({ event_sink: (event) => out.push(event), agents: ['Felix'], rcon: { async send(command) { sent.push(command); return ''; } }, signer: { sign: async () => ({ url: 'https://textures.example.invalid/t/1' }) } });
    const handlers = new Map();
    skins.attach({ on: (event, handler) => handlers.set(event, handler) }, { isAgentSocket: (name) => name === 'Felix' });
    const answer = await new Promise((resolve) => handlers.get('genesis-skin-apply')({ agent: 'Felix', png_base64: png().toString('base64') }, resolve));
    assert.equal(answer.ok, true);
    assert.deepEqual(out.map((event) => [event.agent, event.type, event.data.state]), [['skins', 'agent.state', 'skin_applied']]);
    assert.deepEqual(validateEvent(out[0]).errors, []);
    handlers.get('login-agent')('Felix');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sent.at(-1), 'sr applyskin Felix');
    // a restart of this process: the dashboard says what it has stored, and the next login applies it again
    const fresh = startSkins({ agents: ['Felix'], rcon: { async send(command) { sent.push(`fresh: ${command}`); return ''; } } });
    const fresh_handlers = new Map();
    fresh.attach({ on: (event, handler) => fresh_handlers.set(event, handler) }, { isAgentSocket: () => true });
    fresh_handlers.get('genesis-skin-known')({ agent: 'Felix', sha256: 'a'.repeat(64) });
    fresh_handlers.get('login-agent')('Felix');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sent.at(-1), 'fresh: sr applyskin Felix');
    assert.equal((await new Promise((resolve) => handlers.get('genesis-skin-apply')({ agent: 'Felix', png_base64: 'AAAA' }, resolve))).ok, false);
});

test('the MindServer does not throw for an agent that is not connected, and the launcher keeps secrets out of the settings', () => {
    const mindserver = readFileSync(path.join(REPO_ROOT, 'src', 'mindcraft', 'mindserver.js'), 'utf8');
    const handler = (name) => mindserver.slice(mindserver.indexOf(`socket.on('${name}'`), mindserver.indexOf('});', mindserver.indexOf(`socket.on('${name}'`)));
    assert.match(handler('restart-agent'), /if \(!agent \|\| !agent\.socket\) \{[\s\S]*return;/);
    assert.match(handler('set-agent-settings'), /if \(agent\.socket\) agent\.socket\.emit\('restart-agent'\)/);
    // the tracked settings file and the compose files hold no address with a password, only variables
    const settings = JSON.parse(readFileSync(path.join(REPO_ROOT, 'genesis', 'settings.json'), 'utf8'));
    assert.ok(!settings.genesis_planning.postgres_url);
    const compose = readFileSync(path.join(REPO_ROOT, 'genesis', 'compose.agents.yaml'), 'utf8');
    assert.match(compose, /GENESIS_DATABASE_URL: "\$\{GENESIS_AGENTS_DATABASE_URL:-\$\{GENESIS_POSTGRES_PASSWORD:\+postgres:\/\/genesis:\$\{GENESIS_POSTGRES_PASSWORD\}@postgres:5432\/genesis\}\}"/);
    assert.match(compose, /GENESIS_WORLD_FILE: "\$\{GENESIS_WORLD_FILE:-\.\/bots\/genesis_world\/genesis\.world\.json\}"/);
    const minecraft = readFileSync(path.join(REPO_ROOT, 'genesis', 'compose.minecraft.yaml'), 'utf8');
    assert.match(minecraft, /MODRINTH_PROJECTS: \|\n\s+worldedit:7\.4\.6\n\s+skinsrestorer:15\.12\.6\n/);
    assert.match(minecraft, /VIEW_DISTANCE: "\$\{GENESIS_MINECRAFT_VIEW_DISTANCE:-10\}"/);
});

// ---- what stage 1 of the live run taught ------------------------------------------------------

test('the camp is lit and fenced by the bootstrap: no cell further than 8 blocks from a torch, a closed ring with four gates, every home inside', async () => {
    const { campDefence, CAMP_DEFENCE, buildBootstrapPlan } = await import('../world/plan.js');
    const config = exampleWorld();
    const { torches, fence, gates } = campDefence(config);
    assert.deepEqual([CAMP_DEFENCE.torch_spacing, torches.length, fence.length, gates.length], [8, 9, 92, 4]);
    // the spacing rule: a hostile mob spawns only at block light 0; a torch gives 14, less 1 per block walked
    let worst = 0;
    for (let x = -12; x <= 12; x++) for (let z = -12; z <= 12; z++) worst = Math.max(worst, Math.min(...torches.map((t) => Math.abs(t[0] - x) + Math.abs(t[2] - z))));
    assert.ok(worst <= 9, `a cell of the camp is ${worst} blocks from the nearest torch`);
    assert.ok(14 - worst >= 5, 'the light inside the camp falls too low');
    // the ring is closed: every cell of the camp's edge is a fence or a gate, and nothing of the camp stands in one
    const ring = new Set([...fence, ...gates.map((gate) => gate.pos)].map((pos) => `${pos[0]},${pos[2]}`));
    for (let n = -12; n <= 12; n++) for (const cell of [`${n},-12`, `${n},12`, `-12,${n}`, `12,${n}`]) assert.ok(ring.has(cell), `the fence is open at ${cell}`);
    assert.deepEqual(gates.map((gate) => [gate.pos, gate.facing]), [[[0, 64, -12], 'south'], [[0, 64, 12], 'south'], [[-12, 64, 0], 'east'], [[12, 64, 0], 'east']]);
    // every agent's home (where the Shelter phase takes it) is INSIDE the fence, and no torch stands on a home or a block of the camp
    for (const [name, agent] of Object.entries(config.agents)) assert.ok(Math.abs(agent.home[0]) < 12 && Math.abs(agent.home[2]) < 12, `${name}'s home is not inside the fence`);
    const plan = buildBootstrapPlan(config);
    const cells = plan.blocks.filter((block) => block.pos[1] === 64 && !block.id.startsWith('field.')).map((block) => block.pos.join(','));
    assert.equal(new Set(cells).size, cells.length, 'two blocks of the camp share a cell');
    assert.ok(torches.every((t) => !Object.values(config.agents).some((agent) => agent.home[0] === t[0] && agent.home[2] === t[2])));
    assert.deepEqual(plan.blocks.find((block) => block.id === 'gate.1'), { id: 'gate.1', pos: [0, 64, -12], place: 'minecraft:oak_fence_gate[facing=south,open=false]', expect: 'minecraft:oak_fence_gate', purpose: 'camp gate 1 of 4', once: false });
    assert.equal(plan.blocks.find((block) => block.id === 'torch.5').place, 'minecraft:torch');
    assert.match(plan.favours.map((entry) => entry.what).join('\n'), /The starter camp was lit and fenced by the operator: 9 torches, so that no hostile mob can spawn inside it, and a fence with 4 gates around it/);
    // Paper's login throttle is named among what the operator must set
    assert.ok(plan.server_settings.some((setting) => setting.file === 'bukkit.yml' && setting.key === 'settings.connection-throttle' && setting.value === '-1'));
});

test('the bootstrap builds and records the fence, the gates and the torches, and sets the morning once: never again, never on a world that was bootstrapped before', async () => {
    const config = exampleWorld();
    const server = fakeMinecraft({ seed: '20261116' });
    const files = fakeFiles();
    const clock = fakeClock();
    const run = () => runBootstrap({ config, rcon: server, files, clock, manifest_file: '/w/bootstrap.manifest.json', sleep: async () => {}, worldedit: false });
    const first = await run();
    assert.equal(first.ok, true, first.problems.join('; '));
    assert.equal(server.blockAt(-12, 64, -12).name, 'oak_fence');
    assert.deepEqual(server.blockAt(12, 64, 0), { name: 'oak_fence_gate', states: { facing: 'east', open: 'false' } });
    assert.equal(server.blockAt(-8, 64, -8).name, 'torch');
    const records = first.manifest.blocks.filter((record) => /^(fence|gate|torch)\./.test(record.id));
    assert.deepEqual([records.length, records.every((record) => record.by === 'Operator' && record.placed === true)], [105, true]);
    assert.equal(server.log.filter((command) => command === 'time set day').length, 1);
    assert.deepEqual(first.manifest.rules.find((rule) => rule.id === 'time.first_morning').status, 'set, once');
    assert.ok(first.manifest.favours_agents.some((line) => /lit and fenced/.test(line)) && first.manifest.favours_agents.some((line) => /set to morning once/.test(line)));
    assert.ok(first.manifest.operator_must_set.includes('bukkit.yml: settings.connection-throttle=-1'));
    // an agent opened a gate and a fence went missing: the gate is the agents' to open (any state passes), the fence is put back
    server.blocks.set('12,64,0', { name: 'oak_fence_gate', states: { facing: 'east', open: 'true' } });
    server.blocks.delete('-12,64,5');
    server.log.length = 0;
    const second = await run();
    assert.equal(second.ok, true, second.problems.join('; '));
    assert.deepEqual(server.changing(), ['setblock -12 64 5 minecraft:oak_fence']);
    assert.equal(server.blockAt(12, 64, 0).states.open, 'true', 'the bootstrap closed a gate an agent had opened');
    // the manifest is lost: the camp stands, so this is no new world and the time is left alone
    server.log.length = 0;
    const lost = await runBootstrap({ config, rcon: server, files: fakeFiles(), clock, manifest_file: '/w/bootstrap.manifest.json', sleep: async () => {}, worldedit: false });
    assert.equal(lost.ok, true, lost.problems.join('; '));
    assert.equal(server.log.includes('time set day'), false);
    assert.equal(lost.manifest.rules.find((rule) => rule.id === 'time.first_morning').status, 'not set: the world was bootstrapped before');
});

test('gates: the pathfinder opens them and nothing closes them, so an agent closes an open gate once it is through', async () => {
    const { gateToClose, installGateKeeper, GATE_RULES } = await import('../lib/gate_keeper.js');
    const gate = { x: 12, y: 64, z: 0, open: true };
    // through and walking away: closed
    assert.equal(gateToClose({ gates: [gate], here: { x: 15.5, z: 0.5 }, before: { x: 14.5, z: 0.5 } }), gate);
    // standing in it, walking towards it, out of reach, already closed, or somebody else in it: left alone
    assert.equal(gateToClose({ gates: [gate], here: { x: 12.6, z: 0.5 }, before: null }), null);
    assert.equal(gateToClose({ gates: [gate], here: { x: 15.5, z: 0.5 }, before: { x: 16.5, z: 0.5 } }), null);
    assert.equal(gateToClose({ gates: [gate], here: { x: 20.5, z: 0.5 }, before: null }), null);
    assert.equal(gateToClose({ gates: [{ ...gate, open: false }], here: { x: 15.5, z: 0.5 }, before: null }), null);
    assert.equal(gateToClose({ gates: [gate], here: { x: 15.5, z: 0.5 }, before: null, others: [{ x: 12.4, z: 0.9 }] }), null);
    assert.deepEqual({ ...GATE_RULES }, { reach: 4.5, clear: 1.5, every_ms: 1000 });
    // on a bot: only gates of the camp, and the block is activated once
    const used = [];
    const bot = {
        entity: { position: { x: 15.5, y: 64, z: 0.5 } }, entities: {}, registry: { blocksByName: { oak_fence_gate: { id: 7, name: 'oak_fence_gate' }, oak_fence: { id: 8, name: 'oak_fence' } } },
        findBlocks: ({ matching }) => (matching.includes(7) ? [{ x: 12, y: 64, z: 0 }, { x: 18, y: 64, z: 0 }] : []),
        blockAt: (pos) => ({ pos, getProperties: () => ({ open: true }) }), activateBlock: async (block) => { used.push(block.pos); },
    };
    const keeper = installGateKeeper(bot, { inCamp: (pos) => pos.x === 12, timers: { setInterval: () => 1, clearInterval() {} } });
    keeper.look();
    assert.deepEqual(used, [{ x: 12, y: 64, z: 0 }], 'a gate outside the camp was touched, or the camp\'s was not closed');
    // the source this rests on is still as cited
    const movements = readFileSync(path.join(REPO_ROOT, 'node_modules', 'mineflayer-pathfinder', 'lib', 'movements.js'), 'utf8').split('\n');
    assert.match(movements[113], /this\.canOpenDoors = true/);
    assert.match(movements[419], /Open fence gates and doors/);
});

test('patrol: one attempt per waypoint, the unreachable ones remembered for the away period and in the checkpoint, no incident, not "stuck"', async () => {
    const { PATROL_OPTION, createZones } = await import('../catalog/zones.js');
    const { createRoutine } = await import('../routines/engine.js');
    const { routineFor } = await import('../routines/routines.js');
    const { onGround } = await import('../catalog/templates.js');
    assert.deepEqual([PATROL_OPTION.test('travel:ring-5'), PATROL_OPTION.test('travel:home'), PATROL_OPTION.test('travel:ring-5x')], [true, false, false]);
    // a waypoint is put on the ground where the land is known, and left where it is not
    const hill = (ground) => ({ view: { blockAt: ({ y }) => (y <= ground ? { name: 'stone' } : { name: 'air' }) } });
    assert.deepEqual(onGround(hill(70), { x: 90, y: 64, z: 0 }), { x: 90, y: 71, z: 0 });
    assert.deepEqual(onGround(hill(60), { x: 90, y: 64, z: 0 }), { x: 90, y: 61, z: 0 });
    assert.deepEqual(onGround({ view: { blockAt: () => null } }, { x: 90, y: 64, z: 0 }), { x: 90, y: 64, z: 0 });
    assert.deepEqual(onGround({ view: { blockAt: ({ y }) => (y <= 63 ? { name: 'water' } : { name: 'air' }) } }, { x: 90, y: 64, z: 0 }), { x: 90, y: 64, z: 0 }, 'a waypoint was put on water');

    // the routine: a waypoint that failed is not offered again until the model has been back
    const zones = createZones(exampleWorld());
    const offered = [];
    const catalog = { option: (skill, args) => { offered.push(args.place ?? skill); return skill === 'travel' && /^ring-/.test(args.place) ? { ok: true, option: { id: `travel:${args.place}`, title: `Walk to ${args.place}` } } : { ok: false, reason: 'nothing' }; }, candidates: () => [] };
    const view = { position: () => ({ x: 0, y: 64, z: 4 }), inventory: () => ({ stone_sword: 1, bread: 4 }), dayTicksLeft: () => 9000, health: () => 20, food: () => 20, freeSlots: () => 30 };
    const routine = createRoutine({ agent: 'Felix', definition: routineFor('Felix'), catalog, zones, clock: fakeClock() });
    routine.awayStarted();
    const state = { view, ledger: { stock: () => ({}), count: () => 0, known: () => true, seen_at: () => 0 }, avoid: [] };
    const walked = [];
    for (let n = 0; n < 6; n++) {
        const choice = routine.next(state);
        if (!choice.goal) break;
        walked.push(choice.goal.option_id);
        routine.goalEnded({ option_id: choice.goal.option_id, outcome: 'failed' });
    }
    assert.deepEqual(walked.slice(0, 3), ['travel:ring-0', 'travel:ring-1', 'travel:ring-2']);
    assert.deepEqual(routine.unreachable().slice(0, 3), [0, 1, 2]);
    assert.deepEqual(routine.snapshot().unreachable.slice(0, 3), [0, 1, 2], 'the checkpoint does not carry the unreachable waypoints');
    assert.equal(new Set(walked).size, walked.length, 'a waypoint that failed was tried again');
    // a new process: the checkpoint brings them back; the model returning forgets them
    const again = createRoutine({ agent: 'Felix', definition: routineFor('Felix'), catalog, zones, clock: fakeClock() });
    again.awayStarted();
    again.restore(routine.snapshot());
    assert.deepEqual(again.unreachable(), routine.unreachable());
    again.modelReturned();
    assert.deepEqual(again.unreachable(), []);

    // on the real loop: every waypoint fails once (never three times), no incident is raised, and the watchdog is not told "stuck"
    const clock = fakeClock();
    const t = makeTown({ clock, agents: ['Felix'], recovery: true, inventories: { Felix: { stone_sword: 1, bread: 4 } } });
    await t.start({ available: false });
    const real_run = t.agents.Felix.ops.run;
    t.agents.Felix.ops.run = (command, args, context) => (command === 'goToPosition' && Math.hypot(args[0], args[2] - 4) > 60
        ? Promise.resolve({ ok: false, interrupted: false, timedout: false, output: 'no way to the goal without breaking blocks' }) : real_run(command, args, context));
    t.run();
    await clock.advance(10 * 60 * SECOND);
    const felix = t.agents.Felix;
    const tries = felix.eventsOf('skill.started').filter((event) => event.data.skill === 'goToPosition' && Math.hypot(event.data.args[0], event.data.args[2] - 4) > 60);
    assert.ok(tries.length >= 1, 'the patrol never set out');
    assert.ok(tries.every((event) => event.data.attempt === 1), 'a patrol waypoint was tried more than once');
    assert.equal(new Set(tries.map((event) => event.data.args.slice(0, 3).join(','))).size, tries.length, 'a waypoint that failed was walked to again in the same away period');
    assert.deepEqual(felix.events.filter((event) => event.type === 'agent.failure').map((event) => event.data.kind), [], 'a skipped waypoint raised an incident');
    assert.equal(felix.runtime.watchdog().stats().stalls, 0, 'the watchdog counted a skipped waypoint as stuck');
    await t.stop();
});

test('a kick reason is readable in every form it arrives in, and the launcher starts the agents a few seconds apart', async () => {
    const source = readFileSync(path.join(REPO_ROOT, 'src', 'agent', 'connection_handler.js'), 'utf8');
    // (the upstream file imports the MindServer proxy: its one new function is taken out and run on its own)
    const kickText = new Function(`${/export (function kickText[\s\S]*?\n})/.exec(source)[1]}; return kickText;`)();
    assert.equal(kickText('Connection throttled! Please wait before reconnecting.'), 'Connection throttled! Please wait before reconnecting.');
    assert.equal(kickText({ translate: 'multiplayer.disconnect.invalid_player_movement' }), 'multiplayer.disconnect.invalid_player_movement');
    assert.equal(kickText({ text: 'Kicked: ', extra: [{ text: 'Invalid move player packet received' }] }), 'Kicked: Invalid move player packet received');
    // the form 1.21 sends: the component as NBT, which printed as "[object Object]"
    assert.equal(kickText({ type: 'compound', value: { text: { type: 'string', value: 'You are not whitelisted on this server!' } } }), 'You are not whitelisted on this server!');
    assert.equal(kickText({ type: 'compound', value: { translate: { type: 'string', value: 'disconnect.timeout' }, with: { type: 'list', value: { type: 'string', value: ['30'] } } } }), 'disconnect.timeout 30');
    assert.equal(kickText(null), '');
    assert.match(source, /fallback = kickText\(obj\) \|\| raw;/);
    // the agents log in apart: main.js waits genesis_start_gap_ms between them, and the launcher sets 5 seconds with planning on
    assert.match(readFileSync(path.join(REPO_ROOT, 'main.js'), 'utf8'), /if \(!genesis_first_agent && settings\.genesis_start_gap_ms > 0\) await new Promise/);
    assert.match(readFileSync(path.join(REPO_ROOT, 'genesis', 'start.js'), 'utf8'), /settings\.genesis_start_gap_ms === undefined\) settings\.genesis_start_gap_ms = 5000;/);
    // up.sh applies the login throttle like the End, and starts the dashboard only after healthy stores
    const up = readFileSync(path.join(REPO_ROOT, 'genesis', 'up.sh'), 'utf8');
    assert.match(up, /grep -q 'connection-throttle: -1' \/data\/bukkit\.yml/);
    assert.match(up, /subscribe your phone once/);
    assert.ok(!/echo .*\$\(env_get GENESIS_NTFY_TOPIC\)/.test(up), 'up.sh prints the ntfy topic');
    assert.equal((readFileSync(path.join(REPO_ROOT, 'genesis', 'compose.dashboard.yaml'), 'utf8').match(/condition: service_healthy/g) ?? []).length, 4);
});
