// Step 6: the goal store and the checkpoint writer/loader.
//
// Storage is injected. Most tests use the in-memory stand-ins from helpers/fakes.mjs; the
// checkpoint tests that are about real files (a truncated file, a hard kill) use a
// temporary folder and genesis/store/node_files.js. No Postgres anywhere: its adapters
// are only checked against the migration files, statement by statement.
// Run from the repository root:  node --test genesis/tests/*.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { REPO_ROOT } from './helpers/stubs.mjs';
import { fakeClock, fakeFiles, fakeMirror, fakeGoalStorage, recordingPool, settle } from './helpers/fakes.mjs';
import { createGoalStore, goalChangedEventData, GOAL_LIMITS } from '../store/goal_store.js';
import {
    createCheckpointStore, createCheckpointer, checkCheckpoint, currentStep, encodeCheckpoint, decodeCheckpoint,
    STEP_STATUSES, CHECKPOINT_INTERVAL_MS,
} from '../store/checkpoint.js';
import { nodeFiles } from '../store/node_files.js';
import { pgCallStore, pgGoalStorage, pgCheckpointMirror } from '../adapters/pg_stores.js';
import { CALL_RECORD_FIELDS, CALL_OUTCOMES, makeCallRecord } from '../broker/call_record.js';
import { checkEventData, GOAL_SOURCES, GOAL_SCOPES } from '../shared/events.js';
import { createBudget } from '../broker/budget.js';

// ---- the goal store ----

const PLANNER = { reason: 'the hall needs a roof before winter', source: 'planner', call_id: 'call-0001' };
const OPERATOR = { reason: 'set by the operator at world start', source: 'operator' };
const goals = (...titles) => titles.map((title) => ({ title }));

function goalSetup() {
    const storage = fakeGoalStorage();
    const clock = fakeClock();
    const seen = [];
    const store = createGoalStore({ storage, clock, onChange: (change) => seen.push(change) });
    return { store, storage, clock, seen };
}

test('goals: a goal change with no reason is refused', async () => {
    const { store, storage, seen } = goalSetup();
    assert.equal((await store.setLongTerm('Arthur', goals('Build the great hall'), OPERATOR)).ok, true);

    for (const reason of [undefined, null, '', '   ', '\n\t', 42, ['because'], {}]) {
        for (const attempt of [
            () => store.setLongTerm('Arthur', goals('Rule the village'), { ...PLANNER, reason }),
            () => store.setShortTerm('Arthur', goals('Collect oak logs'), { ...PLANNER, reason }),
            () => store.pushShortTerm('Arthur', { title: 'Collect oak logs' }, { source: 'executor', reason }),
            () => store.shiftShortTerm('Arthur', { source: 'routine', reason }),
        ]) {
            const result = await attempt();
            assert.equal(result.ok, false, `accepted the reason ${JSON.stringify(reason)}`);
            assert.equal(result.code, 'reason_required');
        }
    }
    assert.equal((await store.setShortTerm('Arthur', goals('Collect oak logs'))).code, 'reason_required'); // no meta at all

    // nothing was changed, stored or announced by the refused attempts
    assert.deepEqual((await store.get('Arthur')).goals.long_term.map((g) => g.title), ['Build the great hall']);
    assert.deepEqual((await store.get('Arthur')).goals.short_term, []);
    assert.equal(storage.changes.length, 1);
    assert.equal(seen.length, 1);
});

test('goals: long-term goals stay within 1 to 3', async () => {
    const { store, storage } = goalSetup();
    // an agent never seen has none yet; the first change must already give 1 to 3
    assert.deepEqual((await store.get('Mira')).goals, { long_term: [], short_term: [] });
    assert.equal((await store.setLongTerm('Mira', [], OPERATOR)).code, 'too_few');
    assert.equal((await store.setLongTerm('Mira', goals('a', 'b', 'c', 'd'), OPERATOR)).code, 'too_many');
    assert.deepEqual(storage.changes, []);

    for (const count of [1, 2, 3]) {
        const titles = ['Feed the village', 'Breed cows', 'Plant an orchard'].slice(0, count);
        const result = await store.setLongTerm('Mira', goals(...titles), OPERATOR);
        assert.equal(result.ok, true, result.error);
        assert.equal(result.goals.long_term.length, count);
    }
    // from 3 goals: no way to 0 and no way to 4, whoever asks
    for (const source of GOAL_SOURCES) {
        const meta = { reason: 'trying the limits', source, call_id: source === 'planner' ? 'call-9' : null };
        assert.equal((await store.setLongTerm('Mira', [], meta)).code, 'too_few');
        assert.equal((await store.setLongTerm('Mira', goals('1', '2', '3', '4'), meta)).code, 'too_many');
    }
    const kept = (await store.get('Mira')).goals.long_term;
    assert.deepEqual(kept.map((g) => g.title), ['Feed the village', 'Breed cows', 'Plant an orchard']);
    assert.ok(kept.length >= GOAL_LIMITS.long_term_min && kept.length <= GOAL_LIMITS.long_term_max);
    assert.equal(storage.changes.length, 3);
    assert.deepEqual(storage.goals.get('Mira').long_term, kept);
});

