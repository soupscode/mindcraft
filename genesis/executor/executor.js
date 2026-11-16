// Genesis: the executor. It carries out the goals in an agent's short-term queue, one
// template step at a time, with no model call anywhere.
//
//   - takes the first queued goal, checks its preconditions again, and drops it with a
//     reason when they no longer hold
//   - runs the template's steps in order; each step is one upstream skill (genesis/catalog/ops.js)
//   - a step that fails is tried up to 3 times; then the goal ends with a named reason and
//     one planning trigger is raised
//   - a step that was interrupted (a reflex took over, the operator ran a command) is run
//     again and is not counted as a failure, up to a limit
//   - scaffold blocks the agent put down inside the camp, the field or a plot are taken
//     away before a step counts as done
//   - emits agent.decision, skill.started, skill.progress, skill.result and agent.state
//     with `corr` set to the decision id (goal.changed comes from the goal store)
//   - writes a checkpoint at every step boundary and every 30 seconds; start() loads the
//     checkpoint and resumes the same step
//
// Everything outside is injected:
//   catalog      genesis/catalog/catalog.js
//   goals        the goal store (genesis/store/goal_store.js)
//   checkpoints  the checkpoint store (genesis/store/checkpoint.js)
//   ops          { run(command, args, { permit, corr, cleanup }) -> Promise<{ ok, interrupted, timedout, output }> }
//                permit: null | { dig: (pos) -> true where digging stays forbidden, no_place: boolean }
//   state        () -> { agent, view, ledger, avoid, now }   the world as it is (see genesis/catalog/templates.js)
//   emit         (type, data, { corr, severity })            genesis/events/agent_emit.js shape
//   getSeq       () -> the seq of the agent's last event, for the checkpoint
//   clock        { now(), setTimeout(fn, ms), clearTimeout(handle) }
//   scaffold     genesis/executor/scaffold.js (optional)
//   onTrigger    ({ kind, detail }) -> void    kind: goal_complete | step_failed | reflex_interrupt   (planning, step 8)
//   chooseWork   async () -> { goal: { title, option_id }, reason, routine? } | { idle_ms } | null
//                asked when the queue is empty (the role routine, step 9); a goal it returns is
//                queued with source "routine"
//   extras       () -> { routine, pending_request, places }   more for the checkpoint
//   ids          () -> string    ids of decisions (ULIDs by default)
//
// Depends only on other Genesis files.

import { classifyFailure } from '../catalog/ops.js';
import { createCheckpointer, CHECKPOINT_INTERVAL_MS } from '../store/checkpoint.js';
import { createUlidFactory, clipText } from '../shared/events.js';

export const EXECUTOR_DEFAULTS = Object.freeze({
    max_attempts: 3,            // decided: a step is tried three times
    max_interruptions: 5,       // then being interrupted counts as the failure
    step_gap_ms: 250,           // between steps (upstream's action manager ends the process when actions start within 20 ms of each other)
    retry_gap_ms: 2000,         // before a failed step is tried again
    idle_ms: 5000,              // how long to wait when there is nothing to do
    progress_ms: 5000,          // how often progress is measured while a step runs
    checkpoint_interval_ms: CHECKPOINT_INTERVAL_MS,
});

// Reasons no second try can change: the step asked for something that is never allowed.
const FINAL_REASONS = new Set(['protected_zone', 'outside_plot', 'outside_field', 'cell_occupied', 'unknown_command', 'unknown_option', 'plot_not_registered']);

const copy = (value) => JSON.parse(JSON.stringify(value));

