// The learning step, part 1: the experience record and its storage, the count table, the
// place memory and recent history, the 96 inputs, the network, the weight files, the option
// scorer and the exploration rule.
//
// No Minecraft server, no bot, no model, no database, no network. What needs outcomes uses
// the invented rule of genesis/learning/sim.js: A SIMULATION, NOT MINECRAFT.
// Run from the repository root:  node --test genesis/tests/*.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './helpers/stubs.mjs';
import {
    openExperience, closeExperience, labelsOf, makeDecision, makeSituation, checkPredicted,
    EXPERIENCE_FIELDS, DECISION_FIELDS, CHOOSERS, OUTCOMES,
} from '../learning/experience.js';
import { memoryLearningStore, pgLearningStore, VERSION_STATES } from '../learning/store.js';
import { createCountTable, optionKey, NEW_BELOW, TABLE_PRIORS } from '../learning/count_table.js';
import { createPlaceMemory, createHistory, failureGroup, PLACE_MAX_CELLS } from '../learning/memory.js';
import { featurize, FEATURE_NAMES, FEATURE_COUNT, FEATURE_VERSION, SKILLS, itemGroup, placeKind, DOMAINS } from '../learning/features.js';
import {
    ARCH, HYPER, ENSEMBLE_SIZE, paramCount, createNet, createEnsemble, forward, trainStep, predict, offsetsOf, nonZero,
    exportWeights, importWeights, weightsHash, allFinite, sigmoid, logit,
} from '../learning/net.js';
import { createVersionStore, memoryFiles, versionFile } from '../learning/versions.js';
import { createLearner, LEARNING_RULES } from '../learning/learner.js';
import { createScorer, optionLabel, shortTime, needFromShortfalls, scoreOf, SCORER_RULES } from '../learning/scorer.js';
import { learningView, statements, behaviourChanges } from '../learning/views.js';
import { createSim, simulateGoals, simClock, SIM_AGENTS } from '../learning/sim.js';
import { createRng, hashText } from '../learning/rng.js';
import { TEMPLATE_NAMES, MESSAGE_TEMPLATES, HANDOFF_TEMPLATES } from '../catalog/templates.js';

const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const TABLE = { p_ok: 0.5, p_danger: 0.05, secs: 60, yield: 0.7, n: 0 };
const PREDICTED = { net_version: 0, source: 'table', table: TABLE, net: { p_ok: 0.5, p_danger: 0.05, secs: 60, yield: 0.7, spread: 0, danger_max: 0.05 } };
const GATHER = { id: 'gather_blocks:oak_log:8', skill: 'gather_blocks', args: { type: 'oak_log', count: 8 } };

function opened(over = {}) {
    return {
        id: 'e1', agent: 'Arthur', goal_id: 'g1', decision_id: 'd1', call_id: null, option_id: GATHER.id, skill: GATHER.skill, args: GATHER.args,
        chooser: 'routine', explore: false, situation: makeSituation({ health: 18 }), predicted: PREDICTED, predicted_at: T0, started_at: T0, world_sha256: 'w', ...over,
    };
}
const ended = (over = {}) => ({ outcome: 'completed', reason: null, done: 8, total: 8, duration_ms: 42000, steps: [{ command: 'collectBlock', ok: true, ms: 40000 }], gained: { oak_log: 8 }, ended_at: T0 + 42000, ...over });

// ---- the experience record ---------------------------------------------------------------

test('experience: a goal is opened with its prediction and closed with its outcome, and the prediction cannot be written afterwards', () => {
    const open = openExperience(opened());
    assert.equal(open.ok, true);
    assert.deepEqual(Object.keys(open.experience).sort(), [...EXPERIENCE_FIELDS].sort());
    assert.equal(open.experience.outcome, null);
    assert.equal(open.experience.predicted_at, T0);

    const closed = closeExperience(open.experience, ended());
    assert.equal(closed.ok, true);
    assert.equal(closed.experience.outcome, 'completed');
    assert.deepEqual(closed.experience.predicted, PREDICTED);
    assert.deepEqual(closed.experience.gained, { oak_log: 8 });

    // prediction first, outcome after: every way round it is refused
    assert.match(closeExperience(open.experience, ended({ predicted: { ...PREDICTED, net_version: 9 } })).problems.join(), /predicted was fixed when the goal started/);
    assert.match(closeExperience(open.experience, ended({ ended_at: T0 - 1 })).problems.join(), /cannot end before its prediction/);
    assert.match(closeExperience(closed.experience, ended()).problems.join(), /already ended/);
    assert.match(openExperience(opened({ outcome: 'completed' })).problems.join(), /outcome belongs to the end of the goal/);
    assert.match(openExperience(opened({ predicted: null })).problems.join(), /predicted must be an object/);
    assert.match(openExperience(opened({ predicted: { ...PREDICTED, table: { ...TABLE, p_ok: 1.2 } } })).problems.join(), /p_ok must be a probability/);
    assert.match(openExperience(opened({ chooser: 'somebody' })).problems.join(), /chooser must be one of/);
    assert.match(closeExperience(open.experience, ended({ outcome: 'won' })).problems.join(), /outcome must be one of/);
    assert.deepEqual(checkPredicted(PREDICTED), []);
    assert.deepEqual(CHOOSERS, ['planner', 'routine', 'network', 'operator', 'recovery']);
    assert.deepEqual(OUTCOMES, ['completed', 'failed', 'dropped', 'abandoned']);
});

test('experience: the labels come from the recorded outcome only, and a replaced goal has no success label', () => {
    const open = openExperience(opened()).experience;
    const label = (end) => labelsOf(closeExperience(open, ended(end)).experience);
    assert.deepEqual(label({}), { ok: 1, yield: 1, log_secs: Math.log(42), danger: 0, died: false, hurt: false, stuck: false });
    const failed = label({ outcome: 'failed', reason: 'no_safe_path', done: 2 });
    assert.equal(failed.ok, 0);
    assert.equal(failed.yield, 0.25);
    assert.equal(failed.log_secs, null, 'only a completed goal has a duration to learn from');
    assert.equal(label({ outcome: 'dropped' }).ok, 0);
    assert.equal(label({ outcome: 'abandoned' }).ok, null, 'a goal a new plan replaced is censored');
    assert.equal(label({ outcome: 'abandoned', died: true }).danger, 1, 'but what happened to the agent during it still counts');
    assert.equal(label({ health_lost: 5.9 }).danger, 0);
    assert.deepEqual([label({ health_lost: 6 }).danger, label({ health_lost: 6 }).hurt], [1, true]);
    assert.deepEqual([label({ stuck: true }).danger, label({ stuck: true }).stuck], [1, true]);
    assert.equal(labelsOf(open), null, 'a goal that has not ended has no labels');
});

test('experience: a decision records everything that was offered, and nothing can be chosen that was not', () => {
    const offered = [{ id: 'a:1', p_ok: 0.7, p_danger: 0.01, secs: 30, n: 12, need: 1, score: 1.4 }, { id: 'b:2' }];
    const made = makeDecision({ decision_id: 'd1', agent: 'Mira', chooser: 'network', offered, chosen: 'b:2', default_choice: 'a:1', explore: true, net_version: 3, prompt_version: 'p1', ts: T0 });
    assert.equal(made.ok, true);
    assert.deepEqual(Object.keys(made.decision).sort(), [...DECISION_FIELDS].sort());
    assert.deepEqual(made.decision.offered[1], { id: 'b:2', p_ok: null, p_danger: null, secs: null, n: 0, need: null, score: null });
    assert.match(makeDecision({ decision_id: 'd2', agent: 'Mira', chooser: 'network', offered, chosen: 'c:3', ts: T0 }).problems.join(), /c:3, which was not offered/);
    assert.equal(makeDecision({ decision_id: 'd3', agent: 'Mira', chooser: 'planner', offered, chosen: ['a:1', 'b:2'], ts: T0 }).ok, true, 'a planner reply chooses up to three');
});