test('goals: the short-term queue holds up to 3 goals', async () => {
    const { store } = goalSetup();
    const meta = { reason: 'next steps for the hall', source: 'executor' };
    for (const title of ['Collect oak logs', 'Craft planks', 'Place the floor']) {
        assert.equal((await store.pushShortTerm('Arthur', { title }, meta)).ok, true);
    }
    const full = await store.pushShortTerm('Arthur', { title: 'Raise the walls' }, meta);
    assert.deepEqual([full.ok, full.code], [false, 'too_many']);
    assert.equal((await store.setShortTerm('Arthur', goals('a', 'b', 'c', 'd'), meta)).code, 'too_many');

    const shifted = await store.shiftShortTerm('Arthur', { reason: 'done: 8 oak logs collected', source: 'executor' });
    assert.deepEqual(shifted.goals.short_term.map((g) => g.title), ['Craft planks', 'Place the floor']);
    assert.equal((await store.pushShortTerm('Arthur', { title: 'Raise the walls' }, meta)).ok, true);
    assert.equal((await store.setShortTerm('Arthur', [], { reason: 'night fell, plans dropped', source: 'routine' })).ok, true);
    assert.equal((await store.shiftShortTerm('Arthur', meta)).code, 'no_change'); // nothing to take off
});

test('goals: every change is recorded with before, after, reason, source, call id and timestamp', async () => {
    const { store, storage, clock, seen } = goalSetup();
    await store.setLongTerm('Nova', goals('Own the market'), OPERATOR);
    await clock.advance(5000);
    const result = await store.setShortTerm('Nova',
        [{ title: 'Trade wheat with Mira', option_id: 'trade_mira' }, { title: 'Stock the stall', option_id: 'stock' }],
        { reason: '  prices are high this week  ', source: 'planner', call_id: 'call-0042' });
    assert.equal(result.ok, true);

    assert.equal(storage.changes.length, 2);
    const [first, second] = storage.changes;
    assert.deepEqual(Object.keys(second), ['id', 'agent', 'scope', 'before', 'after', 'reason', 'source', 'call_id', 'ts']);
    assert.deepEqual({ ...first, id: null, after: first.after.map((g) => g.title) }, {
        id: null, agent: 'Nova', scope: 'long_term', before: [], after: ['Own the market'],
        reason: 'set by the operator at world start', source: 'operator', call_id: null, ts: '2026-01-01T00:00:00.000Z',
    });
    assert.equal(second.agent, 'Nova');
    assert.equal(second.scope, 'short_term');
    assert.deepEqual(second.before, []);
    assert.deepEqual(second.after.map((g) => [g.title, g.option_id]), [['Trade wheat with Mira', 'trade_mira'], ['Stock the stall', 'stock']]);
    assert.ok(second.after.every((g) => typeof g.id === 'string' && g.id.length > 0));
    assert.equal(second.reason, 'prices are high this week');
    assert.equal(second.source, 'planner');
    assert.equal(second.call_id, 'call-0042');
    assert.equal(second.ts, '2026-01-01T00:00:05.000Z');
    assert.notEqual(first.id, second.id);
    assert.deepEqual(result.change, second);
    assert.deepEqual(seen, storage.changes);
    // "before" of the next change is "after" of this one
    const third = await store.shiftShortTerm('Nova', { reason: 'done: traded 12 wheat', source: 'executor' });
    assert.deepEqual(third.change.before, second.after);
    // a change fits the goal.changed event as it is
    for (const change of storage.changes) assert.deepEqual(checkEventData('goal.changed', goalChangedEventData(change)), []);
});

test('goals: a source outside the four, a planner change without its call id, and malformed goals are refused', async () => {
    const { store, storage } = goalSetup();
    const refused = async (promise, code) => {
        const result = await promise;
        assert.deepEqual([result.ok, result.code], [false, code], JSON.stringify(result));
    };
    for (const source of [undefined, 'model', 'Arthur', '']) {
        await refused(store.setLongTerm('Felix', goals('Map the world'), { reason: 'r', source }), 'bad_source');
    }
    await refused(store.setLongTerm('Felix', goals('Map the world'), { reason: 'r', source: 'planner' }), 'call_id_required');
    await refused(store.setLongTerm('Felix', goals('Map the world'), { reason: 'r', source: 'operator', call_id: 7 }), 'bad_call_id');
    await refused(store.setLongTerm('', goals('Map the world'), OPERATOR), 'bad_agent');
    for (const bad of [null, 'Map the world', [null], ['Map the world'], [{ title: '' }], [{ title: 'x'.repeat(61) }],
        [{ title: 'ok', id: '' }], [{ title: 'ok', option_id: 5 }], [{ id: 'same', title: 'a' }, { id: 'same', title: 'b' }]]) {
        await refused(store.setLongTerm('Felix', bad, OPERATOR), 'bad_goals');
    }
    assert.deepEqual(storage.changes, []);
    assert.equal((await store.setLongTerm('Felix', goals('Map the world'), OPERATOR)).ok, true);
    await refused(store.setLongTerm('Felix', (await store.get('Felix')).goals.long_term, OPERATOR), 'no_change');
    assert.deepEqual([...GOAL_SCOPES], ['long_term', 'short_term']);
});

