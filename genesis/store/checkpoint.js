// Genesis: the checkpoint of an agent. Written atomically at every step boundary and every
// 30 seconds, and mirrored to Postgres. After a hard kill the agent loads it and resumes
// the same step. A corrupt file is detected and reported, never thrown at the agent.
//
// Checkpoint:
//   {"v":1,"agent","seq","saved_at",
//    "plan":{"id","goal","source":"model|routine","cursor",
//            "steps":[{"i","command","args","status":"pending|active|done|parked|skipped","attempts","progress":{"done","total"}}]},
//    "routine":{"name","phase"}|null,
//    "position":{"x","y","z","dimension"},
//    "places":{},"pending_request":{"id","kind","queued_at"}|null,"budgets":{},
//    "hold":{"by","reason","at"}|null}
//   hold is optional (a checkpoint written before it existed has none): set while the operator
//   holds the agent with !stop, so that the hold survives a restart.
//   plan may be null: an agent that has no plan yet still has a position to save.
//   plan.cursor is the index of the current step; cursor == steps.length means the plan is finished.
//   seq is the seq of the agent's last event (genesis/events/agent_emit.js takes it back as last_seq).
//
// On disk the checkpoint is wrapped as {"sha256":"<hash of the checkpoint's JSON text>","checkpoint":{...}}
// in <dir>/<agent>.checkpoint.json. The hash is what tells a damaged file from a good one
// even when the damage leaves valid JSON behind.
//
// Atomic write: the text goes to <file>.tmp, is flushed and read back, and only then
// renamed over <file>. Whatever fails or dies on the way, <file> is either the previous
// complete checkpoint or the new complete one.
//
// Injected:
//   files   { write(path, text), rename(from, to), read(path) -> text | null, remove(path) }
//           (genesis/store/node_files.js is the real one)
//   mirror  { save(checkpoint) -> Promise, load(agent) -> Promise<checkpoint | null> }   optional (Postgres)
//   clock   { now(), setTimeout(fn, ms), clearTimeout(handle) }
//   report  (problem) -> void    told about a corrupt file, a failed write and a failed mirror write
// Depends only on Node built-ins.

import { createHash } from 'node:crypto';

export const CHECKPOINT_VERSION = 1;
export const STEP_STATUSES = Object.freeze(['pending', 'active', 'done', 'parked', 'skipped']);
export const PLAN_SOURCES = Object.freeze(['model', 'routine']);
export const CHECKPOINT_INTERVAL_MS = 30 * 1000;

const TOP_KEYS = ['v', 'agent', 'seq', 'saved_at', 'plan', 'routine', 'position', 'places', 'pending_request', 'budgets'];
const OPTIONAL_KEYS = ['hold']; // may be left out: a checkpoint from before the key existed is still valid
const AGENT_NAME = /^[A-Za-z0-9_]{1,64}$/; // the name becomes part of a file name
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isFilledText = (value) => typeof value === 'string' && value.length > 0;
const isCount = (value) => Number.isInteger(value) && value >= 0;
const isIsoTime = (value) => typeof value === 'string' && ISO_PATTERN.test(value) && !Number.isNaN(Date.parse(value));

function checkPlan(plan, problems) {
    if (plan === null) return;
    if (!isPlainObject(plan)) { problems.push('plan must be an object or null'); return; }
    if (!isFilledText(plan.id)) problems.push('plan.id must be a non-empty string');
    if (!isFilledText(plan.goal) && !isPlainObject(plan.goal)) problems.push('plan.goal must be a non-empty string or an object');
    if (!PLAN_SOURCES.includes(plan.source)) problems.push(`plan.source must be one of ${PLAN_SOURCES.join(', ')}`);
    if (!Array.isArray(plan.steps)) { problems.push('plan.steps must be a list'); return; }
    if (!isCount(plan.cursor) || plan.cursor > plan.steps.length) {
        problems.push(`plan.cursor must be a step index from 0 to ${plan.steps.length}`);
    }
    plan.steps.forEach((step, index) => {
        const where = `plan.steps[${index}]`;
        if (!isPlainObject(step)) { problems.push(`${where} must be an object`); return; }
        if (step.i !== index) problems.push(`${where}.i must be ${index}`);
        if (!isFilledText(step.command)) problems.push(`${where}.command must be a non-empty string`);
        if (!Array.isArray(step.args)) problems.push(`${where}.args must be a list`);
        if (!STEP_STATUSES.includes(step.status)) problems.push(`${where}.status must be one of ${STEP_STATUSES.join(', ')}`);
        if (!isCount(step.attempts)) problems.push(`${where}.attempts must be a whole number, 0 or more`);
        if (!isPlainObject(step.progress) || !isCount(step.progress.done)
            || (step.progress.total !== null && !isCount(step.progress.total))) {
            problems.push(`${where}.progress must be {done, total} with whole numbers (total may be null)`);
        }
        if (step.status === 'active' && index !== plan.cursor) problems.push(`${where} is active but the cursor is at ${plan.cursor}`);
    });
}

