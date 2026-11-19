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
//   - every goal that completes raises a planning trigger, whatever is still queued: the
//     planner's reply then replaces the goals that are still waiting (genesis/planning/agent_planner.js)
//   - hold(): the operator said !stop. The executor HOLDS: no retry, no next step, no routine,
//     nothing started, until resume(). The hold is in the checkpoint, so it survives a restart,
//     and it is emitted as agent.state "held". A held agent has not failed: nothing about a
//     hold is counted or reported as a failure.
//   - recovery (genesis/recovery): pause() while the bot is down (it died and has not
//     respawned); detour() runs goals a chooser hands out (walk home, re-equip) while the goal
//     in hand is kept, and then carries on at the SAME step, with no planning trigger;
//     expectInterrupt() and park() are how the watchdog ladder stops a step on purpose
//     (a new try that is not a reflex and not a failed attempt, or the step parked as "stuck").
//
// Everything outside is injected:
//   catalog      genesis/catalog/catalog.js
//   goals        the goal store (genesis/store/goal_store.js)
//   checkpoints  the checkpoint store (genesis/store/checkpoint.js)
//   ops          { run(command, args, { permit, corr, cleanup }) -> Promise<{ ok, interrupted, timedout, output }> }
//                (a step that is not an upstream skill, the message of an ask_agent or offer_agent goal,
//                is handed on by the agent runtime before it reaches the bot: genesis/agent/runtime.js)
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
//   extras       () -> { routine, pending_request, places, recovery }   more for the checkpoint
//   onGoalStart  ({ plan_id, goal_id, option_id, title, skill, args, source, call_id, steps }) -> void   a goal is about to be carried out
//   onStep       ({ plan_id, step, command, ok }) -> void                 a step of it ended
//   onGoalEnd    ({ option_id, title, outcome, reason, source, origin, goal_id, plan_id?, skill?, started_at?, steps?, done?, total?, parked? }) -> void
//                plan_id and what follows it are missing for a goal that was dropped before it started
//   ids          () -> string    ids of decisions (ULIDs by default)
//
// Depends only on other Genesis files.

import { PATROL_OPTION } from '../catalog/zones.js';
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
const FINAL_REASONS = new Set(['protected_zone', 'outside_plot', 'outside_field', 'cell_occupied', 'unknown_command', 'unknown_option', 'plot_not_registered',
    'contested_claim', // another agent holds the items: trying again at once changes nothing
    'stuck']);         // the watchdog parked the step (genesis/recovery/watchdog.js): it was tried in every way already

// A message the relay did not take (ask_agent, offer_agent: "relay_rate_limit", ...): sending it again at once
// would only be refused again, and count against the agent's messages.
const isFinal = (reason) => FINAL_REASONS.has(reason) || String(reason).startsWith('relay_');

const copy = (value) => JSON.parse(JSON.stringify(value));