test('goals: when the storage fails the change is refused and the goals stay as they were', async () => {
    const { store, storage, seen } = goalSetup();
    await store.setLongTerm('Mira', goals('Feed the village'), OPERATOR);
    storage.failing = true;
    const result = await store.setLongTerm('Mira', goals('Feed the village', 'Breed cows'), OPERATOR);
    assert.deepEqual([result.ok, result.code], [false, 'storage_error']);
    assert.deepEqual((await store.get('Mira')).goals.long_term.map((g) => g.title), ['Feed the village']);
    assert.equal(seen.length, 1);
    // an agent whose goals cannot even be loaded: refused, not thrown
    assert.equal((await store.get('Nova')).code, 'storage_error');
    assert.equal((await store.setLongTerm('Nova', goals('Own the market'), OPERATOR)).code, 'storage_error');
    storage.failing = false;
    assert.equal((await store.setLongTerm('Mira', goals('Feed the village', 'Breed cows'), OPERATOR)).ok, true);
});

test('goals: they are read back from storage after a restart, and changes of one agent do not interleave', async () => {
    const { store, storage, clock } = goalSetup();
    await store.setLongTerm('Arthur', goals('Build the great hall'), OPERATOR);
    const meta = { reason: 'queued by the executor', source: 'executor' };
    const results = await Promise.all(['one', 'two', 'three', 'four'].map((title) => store.pushShortTerm('Arthur', { title }, meta)));
    assert.deepEqual(results.map((r) => r.ok), [true, true, true, false]);
    assert.deepEqual(storage.changes.slice(1).map((c) => [c.before.length, c.after.length]), [[0, 1], [1, 2], [2, 3]]);

    const restarted = createGoalStore({ storage, clock });
    const { goals: loaded } = await restarted.get('Arthur');
    assert.deepEqual(loaded.long_term.map((g) => g.title), ['Build the great hall']);
    assert.deepEqual(loaded.short_term.map((g) => g.title), ['one', 'two', 'three']);
    assert.equal((await restarted.pushShortTerm('Arthur', { title: 'four' }, meta)).code, 'too_many');
});

// ---- the checkpoint ----

// A checkpoint in the middle of a plan: steps 0 and 1 done, step 2 active (3 of 8 placed), the rest waiting.
function midPlan(overrides = {}) {
    return {
        v: 1,
        agent: 'Arthur',
        seq: 1042,
        saved_at: '2026-01-01T12:00:00.000Z',
        plan: {
            id: 'plan-0007',
            goal: 'Build the great hall',
            source: 'model',
            cursor: 2,
            steps: [
                { i: 0, command: '!collectBlocks', args: ['oak_log', 8], status: 'done', attempts: 1, progress: { done: 8, total: 8 } },
                { i: 1, command: '!craftRecipe', args: ['oak_planks', 8], status: 'done', attempts: 2, progress: { done: 8, total: 8 } },
                { i: 2, command: '!placeHere', args: ['oak_planks'], status: 'active', attempts: 1, progress: { done: 3, total: 8 } },
                { i: 3, command: '!goToRememberedPlace', args: ['quarry'], status: 'pending', attempts: 0, progress: { done: 0, total: null } },
                { i: 4, command: '!collectBlocks', args: ['stone', 16], status: 'parked', attempts: 3, progress: { done: 5, total: 16 } },
                { i: 5, command: '!goToBed', args: [], status: 'skipped', attempts: 0, progress: { done: 0, total: 0 } },
            ],
        },
        routine: { name: 'evening', phase: 'return_home' },
        position: { x: -112.5, y: 64, z: 230.25, dimension: 'overworld' },
        places: { home: [-110, 64, 228], quarry: [40, 52, -17], 'Mira\'s farm ☘': [0, 70, 0], 10: [1, 2, 3], 2: [4, 5, 6] },
        pending_request: { id: '01JZ0000000000000000000000', kind: 'plan', queued_at: '2026-01-01T11:59:30.000Z' },
        budgets: { Arthur: { calls: [[1767268800000, 1767268812000]] } },
        ...overrides,
    };
}

