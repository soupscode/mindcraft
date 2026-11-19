// The learning step, wired in: every goal an agent carries out is recorded as an experience
// (the situation and the prediction when it starts, the outcome when it ends), the learner
// in the MindServer process orders and annotates what the catalog offers, and chooses among
// it while the model is away.
//
// The four agents run their real runtime against the stand-in world, with the real learner,
// scorer and service (everything kept in memory). No Minecraft server, no Postgres, no model.
// Run from the repository root:  node --test genesis/tests/*.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeClock, settle } from './helpers/fakes.mjs';
import { makeTown } from './helpers/town.mjs';
import { createBotView } from '../adapters/bot_world.js';
import { EXPERIENCE_FIELDS, OUTCOMES, CHOOSERS, checkPredicted } from '../learning/experience.js';
import { toolTier, selfSituation } from '../learning/recorder.js';
import { createLearningClient } from '../learning/client.js';
import { validateEvent } from '../shared/events.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const KITS = {
    Arthur: { wooden_axe: 1, wooden_pickaxe: 1, bread: 4 },
    Mira: { wooden_hoe: 1, bread: 4 },
    Felix: { wooden_sword: 1, bread: 4 },
    Nova: { bread: 2 },
};
const NAMES = ['Arthur', 'Mira', 'Felix', 'Nova'];
const walking = (command, args, far) => (command === 'goToPosition' ? 500 + far * 250 : command === 'breakBlockAt' ? 1500 + far * 250 : 1000);

// A town with the learner whose model is away. choose: false leaves the routines' own picks in charge
// (the learner then only records), so a test can look at the recording alone.
async function awayTown({ choose = false, ...options } = {}) {
    const t = makeTown({ clock: fakeClock(), inventories: KITS, learning: true, ...options, runtime: { learned_choice: choose, ...(options.runtime ?? {}) } });
    await t.start({ available: false });
    await t.host.signal('desktop_leaving');
    t.world.durations = walking;
    return t;
}

// ---- step 2: experience around goals -----------------------------------------------------------------

test('experience: every goal that ends has one row, with the situation and the prediction stored before the outcome', async () => {
    const t = await awayTown({ agents: NAMES });
    t.world.regrow_ms = 6 * MINUTE;
    t.run();
    await t.clock.advance(2 * HOUR);
    await t.stop();
    await settle();
    const rows = await t.learning_store.listExperience({});
    assert.ok(rows.length >= 50, `${rows.length} experiences in two hours`);
    for (const name of NAMES) {
        const agent = t.agents[name];
        const mine = rows.filter((row) => row.agent === name);
        // one row for every goal the executor ended
        const ended = agent.eventsOf('agent.state').filter((event) => ['goal_completed', 'goal_failed', 'goal_dropped', 'goal_abandoned', 'routine_yielded'].includes(event.data.state));
        assert.equal(mine.length, ended.length, `${name}: ${mine.length} rows for ${ended.length} goals that ended`);
        assert.ok(mine.length >= 6, `${name} has ${mine.length} rows`);
    }
    for (const row of rows) {
        for (const field of EXPERIENCE_FIELDS) assert.ok(row[field] !== undefined, `${row.id} has no ${field}`);
        assert.ok(OUTCOMES.includes(row.outcome) && CHOOSERS.includes(row.chooser));
        assert.equal(row.chooser, 'routine');
        // the prediction first, the outcome after
        assert.deepEqual(checkPredicted(row.predicted), []);
        assert.ok(row.predicted_at <= row.ended_at && row.started_at <= row.ended_at, `${row.id}: predicted ${row.predicted_at}, ended ${row.ended_at}`);
        assert.ok(Number.isInteger(row.predicted.net_version) && row.predicted.net_version >= 0);
        // the situation is the raw snapshot at the start
        const s = row.situation;
        assert.ok(Number.isFinite(s.position.x) && Number.isFinite(s.health) && Number.isFinite(s.food) && Number.isFinite(s.free_slots) && Number.isFinite(s.daylight_left));
        assert.ok(s.home_distance >= 0 && s.range > 0 && typeof s.rain === 'boolean' && Array.isArray(s.agents_near) && Number.isFinite(s.hostiles_near));
        assert.equal(s.model_available, false);
        assert.ok(Array.isArray(row.steps) && typeof row.died === 'boolean' && typeof row.stuck === 'boolean' && row.gained !== null && typeof row.gained === 'object');
        if (row.outcome === 'completed') assert.ok(row.steps.length > 0 && row.steps.every((step) => typeof step.command === 'string' && step.attempts >= 1 && step.ms >= 0), JSON.stringify(row.steps));
        if (row.outcome !== 'dropped') assert.ok(row.duration_ms > 0, `${row.id} ${row.option_id} took ${row.duration_ms}`);
    }
    // what a goal is aimed at, and what it brought
    const gather = rows.find((row) => row.agent === 'Arthur' && row.skill === 'gather_blocks' && row.outcome === 'completed');
    assert.ok(gather.situation.target.dist > 0 && gather.situation.target.pos !== null && gather.situation.target.in_site === false);
    assert.ok(Object.values(gather.gained).some((n) => n > 0), JSON.stringify(gather.gained));
    assert.deepEqual([gather.done > 0, gather.total], [true, 8]);
    assert.deepEqual(gather.situation.tools, { pickaxe: 1, axe: 1, sword: 0, hoe: 0 });
    const walk = rows.find((row) => row.agent === 'Felix' && row.option_id.startsWith('travel:ring-'));
    assert.deepEqual([walk.situation.target.kind, walk.situation.target.path], ['patrol', 'ok']);
    const store = rows.find((row) => row.skill === 'store_items' && row.outcome === 'completed');
    assert.ok(store.situation.target.kind === 'chest' && Object.values(store.gained).every((n) => n < 0), 'what was stored left the inventory');
    // the learner saw them all, each agent its own
    const status = t.learning.learner.status();
    assert.equal(status.examples, rows.length);
    assert.equal(Object.values(status.agents).reduce((n, a) => n + a.own, 0), rows.length);
    // and said so: one "experience" event per goal, learning_update now and then, all of them valid events' data
    const told = t.learning_events.filter((event) => event.data.state === 'experience');
    assert.equal(told.length, rows.length);
    assert.ok(told.every((event) => NAMES.includes(event.data.about) && Number.isFinite(event.data.detail.predicted.p_ok)));
    assert.ok(t.learning_events.filter((event) => event.data.state === 'learning_update').length >= Math.floor(rows.length / 5));
    for (const name of NAMES) for (const event of t.agents[name].events) assert.deepEqual(validateEvent(event).errors, []);
});