// Problems with a checkpoint (empty = fine). Never throws.
export function checkCheckpoint(checkpoint) {
    if (!isPlainObject(checkpoint)) return ['checkpoint must be an object'];
    const problems = [];
    for (const key of TOP_KEYS) if (!Object.hasOwn(checkpoint, key)) problems.push(`"${key}" is missing`);
    for (const key of Object.keys(checkpoint)) if (!TOP_KEYS.includes(key) && !OPTIONAL_KEYS.includes(key)) problems.push(`"${key}" is not a checkpoint field`);
    if (problems.length > 0) return problems;

    if (checkpoint.v !== CHECKPOINT_VERSION) problems.push(`v must be ${CHECKPOINT_VERSION}`);
    if (typeof checkpoint.agent !== 'string' || !AGENT_NAME.test(checkpoint.agent)) problems.push('agent must be a name of letters, digits and _');
    if (!isCount(checkpoint.seq)) problems.push('seq must be a whole number, 0 or more');
    if (!isIsoTime(checkpoint.saved_at)) problems.push('saved_at must be an ISO-8601 UTC time');
    checkPlan(checkpoint.plan, problems);
    const routine = checkpoint.routine;
    if (routine !== null && (!isPlainObject(routine) || !isFilledText(routine.name) || typeof routine.phase !== 'string')) {
        problems.push('routine must be {name, phase} or null');
    }
    const position = checkpoint.position;
    if (!isPlainObject(position) || !['x', 'y', 'z'].every((axis) => Number.isFinite(position[axis])) || !isFilledText(position.dimension)) {
        problems.push('position must be {x, y, z, dimension} with numbers and a dimension name');
    }
    if (!isPlainObject(checkpoint.places)) problems.push('places must be an object');
    const pending = checkpoint.pending_request;
    if (pending !== null && (!isPlainObject(pending) || !isFilledText(pending.id) || !isFilledText(pending.kind) || !isIsoTime(pending.queued_at))) {
        problems.push('pending_request must be {id, kind, queued_at} or null');
    }
    if (!isPlainObject(checkpoint.budgets)) problems.push('budgets must be an object');
    const hold = checkpoint.hold;
    if (hold !== undefined && hold !== null && (!isPlainObject(hold) || !isFilledText(hold.by) || !isFilledText(hold.reason) || !isIsoTime(hold.at))) {
        problems.push('hold must be {by, reason, at} or null');
    }
    return problems;
}

// The step the agent is on: the one the cursor points at, or null (no plan, or the plan is finished).
export function currentStep(checkpoint) {
    const plan = checkpoint?.plan;
    if (!plan || !Array.isArray(plan.steps)) return null;
    return plan.steps[plan.cursor] ?? null;
}

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

// The text of the checkpoint file.
export function encodeCheckpoint(checkpoint) {
    const body = JSON.stringify(checkpoint);
    return `{"sha256":"${sha256(body)}","checkpoint":${body}}\n`;
}