// ---- storage ------------------------------------------------------------------------------

test('store (memory): begin stores the prediction, end stores the outcome, and an outcome without a stored prediction is refused', async () => {
    const store = memoryLearningStore();
    await store.recordDecision({ decision_id: 'd1', agent: 'Arthur', chooser: 'routine', offered: [{ id: GATHER.id }], chosen: GATHER.id, default_choice: GATHER.id, ts: T0 });
    await store.beginExperience(opened());
    assert.equal((await store.experience('e1')).outcome, null);
    assert.equal(await store.countExperience(), 0, 'only ended goals count');
    await assert.rejects(store.endExperience('never-started', ended()), /no prediction was stored/);
    await assert.rejects(store.endExperience('e1', ended({ predicted: PREDICTED })), /cannot be changed afterwards/);
    await assert.rejects(store.beginExperience(opened()), /already exists/);
    const closed = await store.endExperience('e1', ended());
    assert.equal(closed.outcome, 'completed');
    await assert.rejects(store.endExperience('e1', ended()), /already ended/);
    assert.equal(await store.countExperience({ agent: 'Arthur' }), 1);
    assert.equal(await store.countExperience({ agent: 'Mira' }), 0);
    await store.beginExperience(opened({ id: 'e2', agent: 'Mira', started_at: T0 + 1000, predicted_at: T0 + 1000 }));
    assert.deepEqual((await store.listExperience()).map((e) => e.id), ['e1']);
    assert.deepEqual((await store.listExperience({ ended: false })).map((e) => e.id), ['e2'], 'a goal cut off by a crash stays visible as open');
    assert.equal((await store.listDecisions({ agent: 'Arthur' })).length, 1);

    await store.saveVersion({ v: 1, feature_version: 1, parent: 0, examples: 250, metrics: {}, sha256: 'x', state: 'in_use', created_at: T0 });
    await store.markVersion(1, 'rolled_back', 'benched');
    assert.deepEqual((await store.listVersions()).map((r) => [r.v, r.state, r.reason]), [[1, 'rolled_back', 'benched']]);
    await assert.rejects(store.saveVersion({ v: 2, state: 'nonsense' }), /version state must be one of/);
    await store.setState('count_table', { v: 1 });
    assert.deepEqual(await store.getState('count_table'), { v: 1 });
    assert.equal(await store.getState('nothing'), null);
    await store.saveBuild({ build_id: 'b1', plot: 'arthur-1', prefab: 'shack', prefab_sha256: 'h', builder: 'Arthur', cells_total: 75, started_at: T0 });
    assert.equal((await store.listBuilds({ builder: 'Arthur' })).length, 1);
});