export function createExecutor({
    agent, catalog, goals, checkpoints, ops, state, emit = () => null, getSeq = () => 0,
    clock = { now: Date.now, setTimeout, clearTimeout }, scaffold = null, zones = null,
    onTrigger = () => {}, chooseWork = null, extras = () => ({}), ids = null, onGoalEnd = () => {}, ...options
} = {}) {
    const config = { ...EXECUTOR_DEFAULTS };
    for (const key of Object.keys(EXECUTOR_DEFAULTS)) {
        if (options[key] !== undefined) config[key] = options[key];
    }
    const nextId = ids ?? createUlidFactory({ now: clock.now });
    const stats = { goals_started: 0, goals_completed: 0, goals_failed: 0, goals_dropped: 0, steps_done: 0, steps_failed: 0, steps_skipped: 0, interruptions: 0, resumed: 0 };
    const sources = new Map();       // goal id -> { source, call_id }: who put the goal in the queue
    const removal_pending = new Map(); // goal id -> meta: goals that ended while the goal store could not be written

    let plan = null;            // the checkpoint's "plan": { id, goal: { id, title, option_id, skill, origin, call_id, baseline }, source, cursor, steps }
    let interruptions = 0;      // of the current step
    let reflex_reported = false; // one planning trigger per goal for interruptions
    let yield_reason = null;    // set when the routine must give way after its current step
    let busy = false;
    let running = false;
    let wake_sleep = null;
    let started = false;
    let last_outcome = null;    // { option_id, title, outcome, reason } of the goal that ended last

    const say = (type, data, extra = {}) => {
        try { return emit(type, data, { corr: plan?.id ?? null, ...extra }); } catch { return null; }
    };
    const trigger = (kind, detail = {}) => {
        try { onTrigger({ kind, detail }); } catch { /* planning is never allowed to stop the work */ }
    };

    function world() {
        const current = state();
        return { ...current, now: current.now ?? clock.now() };
    }

    function checkpointState() {
        const current = state();
        const position = current.view.position();
        const more = extras() ?? {};
        return {
            v: 1,
            agent,
            seq: Math.max(0, Math.floor(Number(getSeq()) || 0)),
            plan: plan ? copy(plan) : null,
            routine: more.routine ?? null,
            position: { x: position.x, y: position.y, z: position.z, dimension: current.view.dimension?.() ?? zones?.dimension ?? 'overworld' },
            places: { ...(more.places ?? {}), scaffold: scaffold ? scaffold.snapshot() : [] },
            pending_request: more.pending_request ?? null,
            budgets: {},
        };
    }

    const checkpointer = createCheckpointer({ store: checkpoints, getState: checkpointState, clock, interval_ms: config.checkpoint_interval_ms });
    const boundary = () => checkpointer.stepBoundary();

    const queueOf = async () => {
        const got = await goals.get(agent);
        return got.ok ? got.goals.short_term : null;
    };

    // Takes a goal out of the queue. When the store cannot be written the goal is remembered
    // as ended, so it is never started a second time.
    async function removeGoal(goal_id, meta) {
        const result = await goals.setShortTerm(agent, (queue) => queue.filter((goal) => goal.id !== goal_id), meta);
        if (result.ok || result.code === 'no_change') {
            removal_pending.delete(goal_id);
            sources.delete(goal_id);
            return true;
        }
        removal_pending.set(goal_id, meta);
        return false;
    }

    async function endPlan(outcome, reason, meta) {
        const ended = plan;
        last_outcome = { option_id: ended.goal.option_id, title: ended.goal.title, outcome, reason: reason ?? null, at: clock.now() };
        await removeGoal(ended.goal.id, meta);
        if (plan === ended) plan = null;
        interruptions = 0;
        reflex_reported = false;
        await boundary();
        try { onGoalEnd({ ...last_outcome, source: ended.source, goal_id: ended.goal.id }); } catch { /* the listener's problem */ }
        return (await queueOf())?.length ?? 0;
    }

    // Takes away scaffold blocks left inside a zone. Returns how many are still standing.
    async function cleanScaffold() {
        if (!scaffold) return 0;
        for (let pass = 0; pass < 2; pass++) {
            const left = scaffold.left(world().view);
            if (left.length === 0) return 0;
            for (const cell of left) {
                const args = [cell.x, cell.y, cell.z];
                const started_at = clock.now();
                say('skill.started', { skill: 'breakBlockAt', args, cleanup: 'scaffold' });
                let result;
                try {
                    result = await ops.run('breakBlockAt', args, { permit: null, corr: plan?.id ?? null, cleanup: true });
                } catch (err) {
                    result = { ok: false, interrupted: false, timedout: false, output: `!!Code threw exception!!\n${err?.message ?? err}` };
                }
                say('skill.result', resultData('breakBlockAt', result, started_at, { cleanup: 'scaffold' }), { severity: result.ok ? 'info' : 'warn' });
            }
        }
        return scaffold.left(world().view).length;
    }

    function resultData(command, result, started_at, more = {}) {
        return {
            skill: command,
            ok: result.ok === true,
            interrupted: result.interrupted === true,
            timedout: result.timedout === true,
            output: clipText(result.output ?? '', 2000),
            duration_ms: Math.max(0, Math.round(clock.now() - started_at)),
            ...more,
        };
    }

    function measure(for_plan) {
        const measured = catalog.progress(for_plan.goal.option_id, world(), for_plan.goal.baseline, for_plan);
        return measured ?? { done: 0, total: null, unit: null };
    }

    function reportProgress(for_plan, step) {
        const measured = measure(for_plan);
        step.progress = { done: measured.done, total: measured.total };
        say('skill.progress', { skill: for_plan.goal.skill, done: measured.done, total: measured.total, unit: measured.unit, step: step.i }, { corr: for_plan.id });
        return measured;
    }

    async function startGoal(goal) {
        const origin = sources.get(goal.id) ?? { source: 'planner', call_id: null };
        const checked = catalog.check(goal.option_id, world());
        let built = null;
        let reason = checked.ok ? null : checked.reason;
        if (checked.ok) {
            try { built = catalog.plan(checked.option, world()); } catch (err) { reason = `plan_error: ${err?.message ?? err}`; }
        }
        if (reason !== null) {
            // the preconditions held when the goal was chosen and no longer do
            stats.goals_dropped++;
            last_outcome = { option_id: goal.option_id, title: goal.title, outcome: 'dropped', reason, at: clock.now() };
            await removeGoal(goal.id, { reason: `dropped before starting: ${reason}`, source: 'executor', call_id: origin.call_id ?? null });
            say('agent.state', { state: 'goal_dropped', detail: { goal_id: goal.id, option_id: goal.option_id, reason } }, { severity: 'warn' });
            try { onGoalEnd({ ...last_outcome, source: origin.source, goal_id: goal.id }); } catch { /* the listener's problem */ }
            const left = (await queueOf())?.length ?? 0;
            if (left === 0) trigger('goal_complete', { outcome: 'dropped', reason, option_id: goal.option_id });
            return { kind: 'goal_dropped', goal_id: goal.id, reason };
        }
        const resolved = catalog.resolve(goal.option_id);
        plan = {
            id: nextId(),
            // origin: who queued the goal (planner, routine, operator). The checkpoint's plan.source
            // only knows "model" and "routine": everything that is not the routine is filed under "model".
            goal: { id: goal.id, title: goal.title, option_id: goal.option_id, skill: resolved.skill, origin: origin.source, call_id: origin.call_id ?? null, baseline: built.baseline ?? {} },
            source: origin.source === 'routine' ? 'routine' : 'model',
            cursor: 0,
            steps: built.steps.map((step, i) => ({ i, command: step.command, args: copy(step.args), status: 'pending', attempts: 0, progress: { done: 0, total: null } })),
        };
        interruptions = 0;
        reflex_reported = false;
        stats.goals_started++;
        say('agent.decision', {
            decision_id: plan.id, summary: goal.title, trigger: origin.source, command: resolved.skill, args: [goal.option_id],
            goal_id: goal.id, call_id: origin.call_id ?? null, steps: plan.steps.map((step) => step.command), steps_from: 'template',
        });
        say('agent.state', { state: 'goal_started', detail: { goal_id: goal.id, option_id: goal.option_id, steps: plan.steps.length, source: origin.source } });
        await boundary();
        return { kind: 'goal_started', goal_id: goal.id, plan_id: plan.id };
    }

    async function completeGoal() {
        const done = plan;
        const measured = measure(done);
        stats.goals_completed++;
        say('agent.state', { state: 'goal_completed', detail: { goal_id: done.goal.id, option_id: done.goal.option_id, done: measured.done, total: measured.total, unit: measured.unit } });
        const left = await endPlan('completed', null, { reason: 'completed', source: 'executor', call_id: sources.get(done.goal.id)?.call_id ?? null });
        if (left === 0) trigger('goal_complete', { outcome: 'completed', option_id: done.goal.option_id });
        return { kind: 'goal_completed', goal_id: done.goal.id };
    }

    async function stepFailed(step, reason) {
        const failed = plan;
        stats.steps_failed++;
        if (step.attempts < config.max_attempts && !FINAL_REASONS.has(reason)) {
            await boundary();
            return { kind: 'step_retry', step: step.i, reason, attempts: step.attempts, wait_ms: config.retry_gap_ms };
        }
        step.status = 'parked';
        stats.goals_failed++;
        const detail = { goal_id: failed.goal.id, option_id: failed.goal.option_id, reason, step: step.i, command: step.command, attempts: step.attempts };
        say('agent.state', { state: 'goal_failed', detail }, { severity: 'warn' });
        await endPlan('failed', reason, {
            reason: `failed: ${reason} (${step.command}, step ${step.i + 1} of ${failed.steps.length}, ${step.attempts} attempt${step.attempts === 1 ? '' : 's'})`,
            source: 'executor', call_id: sources.get(failed.goal.id)?.call_id ?? null,
        });
        trigger('step_failed', { reason, option_id: failed.goal.option_id, command: step.command }); // exactly one planning request
        return { kind: 'goal_failed', goal_id: failed.goal.id, reason, step: step.i };
    }

    async function stepOnce() {
        const mine = plan;
        if (yield_reason !== null && mine.source === 'routine') {
            // the routine gives way between steps: the step that was running has ended
            const reason = yield_reason;
            yield_reason = null;
            say('agent.state', { state: 'routine_yielded', detail: { goal_id: mine.goal.id, option_id: mine.goal.option_id, reason, step: mine.cursor } });
            await endPlan('yielded', reason, { reason: `routine yields: ${reason}`, source: 'routine', call_id: null });
            return { kind: 'routine_yielded', goal_id: mine.goal.id, reason };
        }
        if (mine.cursor >= mine.steps.length) return completeGoal();
        const step = mine.steps[mine.cursor];
        const guard = catalog.before(mine.goal.option_id, step, world());
        if (guard?.skip) {
            step.status = 'skipped';
            stats.steps_skipped++;
            mine.cursor++;
            await boundary();
            return { kind: 'step_skipped', step: step.i, reason: guard.skip, wait_ms: 0 };
        }
        step.status = 'active';
        step.attempts++;
        if (guard?.fail) return stepFailed(step, guard.fail); // refused before anything was done

        const started_at = clock.now();
        say('skill.started', { skill: step.command, args: copy(step.args), goal_skill: mine.goal.skill, step: step.i, of: mine.steps.length, attempt: step.attempts, steps_from: 'template' });
        await boundary(); // the checkpoint now says: this step is being worked on
        if (plan !== mine) return { kind: 'plan_gone' };
        scaffold?.begin(guard?.intend ?? []);
        const no_place = mine.source === 'routine'; // a routine never places a block, not even to walk
        const permit = guard?.permit?.dig
            ? { dig: (pos) => (zones ? zones.isProtected(pos) : true), no_place }
            : (no_place ? { no_place } : null);

        let ticker = null;
        const tick = () => {
            ticker = clock.setTimeout(() => {
                if (plan !== mine) return;
                reportProgress(mine, step);
                tick();
            }, config.progress_ms);
        };
        tick();
        let result;
        try {
            result = await ops.run(step.command, copy(step.args), { permit, corr: mine.id, cleanup: false });
        } catch (err) {
            result = { ok: false, interrupted: false, timedout: false, output: `!!Code threw exception!!\n${err?.message ?? err}` };
        } finally {
            if (ticker !== null) clock.clearTimeout(ticker);
        }
        result = { ok: result?.ok === true, interrupted: result?.interrupted === true, timedout: result?.timedout === true, output: String(result?.output ?? '') };
        say('skill.result', resultData(step.command, result, started_at, { goal_skill: mine.goal.skill, step: step.i, attempt: step.attempts }),
            { corr: mine.id, severity: result.ok ? 'info' : 'warn' });
        if (plan !== mine) return { kind: 'plan_gone' }; // the goal was taken away while the step ran (a death, a new plan)

        if (result.interrupted && !result.timedout) {
            stats.interruptions++;
            interruptions++;
            if (interruptions <= config.max_interruptions) {
                step.attempts--; // an interruption is not a failed try
                if (!reflex_reported) {
                    reflex_reported = true;
                    trigger('reflex_interrupt', { option_id: mine.goal.option_id, command: step.command });
                }
                await boundary();
                return { kind: 'step_interrupted', step: step.i, wait_ms: config.retry_gap_ms };
            }
        }
        const after = catalog.after(mine.goal.option_id, step, result, world(), mine.goal.baseline);
        let reason = after?.fail ?? (result.ok ? null : classifyFailure(step.command, result));
        if ((await cleanScaffold()) > 0 && reason === null) reason = 'scaffold_left_in_zone';
        if (plan !== mine) return { kind: 'plan_gone' };
        if (reason !== null) return stepFailed(step, reason);

        step.status = 'done';
        stats.steps_done++;
        interruptions = 0;
        reportProgress(mine, step);
        mine.cursor++;
        await boundary();
        return { kind: 'step_done', step: step.i };
    }

    // Does one thing: starts a goal, runs a step, ends a goal, or finds there is nothing to do.
    async function runOnce() {
        if (!started) throw new Error('the executor was not started');
        if (busy) return { kind: 'busy', wait_ms: config.step_gap_ms };
        busy = true;
        try {
            for (const [goal_id, meta] of [...removal_pending]) await removeGoal(goal_id, meta);
            const queue = await queueOf();
            if (queue === null) return { kind: 'store_unavailable', wait_ms: config.idle_ms };
            if (plan) {
                if (queue[0]?.id !== plan.goal.id && !removal_pending.has(plan.goal.id)) {
                    // the queue was replaced (a new plan from the planner or the operator)
                    const gone = plan;
                    say('agent.state', { state: 'goal_abandoned', detail: { goal_id: gone.goal.id, option_id: gone.goal.option_id, reason: 'replaced' } });
                    last_outcome = { option_id: gone.goal.option_id, title: gone.goal.title, outcome: 'abandoned', reason: 'replaced', at: clock.now() };
                    plan = null;
                    await boundary();
                    return { kind: 'goal_abandoned', goal_id: gone.goal.id, reason: 'replaced', wait_ms: 0 };
                }
                return await stepOnce();
            }
            // scaffold left behind by a goal that failed is cleared before anything else starts
            if (scaffold && scaffold.count() > 0 && (await cleanScaffold()) > 0) return { kind: 'scaffold_pending', wait_ms: config.idle_ms };
            const next = queue.find((goal) => !removal_pending.has(goal.id));
            if (next) return await startGoal(next);
            yield_reason = null; // nothing of the routine is running: there is nothing to yield
            if (chooseWork) {
                const choice = await chooseWork();
                if (choice?.goal) {
                    const pushed = await goals.pushShortTerm(agent, { title: choice.goal.title, option_id: choice.goal.option_id },
                        { reason: choice.reason, source: 'routine', call_id: null });
                    if (pushed.ok) {
                        const queued = pushed.goals.short_term[pushed.goals.short_term.length - 1];
                        sources.set(queued.id, { source: 'routine', call_id: null });
                        return { kind: 'routine_goal', goal_id: queued.id, option_id: queued.option_id, wait_ms: 0 };
                    }
                    return { kind: 'store_unavailable', wait_ms: config.idle_ms };
                }
                return { kind: 'idle', wait_ms: choice?.idle_ms ?? config.idle_ms };
            }
            return { kind: 'idle', wait_ms: config.idle_ms };
        } finally {
            busy = false;
        }
    }

    function sleep(ms) {
        return new Promise((resolve) => {
            const timer = clock.setTimeout(() => { wake_sleep = null; resolve(); }, Math.max(0, ms));
            wake_sleep = () => { clock.clearTimeout(timer); wake_sleep = null; resolve(); };
        });
    }

    return {
        // Loads the checkpoint. With a plan in it, the executor carries on at the same step.
        // Resolves to { resumed, checkpoint, load } (checkpoint is null when there was none).
        async start() {
            const load = await checkpoints.load(agent);
            const checkpoint = load.status === 'ok' ? load.checkpoint : null;
            let resumed = false;
            if (checkpoint) {
                scaffold?.restore(checkpoint.places?.scaffold);
                const saved = checkpoint.plan;
                if (saved && saved.cursor < saved.steps.length && catalog.resolve(saved.goal?.option_id)) {
                    const queue = await queueOf();
                    if (queue && queue.some((goal) => goal.id === saved.goal.id)) {
                        plan = copy(saved);
                        sources.set(plan.goal.id, { source: plan.goal.origin ?? (plan.source === 'routine' ? 'routine' : 'planner'), call_id: plan.goal.call_id ?? null });
                        resumed = true;
                        stats.resumed++;
                        const step = plan.steps[plan.cursor];
                        say('agent.state', { state: 'resumed', detail: { goal_id: plan.goal.id, option_id: plan.goal.option_id, step: step.i, command: step.command, attempts: step.attempts, from: load.from } });
                    }
                }
            }
            started = true;
            checkpointer.start();
            return { resumed, checkpoint, load };
        },
        runOnce,
        // Keeps working until stop(). Never rejects.
        async run() {
            running = true;
            while (running) {
                let outcome;
                try {
                    outcome = await runOnce();
                } catch (err) {
                    outcome = { kind: 'error', error: String(err?.message ?? err), wait_ms: config.idle_ms };
                }
                if (!running) break;
                await sleep(outcome.wait_ms ?? config.step_gap_ms);
            }
        },
        stop() {
            running = false;
            checkpointer.stop();
            wake_sleep?.();
        },
        // Ends a wait early (a new goal arrived).
        wake() { wake_sleep?.(); },
        // Who queued a goal, so its decision and its goal changes carry the right source and call id.
        noteGoals(queued, origin) {
            for (const goal of queued ?? []) sources.set(goal.id, { source: origin.source, call_id: origin.call_id ?? null });
        },
        // The goal being worked on is given up now (the agent died). The step that is running
        // ends on its own (the skill is stopped by whoever calls this).
        async abandon(reason, { source = 'executor' } = {}) {
            if (!plan) return false;
            const gone = plan;
            plan = null;
            say('agent.state', { state: 'goal_abandoned', detail: { goal_id: gone.goal.id, option_id: gone.goal.option_id, reason } }, { corr: gone.id, severity: 'warn' });
            last_outcome = { option_id: gone.goal.option_id, title: gone.goal.title, outcome: 'abandoned', reason, at: clock.now() };
            await removeGoal(gone.goal.id, { reason: `abandoned: ${reason}`, source, call_id: null });
            await boundary();
            try { onGoalEnd({ ...last_outcome, source: gone.source, goal_id: gone.goal.id }); } catch { /* the listener's problem */ }
            return true;
        },
        // The routine gives way after the step it is on.
        requestYield(reason) { yield_reason = reason; },
        saveNow: () => checkpointer.saveNow(),
        plan: () => (plan ? copy(plan) : null),
        corr: () => plan?.id ?? null,
        lastOutcome: () => (last_outcome ? { ...last_outcome } : null),
        isBusy: () => busy,
        stats: () => ({ ...stats, scaffold_tracked: scaffold?.count() ?? 0 }),
    };
}