test('experience: health lost, a death, a parked step and a goal that could not start are all in the row', async () => {
    const t = await awayTown({ agents: ['Arthur'] });
    const arthur = t.agents.Arthur;
    t.world.regrow_ms = 2 * MINUTE;
    // the first gather hurts: three hearts lost on the way, then some regained (the loss still counts)
    let hurt = false;
    const plain = t.world.durations;
    t.world.durations = (command, args, far) => {
        if (command === 'breakBlockAt' && !hurt) { hurt = true; t.world.body('Arthur').health = 13; }
        return plain(command, args, far);
    };
    t.run();
    await t.clock.advance(3 * MINUTE);
    const first = (await t.learning_store.listExperience({})).find((row) => row.skill === 'gather_blocks');
    assert.ok(first, 'the first gather was recorded');
    assert.deepEqual([first.health_lost, first.health_min, first.died], [7, 13, false]);
    // a step the watchdog parks is "stuck" (the last rung of its ladder: executor.park)
    t.world.body('Arthur').health = 20;
    t.world.stall = (call) => call.command === 'goToPosition' || call.command === 'breakBlockAt';
    for (let i = 0; i < 60 && !(arthur.runtime.executor.plan()?.steps.some((step) => step.status === 'active')); i++) await t.clock.advance(5 * SECOND);
    assert.ok(arthur.runtime.executor.plan(), 'a goal is in hand and gets nowhere');
    arthur.runtime.executor.park('stuck');
    t.world.interrupt('Arthur');
    await t.clock.advance(30 * SECOND);
    t.world.stall = null;
    const parked = (await t.learning_store.listExperience({})).filter((row) => row.stuck);
    assert.ok(parked.length >= 1 && parked.every((row) => row.outcome === 'failed' && row.reason === 'stuck'), 'a parked step was not recorded as stuck');
    await t.stop();
    await settle();
    const rows = await t.learning_store.listExperience({});
    // the learner's labels: danger for the hurt and the stuck ones
    const status = t.learning.learner.status();
    assert.equal(status.examples, rows.length);
    assert.ok(rows.every((row) => row.predicted_at <= row.ended_at));
    assert.ok(arthur.runtime.recorder().stats().errors === 0);
});

test('experience: a goal dropped before it started is opened and closed in that order, and a death is on the goal it happened in', async () => {
    // (Arthur's spawn point is away from home: after a death he has a walk home to make)
    const t = makeTown({ clock: fakeClock(), inventories: { Arthur: { oak_planks: 4, bread: 4 } }, positions: { Arthur: { x: 6, y: 64, z: 30 } }, learning: true, recovery: true });
    await t.start({ available: false });
    const arthur = t.agents.Arthur;
    t.world.durations = walking;
    // a goal the planner chose (as a reply would queue it): store the planks. Before its turn comes the planks are gone
    const queue = async (option_id, call_id) => {
        const pushed = await arthur.runtime.goals.pushShortTerm('Arthur', { title: `Do ${option_id}`.slice(0, 60), option_id }, { reason: 'the test stands in for a planner reply', source: 'planner', call_id });
        arthur.runtime.executor.noteGoals([pushed.goals.short_term.at(-1)], { source: 'planner', call_id });
    };
    await queue('store_items:shared:oak_planks', 'call-7');
    t.world.body('Arthur').inventory = { bread: 4 };
    t.run();
    await t.clock.advance(10 * SECOND);
    const dropped = (await t.learning_store.listExperience({})).find((row) => row.outcome === 'dropped');
    assert.ok(dropped, 'the dropped goal has a row');
    assert.deepEqual([dropped.option_id, dropped.reason, dropped.chooser, dropped.duration_ms], ['store_items:shared:oak_planks', 'not_held', 'planner', 0]);
    assert.ok(dropped.predicted_at <= dropped.ended_at && dropped.predicted.table.n === 0);
    assert.ok(dropped.call_id, 'the planner call behind the goal is on the row');

    // a planner goal in hand when the agent dies: the death is on that goal's row, whatever becomes of the goal
    t.world.body('Arthur').inventory = { wooden_axe: 1, bread: 4 };
    await queue('gather_blocks:oak_log:8', 'call-8');
    arthur.runtime.executor.wake();
    for (let i = 0; i < 20 && arthur.runtime.executor.plan()?.goal.option_id !== 'gather_blocks:oak_log:8'; i++) await t.clock.advance(1 * SECOND);
    assert.equal(arthur.runtime.executor.plan()?.goal.option_id, 'gather_blocks:oak_log:8');
    arthur.runtime.deathBegan();
    const at = t.world.kill('Arthur');
    t.world.interrupt('Arthur');
    await arthur.runtime.died(at);
    await t.clock.advance(10 * MINUTE);
    await t.stop();
    await settle();
    const rows = await t.learning_store.listExperience({ ended: null });
    const gather = rows.find((row) => row.option_id === 'gather_blocks:oak_log:8');
    assert.ok(gather, 'the gather has a row');
    assert.deepEqual([gather.outcome !== null, gather.died, gather.chooser, gather.call_id], [true, true, 'planner', 'call-8'], `the death is on the goal it happened in (${gather.outcome})`);
    // the walk home and the re-equip are goals of the recovery, and say so
    assert.ok(rows.some((row) => row.chooser === 'recovery'), rows.map((row) => `${row.chooser}:${row.option_id}`).join(' '));
    assert.ok(rows.filter((row) => row.outcome !== null).every((row) => row.predicted_at <= row.ended_at));
});

test('experience: an outcome whose start never arrived is dropped and counted, and a learner that does not answer costs the agent nothing', async () => {
    const t = await awayTown({ agents: ['Mira'] });
    assert.deepEqual(await t.learning.end({ agent: 'Mira', id: 'never-started', end: { outcome: 'completed', ended_at: t.clock.now() } }), { ok: false, error: 'experience never-started was never started by Mira' });
    assert.equal(t.learning.stats().without_start, 1);
    assert.equal(t.learning.learner.status().examples, 0, 'nothing was learned from it');
    // somebody else's experience cannot be ended, and an unknown agent's cannot be begun
    await t.learning.begin({ agent: 'Mira', id: 'm1', option: { id: 'travel:home', skill: 'travel', args: { place: 'home' } }, chooser: 'routine', situation: {}, started_at: t.clock.now() });
    assert.equal((await t.learning.end({ agent: 'Nova', id: 'm1', end: { outcome: 'completed', ended_at: t.clock.now() } })).ok, false);
    assert.equal((await t.learning.begin({ agent: 'Stranger', id: 's1', option: { id: 'travel:home', skill: 'travel', args: {} }, chooser: 'routine', situation: {} })).ok, false);
    // an agent's process can only speak for itself
    const sent = [];
    t.agents.Mira.socket.emit('genesis-learn-begin', { agent: 'Nova', id: 'n1', option: { id: 'travel:home', skill: 'travel', args: {} }, chooser: 'routine', situation: {} }, (answer) => sent.push(answer));
    await settle();
    assert.deepEqual(sent, []);
    assert.equal(await t.learning_store.experience('n1'), null);
    await t.stop();

    // no answer within the time: rank() and choose() give null, begin() and end() return at once
    const clock = fakeClock();
    const silent = createLearningClient({ agent: 'Mira', send: () => {}, clock, timeout_ms: 1500 });
    const asked = silent.rank({ options: [], situations: {} });
    silent.begin({ id: 'x' });
    silent.end({ id: 'x', end: {} });
    await clock.advance(1500);
    assert.equal(await asked, null);
    const broken = createLearningClient({ agent: 'Mira', send: () => { throw new Error('not connected'); }, clock });
    broken.begin({ id: 'y' });
    assert.equal(await broken.choose({ options: [], situations: {} }), null);
    assert.deepEqual([silent.stats().unanswered, broken.stats().send_failed], [1, 2]);
});

// ---- the world view's additions ----------------------------------------------------------------------