function checkpointSetup({ with_mirror = false } = {}) {
    const files = fakeFiles();
    const mirror = with_mirror ? fakeMirror() : null;
    const reports = [];
    const clock = fakeClock();
    const store = createCheckpointStore({ files, dir: '/data/checkpoints', mirror, clock, report: (problem) => reports.push(problem) });
    return { store, files, mirror, reports, clock, file: '/data/checkpoints/Arthur.checkpoint.json' };
}

test('checkpoint: one written mid-plan loads back identically and reports the same current step', async () => {
    const { store, files, file } = checkpointSetup();
    const written = midPlan();
    assert.deepEqual(checkCheckpoint(written), []);
    assert.deepEqual(await store.write(written), { ok: true, path: file });

    // a new store, as after a restart of the process
    const reloaded = createCheckpointStore({ files, dir: '/data/checkpoints' });
    const loaded = await reloaded.load('Arthur');
    assert.equal(loaded.status, 'ok');
    assert.equal(loaded.from, 'file');
    assert.deepEqual(loaded.checkpoint, written);
    assert.equal(JSON.stringify(loaded.checkpoint), JSON.stringify(written)); // also the same order of fields
    assert.notEqual(loaded.checkpoint, written);
    assert.deepEqual(loaded.current_step, written.plan.steps[2]);
    assert.deepEqual(loaded.current_step, currentStep(written));
    assert.deepEqual([loaded.current_step.i, loaded.current_step.command, loaded.current_step.status], [2, '!placeHere', 'active']);
    assert.deepEqual(loaded.current_step.progress, { done: 3, total: 8 });
    // what the rest of the system takes back from it
    assert.equal(loaded.checkpoint.seq, 1042);
    const budget = createBudget();
    budget.restore(loaded.checkpoint.budgets);
    assert.equal(budget.usage('Arthur', 1767268800000 + 1000).used, 1);

    assert.deepEqual([...files.store.keys()], [file]); // no temporary file is left behind
});

test('checkpoint: the same through real files, and the current step when there is none', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'genesis-checkpoint-'));
    const store = createCheckpointStore({ files: nodeFiles(), dir: path.join(dir, 'nested', 'checkpoints') });
    assert.deepEqual(await store.load('Arthur'), { status: 'missing', checkpoint: null, current_step: null });

    const finished = midPlan({ agent: 'Mira', plan: { ...midPlan().plan, cursor: 6, steps: midPlan().plan.steps.map((s) => ({ ...s, status: 'done' })) } });
    const idle = midPlan({ agent: 'Felix', plan: null, routine: null, pending_request: null });
    for (const checkpoint of [midPlan(), finished, idle]) {
        assert.equal((await store.write(checkpoint)).ok, true);
        const loaded = await createCheckpointStore({ files: nodeFiles(), dir: path.join(dir, 'nested', 'checkpoints') }).load(checkpoint.agent);
        assert.equal(loaded.status, 'ok');
        assert.deepEqual(loaded.checkpoint, checkpoint);
    }
    assert.equal((await store.load('Arthur')).current_step.i, 2);
    assert.equal((await store.load('Mira')).current_step, null);  // the plan is finished
    assert.equal((await store.load('Felix')).current_step, null); // no plan
    assert.deepEqual(readdirSync(path.join(dir, 'nested', 'checkpoints')).sort(),
        ['Arthur.checkpoint.json', 'Felix.checkpoint.json', 'Mira.checkpoint.json']);
});

test('checkpoint: a truncated file is reported as corrupt without throwing', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'genesis-checkpoint-'));
    const reports = [];
    const store = createCheckpointStore({ files: nodeFiles(), dir, report: (problem) => reports.push(problem) });
    await store.write(midPlan());
    const file = store.pathFor('Arthur');
    const text = readFileSync(file, 'utf8');
    assert.equal(text, encodeCheckpoint(midPlan()));

    // cut the real file at many lengths, among them an empty file and one that lacks only the last brace
    const lengths = [0, 1, 10, 80, 81, Math.floor(text.length / 3), Math.floor(text.length / 2), text.length - 20, text.length - 3, text.length - 2];
    for (const length of lengths) {
        writeFileSync(file, text.slice(0, length));
        reports.length = 0;
        const loaded = await store.load('Arthur'); // must not throw
        assert.equal(loaded.status, 'corrupt', `a file cut to ${length} of ${text.length} characters was accepted`);
        assert.equal(loaded.checkpoint, null);
        assert.equal(loaded.current_step, null);
        assert.equal(loaded.path, file);
        assert.ok(loaded.reason.length > 0);
        assert.equal(reports.length, 1);
        assert.deepEqual([reports[0].problem, reports[0].agent, reports[0].path], ['checkpoint_corrupt', 'Arthur', file]);
    }
    // every possible cut is caught (in memory, no need for the disk)
    for (let length = 0; length < text.length - 1; length++) {
        assert.equal(decodeCheckpoint(text.slice(0, length)).ok, false, `cut at ${length}`);
    }
    assert.equal(store.stats().corrupt_found, lengths.length);

    // the next write replaces the damaged file, and loading works again
    assert.equal((await store.write(midPlan({ seq: 1043 }))).ok, true);
    assert.equal((await store.load('Arthur')).checkpoint.seq, 1043);
});