// Reads the text of a checkpoint file. Never throws.
// Returns { ok: true, checkpoint } or { ok: false, reason }.
export function decodeCheckpoint(text) {
    if (typeof text !== 'string' || text.trim().length === 0) return { ok: false, reason: 'the file is empty' };
    let wrapper;
    try {
        wrapper = JSON.parse(text);
    } catch (err) {
        return { ok: false, reason: `the file is not complete JSON (${err.message})` };
    }
    if (!isPlainObject(wrapper) || typeof wrapper.sha256 !== 'string' || !Object.hasOwn(wrapper, 'checkpoint')) {
        return { ok: false, reason: 'the file is not a checkpoint file (sha256 and checkpoint expected)' };
    }
    // JSON.stringify of what JSON.parse returned gives back the text that was hashed
    if (sha256(JSON.stringify(wrapper.checkpoint)) !== wrapper.sha256) {
        return { ok: false, reason: 'the content does not match its sha256' };
    }
    const problems = checkCheckpoint(wrapper.checkpoint);
    if (problems.length > 0) return { ok: false, reason: `not a valid checkpoint: ${problems.join('; ')}` };
    return { ok: true, checkpoint: wrapper.checkpoint };
}

export function createCheckpointStore({ files, dir, mirror = null, clock = { now: Date.now }, report = () => {} } = {}) {
    const stats = { written: 0, write_failures: 0, corrupt_found: 0, mirror_saved: 0, mirror_failures: 0 };
    const chains = new Map();        // agent -> the write in progress: one at a time per agent
    const mirror_waiting = new Map(); // agent -> newest checkpoint not yet mirrored
    let mirror_busy = null;

    const pathFor = (agent) => `${dir}/${agent}.checkpoint.json`;

    function tell(problem) {
        try { report({ ts: new Date(clock.now()).toISOString(), ...problem }); } catch { /* reporting must not break the store */ }
    }

    // The mirror is fed in the background, newest checkpoint per agent only: a slow or dead
    // Postgres delays nothing and piles nothing up.
    function feedMirror() {
        if (!mirror || mirror_busy || mirror_waiting.size === 0) return;
        const [agent, checkpoint] = mirror_waiting.entries().next().value;
        mirror_waiting.delete(agent);
        mirror_busy = Promise.resolve()
            .then(() => mirror.save(checkpoint))
            .then(() => { stats.mirror_saved++; }, (err) => {
                stats.mirror_failures++;
                tell({ problem: 'checkpoint_mirror_failed', agent, message: String(err?.message ?? err) });
            })
            .finally(() => { mirror_busy = null; feedMirror(); });
    }

    async function writeNow(checkpoint) {
        const problems = checkCheckpoint(checkpoint);
        if (problems.length > 0) {
            stats.write_failures++;
            tell({ problem: 'checkpoint_invalid', agent: checkpoint?.agent ?? null, errors: problems });
            return { ok: false, code: 'invalid', errors: problems };
        }
        const file = pathFor(checkpoint.agent);
        const tmp = `${file}.tmp`;
        try {
            const text = encodeCheckpoint(checkpoint);
            await files.write(tmp, text);
            if (await files.read(tmp) !== text) throw new Error('the temporary file does not hold what was written');
            await files.rename(tmp, file);
        } catch (err) {
            stats.write_failures++;
            try { await files.remove(tmp); } catch { /* a leftover .tmp is ignored and overwritten next time */ }
            tell({ problem: 'checkpoint_write_failed', agent: checkpoint.agent, path: file, message: String(err?.message ?? err) });
            return { ok: false, code: 'write_failed', error: String(err?.message ?? err) };
        }
        stats.written++;
        if (mirror) {
            mirror_waiting.set(checkpoint.agent, JSON.parse(JSON.stringify(checkpoint)));
            feedMirror();
        }
        return { ok: true, path: file };
    }

    async function fromMirror(agent) {
        if (!mirror) return null;
        try {
            const mirrored = await mirror.load(agent);
            if (mirrored === null || mirrored === undefined) return null;
            if (checkCheckpoint(mirrored).length > 0 || mirrored.agent !== agent) return null;
            return mirrored;
        } catch {
            return null;
        }
    }

    return {
        pathFor,
        // Writes the checkpoint atomically. Resolves to { ok: true, path } or
        // { ok: false, code: 'invalid' | 'write_failed', ... }. Never rejects.
        write(checkpoint) {
            const agent = typeof checkpoint?.agent === 'string' ? checkpoint.agent : '';
            const turn = (chains.get(agent) ?? Promise.resolve()).then(() => writeNow(checkpoint));
            const safe = turn.catch((err) => ({ ok: false, code: 'write_failed', error: String(err?.message ?? err) }));
            chains.set(agent, safe);
            return safe;
        },
        // Loads the agent's checkpoint. Never rejects. Resolves to
        //   { status: 'ok', checkpoint, current_step, from: 'file' }
        //   { status: 'ok', checkpoint, current_step, from: 'mirror', file: 'missing' | 'corrupt', reason }
        //   { status: 'missing', checkpoint: null, current_step: null }
        //   { status: 'corrupt', checkpoint: null, current_step: null, reason, path }
        async load(agent) {
            if (typeof agent !== 'string' || !AGENT_NAME.test(agent)) {
                return { status: 'missing', checkpoint: null, current_step: null, reason: 'not an agent name' };
            }
            const file = pathFor(agent);
            let text = null;
            let reason = null;
            try {
                text = await files.read(file);
            } catch (err) {
                reason = `the file cannot be read (${err?.message ?? err})`;
            }
            if (text !== null) {
                const decoded = decodeCheckpoint(text);
                if (decoded.ok && decoded.checkpoint.agent === agent) {
                    return { status: 'ok', checkpoint: decoded.checkpoint, current_step: currentStep(decoded.checkpoint), from: 'file' };
                }
                reason = decoded.ok ? `the file holds the checkpoint of ${decoded.checkpoint.agent}` : decoded.reason;
            }
            const file_state = reason === null ? 'missing' : 'corrupt';
            if (file_state === 'corrupt') {
                stats.corrupt_found++;
                tell({ problem: 'checkpoint_corrupt', agent, path: file, reason });
            }
            const mirrored = await fromMirror(agent);
            if (mirrored) {
                return { status: 'ok', checkpoint: mirrored, current_step: currentStep(mirrored), from: 'mirror', file: file_state, reason };
            }
            if (file_state === 'missing') return { status: 'missing', checkpoint: null, current_step: null };
            return { status: 'corrupt', checkpoint: null, current_step: null, reason, path: file };
        },
        // Resolves when no write and no mirror write is under way (for shutdown and for tests).
        async idle() {
            await Promise.all([...chains.values()]);
            while (mirror_busy) await mirror_busy;
        },
        stats: () => ({ ...stats }),
    };
}