test('world view: hostile mobs near, rain and agents near, as the bot knows them', () => {
    const at = (x, y, z) => ({ x, y, z, distanceTo(o) { return Math.hypot(x - o.x, y - o.y, z - o.z); } });
    const bot = {
        username: 'Arthur', entity: { position: at(0, 64, 0) }, isRaining: false, thunderState: 0, inventory: { emptySlotCount: () => 30, items: () => [] }, time: { timeOfDay: 1000 },
        entities: {
            1: { name: 'zombie', type: 'hostile', position: at(5, 64, 0) }, 2: { name: 'creeper', type: 'mob', position: at(0, 64, 15) }, 3: { name: 'skeleton', type: 'hostile', position: at(40, 64, 0) },
            4: { name: 'cow', type: 'animal', position: at(2, 64, 2) }, 5: { name: 'iron_golem', type: 'mob', position: at(3, 64, 0) }, 6: { name: 'player', type: 'player', position: at(1, 64, 1) },
        },
        players: { Mira: { entity: { position: at(6, 64, 8) } }, Felix: { entity: { position: at(60, 64, 0) } }, Nova: {}, Operator: { entity: { position: at(1, 64, 0) } } },
    };
    bot.entities[7] = bot.entity;
    // upstream's own test of "hostile" (src/utils/mcdata.js line 145), as the adapter is handed it
    const mc = { isHostile: (mob) => Boolean(mob?.name) && (mob.type === 'mob' || mob.type === 'hostile') && mob.name !== 'iron_golem' && mob.name !== 'snow_golem' };
    const view = createBotView(bot, { world: { getInventoryCounts: () => ({}) }, mc, pf: {}, Vec3: null });
    assert.equal(view.hostilesNear(16), 2, 'the zombie and the creeper; not the far skeleton, the cow, the golem or a player');
    assert.equal(view.hostilesNear(64), 3);
    assert.equal(view.raining(), false);
    bot.isRaining = true;
    assert.equal(view.raining(), true);
    bot.isRaining = false;
    bot.thunderState = 1;
    assert.equal(view.raining(), true);
    assert.deepEqual(view.agentsNear(['Arthur', 'Mira', 'Felix', 'Nova'], 16), [{ name: 'Mira', dist: 10 }], 'only agents of the world file, only in sight, never itself');
    // a bot that knows nothing of entities counts none
    assert.equal(createBotView({ ...bot, entities: undefined }, { world: {}, mc, pf: {}, Vec3: null }).hostilesNear(), 0);
    assert.deepEqual([toolTier({ stone_pickaxe: 1, wooden_pickaxe: 1 }, 'pickaxe'), toolTier({ iron_axe: 1 }, 'axe'), toolTier({ wooden_axe: 0 }, 'axe'), toolTier({ diamond_sword: 1 }, 'sword'), toolTier({}, 'hoe')], [2, 3, 0, 4, 0]);
    const zones = { distanceFromHome: () => 12.34, range: () => 48, agents: () => ['Arthur', 'Mira'] };
    const self = selfSituation({ agent: 'Arthur', view: { ...view, inventory: () => ({ oak_log: 3, rotten_flesh: 2 }), health: () => 18, food: () => 17, freeSlots: () => 30, position: () => ({ x: 0, y: 64, z: 0 }) }, zones, known: (item) => item === 'oak_log' });
    assert.deepEqual([self.inventory, self.hostiles_near, self.rain, self.agents_near, self.home_distance, self.day_tick, self.daylight_left], [{ oak_log: 3 }, 2, true, [{ name: 'Mira', dist: 10 }], 12.3, 1000, 11000]);
});

// ---- step 3: the learner in the host, and the planner's options ordered and annotated -----------------

import { createPlanningHost, createHostLearning } from '../planning/host.js';
import { startPlanning, LEARNING_EVENT_AGENT } from '../planning/server.js';
import { memoryLearningStore, withFileState, stateFile, LEARNING_DIR } from '../learning/store.js';
import { memoryFiles, versionFile } from '../learning/versions.js';
import { STATE_LEARNER, STATE_PLACES } from '../learning/service.js';
import { buildPlanContext, estimatePromptTokens, PROMPT_LIMITS, PROMPT_VERSION } from '../planning/context.js';
import { createEnsemble } from '../learning/net.js';
import { checkLearningSettings } from '../lib/config.js';
import { genesisLearningOn } from '../agent/hooks.js';
import { stubModel } from './helpers/town.mjs';

// Feeds the learner `n` ended goals of one option for one agent, through the service as an agent would.
async function teach(service, clock, agent, option, n, { ok = true, secs = 30, situation = {} } = {}) {
    for (let i = 0; i < n; i++) {
        const id = `${agent}-${option.id}-${clock.now()}-${i}`;
        await service.begin({ agent, id, option, chooser: 'routine', situation, started_at: clock.now() });
        await clock.advance(secs * SECOND);
        await service.end({ agent, id, end: { outcome: ok ? 'completed' : 'failed', reason: ok ? null : 'no_safe_path', done: ok ? 1 : 0, total: 1, duration_ms: secs * SECOND } });
    }
}

test('host: the learner, its store and its version store are made in the MindServer process, and what was learned outlives a restart', async () => {
    const clock = fakeClock();
    const files = memoryFiles();
    const state_store = () => withFileState(memoryLearningStore(), { files, dir: '/learn' });
    const events = [];
    const make = () => createPlanningHost({ model: stubModel(clock), clock, learning: { agents: NAMES, store: state_store(), files, weights_dir: '/learn/weights', emit: (type, data) => events.push(data), service: { keep_every: 5 }, rules: { snapshot_every: 20 } } });
    const host = make();
    assert.ok(host.learning && host.learning.learner && host.learning.scorer && host.learning.versions, 'the host made the learner, the scorer and the version store');
    assert.deepEqual(await host.learning.restore(), { table: false, places: false, version: null }, 'a first start: nothing was kept');
    assert.equal(createPlanningHost({ model: stubModel(clock), clock }).learning, null, 'without its settings there is no learner');
    const GATHER = { id: 'gather_blocks:oak_log:8', skill: 'gather_blocks', args: { type: 'oak_log', count: 8 }, title: 'Gather 8 oak_log' };
    await teach(host.learning, clock, 'Arthur', GATHER, 30, { situation: { position: { x: -24, y: 64, z: -6 } } });
    await host.learning.keep();
    await host.learning.flush();
    assert.equal(host.learning.learner.status().examples, 30);
    // kept: the count table and the examples under one name, the places under another; the versions as files
    assert.ok(files.names().includes(stateFile('/learn', STATE_LEARNER)) && files.names().includes(stateFile('/learn', STATE_PLACES)), files.names().join(' '));
    assert.ok(files.names().includes(versionFile('/learn/weights', 0)), 'version 0 is a file');
    const v = host.learning.learner.version();
    assert.ok(v >= 1, 'a candidate from the live weights was published after 20 goals');
    assert.ok(files.names().includes(versionFile('/learn/weights', v)));
    assert.ok(events.some((data) => data.state === 'learning_version' && data.detail.v === v && data.detail.state === 'in_use'));
    const before = host.learning.learner.table.predict('Arthur', GATHER);

    // the process ends and starts again: the same files, a new host
    const again = make();
    assert.equal(again.learning.learner.status().examples, 0);
    const restored = await again.learning.restore();
    assert.deepEqual(restored, { table: true, places: true, version: v });
    assert.equal(again.learning.learner.status().examples, 30);
    assert.deepEqual(again.learning.learner.table.predict('Arthur', GATHER), before);
    assert.equal(again.learning.learner.version(), v);
    assert.equal(again.learning.learner.weightsHash(), host.learning.learner.weightsHash(), 'the network in use is the one that was in use');
    assert.ok(again.learning.learner.place.size() >= 1, 'the remembered places are back');

    // DECIDED: a full world reset keeps the network, the count table and the examples, and wipes remembered places.
    // The reset removes the "places" entry (genesis/world/reset.js); nothing else of the learner's.
    await files.remove(stateFile('/learn', STATE_PLACES));
    const after_reset = make();
    assert.deepEqual(await after_reset.learning.restore(), { table: true, places: false, version: v });
    assert.equal(after_reset.learning.learner.place.size(), 0);
    assert.deepEqual(after_reset.learning.learner.table.predict('Arthur', GATHER), before);
    assert.equal(after_reset.learning.learner.weightsHash(), host.learning.learner.weightsHash());
    // the same from inside a running process
    await again.learning.worldReset();
    assert.equal(again.learning.learner.place.size(), 0);
    assert.equal(again.learning.learner.status().examples, 30);

    // a damaged version file: the newest that loads is used, and the learner still starts
    files.corrupt(versionFile('/learn/weights', v), '{"v":');
    const damaged = make();
    const got = await damaged.learning.restore();
    assert.ok(got.version === null || got.version < v, `fell back from the damaged v${v} to ${got.version}`);
    assert.equal(got.table, true);
});