test('checkpoint: damage that leaves valid JSON behind is caught too', async () => {
    const { store, files, file, reports } = checkpointSetup();
    await store.write(midPlan());
    const good = files.store.get(file);
    const damaged = {
        'a changed digit': good.replace('"cursor":2', '"cursor":3'),
        'a changed word': good.replace('!placeHere', '!placeThere'),
        'not a checkpoint file': JSON.stringify(midPlan()),
        'no hash': JSON.stringify({ checkpoint: midPlan() }),
        'another agent\'s file': encodeCheckpoint(midPlan({ agent: 'Mira' })),
        'a checkpoint that breaks the rules': encodeCheckpoint(midPlan({ seq: -1 })),
        'binary rubbish': '\u0000\u0000\u0000\u0000',
        'a list': '[]',
        'null': 'null',
    };
    for (const [name, text] of Object.entries(damaged)) {
        files.store.set(file, text);
        const loaded = await store.load('Arthur');
        assert.equal(loaded.status, 'corrupt', `accepted: ${name}`);
    }
    assert.equal(reports.filter((r) => r.problem === 'checkpoint_corrupt').length, Object.keys(damaged).length);
    files.store.set(file, good);
    files.fail_read = new Error('EIO: i/o error, read');
    const unreadable = await store.load('Arthur');
    assert.equal(unreadable.status, 'corrupt');
    assert.match(unreadable.reason, /cannot be read \(EIO/);
    assert.equal((await store.load('Arthur')).status, 'ok');
    for (const name of ['', '../../etc/passwd', 'a/b', null, undefined, 42]) {
        assert.equal((await store.load(name)).status, 'missing'); // never a path outside the folder
    }
});

test('checkpoint: an atomic write never leaves a partial file (a failure between write and rename)', async () => {
    const { store, files, file, reports } = checkpointSetup();
    const old = midPlan({ seq: 1042 });
    assert.equal((await store.write(old)).ok, true);
    const old_text = files.store.get(file);

    // the new checkpoint is fully written to the temporary file, and then the rename fails
    files.fail_rename = new Error('EIO: i/o error, rename');
    const next_step = { ...midPlan().plan, cursor: 3 };
    next_step.steps = next_step.steps.map((step, i) => (i === 2 ? { ...step, status: 'done' } : i === 3 ? { ...step, status: 'active' } : step));
    const failed = await store.write(midPlan({ seq: 1043, plan: next_step }));
    assert.deepEqual([failed.ok, failed.code], [false, 'write_failed']);
    assert.match(failed.error, /EIO/);
    assert.equal(files.store.get(file), old_text, 'the checkpoint file was touched');
    assert.deepEqual((await store.load('Arthur')).checkpoint, old);
    assert.deepEqual(files.log.slice(-3).map((entry) => entry[0]), ['write', 'rename', 'remove']);
    assert.deepEqual(files.log.at(-3), ['write', `${file}.tmp`]); // the write never went to the real file

    // the write itself breaks half way (disk full, power cut): only the temporary file was hit
    files.partial_write = true;
    const partial = await store.write(midPlan({ seq: 1044 }));
    assert.deepEqual([partial.ok, partial.code], [false, 'write_failed']);
    assert.equal(files.store.get(file), old_text);
    assert.deepEqual((await store.load('Arthur')).checkpoint, old);

    // the process dies right after the write and before the rename: the half-made .tmp stays behind
    files.store.set(`${file}.tmp`, encodeCheckpoint(midPlan({ seq: 1045 })).slice(0, 200));
    const after_crash = createCheckpointStore({ files, dir: '/data/checkpoints' });
    const loaded = await after_crash.load('Arthur');
    assert.equal(loaded.status, 'ok');
    assert.deepEqual(loaded.checkpoint, old);
    assert.deepEqual(loaded.current_step, old.plan.steps[2]);

    // a disk that silently stores less than it was given is noticed before the rename
    const write = files.write;
    files.write = async (target, text) => { files.store.set(target, text.slice(0, -40)); };
    assert.equal((await store.write(midPlan({ seq: 1046 }))).ok, false);
    assert.equal(files.store.get(file), old_text);
    files.write = write;

    // at no point did the real file hold anything but a complete checkpoint
    assert.equal(reports.filter((r) => r.problem === 'checkpoint_write_failed').length, 3);
    assert.equal(reports.filter((r) => r.problem === 'checkpoint_corrupt').length, 0);
    const next = await store.write(midPlan({ seq: 1047 }));
    assert.equal(next.ok, true);
    assert.equal((await store.load('Arthur')).checkpoint.seq, 1047);
    assert.deepEqual([...files.store.keys()], [file]);
});

test('checkpoint: after a hard kill in the middle of writing, the file is a complete checkpoint and the step is the same', { timeout: 60000 }, async () => {
    const writer = path.join(REPO_ROOT, 'genesis', 'tests', 'helpers', 'checkpoint-writer.mjs');
    for (const kill_after_writes of [3, 17, 41]) {
        const dir = mkdtempSync(path.join(tmpdir(), 'genesis-hard-kill-'));
        const child = spawn(process.execPath, [writer, dir], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        child.stderr.on('data', (chunk) => { err += chunk; });
        const closed = once(child, 'close');
        child.stdout.on('data', (chunk) => {
            out += chunk;
            // kill -9 while it is busy with a later write: no warning, no clean-up
            if (out.split('\n').length - 1 >= kill_after_writes) child.kill('SIGKILL');
        });
        const [code, signal] = await closed;
        assert.equal(signal, 'SIGKILL', `the writer ended by itself (code ${code}): ${err}`);
        const acknowledged = out.trim().split('\n').map(Number);
        const last = acknowledged.at(-1);
        assert.ok(last >= kill_after_writes);

        const reports = [];
        const loaded = await createCheckpointStore({ files: nodeFiles(), dir, report: (p) => reports.push(p) }).load('Arthur');
        assert.equal(loaded.status, 'ok', JSON.stringify(reports));
        assert.deepEqual(reports, []);
        // the last completed write, or the one that was under way and got as far as the rename
        assert.ok(loaded.checkpoint.seq === last || loaded.checkpoint.seq === last + 1, `seq ${loaded.checkpoint.seq}, last acknowledged ${last}`);
        const cursor = loaded.checkpoint.seq % 40;
        assert.equal(loaded.checkpoint.plan.cursor, cursor);
        assert.deepEqual([loaded.current_step.i, loaded.current_step.status, loaded.current_step.command], [cursor, 'active', '!collectBlocks']);
        assert.deepEqual(loaded.current_step.args, ['oak_log', cursor + 1]);
        assert.ok(existsSync(path.join(dir, 'Arthur.checkpoint.json')));
    }
});

test('checkpoint: only a valid checkpoint is ever written', async () => {
    const { store, files, reports } = checkpointSetup();
    const steps = (change) => ({ ...midPlan().plan, steps: midPlan().plan.steps.map((step, i) => (i === 2 ? { ...step, ...change } : step)) });
    const invalid = {
        'no object': null,
        'wrong version': midPlan({ v: 2 }),
        'agent with a path in it': midPlan({ agent: '../Arthur' }),
        'negative seq': midPlan({ seq: -1 }),
        'saved_at not a time': midPlan({ saved_at: 'yesterday' }),
        'extra field': { ...midPlan(), inventory: {} },
        'missing field': (() => { const c = midPlan(); delete c.places; return c; })(),
        'cursor beyond the steps': midPlan({ plan: { ...midPlan().plan, cursor: 7 } }),
        'plan source': midPlan({ plan: { ...midPlan().plan, source: 'operator' } }),
        'step status': midPlan({ plan: steps({ status: 'running' }) }),
        'step index': midPlan({ plan: steps({ i: 9 }) }),
        'step args': midPlan({ plan: steps({ args: 'oak_planks' }) }),
        'step progress': midPlan({ plan: steps({ progress: { done: 'some', total: 8 } }) }),
        'active step away from the cursor': midPlan({ plan: { ...midPlan().plan, cursor: 0 } }),
        'position without a dimension': midPlan({ position: { x: 1, y: 2, z: 3 } }),
        'position not a number': midPlan({ position: { x: NaN, y: 2, z: 3, dimension: 'overworld' } }),
        'routine': midPlan({ routine: { name: '' } }),
        'pending request': midPlan({ pending_request: { id: 'r1' } }),
        'places': midPlan({ places: [] }),
        'budgets': midPlan({ budgets: null }),
    };
    for (const [name, checkpoint] of Object.entries(invalid)) {
        assert.ok(checkCheckpoint(checkpoint).length > 0, `passed the check: ${name}`);
        const result = await store.write(checkpoint);
        assert.deepEqual([result.ok, result.code], [false, 'invalid'], name);
    }
    assert.equal(files.store.size, 0);
    assert.equal(reports.length, Object.keys(invalid).length);
    for (const status of STEP_STATUSES) assert.deepEqual(checkCheckpoint(midPlan({ plan: steps({ status }) })), []);
});

test('checkpoint: mirrored to Postgres, which never holds anything up and is the fallback for a lost file', async () => {
    const { store, files, mirror, reports, file } = checkpointSetup({ with_mirror: true });
    assert.equal((await store.write(midPlan())).ok, true);
    await store.idle();
    assert.deepEqual(mirror.rows.get('Arthur'), midPlan());

    // Postgres down: the file is written all the same, the failure is counted and reported
    mirror.failing = true;
    const result = await store.write(midPlan({ seq: 1043 }));
    assert.equal(result.ok, true);
    await store.idle();
    assert.equal((await store.load('Arthur')).checkpoint.seq, 1043);
    assert.equal(store.stats().mirror_failures, 1);
    assert.deepEqual(reports.map((r) => r.problem), ['checkpoint_mirror_failed']);
    assert.equal(mirror.rows.get('Arthur').seq, 1042);

    // a mirror that never answers: writes go on, and only the newest checkpoint waits for it
    mirror.failing = false;
    let release;
    mirror.save = (checkpoint) => new Promise((resolve) => { release = () => { mirror.rows.set(checkpoint.agent, checkpoint); resolve(); }; });
    for (const seq of [1044, 1045, 1046, 1047]) assert.equal((await store.write(midPlan({ seq }))).ok, true);
    assert.equal((await store.load('Arthur')).checkpoint.seq, 1047);
    release();          // 1044 is through at last
    await settle();
    release();          // the next one sent is the newest, 1045 and 1046 were skipped
    await store.idle();
    assert.equal(mirror.rows.get('Arthur').seq, 1047);

    // the file is lost or damaged: the mirror's copy is used, and the damage is still reported
    reports.length = 0;
    files.store.set(file, files.store.get(file).slice(0, 300));
    const recovered = await store.load('Arthur');
    assert.deepEqual([recovered.status, recovered.from, recovered.file], ['ok', 'mirror', 'corrupt']);
    assert.equal(recovered.checkpoint.seq, 1047);
    assert.equal(recovered.current_step.i, 2);
    assert.deepEqual(reports.map((r) => r.problem), ['checkpoint_corrupt']);
    files.store.delete(file);
    assert.deepEqual([(await store.load('Arthur')).from, (await store.load('Arthur')).file], ['mirror', 'missing']);
    // file damaged and Postgres down as well: reported as corrupt, still nothing thrown
    files.store.set(file, 'garbage');
    mirror.load = async () => { throw new Error('connection terminated'); };
    assert.equal((await store.load('Arthur')).status, 'corrupt');
});

test('checkpoint: written at every step boundary and every 30 seconds', async () => {
    const { store, files, clock, file } = checkpointSetup();
    assert.equal(CHECKPOINT_INTERVAL_MS, 30000);
    const state = midPlan();
    delete state.saved_at;
    const checkpointer = createCheckpointer({ store, getState: () => state, clock });
    const seqOnDisk = () => (files.store.has(file) ? decodeCheckpoint(files.store.get(file)).checkpoint.seq : null);
    const writes = () => files.log.filter((entry) => entry[0] === 'rename').length;

    checkpointer.start();
    assert.equal(seqOnDisk(), null);
    await clock.advance(29_999);
    assert.equal(writes(), 0);
    await clock.advance(1);
    assert.equal(writes(), 1);
    assert.equal(decodeCheckpoint(files.store.get(file)).checkpoint.saved_at, '2026-01-01T00:00:30.000Z');

    // a step ends 7 seconds later: written at once, not at the next half minute
    await clock.advance(7000);
    state.seq = 1050;
    state.plan = { ...state.plan, cursor: 3, steps: state.plan.steps.map((s, i) => (i === 2 ? { ...s, status: 'done' } : i === 3 ? { ...s, status: 'active' } : s)) };
    assert.deepEqual(await checkpointer.stepBoundary(), { ok: true, path: file });
    assert.equal(writes(), 2);
    assert.equal(seqOnDisk(), 1050);
    assert.equal((await store.load('Arthur')).current_step.i, 3);

    await clock.advance(5 * 60_000);
    assert.equal(writes(), 2 + 10); // one every 30 seconds
    // a state that cannot be saved, or cannot even be read, is a result, not an exception
    state.seq = -5;
    assert.equal((await checkpointer.stepBoundary()).ok, false);
    const broken = createCheckpointer({ store, getState: () => { throw new Error('bot is gone'); }, clock });
    assert.deepEqual(await broken.saveNow(), { ok: false, code: 'state_error', error: 'bot is gone' });
    state.seq = 1051;

    // boundaries that come while a write is under way end in one more write with the newest state
    const slow_rename = files.rename;
    let let_go;
    files.rename = async (...args) => { await new Promise((resolve) => { let_go = resolve; }); return slow_rename(...args); };
    const first = checkpointer.stepBoundary();
    await settle();
    state.seq = 1052;
    const second = checkpointer.stepBoundary();
    state.seq = 1053;
    const third = checkpointer.stepBoundary();
    assert.equal(second, third);
    files.rename = slow_rename;
    let_go();
    await Promise.all([first, second]);
    assert.equal(seqOnDisk(), 1053);

    checkpointer.stop();
    const before = writes();
    await clock.advance(10 * 60_000);
    assert.equal(writes(), before);
    assert.equal(clock.pending(), 0);
});

// ---- the Postgres side: statements against the migration files (no database here) ----

function tableColumns(sql, table) {
    const body = sql.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`))?.[1];
    assert.ok(body, `no CREATE TABLE for ${table}`);
    return body.split('\n').map((line) => line.trim()).filter((line) => /^[a-z_]+\s+(text|jsonb|boolean|integer|bigint|real|timestamptz)\b/.test(line))
        .map((line) => line.split(/\s+/)[0]);
}

function placeholders(text) {
    return [...new Set([...text.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
}

test('postgres: the migrations hold the decided fields, and every statement fits them', async () => {
    const dir = path.join(REPO_ROOT, 'genesis', 'store', 'migrations');
    const names = readdirSync(dir).sort();
    assert.deepEqual(names, ['001_planner_calls.sql', '002_goals.sql', '003_checkpoints.sql', '004_learning.sql']);
    // the learning tables: a number that is not whole (health) is `real`, and the column reader knows it
    const learning = readFileSync(path.join(dir, '004_learning.sql'), 'utf8');
    assert.ok(tableColumns(learning, 'experience').includes('health_min') && tableColumns(learning, 'experience').includes('health_lost'));
    for (const table of ['experience', 'decisions', 'learning_versions', 'learning_state', 'lessons', 'plays', 'wishes', 'refusals', 'builds']) assert.ok(tableColumns(learning, table).length > 0, table);
    assert.ok([...learning.matchAll(/CREATE (TABLE|INDEX) (?!IF NOT EXISTS)/g)].length === 0, 'every statement can be run again');
    const sql = names.map((name) => readFileSync(path.join(dir, name), 'utf8')).join('\n');

    const call_columns = tableColumns(sql, 'planner_calls');
    for (const field of CALL_RECORD_FIELDS) {
        assert.ok(call_columns.includes(field === 'trigger' ? 'call_trigger' : field), `planner_calls has no column for ${field}`);
    }
    for (const outcome of CALL_OUTCOMES) assert.ok(sql.includes(`'${outcome}'`), `outcome ${outcome} is not allowed by the table`);
    assert.deepEqual(tableColumns(sql, 'goal_changes'), ['id', 'agent', 'scope', 'before', 'after', 'reason', 'source', 'call_id', 'ts']);
    for (const value of [...GOAL_SOURCES, ...GOAL_SCOPES]) assert.ok(sql.includes(`'${value}'`));
    assert.match(sql, /reason\s+text NOT NULL CHECK \(length\(btrim\(reason\)\) > 0\)/); // the database refuses an empty reason too
    assert.deepEqual(tableColumns(sql, 'agent_goals'), ['agent', 'long_term', 'short_term', 'updated_at']);
    assert.deepEqual(tableColumns(sql, 'agent_checkpoints'), ['agent', 'seq', 'saved_at', 'checkpoint', 'updated_at']);

    const pool = recordingPool([{ long_term: [], short_term: [], checkpoint: midPlan() }]);
    await pgCallStore(pool).record(makeCallRecord({ call_id: 'c1', agent: 'Arthur', trigger: 'idle', outcome: 'ok', valid: true }));
    const goal_change = { id: 'g1', agent: 'Arthur', scope: 'long_term', before: [], after: [{ id: 'a', title: 't', option_id: null }], reason: 'r', source: 'operator', call_id: null, ts: '2026-01-01T00:00:00.000Z' };
    await pgGoalStorage(pool).save('Arthur', { long_term: goal_change.after, short_term: [] }, goal_change);
    assert.deepEqual(await pgGoalStorage(pool).load('Arthur'), { long_term: [], short_term: [] });
    await pgCheckpointMirror(pool).save(midPlan());
    assert.deepEqual(await pgCheckpointMirror(pool).load('Arthur'), midPlan());
    assert.equal(await pgCheckpointMirror(recordingPool([])).load('Arthur'), null);
    assert.equal(await pgGoalStorage(recordingPool([])).load('Arthur'), null);

    assert.equal(pool.queries.length, 5);
    for (const { text, values } of pool.queries) {
        // $1..$n with no gap, and exactly n values
        assert.deepEqual(placeholders(text), values.map((_, i) => i + 1), text);
        assert.ok(values.every((value) => value !== undefined), `an undefined value in: ${text}`);
        const table = text.match(/(?:INSERT INTO|FROM) ([a-z_]+)/)[1];
        const columns = tableColumns(sql, table);
        for (const list of text.matchAll(/INSERT INTO ([a-z_]+)\s*\(([^)]*)\)/g)) {
            const known = tableColumns(sql, list[1]);
            for (const column of list[2].split(',').map((c) => c.trim())) assert.ok(known.includes(column), `${list[1]} has no column ${column}`);
        }
        assert.ok(columns.length > 0);
    }
    const call_insert = pool.queries[0];
    assert.equal(call_insert.values.length, CALL_RECORD_FIELDS.length);
    assert.equal(call_insert.values[3], 'idle'); // the record's trigger goes to call_trigger
});