// The columns of one table of the migration, by the same reading genesis/tests/store.test.js uses (plus the type real).
function tableColumns(sql, table) {
    const body = sql.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`))?.[1];
    assert.ok(body, `no CREATE TABLE for ${table}`);
    return body.split('\n').map((line) => line.trim()).filter((line) => /^[a-z_0-9]+\s+(text|jsonb|boolean|integer|bigint|timestamptz|real)\b/.test(line)).map((line) => line.split(/\s+/)[0]);
}

function recordingPool(answers = []) {
    const queries = [];
    return { queries, async query(text, values) { queries.push({ text, values }); return { rows: answers.shift() ?? [] }; } };
}

test('store (postgres, not run against a database): the migration holds every field, and every statement fits it', async () => {
    const file = path.join(REPO_ROOT, 'genesis', 'store', 'migrations', '004_learning.sql');
    const sql = readFileSync(file, 'utf8');
    assert.deepEqual(tableColumns(sql, 'experience').sort(), [...EXPERIENCE_FIELDS].sort());
    assert.deepEqual(tableColumns(sql, 'decisions').sort(), [...DECISION_FIELDS].sort());
    for (const table of ['learning_versions', 'learning_state', 'lessons', 'plays', 'wishes', 'refusals', 'builds']) assert.ok(tableColumns(sql, table).length > 0, table);
    for (const value of [...CHOOSERS, ...OUTCOMES, ...VERSION_STATES]) assert.ok(sql.includes(`'${value}'`), `${value} is not allowed by the tables`);
    assert.match(sql, /CHECK \(ended_at IS NULL OR ended_at >= predicted_at\)/, 'the database refuses an outcome dated before its prediction too');
    assert.doesNotMatch(sql, /NOT WIRED IN/, 'the migration is applied with the others now');

    const open_row = { ...openExperience(opened()).experience, predicted_at: new Date(T0), started_at: new Date(T0) };
    const pool = recordingPool([[], [], [open_row], [], [{ n: '3' }], [], [], [], [{ value: { v: 1 } }], [], [], [], []]);
    const store = pgLearningStore(pool);
    await store.recordDecision({ decision_id: 'd1', agent: 'Arthur', chooser: 'routine', offered: [{ id: GATHER.id }], chosen: GATHER.id, default_choice: GATHER.id, ts: T0 });
    await store.beginExperience(opened());
    const closed = await store.endExperience('e1', ended());
    assert.equal(closed.outcome, 'completed');
    assert.equal(await store.countExperience(), 3);
    await store.saveVersion({ v: 1, feature_version: 1, parent: 0, examples: 250, metrics: {}, sha256: 'x', state: 'in_use', created_at: T0 });
    await store.markVersion(1, 'kept');
    await store.setState('count_table', { v: 1 }, T0);
    assert.deepEqual(await store.getState('count_table'), { v: 1 });
    await store.saveBuild({ build_id: 'b1', plot: 'arthur-1', prefab: 'shack', prefab_sha256: 'h', builder: 'Arthur', cells_total: 75, started_at: T0 });
    await store.listExperience({ agent: 'Arthur' });
    await store.listDecisions({});
    await store.listBuilds({});
    await store.listVersions();

    for (const { text, values } of pool.queries) {
        const used = [...new Set([...text.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
        assert.deepEqual(used, values.map((_, i) => i + 1), `placeholders and values do not match in: ${text}`);
        assert.ok(values.every((value) => value !== undefined), `an undefined value in: ${text}`);
        for (const list of text.matchAll(/INSERT INTO ([a-z_]+)\s*\(([^)]*)\)/g)) {
            const known = tableColumns(sql, list[1]);
            for (const column of list[2].split(',').map((c) => c.trim())) assert.ok(known.includes(column), `${list[1]} has no column ${column}`);
        }
        for (const set of text.matchAll(/UPDATE ([a-z_]+)\s+SET ([\s\S]*?)\s+WHERE/g)) {
            const known = tableColumns(sql, set[1]);
            for (const column of set[2].split(',').map((c) => c.trim().split(/\s*=/)[0])) assert.ok(known.includes(column), `${set[1]} has no column ${column}`);
        }
    }
    const update = pool.queries.find((q) => q.text.includes('UPDATE experience'));
    assert.ok(!/predicted\s*=/.test(update.text) && !/situation\s*=/.test(update.text), 'ending a goal never rewrites what was predicted');
    assert.match(update.text, /outcome IS NULL/, 'only an open row is ended');
});

// ---- the count table ------------------------------------------------------------------------

test('count table: a known sequence of outcomes gives the expected values, level by level', () => {
    const table = createCountTable();
    const fresh = table.predict('Arthur', GATHER);
    const near = (a, b) => Math.abs(a - b) < 1e-9;
    assert.ok(near(fresh.p_ok, 0.5) && near(fresh.p_danger, 0.05) && near(fresh.secs, 60) && near(fresh.yield, 0.7), JSON.stringify(fresh));
    assert.equal(fresh.n, 0);

    // Arthur: 3 of 4 gather goals on oak completed
    for (const ok of [1, 1, 0, 1]) table.update('Arthur', GATHER, { ok, danger: 0, log_secs: ok ? Math.log(30) : null, yield: ok ? 1 : 0.5 });
    const a = table.predict('Arthur', GATHER);
    // by hand: skill (3 + 2 * 0.5) / (4 + 2) = 4/6; agent and skill (3 + 4 * 4/6) / (4 + 4) = 17/24; agent and option (3 + 8 * 17/24) / (4 + 8) = 26/36
    assert.ok(Math.abs(a.p_ok - 26 / 36) < 1e-12, String(a.p_ok));
    assert.deepEqual([a.n, a.n_own, a.n_skill], [4, 4, 4]);
    // danger by hand: base (0 + 20 * 0.05) / (4 + 20) = 1/24; skill (0 + 20 / 24) / 24; agent the same step again
    const base = 1 / 24;
    const skill = (20 * base) / 24;
    assert.ok(Math.abs(a.p_danger - (20 * skill) / 24) < 1e-12);
    assert.ok(a.secs < 60 && a.secs > 30, 'three goals of 30 seconds pull the estimate down from the prior of 60');

    // Mira has not gathered: she starts from what everyone's gathering says, not from Arthur's own numbers
    const m = table.predict('Mira', GATHER);
    assert.ok(Math.abs(m.p_ok - 4 / 6) < 1e-12);
    assert.deepEqual([m.n, m.n_own], [4, 0], 'n is what stands behind the option from any agent');
    // another kind of block: the skill's level, no option count
    assert.equal(table.predict('Arthur', { skill: 'gather_blocks', args: { type: 'stone', count: 8 } }).n, 0);
    // a replaced goal changes no success count
    table.update('Arthur', GATHER, { ok: null, danger: 1, log_secs: null, yield: null });
    assert.ok(Math.abs(table.predict('Arthur', GATHER).p_ok - 26 / 36) < 1e-12);
    assert.ok(table.predict('Arthur', GATHER).p_danger > a.p_danger);

    // kept across a restart and a world reset
    const again = createCountTable();
    assert.equal(again.load(JSON.parse(JSON.stringify(table.toJSON()))), true);
    assert.deepEqual(again.predict('Arthur', GATHER), table.predict('Arthur', GATHER));
    assert.equal(again.load({ v: 2 }), false);
    assert.equal(NEW_BELOW, 20);
    assert.equal(TABLE_PRIORS.p_ok, 0.5);
});

test('count table: an option is its skill and what it is aimed at, without the count', () => {
    assert.equal(optionKey(GATHER), 'gather_blocks:oak_log');
    assert.equal(optionKey({ skill: 'gather_blocks', args: { type: 'oak_log', count: 16 } }), 'gather_blocks:oak_log');
    assert.equal(optionKey({ skill: 'travel', args: { place: 'ring-3' } }), 'travel:ring-3');
    assert.equal(optionKey({ skill: 'fetch_items', args: { chest: 'shared', item: 'bread', count: 4 } }), 'fetch_items:shared:bread');
    assert.equal(optionKey({ skill: 'ask_agent', args: { to: 'Nova', item: 'cobblestone', count: 8 } }), 'ask_agent:Nova:cobblestone');
    assert.equal(optionKey({ skill: 'build_blueprint', args: { plot: 'arthur-1' } }), 'build_blueprint:arthur-1');
    assert.equal(optionKey({ id: 'smelt_item:raw_iron:8', skill: 'smelt_item' }), 'smelt_item:raw_iron');
});

// ---- place memory and recent history ---------------------------------------------------------

test('place memory: counts per 16 by 16 cell, fading with time, bounded, and wiped by a world reset', () => {
    const place = createPlaceMemory({ half_life_ms: 1000 });
    place.note({ x: 5, y: 64, z: 5 }, 'death', 0);
    place.note({ x: 15, y: 70, z: 0 }, 'fail', 0);      // the same cell
    place.note({ x: 16, y: 64, z: 0 }, 'ok', 0);        // the next cell
    assert.deepEqual(place.at({ x: 1, y: 0, z: 1 }, 0), { ok: 0, fail: 1, death: 1, stuck: 0 });
    assert.deepEqual(place.at({ x: 20, y: 0, z: 1 }, 0), { ok: 1, fail: 0, death: 0, stuck: 0 });
    assert.equal(place.at({ x: 1, y: 0, z: 1 }, 1000).death, 0.5, 'half as much after one half-life');
    assert.deepEqual(place.at({ x: -500, y: 0, z: 1 }, 0), { ok: 0, fail: 0, death: 0, stuck: 0 });
    place.note({ x: 5, y: 64, z: 5 }, 'nonsense', 0);
    assert.equal(place.size(), 2);

    const copy = createPlaceMemory({ half_life_ms: 1000 });
    assert.equal(copy.load(JSON.parse(JSON.stringify(place.toJSON()))), true);
    assert.deepEqual(copy.at({ x: 1, y: 0, z: 1 }, 0), place.at({ x: 1, y: 0, z: 1 }, 0));

    const small = createPlaceMemory({ max_cells: 3 });
    for (let i = 0; i < 10; i++) small.note({ x: i * 16, y: 64, z: 0 }, 'ok', i);
    assert.equal(small.size(), 3, 'never more than its limit');
    assert.equal(small.at({ x: 0, y: 0, z: 0 }, 10).ok, 0, 'the cell not touched for longest went');
    assert.equal(PLACE_MAX_CELLS, 1024);
    place.wipe();
    assert.equal(place.size(), 0);
});

test('recent history: streaks, the last three outcomes, deaths in the last hour', () => {
    const history = createHistory();
    assert.deepEqual(history.snapshot('Felix', 'travel:ring-3', 'travel', T0), {
        outcomes: [], streak_option: 0, streak_skill: 0, mins_since_death: null, deaths_hour: 0, incidents_hour: 0, last_failure_group: null,
    });
    history.note('Felix', 'travel:ring-3', 'travel', { outcome: 'failed', reason: 'no_safe_path' }, T0);
    history.note('Felix', 'travel:ring-3', 'travel', { outcome: 'failed', reason: 'no_safe_path', died: true }, T0 + 60000);
    history.note('Felix', 'travel:ring-1', 'travel', { outcome: 'failed', reason: 'missing_materials', stuck: true }, T0 + 120000);
    const now = T0 + 5 * 60000;
    const s = history.snapshot('Felix', 'travel:ring-3', 'travel', now);
    assert.deepEqual([s.streak_option, s.streak_skill, s.deaths_hour, s.incidents_hour, s.mins_since_death, s.last_failure_group], [2, 3, 1, 1, 4, 'materials']);
    assert.deepEqual(s.outcomes, ['failed', 'failed', 'failed']);
    assert.equal(history.snapshot('Mira', 'travel:ring-3', 'travel', now).streak_option, 0, 'each agent has its own');
    history.note('Felix', 'travel:ring-3', 'travel', { outcome: 'completed' }, now);
    assert.equal(history.snapshot('Felix', 'travel:ring-3', 'travel', now).streak_option, 0, 'a success ends the streak');
    assert.equal(history.snapshot('Felix', 'travel:ring-3', 'travel', now + 2 * 60 * 60000).deaths_hour, 0);
    assert.deepEqual(['no_safe_path', 'missing_materials', 'place_failed'].map(failureGroup), ['path', 'materials', 'other']);
    history.wipe();
    assert.equal(history.snapshot('Felix', 'travel:ring-3', 'travel', now).mins_since_death, null);
});

// ---- the inputs -------------------------------------------------------------------------------

test('features: 96 named inputs in the plan\'s nine groups, covering every skill the catalog has', () => {
    assert.equal(FEATURE_COUNT, 96);
    assert.equal(FEATURE_COUNT, ARCH.inputs);
    assert.equal(new Set(FEATURE_NAMES).size, 96);
    assert.equal(FEATURE_VERSION, 1);
    const sizes = {};
    for (const name of FEATURE_NAMES) { const g = name.split(':')[0]; sizes[g] = (sizes[g] ?? 0) + 1; }
    assert.deepEqual(sizes, {
        skill: 13, item_group: 12, item_bucket: 8, option: 1, place_kind: 6,          // option: 40
        target: 6, self: 12, time: 5, recent: 11, others: 5, place_here: 4, place_target: 4, context: 5, prior: 4,
    });
    // every skill the catalog offers has its own input, and "play"
    const catalog_skills = [...TEMPLATE_NAMES, ...HANDOFF_TEMPLATES.map((t) => t.name), ...MESSAGE_TEMPLATES.map((t) => t.name)];
    assert.deepEqual([...new Set(catalog_skills)].sort(), SKILLS.filter((s) => s !== 'play').sort());
    assert.deepEqual(Object.values(DOMAINS).flat().sort(), SKILLS.filter((s) => s !== 'play').sort(), 'every skill is shown under one domain');
});

test('features: what goes in is what the situation says, and nothing of the outcome', () => {
    const situation = makeSituation({
        position: { x: 0, y: 70, z: 0 }, home_distance: 24, range: 48, health: 10, food: 20, free_slots: 18, inventory: { oak_log: 32, torch: 8, bread: 4 },
        tools: { pickaxe: 2, axe: 1, sword: 0, hoe: 1 }, day_tick: 6000, daylight_left: 6000, rain: true,
        agents_near: [{ name: 'Mira', dist: 8 }, { name: 'Nova', dist: 40 }], hostiles_near: 2,
        target: { pos: { x: 30, y: 78, z: 0 }, dist: 30, dy: 8, home_distance: 48, in_site: true, path: 'partial' },
        queue_length: 3, model_available: true,
        recent: { outcomes: ['completed', 'failed'], streak_option: 5, streak_skill: 1, mins_since_death: 0, deaths_hour: 3, incidents_hour: 0, last_failure_group: 'path' },
        place: { here: { ok: 2 }, target: { death: 2 } },
    });
    const x = featurize({ agent: 'Arthur', option: GATHER, situation, table: { p_ok: 0.8, p_danger: 0.1, secs: 60, n: 0 }, chooser: 'network' });
    const at = (name) => x[FEATURE_NAMES.indexOf(name)];
    const close = (name, value) => assert.ok(Math.abs(at(name) - value) < 1e-6, `${name}: ${at(name)} is not ${value}`);
    close('skill:gather_blocks', 1); close('skill:travel', 0);
    close('item_group:wood', 1); close('option:count', 8 / 64);
    assert.equal(FEATURE_NAMES.filter((n) => n.startsWith('item_bucket:')).reduce((sum, n) => sum + at(n), 0), 1, 'the item name lands in exactly one of the eight buckets');
    close('target:height_difference', 0.5); close('target:height_size', 0.5); close('target:home_distance', 1); close('target:in_site', 1); close('target:path', 0.5);
    close('self:health', 0.5); close('self:food', 1); close('self:free_slots', 0.5); close('self:pickaxe', 0.4); close('self:sword', 0); close('self:hoe', 1);
    close('self:torches', 0.5); close('self:food_items', 0.25); close('self:home_distance', 0.5); close('self:held_of_item', 0.5);
    close('time:sin', 1); close('time:cos', 0); close('time:daylight_left', 0.5); close('time:night', 0); close('time:rain', 1);
    close('recent:outcome_1', 1); close('recent:outcome_2', -1); close('recent:outcome_3', 0); close('recent:streak_option', 1); close('recent:death_recency', 1);
    close('recent:deaths_hour', 1); close('recent:failed_path', 1); close('recent:failed_materials', 0);
    close('others:agents_near', 1 / 3); close('others:hostiles_near', 0.5); close('others:recipient_kept', 0);
    close('place_here:ok', 0.5); close('place_target:death', 0.5);
    close('context:by_network', 1); close('context:by_routine', 0); close('context:model_available', 1); close('context:queue_length', 1);
    close('prior:p_ok', 0.8); close('prior:p_danger', 0.1); close('prior:examples', 0);
    for (const value of x) assert.ok(Number.isFinite(value) && value >= -1 && value <= 2);

    // a bare situation still gives 96 finite numbers
    const bare = featurize({ agent: 'Arthur', option: { skill: 'travel', args: { place: 'ring-2' } }, situation: makeSituation({}), table: TABLE });
    assert.equal(bare.length, 96);
    assert.ok([...bare].every(Number.isFinite));
    assert.equal(bare[FEATURE_NAMES.indexOf('place_kind:patrol')], 1);

    assert.deepEqual(['oak_log', 'cobblestone', 'raw_iron', 'coal', 'dirt', 'wheat_seeds', 'bread', 'stone_pickaxe', 'furnace', 'oak_door', 'glass', 'string'].map(itemGroup),
        ['wood', 'stone', 'ore', 'fuel', 'soil', 'crop_or_seed', 'food', 'tool', 'station', 'building_part', 'glass', 'other']);
    assert.deepEqual(['home', 'camp', 'chest-shared', 'plot-arthur-1', 'ring-0', 'somewhere'].map((place) => placeKind({ args: { place } })),
        ['home', 'zone', 'chest', 'plot', 'patrol', 'other']);
});

// ---- the network --------------------------------------------------------------------------------

test('network: 96 to 64 to 32 and one head of 4 per agent; with no data it says exactly what the count table says', () => {
    assert.deepEqual([ARCH.inputs, ...ARCH.hidden, ARCH.outputs], [96, 64, 32, 4]);
    assert.equal(ENSEMBLE_SIZE, 5);
    assert.equal(paramCount(ARCH, 4), 96 * 64 + 64 + 64 * 32 + 32 + 4 * (32 * 4 + 4));
    assert.equal(paramCount(ARCH, 4), 8816);
    const net = createNet({ agents: [...SIM_AGENTS], seed: 3 });
    assert.equal(Object.values(net.p).reduce((n, array) => n + array.length, 0), 8816);

    const ensemble = createEnsemble({ agents: [...SIM_AGENTS], seed: 3 });
    const x = featurize({ agent: 'Arthur', option: GATHER, situation: makeSituation({ health: 9 }), table: TABLE });
    for (const table of [{ p_ok: 0.72, p_danger: 0.03, secs: 60, yield: 0.7 }, { p_ok: 0.2, p_danger: 0.4, secs: 60, yield: 0.7 }]) {
        const says = predict(ensemble, 'Mira', x, offsetsOf(table));
        assert.ok(Math.abs(says.p_ok - table.p_ok) < 1e-6);
        assert.ok(Math.abs(says.p_danger - table.p_danger) < 1e-6);
        assert.ok(Math.abs(says.secs - 60) < 1e-3 && Math.abs(says.yield - 0.7) < 1e-6);
        assert.equal(says.spread, 0, 'five untrained members agree: no data, no disagreement');
        assert.equal(says.members.length, 5);
    }
    // an agent the network has no head for gets the table's estimate, never an error
    assert.ok(Math.abs(predict(ensemble, 'Somebody', x, offsetsOf(TABLE)).p_ok - 0.5) < 1e-6);
    assert.throws(() => createNet({ agents: [] }), /needs the list of agents/);
    assert.ok(Math.abs(sigmoid(logit(0.3)) - 0.3) < 1e-12);
    assert.equal(HYPER.weight_decay, 0.001);
    assert.deepEqual([...HYPER.loss_weights], [1, 1, 0.5, 0.5]);
});

test('network: the backward pass matches a numerical gradient, and masked labels carry none', () => {
    const agents = ['A', 'B'];
    const net = createNet({ agents, seed: 11 });
    const r = createRng(5);
    for (const key of ['Wo', 'bo']) for (let i = 0; i < net.p[key].length; i++) net.p[key][i] = (r() - 0.5) * 0.4;   // heads off zero, so every layer has a gradient
    const x = Float32Array.from({ length: 96 }, (_, i) => (i % 3 === 0 ? 0 : r()));
    const example = { x, nz: nonZero(x), head: 1, off: offsetsOf({ p_ok: 0.6, p_danger: 0.1 }), y: { ok: 1, danger: 0, log_secs: 3.2, yield: 0.5 } };
    const plain = { ...HYPER, lr: 0, weight_decay: 0 };          // lr 0: the step computes the gradient and changes nothing
    const lossOf = () => {
        const o = forward(net, example.x, example.nz, example.head, example.off);
        const e = o[2] - example.y.log_secs;
        return -Math.log(sigmoid(o[0])) - Math.log(1 - sigmoid(o[1])) + 0.5 * (Math.abs(e) <= 1 ? 0.5 * e * e : Math.abs(e) - 0.5)
            - 0.5 * (0.5 * Math.log(sigmoid(o[3])) + 0.5 * Math.log(1 - sigmoid(o[3])));
    };
    const loss = trainStep(net, [example], plain);
    assert.ok(Math.abs(loss - lossOf()) < 1e-4, 'the loss the step reports is the loss of the plan');
    let checked = 0;
    for (const [key, indices] of [['W1', [3 * 64 + 5, 4 * 64 + 9, 7 * 64 + 20]], ['b1', [5, 9]], ['W2', [70, 400]], ['b2', [3]], ['Wo', [1 * 4 * 32 + 7, (1 * 4 + 2) * 32 + 3]], ['bo', [4, 6, 7]]]) {
        for (const i of indices) {
            const analytic = net.g[key][i];
            if (analytic === 0) continue;
            const kept = net.p[key][i];
            const h = 1e-2;
            net.p[key][i] = kept + h; const up = lossOf();
            net.p[key][i] = kept - h; const down = lossOf();
            net.p[key][i] = kept;
            const numeric = (up - down) / (2 * h);
            assert.ok(Math.abs(numeric - analytic) < 2e-3 + 0.05 * Math.abs(analytic), `${key}[${i}]: analytic ${analytic}, numeric ${numeric}`);
            checked++;
        }
    }
    assert.ok(checked >= 6, `only ${checked} gradients could be checked`);
    // the other agent's head got no gradient, and a censored example none at all
    assert.ok(net.g.Wo.slice(0, 4 * 32).every((g) => g === 0));
    trainStep(net, [{ ...example, y: { ok: null, danger: null, log_secs: null, yield: null } }], plain);
    assert.ok(Object.values(net.g).every((g) => g.every((v) => v === 0)));
});

test('network: training moves the estimate towards the outcomes, and weights survive a file round trip bit for bit', () => {
    const ensemble = createEnsemble({ agents: ['A', 'B'], seed: 2 });
    const x = featurize({ agent: 'A', option: GATHER, situation: makeSituation({}), table: TABLE });
    const example = { x, nz: nonZero(x), head: 0, off: offsetsOf(TABLE), y: { ok: 0, danger: 1, log_secs: Math.log(200), yield: 0.2 } };
    const before = predict(ensemble, 'A', x, example.off);
    for (const net of ensemble.nets) for (let i = 0; i < 200; i++) trainStep(net, [example]);
    const after = predict(ensemble, 'A', x, example.off);
    assert.ok(after.p_ok < before.p_ok - 0.2 && after.p_danger > before.p_danger + 0.2 && after.secs > before.secs * 1.5 && after.yield < before.yield - 0.2);
    assert.ok(after.spread >= 0 && after.danger_max >= after.p_danger);
    assert.ok(allFinite(ensemble));

    const saved = JSON.parse(JSON.stringify(exportWeights(ensemble)));
    const loaded = importWeights(saved);
    assert.equal(weightsHash(loaded), weightsHash(ensemble));
    assert.deepEqual(predict(loaded, 'A', x, example.off).members, after.members);
    saved.nets[0].W1 = saved.nets[0].W1.slice(8);
    assert.throws(() => importWeights(saved), /weights have/);
    ensemble.nets[0].p.b1[0] = NaN;
    assert.equal(allFinite(ensemble), false);
});

// ---- versions as files ----------------------------------------------------------------------------

test('weight files: written atomically; a kill before the rename leaves the previous version loadable; a damaged file is detected', async () => {
    const files = memoryFiles();
    const problems = [];
    const store = createVersionStore({ files, dir: '/w', report: (p) => problems.push(p) });
    const weights = (seed) => exportWeights(createEnsemble({ agents: ['A'], seed, size: 2 }));
    const base = { feature_version: 1, arch: ARCH, examples: 100, metrics: {} };
    assert.equal(await store.current(), null);
    await store.save({ ...base, v: 1, created_at: T0, weights: weights(1) });
    await store.save({ ...base, v: 2, created_at: T0 + 1000, parent: 1, weights: weights(2) });
    assert.equal((await store.current()).v, 2);
    assert.deepEqual(Object.keys(await store.load(2)).sort(), ['arch', 'created_at', 'examples', 'feature_version', 'metrics', 'parent', 'sha256', 'v', 'weights']);
    assert.equal(versionFile('/w', 41), '/w/net-v000041.json');

    // killed while version 3 is written: before its file is renamed into place
    files.fail((op, file) => op === 'rename' && file.endsWith('net-v000003.json'));
    await assert.rejects(store.save({ ...base, v: 3, created_at: T0 + 2000, weights: weights(3) }));
    files.fail(null);
    assert.equal((await store.current()).v, 2, 'the previous version is still the current one');
    assert.equal(await store.load(3), null);
    // killed after the version file is in place but before the pointer moves
    files.fail((op, file) => op === 'rename' && file.endsWith('current.json'));
    await assert.rejects(store.save({ ...base, v: 3, created_at: T0 + 2000, weights: weights(3) }));
    files.fail(null);
    assert.equal((await store.current()).v, 2);

    // damage that leaves valid JSON behind
    const good = JSON.parse(await files.read(versionFile('/w', 2)));
    good.weights.nets[0].b1 = good.weights.nets[0].b1.replace(/^./, good.weights.nets[0].b1[0] === 'A' ? 'B' : 'A');
    files.corrupt(versionFile('/w', 2), JSON.stringify(good));
    assert.equal(await store.load(2), null);
    assert.equal(problems.at(-1).kind, 'version_corrupt');
    assert.equal((await store.current()).v, 1, 'falls back to the newest listed version that loads');
    assert.equal(await store.point(3), true, 'version 3 was written whole before the kill: it can be pointed at');
    assert.equal((await store.current()).v, 3);
    assert.equal(await store.point(1), true);
    assert.equal((await store.current()).v, 1, 'a rollback moves the pointer');
    assert.equal(await store.point(99), false);
});

test('weight files: the newest thirty and the last of each day are kept', async () => {
    const files = memoryFiles();
    const store = createVersionStore({ files, dir: '/w', keep: 3 });
    const weights = exportWeights(createEnsemble({ agents: ['A'], seed: 1, size: 1 }));
    const day = 24 * 60 * 60 * 1000;
    // two versions a day for four days
    for (let v = 1; v <= 8; v++) await store.save({ v, feature_version: 1, arch: ARCH, examples: v * 100, created_at: T0 + Math.floor((v - 1) / 2) * day + (v % 2) * 1000, weights });
    const kept = (await store.list()).map((entry) => entry.v);
    assert.deepEqual(kept, [2, 4, 6, 7, 8], 'the last of day one and two, and the newest three');
    assert.deepEqual(files.names().filter((name) => name.includes('net-v')).length, 5);
});

// ---- the scorer ----------------------------------------------------------------------------------

const OPTIONS = [
    { id: 'gather_blocks:oak_log:8', skill: 'gather_blocks', args: { type: 'oak_log', count: 8 }, title: 'Gather 8 oak_log', description: 'd' },
    { id: 'travel:ring-1', skill: 'travel', args: { place: 'ring-1' }, title: 'Go to ring-1', description: 'd' },
    { id: 'craft_item:oak_planks:4', skill: 'craft_item', args: { item: 'oak_planks', count: 4 }, title: 'Craft oak_planks', description: 'd' },
    { id: 'build_blueprint:arthur-1', skill: 'build_blueprint', args: { plot: 'arthur-1' }, title: 'Build on plot arthur-1', description: 'd' },
];

function teach(learner, clock, agent, option, results, raw = {}) {
    results.forEach((ok, i) => {
        const now = clock.now();
        const situation = learner.stamp(agent, option, raw, now);
        const open = openExperience({ id: `${agent}-${option.id}-${now}-${i}`, agent, option_id: option.id, skill: option.skill, args: option.args, chooser: 'routine',
            situation, predicted: learner.toPredicted(learner.estimate(agent, option, situation)), predicted_at: now, started_at: now }).experience;
        clock.advance(30000);
        learner.observe(closeExperience(open, { outcome: ok ? 'completed' : 'failed', done: ok ? 1 : 0, total: 1, ended_at: clock.now() }).experience);
    });
}

test('scorer: it never invents, drops or changes an option; it orders them and says what stands behind each', () => {
    const clock = simClock();
    const learner = createLearner({ agents: ['Arthur', 'Mira'], seed: 4, clock });
    const scorer = createScorer({ learner, seed: 9, clock });
    teach(learner, clock, 'Arthur', OPTIONS[1], Array(25).fill(false));                  // travel keeps failing
    teach(learner, clock, 'Arthur', OPTIONS[2], Array(25).fill(true));                   // crafting works
    const ranked = scorer.rank({ agent: 'Arthur', options: OPTIONS, situate: () => ({ health: 20 }) });
    assert.deepEqual(ranked.map((o) => o.id).sort(), OPTIONS.map((o) => o.id).sort(), 'the same options, each once');
    for (const entry of ranked) {
        const given = OPTIONS.find((o) => o.id === entry.id);
        for (const key of Object.keys(given)) assert.deepEqual(entry[key], given[key], `${key} of ${entry.id} was changed`);
    }
    assert.equal(ranked[0].id, 'craft_item:oak_planks:4');
    assert.equal(ranked.at(-1).id, 'travel:ring-1');
    const craft = ranked[0];
    assert.equal(craft.estimate.n, 25);
    assert.equal(craft.estimate.new, false);
    assert.equal(craft.estimate.source, 'table', 'the count table is in charge until the network has beaten it');
    assert.match(craft.label, /^\[\d+% \d+[smh]\]$/);
    assert.equal(ranked.find((o) => o.id === OPTIONS[0].id).label, '[new]', 'nothing stands behind it yet');
    assert.deepEqual(checkPredicted(craft.predicted), [], 'what is handed back can be stored as the prediction');
    // the same options, situations and weights: the same order
    assert.deepEqual(scorer.rank({ agent: 'Arthur', options: OPTIONS, situate: () => ({ health: 20 }) }).map((o) => o.id), ranked.map((o) => o.id));
    assert.deepEqual(scorer.rank({ agent: 'Arthur', options: [...OPTIONS].reverse(), situate: () => ({ health: 20 }) }).map((o) => o.id).sort(), ranked.map((o) => o.id).sort());
    assert.deepEqual(scorer.rank({ agent: 'Arthur', options: [] }), []);

    // an option whose estimate cannot be made stays offered, without numbers
    const broken = scorer.rank({ agent: 'Arthur', options: OPTIONS, situate: (option) => { if (option.skill === 'travel') throw new Error('view failed'); return {}; } });
    assert.equal(broken.length, 4);
    assert.deepEqual([broken.at(-1).id, broken.at(-1).estimate, broken.at(-1).label], ['travel:ring-1', null, '']);

    // no input makes it produce an id that was not handed in (random lists of made-up options)
    const r = createRng(77);
    for (let round = 0; round < 50; round++) {
        const list = Array.from({ length: r.int(17) }, (_, i) => ({ id: `${r.pick(['travel', 'craft_item', 'unknown_skill'])}:x${i}:${r.int(9)}`, skill: r.pick(['travel', 'craft_item', 'unknown_skill']), args: { place: `x${i}` } }));
        const out = scorer.choose({ agent: r.pick(['Arthur', 'Mira', 'Stranger']), options: list, situate: {} });
        assert.deepEqual(out.ranked.map((o) => o.id).sort(), list.map((o) => o.id).sort());
        assert.ok(out.chosen === null ? list.length === 0 : list.some((o) => o.id === out.chosen.id));
        assert.equal(makeDecision({ ...out.decision, decision_id: `d${round}` }).ok, true, 'the decision row holds: nothing chosen that was not offered');
    }
});

test('scorer: labels and the score', () => {
    const e = { p_ok: 0.724, p_danger: 0.02, secs: 120, yield: 1, n: 40, new: false };
    assert.equal(optionLabel(e), '[72% 2m]');
    assert.equal(optionLabel({ ...e, p_danger: 0.11 }), '[72% 2m !]');
    assert.equal(optionLabel({ ...e, n: 12, new: true }), '[new 72% 2m]');
    assert.equal(optionLabel({ ...e, n: 0, new: true }), '[new]');
    assert.deepEqual([shortTime(45), shortTime(89), shortTime(90), shortTime(3600), shortTime(4 * 3600)], ['45s', '89s', '2m', '60m', '4h']);
    // 16 annotated options cost little of the planner prompt: under 16 characters each (about 4 tokens)
    assert.ok(optionLabel({ ...e, p_ok: 1, secs: 59 * 60, p_danger: 0.5, n: 5, new: true }).length <= 16);
    // score = need x p_ok x yield / minutes - risk x p_danger
    assert.ok(Math.abs(scoreOf(e, 1) - (0.724 / 2 - SCORER_RULES.risk * 0.02)) < 1e-12);
    assert.ok(scoreOf(e, 2) > scoreOf(e, 1));
    assert.ok(scoreOf({ ...e, p_danger: 0.3 }, 1) < scoreOf(e, 1));
    assert.equal(needFromShortfalls(OPTIONS[0], {}), 1);
    assert.equal(needFromShortfalls(OPTIONS[0], { oak_log: 16 }), 1.5);
    assert.equal(needFromShortfalls(OPTIONS[0], { oak_log: 4 }), 2);
    assert.equal(needFromShortfalls(OPTIONS[1], { oak_log: 4 }), 1);
});

test('scorer, model away: free choice among everything offered; a build is continued but never started', () => {
    const clock = simClock();
    const learner = createLearner({ agents: ['Arthur'], seed: 4, clock });
    const scorer = createScorer({ learner, seed: 9, clock, rules: { explore_rate: 0 } });
    teach(learner, clock, 'Arthur', OPTIONS[3], Array(30).fill(true));        // building has gone well
    teach(learner, clock, 'Arthur', OPTIONS[0], Array(30).fill(false));
    teach(learner, clock, 'Arthur', OPTIONS[1], Array(30).fill(false));
    teach(learner, clock, 'Arthur', OPTIONS[2], Array(30).fill(false));
    const fresh = scorer.choose({ agent: 'Arthur', options: OPTIONS, situate: {}, started_builds: [] });
    assert.notEqual(fresh.chosen.skill, 'build_blueprint', 'the best-scored option is a build, but no build is started while the model is away');
    assert.equal(fresh.ranked[0].skill, 'build_blueprint', 'it is still ranked and shown');
    const going = scorer.choose({ agent: 'Arthur', options: OPTIONS, situate: {}, started_builds: ['arthur-1'] });
    assert.equal(going.chosen.id, 'build_blueprint:arthur-1', 'a started build is continued');
    assert.equal(going.decision.chooser, 'network');
    assert.equal(going.decision.default_choice, OPTIONS[0].id, 'what the unlearned rule would have taken is recorded beside it');
    assert.equal(going.decision.offered.length, 4);
    assert.equal(scorer.choose({ agent: 'Arthur', options: [OPTIONS[3]], situate: {} }).chosen, null, 'nothing else on offer: nothing is chosen');
    // need is computed by code and can turn the choice
    const needy = scorer.choose({ agent: 'Arthur', options: OPTIONS.slice(0, 3), situate: {}, need: (o) => (o.skill === 'travel' ? 50 : 1) });
    assert.equal(needy.chosen.id, 'travel:ring-1');
});

test('exploration: about 1 choice in 4 goes to an uncertain option, at night and when hurt as well', () => {
    assert.equal(SCORER_RULES.explore_rate, 0.25);
    assert.equal(SCORER_RULES.explore_danger_cap, null, 'decided: no guard on exploration');
    const clock = simClock();
    const learner = createLearner({ agents: ['Felix'], seed: 4, clock });
    teach(learner, clock, 'Felix', OPTIONS[2], Array(60).fill(true));        // well known and good
    for (const [name, situation] of [['by day and healthy', { health: 20, daylight_left: 6000 }], ['at night with 4 health', { health: 4, daylight_left: 0 }]]) {
        const scorer = createScorer({ learner, seed: 31, clock });
        let explored = 0;
        const tried = new Set();
        for (let i = 0; i < 2000; i++) {
            const out = scorer.choose({ agent: 'Felix', options: OPTIONS.slice(0, 3), situate: situation });
            if (out.explore) { explored++; tried.add(out.chosen.id); assert.equal(out.decision.explore, true); assert.notEqual(out.chosen.id, 'craft_item:oak_planks:4'); }
            else assert.equal(out.chosen.id, 'craft_item:oak_planks:4');
        }
        // one draw in four explores; a third of those land on the best option anyway and are not marked
        assert.ok(explored > 0.12 * 2000 && explored < 0.22 * 2000, `${name}: ${explored} of 2000 choices were exploratory`);
        assert.deepEqual([...tried].sort(), ['gather_blocks:oak_log:8', 'travel:ring-1'], `${name}: the uncertain options are the ones tried`);
    }
    const off = createScorer({ learner, seed: 31, clock });
    for (let i = 0; i < 200; i++) assert.equal(off.choose({ agent: 'Felix', options: OPTIONS.slice(0, 3), situate: {}, explore: false }).explore, false);
    // the same seed makes the same exploratory choices
    const a = createScorer({ learner, seed: 5, clock });
    const b = createScorer({ learner, seed: 5, clock });
    const picks = (s) => Array.from({ length: 100 }, () => s.choose({ agent: 'Felix', options: OPTIONS.slice(0, 3), situate: {} }).chosen.id).join();
    assert.equal(picks(a), picks(b));
});

test('exploration (simulation, not Minecraft): an option with a wrongly bad start but truly good is found with exploration, and stays unused without it', () => {
    const run = (explore) => {
        const clock = simClock();
        const learner = createLearner({ agents: ['Mira'], seed: 8, clock });
        const [good, wronged] = [OPTIONS[2], OPTIONS[0]];
        teach(learner, clock, 'Mira', good, Array(20).fill(true));
        teach(learner, clock, 'Mira', wronged, Array(6).fill(false));        // six bad breaks: it looks bad, it is not
        const scorer = createScorer({ learner, seed: 12, clock });
        const truth = createRng(99);
        let tried = 0;
        for (let i = 0; i < 500; i++) {
            const out = scorer.choose({ agent: 'Mira', options: [good, wronged], situate: {}, explore });
            if (out.chosen.id === wronged.id) tried++;
            teach(learner, clock, 'Mira', out.chosen, [truth.chance(0.9)]);    // both truly succeed 9 times in 10
        }
        return { tried, estimate: learner.table.predict('Mira', wronged).p_ok };
    };
    const on = run(true);
    const off = run(false);
    assert.ok(on.tried >= 20, `with exploration it was tried ${on.tried} times in 500`);
    assert.ok(off.tried < 5, `without exploration it was tried ${off.tried} times in 500`);
    assert.ok(on.estimate > 0.7 && off.estimate < 0.5, `estimates ${on.estimate} and ${off.estimate}`);
});

// ---- the learner's rules ---------------------------------------------------------------------------

test('learner: the rules it runs by', () => {
    assert.deepEqual(
        [LEARNING_RULES.replay_max, LEARNING_RULES.replay_recent, LEARNING_RULES.batch, LEARNING_RULES.window, LEARNING_RULES.bench_margin, LEARNING_RULES.gate_holdout, LEARNING_RULES.keep_versions],
        [40000, 2000, 32, 300, 0.05, 0.15, 30],
    );
    assert.throws(() => createLearner({ agents: [] }), /needs the list of agents/);
});

test('learner: a full world reset keeps the network and the count table and wipes the remembered places', () => {
    const clock = simClock();
    const learner = createLearner({ agents: [...SIM_AGENTS], seed: 6, clock });
    simulateGoals(learner, createSim({ seed: 3 }), 120, { clock });
    assert.ok(learner.place.size() > 0);
    const before = { hash: learner.liveHash(), table: JSON.stringify(learner.table.toJSON()), examples: learner.status().examples, version: learner.version() };
    learner.worldReset();
    assert.equal(learner.place.size(), 0, 'remembered places are wiped');
    assert.equal(learner.history.snapshot('Felix', 'travel:ring-1', 'travel', clock.now()).mins_since_death, null);
    assert.equal(learner.liveHash(), before.hash, 'the network is kept');
    assert.equal(JSON.stringify(learner.table.toJSON()), before.table, 'the count table is kept');
    assert.deepEqual([learner.status().examples, learner.version()], [before.examples, before.version]);
    // and the kept state goes through a restart
    const again = createLearner({ agents: [...SIM_AGENTS], seed: 6, clock });
    assert.equal(again.importState(JSON.parse(JSON.stringify(learner.exportState()))), true);
    assert.deepEqual(again.table.predict('Arthur', GATHER), learner.table.predict('Arthur', GATHER));
});

test('learner (simulation, not Minecraft): through the storage layer, every row has its prediction stamped before its outcome', async () => {
    const clock = simClock();
    const learner = createLearner({ agents: [...SIM_AGENTS], seed: 6, clock });
    const scorer = createScorer({ learner, seed: 2, clock });
    const sim = createSim({ seed: 21 });
    const store = memoryLearningStore();
    for (let i = 0; i < 50; i++) {
        // three offered options for one agent; the scorer picks; the outcome comes from the invented rule
        const cases = [sim.next(), sim.next(), sim.next()].map((c, k) => ({ ...c, option: { ...c.option, id: `${c.option.id}#${k}` } }));
        const agent = cases[0].agent;
        const out = scorer.choose({ agent, options: cases.map((c) => c.option), situate: (option) => cases.find((c) => c.option.id === option.id).raw });
        const picked = cases.find((c) => c.option.id === out.chosen.id);
        await store.recordDecision({ ...out.decision, decision_id: `d${i}` });
        const now = clock.now();
        await store.beginExperience({ id: `e${i}`, agent, decision_id: `d${i}`, option_id: out.chosen.id, skill: out.chosen.skill, args: out.chosen.args, chooser: 'network', explore: out.explore,
            situation: out.chosen.situation, predicted: out.chosen.predicted, predicted_at: now, started_at: now, world_sha256: 'simulation' });
        clock.advance(picked.end.duration_ms);
        learner.observe(await store.endExperience(`e${i}`, { ...picked.end, ended_at: clock.now() }));
    }
    const rows = await store.listExperience();
    const decisions = await store.listDecisions();
    assert.deepEqual([rows.length, decisions.length], [50, 50]);
    for (const row of rows) {
        for (const field of EXPERIENCE_FIELDS) assert.notEqual(row[field], undefined, `${field} is missing`);
        assert.ok(row.predicted_at <= row.started_at && row.started_at < row.ended_at, 'prediction, then the goal, then the outcome');
        assert.deepEqual(checkPredicted(row.predicted), []);
        assert.equal(decisions.find((d) => d.decision_id === row.decision_id).chosen, row.option_id);
    }
    assert.equal(learner.status().examples, 50);
});