// Writes the agent's checkpoint at every step boundary and every 30 seconds.
//   store     a checkpoint store (above)
//   getState  () -> the checkpoint to save, without saved_at (it is stamped here)
// A save never throws; when one is still being written, the next one waits and the ones
// in between are skipped (only the newest state is worth writing).
export function createCheckpointer({ store, getState, clock = { now: Date.now, setTimeout, clearTimeout }, interval_ms = CHECKPOINT_INTERVAL_MS } = {}) {
    let timer = null;
    let running = false;
    let writing = null;
    let again = null;

    async function saveOnce() {
        try {
            const state = getState();
            return await store.write({ ...state, saved_at: new Date(clock.now()).toISOString() });
        } catch (err) {
            return { ok: false, code: 'state_error', error: String(err?.message ?? err) };
        }
    }

    function save() {
        if (writing) {
            again ??= writing.then(() => { again = null; return save(); });
            return again;
        }
        writing = saveOnce().finally(() => { writing = null; });
        return writing;
    }

    function schedule() {
        if (!running) return;
        timer = clock.setTimeout(() => {
            timer = null;
            save().finally(schedule);
        }, interval_ms);
        timer?.unref?.();
    }

    return {
        // Call when a plan step ends or starts. Resolves to the write's result.
        stepBoundary: save,
        saveNow: save,
        start() {
            if (running) return;
            running = true;
            schedule();
        },
        stop() {
            running = false;
            if (timer !== null) { clock.clearTimeout(timer); timer = null; }
        },
    };
}