export function createExecutor({
    agent, catalog, goals, checkpoints, ops, state, emit = () => null, getSeq = () => 0,
    clock = { now: Date.now, setTimeout, clearTimeout }, scaffold = null, zones = null,
    onTrigger = () => {}, chooseWork = null, extras = () => ({}), ids = null, onGoalEnd = () => {}, onGoalStart = () => {}, onStep = () => {}, ...options
} = {}) {
    const config = { ...EXECUTOR_DEFAULTS };
    for (const key of Object.keys(EXECUTOR_DEFAULTS)) {
        if (options[key] !== undefined) config[key] = options[key];
    }
    const nextId = ids ?? createUlidFactory({ now: clock.now });
    const stats = { goals_started: 0, goals_completed: 0, goals_failed: 0, goals_dropped: 0, steps_done: 0, steps_failed: 0, steps_skipped: 0, interruptions: 0, resumed: 0, holds: 0,
        recovery_interruptions: 0, steps_parked_stuck: 0, detours: 0 };
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
    let hold = null;            // { by, reason, at } while the operator holds the agent (!stop), else null
    let paused = null;          // a reason while the bot is down (it died and has not respawned): nothing runs
    let detour = null;          // { reason, next, onEnd, main, goals_run } while a recovery detour runs; main is the goal kept for afterwards
    let step_started = null;    // when the try of the step that is running began (for the step record)
    let expected_interrupt = null; // set by the watchdog right before it stops the running step on purpose
    let park_request = null;    // the reason the watchdog parks the current step with
    const after_turn = [];      // what waits until the thing the executor is doing right now is done

    // What the learning step records of a goal (genesis/learning/recorder.js): when it started and what became of each
    // of its steps. Kept beside the plan, not in it: the checkpoint's shape is not changed, and after a restart a goal
    // that is resumed simply has no step record from before.
    const records = new Map();  // plan id -> { started_at, steps: [{ i, command, ok, reason, ms, attempts }] }
    function noteStep(for_plan, step, ok, reason, started_at) {
        const record = records.get(for_plan.id);
        if (!record) return;
        let entry = record.steps.find((it) => it.i === step.i);
        if (!entry) {
            if (record.steps.length >= 80) return;
            entry = { i: step.i, command: step.command, ok: false, reason: null, ms: 0, attempts: 0 };
            record.steps.push(entry);
        }
        entry.ok = ok;
        entry.reason = ok ? null : reason ?? null;
        entry.ms += started_at === null ? 0 : Math.max(0, Math.round(clock.now() - started_at));
        entry.attempts = step.attempts;
        try { onStep({ plan_id: for_plan.id, step: step.i, command: step.command, ok }); } catch { /* the listener's problem */ }
    }
    // What a goal's end says beside its outcome: the plan, its steps, and how far it got.
    function endInfo(ended) {
        const record = records.get(ended.id);
        records.delete(ended.id);
        let measured = null;
        try { measured = catalog.progress(ended.goal.option_id, world(), ended.goal.baseline, ended); } catch { measured = null; }
        return {
            plan_id: ended.id, skill: ended.goal.skill, started_at: record?.started_at ?? null,
            steps: (record?.steps ?? []).map(({ command, ok, reason, ms, attempts }) => ({ command, ok, reason, ms, attempts })),
            done: measured?.done ?? null, total: measured?.total ?? null,
        };
    }

    const say = (type, data, extra = {}) => {
        try { return emit(type, data, { corr: plan?.id ?? null, ...extra }); } catch { return null; }
    };
    const trigger = (kind, detail = {}) => {
        if (detour) return; // a recovery detour never asks the planner: it is carried out by code alone
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
        const kept = detour ? detour.main : plan; // during a detour the checkpoint keeps the goal that goes on afterwards
        return {
            v: 1,
            agent,
            seq: Math.max(0, Math.floor(Number(getSeq()) || 0)),
            plan: kept ? copy(kept) : null,
            routine: more.routine ?? null,
            position: { x: position.x, y: position.y, z: position.z, dimension: current.view.dimension?.() ?? zones?.dimension ?? 'overworld' },
            places: { ...(more.places ?? {}), scaffold: scaffold ? scaffold.snapshot() : [] },
            pending_request: more.pending_request ?? null,
            budgets: {},
            hold: hold ? { ...hold } : null,
            ...(more.recovery !== undefined && more.recovery !== null ? { recovery: copy(more.recovery) } : {}),
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

    async function endPlan(outcome, reason, meta, more = {}) {
        const ended = plan;
        const info = endInfo(ended);
        last_outcome = { option_id: ended.goal.option_id, title: ended.goal.title, outcome, reason: reason ?? null, at: clock.now() };
        await removeGoal(ended.goal.id, meta);
        if (plan === ended) plan = null;
        interruptions = 0;
        reflex_reported = false;
        await boundary();
        try { onGoalEnd({ ...last_outcome, ...more, ...info, source: ended.source, origin: ended.goal.origin ?? null, goal_id: ended.goal.id }); } catch { /* the listener's problem */ }
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
            try { onGoalEnd({ ...last_outcome, source: origin.source, origin: origin.source, goal_id: goal.id, call_id: origin.call_id ?? null }); } catch { /* the listener's problem */ }
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
            // a recovery detour is scripted work like a routine's: it never places a block either
            source: origin.source === 'routine' || origin.source === 'recovery' ? 'routine' : 'model',
            cursor: 0,
            steps: built.steps.map((step, i) => ({ i, command: step.command, args: copy(step.args), status: 'pending', attempts: 0, progress: { done: 0, total: null } })),
        };
        interruptions = 0;
        reflex_reported = false;
        park_request = null; // what the watchdog asked of an earlier goal is not meant for this one
        expected_interrupt = null;
        stats.goals_started++;
        say('agent.decision', {
            decision_id: plan.id, summary: goal.title, trigger: origin.source, command: resolved.skill, args: [goal.option_id],
            goal_id: goal.id, call_id: origin.call_id ?? null, steps: plan.steps.map((step) => step.command), steps_from: 'template',
        });
        say('agent.state', { state: 'goal_started', detail: { goal_id: goal.id, option_id: goal.option_id, steps: plan.steps.length, source: origin.source } });
        records.set(plan.id, { started_at: clock.now(), steps: [] });
        if (records.size > 8) records.delete(records.keys().next().value);
        // the situation is taken now, before anything of the goal has been done (genesis/learning/recorder.js)
        try {
            onGoalStart({ plan_id: plan.id, goal_id: goal.id, option_id: goal.option_id, title: goal.title, skill: resolved.skill, args: copy(resolved.args), source: origin.source, call_id: origin.call_id ?? null, steps: plan.steps.length });
        } catch { /* the listener's problem */ }
        await boundary();
        return { kind: 'goal_started', goal_id: goal.id, plan_id: plan.id };
    }

    async function completeGoal() {
        const done = plan;
        const measured = measure(done);
        stats.goals_completed++;
        say('agent.state', { state: 'goal_completed', detail: { goal_id: done.goal.id, option_id: done.goal.option_id, done: measured.done, total: measured.total, unit: measured.unit } });
        await endPlan('completed', null, { reason: 'completed', source: 'executor', call_id: sources.get(done.goal.id)?.call_id ?? null });
        // decided: finishing ANY goal asks the planner, also while more goals wait in the queue
        trigger('goal_complete', { outcome: 'completed', option_id: done.goal.option_id });
        return { kind: 'goal_completed', goal_id: done.goal.id };
    }

    async function stepFailed(step, reason) {
        const failed = plan;
        stats.steps_failed++;
        noteStep(failed, step, false, reason, step_started);
        step_started = null;
        // decided: a walk to a patrol waypoint the routine chose is tried ONCE (the routine skips the waypoint)
        const once = failed.source === 'routine' && PATROL_OPTION.test(failed.goal.option_id ?? '');
        if (!once && step.attempts < config.max_attempts && !isFinal(reason)) {
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
        }, { parked: { step: step.i, command: step.command, attempts: step.attempts, max_attempts: config.max_attempts } });
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
        if (park_request !== null) {
            // the watchdog parked the step while it was between two tries
            const why = park_request;
            park_request = null;
            step.status = 'active';
            step.attempts = Math.max(1, step.attempts);
            stats.steps_parked_stuck++;
            return stepFailed(step, why);
        }
        expected_interrupt = null; // only the step that is running when the watchdog acts is meant
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
        step_started = null;
        if (guard?.fail) return stepFailed(step, guard.fail); // refused before anything was done

        const started_at = clock.now();
        step_started = started_at;
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

        if (hold && !result.ok) {
            // the operator's !stop ended the step: it was not tried and has not failed. It waits for the resume.
            step.attempts--;
            step.status = 'pending';
            await boundary();
            return { kind: 'held', step: step.i, wait_ms: config.idle_ms };
        }
        if (paused && !result.ok) {
            // the bot went down under the step (it died): not a try, not a reflex. What comes next is decided at the respawn.
            step.attempts--;
            step.status = 'pending';
            await boundary();
            return { kind: 'paused', step: step.i, reason: paused, wait_ms: config.idle_ms };
        }
        const parked_as = !result.ok && park_request !== null ? park_request : null;
        park_request = null;
        if (parked_as === null && result.interrupted && !result.timedout && expected_interrupt !== null) {
            // the watchdog stopped the step to have it tried afresh: not a reflex and not a failed try
            const why = expected_interrupt;
            expected_interrupt = null;
            stats.recovery_interruptions++;
            step.attempts--;
            await boundary();
            return { kind: 'step_recovery', step: step.i, reason: why, wait_ms: config.retry_gap_ms };
        }
        if (parked_as === null && result.interrupted && !result.timedout) {
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
        // (a template may say the step did what it was for although the skill answered false: after -> { ok: true })
        let reason = parked_as ?? after?.fail ?? (result.ok || after?.ok === true ? null : classifyFailure(step.command, result));
        if (parked_as !== null) stats.steps_parked_stuck++;
        // while the agent is held nothing more is done, not even tidying up: scaffold waits for the resume
        if (!hold && (await cleanScaffold()) > 0 && reason === null) reason = 'scaffold_left_in_zone';
        if (plan !== mine) return { kind: 'plan_gone' };
        if (reason !== null) return stepFailed(step, reason);

        step.status = 'done';
        stats.steps_done++;
        noteStep(mine, step, true, null, started_at);
        step_started = null;
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
        // held by the operator: nothing is retried, started or chosen until resume()
        if (hold) return { kind: 'held', wait_ms: config.idle_ms };
        // the bot is down (it died): nothing runs until the respawn decided what comes next
        if (paused) return { kind: 'paused', reason: paused, wait_ms: config.idle_ms };
        busy = true;
        try {
            for (const [goal_id, meta] of [...removal_pending]) await removeGoal(goal_id, meta);
            const queue = await queueOf();
            if (queue === null) return { kind: 'store_unavailable', wait_ms: config.idle_ms };
            if (detour) return await detourOnce();
            if (plan) {
                if (queue[0]?.id !== plan.goal.id && !removal_pending.has(plan.goal.id)) {
                    // the queue was replaced (a new plan from the planner or the operator)
                    const gone = plan;
                    say('agent.state', { state: 'goal_abandoned', detail: { goal_id: gone.goal.id, option_id: gone.goal.option_id, reason: 'replaced' } });
                    last_outcome = { option_id: gone.goal.option_id, title: gone.goal.title, outcome: 'abandoned', reason: 'replaced', at: clock.now() };
                    const info = endInfo(gone);
                    plan = null;
                    await boundary();
                    try { onGoalEnd({ ...last_outcome, ...info, source: gone.source, origin: gone.goal.origin ?? null, goal_id: gone.goal.id }); } catch { /* the listener's problem */ }
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
            for (const fn of after_turn.splice(0)) { try { fn(); } catch { /* the listener's problem */ } }
        }
    }

    // One thing of a recovery detour: a step of the detour goal in hand, the next goal the
    // chooser hands out, or the end of the detour (the goal that was kept goes on at its step).
    async function detourOnce() {
        if (plan) return await stepOnce();
        const mine = detour;
        let choice = null;
        try { choice = await mine.next({ goals_run: mine.goals_run, last: last_outcome ? { ...last_outcome } : null }); } catch { choice = null; }
        if (detour !== mine) return { kind: 'plan_gone' };
        if (choice?.goal) {
            mine.goals_run++;
            const goal = { id: nextId(), title: String(choice.goal.title).slice(0, 60), option_id: choice.goal.option_id };
            sources.set(goal.id, { source: 'recovery', call_id: null });
            return await startGoal(goal);
        }
        if (Number.isFinite(choice?.idle_ms)) return { kind: 'detour_waiting', wait_ms: choice.idle_ms };
        detour = null;
        plan = mine.main;
        interruptions = 0;
        reflex_reported = false;
        const step = plan ? plan.steps[plan.cursor] ?? null : null;
        say('agent.state', { state: 'detour_ended', detail: { reason: mine.reason, goals_run: mine.goals_run, goal_id: plan?.goal.id ?? null, option_id: plan?.goal.option_id ?? null, step: step?.i ?? null } });
        await boundary();
        try { mine.onEnd?.({ resumed: plan !== null, abandoned: false, goals_run: mine.goals_run, plan_id: plan?.id ?? null, step: step?.i ?? null }); } catch { /* the listener's problem */ }
        return { kind: 'detour_ended', resumed: plan !== null, wait_ms: 0 };
    }

    // Ends a detour before its chooser is done: its own goal goes, the goal it kept is in hand again.
    function cutDetour(reason) {
        if (!detour) return false;
        const cut = detour;
        const side = plan;
        detour = null;
        plan = cut.main;
        if (side) {
            sources.delete(side.goal.id);
            say('agent.state', { state: 'goal_abandoned', detail: { goal_id: side.goal.id, option_id: side.goal.option_id, reason } }, { corr: side.id, severity: 'warn' });
        }
        try { cut.onEnd?.({ resumed: false, abandoned: true, goals_run: cut.goals_run, plan_id: null, step: null }); } catch { /* the listener's problem */ }
        return true;
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
            if (checkpoint?.hold) {
                // the operator's !stop outlives a restart: the agent stays held until it is resumed
                hold = { by: String(checkpoint.hold.by ?? 'operator'), reason: String(checkpoint.hold.reason ?? 'operator_stop'), at: String(checkpoint.hold.at ?? new Date(clock.now()).toISOString()) };
                say('agent.state', { state: 'held', detail: { ...hold, restored: true, goal_id: plan?.goal.id ?? null, option_id: plan?.goal.option_id ?? null } });
            }
            started = true;
            checkpointer.start();
            return { resumed, checkpoint, load, held: hold !== null };
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
            cutDetour(reason); // a detour that is cut short takes its own goal with it, then the goal it kept is given up below
            if (!plan) return false;
            const gone = plan;
            const info = endInfo(gone);
            plan = null;
            say('agent.state', { state: 'goal_abandoned', detail: { goal_id: gone.goal.id, option_id: gone.goal.option_id, reason } }, { corr: gone.id, severity: 'warn' });
            last_outcome = { option_id: gone.goal.option_id, title: gone.goal.title, outcome: 'abandoned', reason, at: clock.now() };
            await removeGoal(gone.goal.id, { reason: `abandoned: ${reason}`, source, call_id: null });
            await boundary();
            try { onGoalEnd({ ...last_outcome, ...info, source: gone.source, origin: gone.goal.origin ?? null, goal_id: gone.goal.id }); } catch { /* the listener's problem */ }
            return true;
        },
        // ---- recovery (genesis/recovery) ----
        // The bot is down: no step runs, and the step that was cut off is neither a try nor a reflex.
        pause(reason = 'down') { paused = String(reason); },
        unpause() { paused = null; wake_sleep?.(); },
        isPaused: () => paused !== null,
        // Runs the goals `next` hands out, one after the other, while the goal in hand is kept
        // (the checkpoint goes on holding it). When `next` has nothing more, the kept goal goes on
        // at the step it was at. Nothing of a detour raises a planning trigger.
        //   next({ goals_run, last }) -> { goal: { title, option_id }, reason } | { idle_ms } | null
        //   onEnd({ resumed, abandoned, goals_run, plan_id, step })
        // Returns false when a detour is already running.
        detour({ reason = 'recovery', next, onEnd = null } = {}) {
            if (detour || typeof next !== 'function') return false;
            const main = plan;
            const step = main ? main.steps[main.cursor] ?? null : null;
            if (step && step.status === 'active') {
                // the step was cut off under the agent: it is tried again afterwards, and this try does not count
                step.status = 'pending';
                step.attempts = Math.max(0, step.attempts - 1);
            }
            detour = { reason: String(reason), next, onEnd, main, goals_run: 0 };
            plan = null; // the step still running finds its goal gone and ends without a verdict
            interruptions = 0;
            expected_interrupt = null;
            park_request = null;
            stats.detours++;
            say('agent.state', { state: 'detour_started', detail: { reason: detour.reason, goal_id: main?.goal.id ?? null, option_id: main?.goal.option_id ?? null, step: step?.i ?? null } }, { corr: main?.id ?? null });
            boundary().catch(() => {});
            wake_sleep?.();
            return true;
        },
        isDetouring: () => detour !== null,
        // Ends a running detour early and keeps the goal it kept (a second death during the re-equip starts it anew).
        cutDetour: (reason = 'cut') => cutDetour(reason),
        // The goal a reply of the planner must not replace: the one in hand, or the one a detour keeps.
        mainPlan: () => { const kept = detour ? detour.main : plan; return kept ? copy(kept) : null; },
        // The watchdog is about to stop the running step so that it is tried afresh.
        expectInterrupt(reason = 'recovery') { if (plan) expected_interrupt = String(reason); return plan !== null; },
        // The watchdog parks the step in hand: its goal ends as failed with this reason, and the next goal starts.
        park(reason = 'stuck') { if (!plan) return false; park_request = String(reason); wake_sleep?.(); return true; },
        // The routine gives way after the step it is on.
        requestYield(reason) { yield_reason = reason; },
        // The operator's !stop: hold everything until resume(). Set at once (before the first
        // await), so the step the stop interrupts is already seen as held. Resolves to true when
        // the agent was not held before.
        async hold({ by = 'operator', reason = 'operator_stop' } = {}) {
            if (hold) return false;
            hold = { by: clipText(by, 40), reason: clipText(reason, 80), at: new Date(clock.now()).toISOString() };
            stats.holds++;
            const step = plan ? plan.steps[plan.cursor] ?? null : null;
            say('agent.state', { state: 'held', detail: { ...hold, goal_id: plan?.goal.id ?? null, option_id: plan?.goal.option_id ?? null, step: step?.i ?? null } });
            await boundary(); // the hold is in the checkpoint from now on
            return true;
        },
        // The operator lets the agent go on: it carries on with the step it was held at.
        async resume({ by = 'operator' } = {}) {
            if (!hold) return false;
            const was = hold;
            hold = null;
            say('agent.state', { state: 'hold_released', detail: {
                by: clipText(by, 40), held_by: was.by, held_at: was.at, held_ms: Math.max(0, Math.round(clock.now() - Date.parse(was.at))),
                goal_id: plan?.goal.id ?? null, option_id: plan?.goal.option_id ?? null,
            } });
            await boundary();
            wake_sleep?.();
            return true;
        },
        isHeld: () => hold !== null,
        holdInfo: () => (hold ? { ...hold } : null),
        saveNow: () => checkpointer.saveNow(),
        plan: () => (plan ? copy(plan) : null),
        corr: () => plan?.id ?? null,
        lastOutcome: () => (last_outcome ? { ...last_outcome } : null),
        isBusy: () => busy,
        // Runs fn once the thing the executor is doing right now (starting a goal, a step, ending a goal with
        // all its bookkeeping) is done; at once when it is doing nothing.
        afterTurn(fn) { if (busy) after_turn.push(fn); else fn(); },
        stats: () => ({ ...stats, scaffold_tracked: scaffold?.count() ?? 0 }),
    };
}