// ---- what the Learning screen is fed ------------------------------------------------------------------

test('learning view (simulation data): the fields of the approved mock-up that can be computed today', () => {
    const clock = simClock();
    const learner = createLearner({ agents: [...SIM_AGENTS], seed: 6, clock, rules: { curve_every: 10 } });
    const experiences = simulateGoals(learner, createSim({ seed: 3 }), 600, { clock, keep: true });
    const decisions = [
        ...Array(7).fill({ agent: 'Arthur', chooser: 'network', chosen: 'gather_blocks:oak_log:16', default_choice: 'gather_blocks:oak_log:8' }),
        ...Array(3).fill({ agent: 'Arthur', chooser: 'network', chosen: 'gather_blocks:birch_log:8', default_choice: 'gather_blocks:oak_log:8', explore: true }),
        { agent: 'Arthur', chooser: 'planner', chosen: ['a'], default_choice: 'b' },
        { agent: 'Mira', chooser: 'network', chosen: 'travel:home', default_choice: 'travel:home' },
    ];
    const lessons = [{ id: 'l1', agent: 'Felix', body: 'The north ridge is a wall to me.', state: 'active', created_at: clock.now(), basis: [{ stat_id: 'travel|climb|a', statement: 'Travel, climb over 6', value: 4, n: 26 }] }];
    const plays = [{ id: 'p1', agent: 'Mira', name: 'Noon bake', steps: [{ skill: 'harvest_replant', args: {} }], tried: 23, worked: 22, state: 'active' }];
    const view = learningView({ status: learner.status(), versions: learner.versions(), decisions, experiences, lessons, plays, roles: { Arthur: 'Builder' }, now: clock.now() });

    assert.deepEqual(Object.keys(view.header).sort(), ['error', 'examples', 'frozen', 'in_use', 'table_error', 'trying', 'updated_at', 'version']);
    assert.equal(view.header.examples, 600);
    assert.deepEqual(view.header.in_use.of, 4);
    assert.equal(view.header.trying.text, '1 in 4');
    assert.ok(view.header.error > 0 && view.header.table_error > 0);
    assert.deepEqual(view.agents.map((a) => a.name), [...SIM_AGENTS]);
    const arthur = view.agents[0];
    assert.equal(arthur.role, 'Builder');
    assert.ok(['In use', 'Table'].includes(arthur.state));
    assert.equal(arthur.examples.own + arthur.examples.from_others, 600);
    assert.equal(view.agents.reduce((n, a) => n + a.examples.own, 0), 600);
    assert.ok(arthur.called_right.window > 0 && arthur.called_right.network > 0.3 && arthur.called_right.table > 0.3);
    assert.ok(arthur.error.curve.length >= 5 && arthur.error.curve.every((p) => p.net > 0 && p.table > 0 && p.examples > 0));
    assert.equal(arthur.calibration.length, 3);
    assert.equal(arthur.calibration.reduce((n, row) => n + row.n, 0), arthur.called_right.window <= 200 ? arthur.examples.own : arthur.calibration.reduce((n, row) => n + row.n, 0));
    for (const row of arthur.calibration.filter((r) => r.n > 0)) assert.ok(row.said >= 0 && row.said <= 1 && row.happened >= 0 && row.happened <= 1);
    assert.ok(arthur.most_sure.length > 0 && arthur.most_sure.every((o) => o.n >= 20 && o.p_ok > 0));
    assert.equal(arthur.least_sure.length, 2);
    assert.deepEqual(arthur.changed, [{ text: 'Gather oak log: 16, was 8', n: 7, explore: 0 }, { text: 'Gather: birch log 8 before oak log 8', n: 3, explore: 3 }]);
    assert.deepEqual(view.agents[1].changed, [], 'a choice that equals the default is no change');
    assert.deepEqual([view.lessons.active, view.lessons.list[0].written_by, view.lessons.list[0].basis[0].label], [1, 'Model', 'Computed']);
    assert.deepEqual([view.plays.active, view.plays.list[0].worked, view.plays.list[0].tried], [1, 22, 23]);
    assert.ok(view.versions.length >= 1 && view.versions.every((v) => typeof v.state === 'string' && Number.isInteger(v.v)));

    // the computed statements: only with 20 examples on each side, strongest first, in the shape a lesson's basis takes
    const all = statements(experiences);
    assert.ok(all.length > 0);
    for (const s of all) assert.ok(s.n >= 20 && s.against.n >= 20 && s.value <= s.n && typeof s.stat_id === 'string');
    const climb = all.find((s) => s.stat_id === 'travel|climb|a');
    assert.ok(climb && climb.share < climb.against.share - 0.3, 'the invented rule (big climbs fail) shows up as a computed statement');
    assert.equal(climb.statement, 'Travel, climb over 6');
    assert.deepEqual(statements(experiences.slice(0, 30)), [], 'too few examples: nothing is stated');
    assert.equal(behaviourChanges(decisions, { limit: 1 }).length, 1);
});

test('rng: seeded, and a name always hashes to the same number', () => {
    const a = createRng(7);
    const b = createRng(7);
    assert.deepEqual(Array.from({ length: 5 }, () => a()), Array.from({ length: 5 }, () => b()));
    assert.notEqual(createRng(8)(), createRng(7)());
    assert.equal(hashText('oak_log'), hashText('oak_log'));
    assert.notEqual(hashText('oak_log'), hashText('birch_log'));
    const r = createRng(1);
    for (let i = 0; i < 100; i++) assert.ok(r.int(5) >= 0 && r.int(5) < 5);
});