test('planning server: learning goes with planning; with a database its rows go there, without one the state is kept in files', async () => {
    const clock = fakeClock();
    const files = memoryFiles();
    const PLANNING = { enabled: true, model: { url: 'http://x:11434', model: 'm' }, ledger_file: '/l/ledger.json' };
    const sink = [];
    const host = await startPlanning(PLANNING, { setSocketExtension: () => {}, clock, files, createModel: () => stubModel(clock), event_sink: (event) => sink.push(event), learning: { agents: NAMES, dir: '/bots/genesis_learning' } });
    assert.ok(host.learning, 'the learner was started with planning');
    assert.deepEqual(host.learning_restored, { table: false, places: false, version: null });
    await host.learning.flush();
    assert.ok(files.names().includes('/bots/genesis_learning/weights/net-v000000.json'));
    // its events are published under its own name, and are valid events
    const told = sink.filter((event) => event.agent === LEARNING_EVENT_AGENT);
    assert.ok(told.some((event) => event.data.state === 'learning_update' && event.data.detail.explore_rate === 0.25));
    for (const event of told) assert.deepEqual(validateEvent(event).errors, []);
    host.stop();
    // with a database: the learner's rows are written there (statements only; no database here)
    const queries = [];
    const pool = { query: async (text, values) => { queries.push({ text, values }); return { rows: [] }; } };
    const with_db = await startPlanning(PLANNING, { setSocketExtension: () => {}, clock, files: memoryFiles(), createModel: () => stubModel(clock), createPool: async () => pool, migrate: async () => ['004_learning.sql'], postgres_url: 'postgres://genesis@db/genesis', learning: { agents: NAMES } });
    await with_db.learning.begin({ agent: 'Mira', id: 'e1', option: { id: 'travel:home', skill: 'travel', args: { place: 'home' } }, chooser: 'routine', situation: {}, started_at: clock.now() });
    assert.ok(queries.some((q) => /INSERT INTO experience/.test(q.text)), 'the experience was written to the database');
    assert.ok(queries.some((q) => /INSERT INTO learning_versions/.test(q.text)) || (await with_db.learning.flush(), queries.some((q) => /INSERT INTO learning_versions/.test(q.text))));
    with_db.stop();
    // no learner without its settings
    const none = await startPlanning(PLANNING, { setSocketExtension: () => {}, clock, files: memoryFiles(), createModel: () => stubModel(clock) });
    assert.equal(none.learning, null);
    none.stop();
    // the setting: on with planning unless switched off; nothing else may be set
    assert.deepEqual(checkLearningSettings(undefined), []);
    assert.deepEqual(checkLearningSettings({ enabled: true, explore_rate: 0.25 }), []);
    assert.match(checkLearningSettings({ enabled: 'yes' }).join(), /enabled" must be true or false/);
    assert.match(checkLearningSettings({ explore_rate: 2 }).join(), /explore_rate" must be a number from 0 to 1/);
    assert.match(checkLearningSettings({ allow_code: true }).join(), /is not a setting/);
    assert.deepEqual([genesisLearningOn({ genesis_planning: { enabled: true } }), genesisLearningOn({ genesis_planning: { enabled: true }, genesis_learning: { enabled: false } }), genesisLearningOn({ genesis_learning: { enabled: true } })], [true, false, false]);
    assert.equal(LEARNING_DIR, './bots/genesis_learning');
});

test('scorer in the service: the same options come back, ordered and annotated; nothing is invented, dropped or changed', async () => {
    const clock = fakeClock();
    const service = createHostLearning({ agents: NAMES, clock, seed: 3 });
    const WALK = { id: 'travel:ring-3', skill: 'travel', args: { place: 'ring-3' }, title: 'Walk to ring-3' };
    const GATHER = { id: 'gather_blocks:oak_log:8', skill: 'gather_blocks', args: { type: 'oak_log', count: 8 }, title: 'Gather 8 oak_log' };
    const CRAFT = { id: 'craft_item:oak_planks:4', skill: 'craft_item', args: { item: 'oak_planks', count: 4 }, title: 'Craft oak_planks x4' };
    await teach(service, clock, 'Felix', WALK, 24, { ok: false, secs: 90 });
    await teach(service, clock, 'Felix', GATHER, 24, { ok: true, secs: 40 });
    const options = [WALK, CRAFT, GATHER];
    const ranked = service.rank({ agent: 'Felix', options, situations: {}, chooser: 'planner' }).ranked;
    assert.deepEqual(ranked.map((entry) => entry.id).sort(), options.map((option) => option.id).sort(), 'exactly the options that were offered');
    assert.equal(ranked[0].id, GATHER.id, 'what keeps working comes first');
    assert.equal(ranked.at(-1).id, WALK.id, 'what keeps failing comes last');
    const label = Object.fromEntries(ranked.map((entry) => [entry.id, entry.label]));
    assert.match(label[GATHER.id], /^\[\d+% \d+s\]$/);
    assert.match(label[WALK.id], /^\[\d+% \d+[sm]\]$/);
    assert.equal(label[CRAFT.id], '[new]', 'an option with no example behind it says so');
    assert.ok(ranked.find((entry) => entry.id === GATHER.id).estimate.p_ok > 0.8 && ranked.find((entry) => entry.id === WALK.id).estimate.p_ok < 0.2);
    // the same options, situations and weights give the same order
    assert.deepEqual(service.rank({ agent: 'Felix', options, situations: {}, chooser: 'planner' }).ranked, ranked);
    // something that is not an option (no id, no skill) is not passed on, and never comes back as one
    const odd = service.rank({ agent: 'Felix', options: [GATHER, { id: 'rm -rf', args: {} }, null, 'travel:home'], situations: {} }).ranked;
    assert.deepEqual(odd.map((entry) => entry.id), [GATHER.id]);
    assert.equal(service.rank({ agent: 'Stranger', options }).ok, false);
});

test('planner: the options the model is shown are the catalog\'s, in the learner\'s order, annotated, and the prompt stays within its budget', async () => {
    const t = makeTown({ clock: fakeClock(), inventories: { Arthur: { wooden_axe: 1, wooden_pickaxe: 1, oak_log: 6, bread: 4 } }, learning: true });
    // the learner has seen Arthur's walks to the field fail and his crafting work
    const offered_first = t.zones && null;
    void offered_first;
    await teach(t.learning, t.clock, 'Arthur', { id: 'travel:field', skill: 'travel', args: { place: 'field' }, title: 'Walk to field' }, 22, { ok: false, secs: 120 });
    await teach(t.learning, t.clock, 'Arthur', { id: 'craft_item:oak_planks:4', skill: 'craft_item', args: { item: 'oak_planks', count: 4 }, title: 'Craft oak_planks x4' }, 22, { ok: true, secs: 5 });
    await t.start({ available: true });
    const arthur = t.agents.Arthur;
    await t.clock.advance(2 * SECOND);
    assert.equal(t.model.requests.length, 1);
    const shown = t.model.offered(0);
    const catalog_order = arthur.runtime.planner && t.calls[0].options_offered.map((option) => option.id);
    assert.deepEqual([...shown].sort(), [...catalog_order].sort());
    // what the catalog offers, unannotated, in its own fixed order (travel first)
    const plain = makeTown({ clock: fakeClock(), inventories: { Arthur: { wooden_axe: 1, wooden_pickaxe: 1, oak_log: 6, bread: 4 } } });
    await plain.start({ available: true });
    await plain.clock.advance(2 * SECOND);
    const unlearned = plain.model.offered(0);
    assert.deepEqual([...shown].sort(), [...unlearned].sort(), 'the learner neither added nor dropped an option');
    assert.notDeepEqual(shown, unlearned, 'the order is the learner\'s');
    assert.ok(shown.indexOf('craft_item:oak_planks:4') < shown.indexOf('travel:field'), `crafting, which works, comes before the walk that keeps failing: ${shown.join(' ')}`);
    assert.equal(shown.at(-1), 'travel:field');
    const prompt = t.model.requests[0].messages.at(-1).content;
    assert.match(prompt, /craft_item:oak_planks:4: (For your build: )?Craft oak_planks \(recipe made 4 times\) \[100% 5s\]/);
    assert.match(prompt, /travel:field: Walk to field \(\d+ blocks\) \[\d% \d+[sm]\]/);
    assert.match(prompt, /\[new\]/);
    assert.doesNotMatch(plain.model.requests[0].messages.at(-1).content, /\[new\]|\[\d+% /, 'without a learner nothing is annotated');
    // the decision row: everything that was on offer with the estimates shown, what was chosen, what the first option was
    await settle();
    const decision = (await t.learning_store.listDecisions({ agent: 'Arthur' }))[0];
    assert.equal(decision.chooser, 'planner');
    assert.deepEqual(decision.offered.map((o) => o.id), shown);
    assert.deepEqual([decision.chosen, decision.default_choice, decision.prompt_version, decision.call_id !== null], [shown[0], unlearned[0], PROMPT_VERSION, true]);
    assert.ok(decision.offered.every((o) => o.p_ok !== null && o.score !== null));
    // the goal it led to carries the decision and the call
    t.run();
    await t.clock.advance(30 * SECOND);
    const all_rows = await t.learning_store.listExperience({ agent: 'Arthur', ended: null });
    const row = all_rows.find((r) => r.option_id === shown[0] && r.chooser === 'planner');
    assert.ok(row, all_rows.map((r) => `${r.chooser}:${r.option_id}:${r.outcome}`).join(' '));
    assert.deepEqual([row.chooser, row.decision_id, row.call_id], ['planner', decision.decision_id, decision.call_id]);
    await t.stop();
    await plain.stop();

    // the budget: 16 options, every one annotated with the longest label there is, and the prompt still fits
    const view = arthur.runtime.state().view;
    const options = Array.from({ length: 16 }, (_, i) => ({ id: `gather_blocks:deepslate_iron_ore:${i + 10}`, description: `Gather up to ${i + 10} deepslate_iron_ore (nearest 31 blocks away) and something long that is cut at eighty characters`, label: '[new 100% 59m !]' }));
    const built = buildPlanContext({ agent: 'Arthur', role: 'builder', trigger: { kind: 'goal_complete', detail: {} }, view, home_distance: 12, long_term: [{ title: 'Build the next bigger build' }, { title: 'Keep the town connected' }, { title: 'My home: next tier' }],
        last_outcome: { title: 'Gather 8 oak_log', outcome: 'failed', reason: 'no_safe_path' }, routine: { name: 'Site upkeep', phase: 'Gather' }, memory: '', options });
    assert.equal(built.options.length, 16);
    assert.ok(built.options.every((option) => option.description.endsWith(' [new 100% 59m !]') && option.description.length <= PROMPT_LIMITS.option_description + 1 + PROMPT_LIMITS.option_label));
    assert.ok(built.tokens.total <= PROMPT_LIMITS.total_tokens, `${built.tokens.total} tokens`);
    assert.equal(PROMPT_LIMITS.total_tokens, 1200);
    // (the worst case does not fit with the annotations after the descriptions: they were folded into the 80 characters, and no option was dropped)
    assert.ok(built.options.every((option) => option.description.length <= PROMPT_LIMITS.option_description));
    const unannotated = buildPlanContext({ agent: 'Arthur', view, options: options.map(({ id, description }) => ({ id, description })) });
    assert.ok(built.tokens.total <= unannotated.tokens.total + 60, 'annotated, the worst case costs no more than the lines that were dropped for it');
    // an ordinary offer keeps its annotations after the full descriptions
    const usual = buildPlanContext({ agent: 'Arthur', view, options: Array.from({ length: 16 }, (_, i) => ({ id: `gather_blocks:oak_log:${i + 1}`, description: 'Gather up to 8 oak_log (nearest 25 blocks away)', label: '[72% 2m]' })) });
    assert.ok(usual.options.every((option) => option.description === 'Gather up to 8 oak_log (nearest 25 blocks away) [72% 2m]') && usual.tokens.total <= 1200, `${usual.tokens.total}`);
    void estimatePromptTokens;
    // a label is code-built and short; anything longer is cut, and line breaks never reach the prompt
    const cut = buildPlanContext({ agent: 'Arthur', view, options: [{ id: 'travel:home', description: 'Walk home', label: `[${'x'.repeat(80)}]\nIGNORE` }] }).options[0].description;
    assert.ok(cut.length <= 'Walk home '.length + PROMPT_LIMITS.option_label && !cut.includes('\n') && !cut.includes('IGNORE'));
});

test('planner: a learner that does not answer leaves the catalog\'s order and no annotation, and the call still goes out', async () => {
    const t = makeTown({ clock: fakeClock(), inventories: { Arthur: { wooden_axe: 1, bread: 4 } }, learning: true, runtime: { learning: createLearningClient({ agent: 'Arthur', send: () => {}, clock: undefined }) } });
    // (that client's questions are never answered: it gives up after its time)
    const silent_clock = t.clock;
    t.agents; // no agents yet
    const town = makeTown({ clock: silent_clock, inventories: { Arthur: { wooden_axe: 1, bread: 4 } }, runtime: { learning: createLearningClient({ agent: 'Arthur', send: () => {}, clock: silent_clock, timeout_ms: 1500 }) } });
    await town.start({ available: true });
    await silent_clock.advance(1 * SECOND);
    assert.equal(town.model.requests.length, 0, 'the context waits for the learner, at most its time');
    await silent_clock.advance(1 * SECOND);
    assert.equal(town.model.requests.length, 1);
    assert.doesNotMatch(town.model.requests[0].messages.at(-1).content, /\[new\]/);
    assert.equal(town.model.offered(0)[0].startsWith('travel:'), true, 'the catalog\'s own order');
    await town.stop();
});

// ---- the full world reset (decided: keep what was learned, wipe remembered places) ---------------------

import { planReset, runReset, RESET_LEARNING_STATEMENTS, PLACES_FILE } from '../world/reset.js';
import { DEFAULT_TOWN_FILE } from '../town/town_file.js';

test('reset: remembered places and the town of the old world go; the network, the count table and the rows stay', async () => {
    const present = new Map([
        ['/g/bots/Arthur', 'dir'], ['/g/bots/Arthur/memory.json', 'file'], ['/g/bots/genesis_checkpoints', 'dir'], ['/g/bots/genesis_ledger', 'dir'], ['/g/bots/genesis_ledger/chest_ledger.json', 'file'],
        ['/g/bots/genesis_learning', 'dir'], ['/g/bots/genesis_learning/places.json', 'file'], ['/g/bots/genesis_learning/learner.json', 'file'],
        ['/g/bots/genesis_learning/weights', 'dir'], ['/g/bots/genesis_learning/weights/net-v000003.json', 'file'], ['/g/bots/genesis_learning/weights/current.json', 'file'],
        ['/g/bots/genesis_town', 'dir'], ['/g/bots/genesis_town/genesis.town.json', 'file'], ['/g/bots/genesis_prefabs/operator/clock_tower.json', 'file'],
    ]);
    const removed = [];
    const files = { kind: async (file) => present.get(file) ?? 'missing', list: async () => [], remove: async (file) => { removed.push(file); present.delete(file); }, write: async () => {} };
    const inputs = { agents: ['Arthur'], memory_dir: 'bots', checkpoint_dir: 'bots/genesis_checkpoints', ledger_file: 'bots/genesis_ledger/chest_ledger.json', manifest_file: 'bots/genesis_world/bootstrap.manifest.json',
        learning_dir: 'bots/genesis_learning', town_file: 'bots/genesis_town/genesis.town.json', cwd: '/g', protect: ['genesis', 'src'], database: true };
    const plan = await planReset({ ...inputs, files });
    assert.equal(plan.ok, true, plan.refused.join('; '));
    assert.deepEqual(plan.remove.map((entry) => entry.path).sort(), ['/g/bots/Arthur/memory.json', '/g/bots/genesis_learning/places.json', '/g/bots/genesis_ledger/chest_ledger.json', '/g/bots/genesis_town/genesis.town.json']);
    assert.deepEqual(plan.database.slice(-2), ["DELETE FROM learning_state WHERE name = 'places'", 'DELETE FROM builds']);
    assert.deepEqual([...RESET_LEARNING_STATEMENTS], plan.database.slice(-2));
    assert.ok(!plan.database.some((statement) => /experience|decisions|learning_versions|lessons|plays/.test(statement)), 'what was learned is not in the list');
    assert.ok(plan.kept.some((note) => /the network, the count table, experience, lessons and plays/.test(note)));
    const queries = [];
    const outcome = await runReset(inputs, { confirmed: true, files, pool: { query: async (text) => { queries.push(text); return { rows: [] }; } } });
    assert.equal(outcome.ok, true, JSON.stringify(outcome.failed));
    assert.ok(removed.includes('/g/bots/genesis_learning/places.json') && removed.includes('/g/bots/genesis_town/genesis.town.json'));
    for (const kept of ['/g/bots/genesis_learning/learner.json', '/g/bots/genesis_learning/weights/net-v000003.json', '/g/bots/genesis_learning/weights/current.json', '/g/bots/genesis_prefabs/operator/clock_tower.json']) assert.equal(present.get(kept), 'file', `${kept} was removed`);
    // the names the reset removes are the names the learner writes
    assert.equal(stateFile(LEARNING_DIR, STATE_PLACES), `${LEARNING_DIR}/${PLACES_FILE}`);
    assert.equal(stateFile(LEARNING_DIR, STATE_LEARNER), `${LEARNING_DIR}/learner.json`);
    assert.equal(DEFAULT_TOWN_FILE, './bots/genesis_town/genesis.town.json');
    // without the learner's folder nothing of it is touched (an older caller)
    const older = await planReset({ ...inputs, learning_dir: null, town_file: null, files });
    assert.deepEqual(older.database, ['DELETE FROM agent_goals', 'DELETE FROM goal_changes', 'DELETE FROM agent_checkpoints']);
});

// ---- step 4: with the model away the learner chooses ---------------------------------------------------

import { needOf, NEED } from '../learning/need.js';
import { ROUTINES } from '../routines/routines.js';
import { SCORER_RULES } from '../learning/scorer.js';

const ROUTINE_SKILLS = {
    Arthur: ['travel', 'fetch_items', 'craft_item', 'gather_blocks', 'store_items'], Mira: ['travel', 'fetch_items', 'craft_item', 'harvest_replant', 'sow_field', 'store_items'],
    Felix: ['travel', 'fetch_items', 'craft_item', 'gather_blocks', 'store_items'], Nova: ['travel', 'fetch_items', 'store_items'],
};

test('model away: the learner chooses among everything the catalog offers; the choice is recorded with what the routine would have done', async () => {
    const t = await awayTown({ agents: NAMES, choose: true, learning: { seed: 11 } });
    t.world.regrow_ms = 6 * MINUTE;
    t.run();
    await t.clock.advance(3 * HOUR);
    await t.stop();
    await settle();
    assert.equal(t.model.requests.length, 0, 'the model was asked while it was away');
    const decisions = await t.learning_store.listDecisions({});
    const learned = decisions.filter((d) => d.chooser === 'network');
    assert.ok(learned.length >= 80, `${learned.length} choices by the learner in three hours`);
    for (const d of learned) {
        const ids = d.offered.map((o) => o.id);
        // never anything that was not offered, and the offer is the catalog's whole list, not one phase's
        assert.ok(typeof d.chosen === 'string' && ids.includes(d.chosen), `${d.chosen} was not offered`);
        assert.ok(d.default_choice === null || ids.includes(d.default_choice));
        assert.ok(d.offered.every((o) => o.p_ok !== null && o.need > 0 && o.score !== null));
    }
    assert.ok(learned.filter((d) => d.offered.length >= 6).length > learned.length / 2, 'the learner saw the whole offer');
    // free choice: skills no phase of the agent's routine ever asks for were chosen
    const outside = Object.fromEntries(NAMES.map((name) => [name, new Set()]));
    for (const d of learned) { const skill = d.chosen.split(':')[0]; if (!ROUTINE_SKILLS[d.agent].includes(skill)) outside[d.agent].add(skill); }
    assert.ok(NAMES.some((name) => outside[name].size > 0), `nothing outside the routines was ever chosen: ${JSON.stringify(Object.fromEntries(NAMES.map((n) => [n, [...outside[n]]])))}`);
    // and it differed from the routine's own pick, which is kept beside it
    assert.ok(learned.filter((d) => d.default_choice !== null && d.chosen !== d.default_choice).length >= 10, 'the learner never chose differently from the fixed order');
    // exploration: about 1 choice in 4 goes to an option the estimates are unsure about, marked as such
    const tries = learned.filter((d) => d.explore).length / learned.length;
    assert.ok(tries > 0.12 && tries < 0.32, `${(tries * 100).toFixed(0)}% of the choices were tries`);
    assert.equal(SCORER_RULES.explore_rate, 0.25);
    assert.equal(SCORER_RULES.explore_danger_cap, null, 'decided: no danger guard on exploration');
    for (const name of NAMES) {
        const agent = t.agents[name];
        // the goal is the routine's in the goal store (the sources stay as they are), with the computed sentence as its reason
        const added = agent.changes().filter((change) => change.after.length > change.before.length);
        assert.ok(added.every((change) => change.source === 'routine'));
        const by_learner = added.filter((change) => /^learned estimate: \d+% ok, about \d+ min, from \d+ examples?/.test(change.reason));
        assert.ok(by_learner.length >= 10, `${name}: ${by_learner.length} goals chosen by the learner`);
        assert.ok(added.every((change) => /^learned estimate: |^routine /.test(change.reason)));
        assert.ok(agent.eventsOf('agent.decision').every((event) => event.data.trigger === 'routine'));
        const told = agent.eventsOf('agent.state').filter((event) => event.data.state === 'learned_choice');
        assert.equal(told.length, by_learner.length);
        assert.ok(told.some((event) => event.data.detail.explore === true) && told.some((event) => event.data.detail.differs === true));
        // never a build from the routine side: no build was started, so none may be continued
        assert.ok(!agent.eventsOf('agent.decision').some((event) => event.data.command === 'build_blueprint'), `${name} started a build while the model was away`);
        // the range still holds for every place the agent stood
        const furthest = Math.max(...t.world.trail.filter((spot) => spot.agent === name).map((spot) => t.zones.distanceFromHome(name, spot)));
        assert.ok(furthest <= ROUTINES[name].range + 1, `${name} was ${furthest.toFixed(1)} blocks from home`);
        for (const event of agent.events) assert.deepEqual(validateEvent(event).errors, []);
    }
    // the experience rows say who chose, and carry the decision
    const rows = await t.learning_store.listExperience({});
    const by_network = rows.filter((row) => row.chooser === 'network');
    assert.ok(by_network.length >= 80 && by_network.every((row) => typeof row.decision_id === 'string'));
    assert.ok(by_network.some((row) => row.explore));
    assert.deepEqual(t.world.placed, [], 'a block was placed while the model was away');
});

test('model away: the hard safety rules stay as they were: shelter at dusk and when hurt, the walk home after a death, parked after the second', async () => {
    const t = await awayTown({ agents: ['Arthur', 'Felix'], choose: true });
    t.run();
    // through dusk and into the night (the day's light ends at tick 12000: ten minutes of real time from tick 1000 on)
    await t.clock.advance(14 * MINUTE);
    for (const name of ['Arthur', 'Felix']) {
        const here = t.world.body(name).position;
        assert.ok(t.zones.distanceFromHome(name, here) <= 5, `${name} is ${t.zones.distanceFromHome(name, here).toFixed(0)} blocks from home at night`);
        assert.equal(t.agents[name].runtime.routine.phase(), 'Shelter');
    }
    const night_start = t.clock.now();
    await t.clock.advance(5 * MINUTE);
    // while sheltering the learner chooses nothing: no goal starts at night
    const at_night = (await t.learning_store.listDecisions({})).filter((d) => d.ts >= night_start);
    assert.deepEqual(at_night.filter((d) => d.chooser === 'network'), []);
    assert.ok(t.agents.Arthur.eventsOf('agent.decision').filter((event) => Date.parse(event.ts) >= night_start).length === 0);
    // the walk home at dusk was the routine's own rule, recorded as its decision with its one option
    const home_walks = (await t.learning_store.listDecisions({})).filter((d) => d.chooser === 'routine' && d.chosen === 'travel:home');
    assert.ok(home_walks.every((d) => d.offered.length === 1));
    await t.stop();

    // hurt below the bound by day: home, whatever the learner would have liked
    const hurt = await awayTown({ agents: ['Arthur'], choose: true, positions: { Arthur: { x: -20, y: 64, z: -6 } } });
    hurt.world.body('Arthur').health = 7;
    hurt.run();
    await hurt.clock.advance(1 * MINUTE);
    const first = hurt.agents.Arthur.changes().find((change) => change.after.length > change.before.length);
    assert.match(first.reason, /^routine Site upkeep, Shelter: going home \(health\)/);
    assert.equal((await hurt.learning_store.listDecisions({})).filter((d) => d.chooser === 'network').length, 0);
    const reflex_walks = (await hurt.learning_store.listDecisions({})).filter((d) => d.chooser === 'routine' && d.chosen === 'travel:home');
    assert.ok(reflex_walks.length >= 1 && reflex_walks.every((d) => d.offered.length === 1), 'the walk home is the rule\'s own decision, with its one option');
    // a death: the walk home is the routine's rule, and the second death parks the agent
    hurt.world.body('Arthur').health = 20;
    await hurt.clock.advance(2 * MINUTE);
    const arthur = hurt.agents.Arthur;
    for (let death = 0; death < 2; death++) {
        arthur.runtime.deathBegan();
        const at = hurt.world.kill('Arthur');
        hurt.world.interrupt('Arthur');
        await arthur.runtime.died({ x: at.x + 30, y: at.y, z: at.z });
        await hurt.clock.advance(30 * SECOND);
    }
    assert.equal(arthur.runtime.routine.isParked(), true);
    const before = (await hurt.learning_store.listDecisions({})).filter((d) => d.chooser === 'network').length;
    await hurt.clock.advance(10 * MINUTE);
    assert.equal((await hurt.learning_store.listDecisions({})).filter((d) => d.chooser === 'network').length, before, 'the learner chose for a parked agent');
    await hurt.stop();
});

test('exploration has no guard of its own: at night, hurt and with danger near, about one choice in four is still a try', () => {
    const clock = fakeClock();
    const service = createHostLearning({ agents: NAMES, clock, seed: 5 });
    const options = ['oak_log', 'stone', 'sand', 'dirt', 'gravel'].map((type) => ({ id: `gather_blocks:${type}:8`, skill: 'gather_blocks', args: { type, count: 8 }, title: `Gather 8 ${type}` }));
    const bad = { health: 4, food: 3, daylight_left: 0, day_tick: 18000, hostiles_near: 5, home_distance: 90, rain: true };
    let tries = 0;
    const picks = new Set();
    for (let i = 0; i < 400; i++) {
        const picked = service.choose({ agent: 'Felix', options, situations: Object.fromEntries(options.map((option) => [option.id, bad])) });
        assert.ok(options.some((option) => option.id === picked.chosen));
        picks.add(picked.chosen);
        if (picked.explore) tries++;
    }
    assert.ok(tries >= 60 && tries <= 110, `${tries} of 400 choices were tries`);
    assert.ok(picks.size >= 3, 'the tries went to different options');
    // building: a started build may be continued, a new one is never started
    const build = { id: 'build_blueprint:arthur-1', skill: 'build_blueprint', args: { plot: 'arthur-1' }, title: 'Build on plot arthur-1' };
    const need = { [build.id]: 2 };
    let started = 0;
    let continued = 0;
    for (let i = 0; i < 200; i++) {
        if (service.choose({ agent: 'Arthur', options: [build, ...options], situations: {}, need }).chosen === build.id) started++;
        if (service.choose({ agent: 'Arthur', options: [build, ...options], situations: {}, need, started_builds: ['arthur-1'] }).chosen === build.id) continued++;
    }
    assert.equal(started, 0, 'a build was started while the model was away');
    assert.ok(continued > 100, `a started build was continued in ${continued} of 200 choices`);
    // with nothing but a build that was not started on offer, nothing is chosen (the routine's own rule then stands)
    assert.equal(service.choose({ agent: 'Arthur', options: [build], situations: {} }).chosen, null);
});

test('need: computed by code from the role and the routine\'s own pick; a weight, never a gate', () => {
    const o = (id, more = {}) => { const [skill, a, b] = id.split(':'); return { id, skill, args: skill === 'travel' ? { place: a } : skill === 'gather_blocks' ? { type: a } : skill === 'craft_item' ? { item: a } : { item: b ?? a }, ...more }; };
    const role = (r, id, more = {}) => needOf(o(id), { role: r, ...more });
    assert.deepEqual([role('explorer', 'travel:ring-3'), role('builder', 'travel:ring-3'), role('builder', 'travel:camp'), role('merchant', 'travel:chest-shared'), role('builder', 'travel:chest-shared')],
        [NEED.role, NEED.idle, NEED.idle, NEED.normal, NEED.some]);
    assert.deepEqual([role('builder', 'gather_blocks:oak_log:8'), role('farmer', 'gather_blocks:oak_log:8'), role('farmer', 'harvest_replant:field'), role('builder', 'harvest_replant:field')], [NEED.role, NEED.normal, NEED.role, NEED.normal]);
    // a craft nothing asked for serves nothing; the role's own craft and a tool that is missing do
    assert.deepEqual([role('builder', 'craft_item:oak_planks:4'), role('builder', 'craft_item:stick:2'), role('farmer', 'craft_item:bread:1'), role('builder', 'craft_item:stone_axe:1'), role('builder', 'craft_item:stone_axe:1', { holds: (suffix) => suffix === '_axe' })],
        [NEED.role, NEED.idle, NEED.role, NEED.some, NEED.idle]);
    assert.equal(role('merchant', 'fetch_items:shared:torch:8'), NEED.idle, 'taking things out of a chest for no reason');
    // what leads to the agent's own build, what the routine's own rule would pick, and what it has agreed to
    assert.equal(needOf(o('fetch_items:shared:oak_planks:8', { for_build: 'arthur-1' }), { role: 'builder' }), NEED.build);
    assert.equal(needOf(o('fetch_items:kits:bread:4'), { role: 'merchant', routine_pick: 'fetch_items:kits:bread:4' }), NEED.routine);
    assert.equal(needOf({ id: 'give_items:Mira:bread:4', skill: 'give_items', args: {} }, {}), NEED.commitment);
    assert.equal(needOf({ id: 'build_blueprint:arthur-1', skill: 'build_blueprint', args: {} }, {}), NEED.commitment);
    assert.equal(needOf({ id: 'ask_agent:Mira:oak_planks:8', skill: 'ask_agent', args: {}, description: 'Ask Mira for 8 oak_planks (for plot arthur-1): Mira may say no' }, {}), NEED.normal);
    assert.equal(needOf({ id: 'ask_agent:Mira:carrot:4', skill: 'ask_agent', args: {}, description: 'Ask Mira for 4 carrot: Mira may say no' }, {}), NEED.idle);
    assert.ok(Object.values(NEED).every((value) => value > 0), 'nothing is ever weighted out of the choice');
});

test('model away: a learner that does not answer leaves the routine choosing by its fixed order, exactly as before', async () => {
    const clock = fakeClock();
    const t = makeTown({ clock, inventories: KITS, agents: ['Arthur'], runtime: { learning: createLearningClient({ agent: 'Arthur', send: () => {}, clock, timeout_ms: 500 }) } });
    await t.start({ available: false });
    await t.host.signal('desktop_leaving');
    t.world.durations = walking;
    t.run();
    await t.clock.advance(20 * MINUTE);
    const made = t.agents.Arthur.changes().filter((change) => change.after.length > change.before.length);
    assert.ok(made.length >= 5 && made.every((change) => /^routine Site upkeep, /.test(change.reason)), made.map((change) => change.reason).join(' | '));
    assert.equal(t.agents.Arthur.runtime.stats().learned_choices, 0);
    await t.stop();
});

test('closed loop: with one thing that keeps failing in the world, the agents with the learner complete more goals per hour than without', async () => {
    // the rule: stone cannot be broken here (every try takes a minute and fails); the routine's Gather phase asks for it every round
    async function run(choose) {
        const t = await awayTown({ agents: ['Arthur'], choose, learning: { seed: 2 } });
        t.world.regrow_ms = 10 * MINUTE;
        const stone = (call) => call.command === 'breakBlockAt' && call.args[1] === 63 && call.args[2] === -22;
        t.world.durations = (command, args, far) => (stone({ command, args }) ? 60 * SECOND : walking(command, args, far));
        t.world.fail = (call) => (stone(call) ? { output: 'You do not have the tools to harvest stone.' } : null);
        t.world.daylight_stopped = true;
        t.world.ticks = () => 3000;          // it stays morning: the comparison is about choosing work, not about nights
        t.run();
        const completed = () => t.agents.Arthur.eventsOf('agent.state').filter((event) => event.data.state === 'goal_completed').length;
        await t.clock.advance(3 * HOUR);
        const before = completed();
        await t.clock.advance(3 * HOUR);
        const result = { per_hour: (completed() - before) / 3, stone: t.agents.Arthur.eventsOf('agent.decision').filter((event) => event.data.args[0].startsWith('gather_blocks:stone') && Date.parse(event.ts) > t.clock.now() - 3 * HOUR).length };
        await t.stop();
        return result;
    }
    const without = await run(false);
    const with_learner = await run(true);
    assert.ok(without.stone >= 6, `the fixed order kept asking for stone (${without.stone} times in three hours)`);
    assert.ok(with_learner.per_hour > without.per_hour * 1.15, `${with_learner.per_hour.toFixed(1)} goals an hour with the learner, ${without.per_hour.toFixed(1)} without`);
    assert.ok(with_learner.stone < without.stone, `the learner asked for stone ${with_learner.stone} times, the routine ${without.stone} times`);
});
