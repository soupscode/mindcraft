// Genesis: one agent's decision loop, put together. It replaces Mindcraft's "ask the model
// after every action" loop for an agent that has the genesis_planning setting on:
//
//   executor   carries out the goals in the short-term queue from the skill templates
//   planner    turns triggers into planning requests to the broker in the MindServer
//   routine    scripted work for when the queue is empty and no reply is coming
//
// Order of work: queued goals first, then the role routine. The model is only asked when
// something changed (a goal completed, a step failed after its retries, a reflex
// interrupted, another agent asked, the operator spoke), and never waited for.
//
// The operator's !stop HOLDS the agent (hold()): no step, no retry, no routine and no
// planning request until resume(). The hold is in the checkpoint and survives a restart.
//
// The chest ledger is ONE for all agents, held in the MindServer; `ledger` is this agent's
// copy of it (genesis/catalog/ledger_client.js). When the agent wants items another agent
// has reserved, the catalog reports a contested claim: it becomes an agent.state event
// "contested_claim" { chest, item, count, holder, asker, ... } and is handed to
// `onContestedClaim(claim)`, the hook the agent-to-agent request will be sent from (a later
// step: nothing is sent to the other agent here).
//
// Everything that touches Minecraft, the MindServer, the clock or files is injected, so
// this file runs unchanged in the tests:
//   view, ops              the world view and the step runner (genesis/adapters/bot_world.js, bot_ops.js)
//   send(event, ...args)   the socket to the MindServer
//   goal_storage           { load, save } behind the goal store (the MindServer's, over the socket)
//   checkpoints            the checkpoint store
//   emit, getSeq           the agent's event emitter (genesis/events/agent_emit.js)
//   ledger                 the agent's copy of the shared chest ledger (a plain one when left out: the tests)
//   onContestedClaim       (claim) -> void   see above
// Depends only on other Genesis files.

import { createExecutor } from '../executor/executor.js';
import { createScaffoldTracker } from '../executor/scaffold.js';
import { createLedger } from '../catalog/ledger.js';
import { createGoalStore, goalChangedEventData } from '../store/goal_store.js';
import { createAgentPlanner } from '../planning/agent_planner.js';
import { createRoutine } from '../routines/engine.js';
import { routineFor } from '../routines/routines.js';
import { clipText } from '../shared/events.js';

export function createAgentRuntime({
    agent, zones, catalog, view, ops, goal_storage, checkpoints, send, emit = () => null, getSeq = () => 0,
    clock = { now: Date.now, setTimeout, clearTimeout }, ledger = createLedger(), scaffold = null,
    routine: routine_definition = routineFor(agent), memory = () => '', ids = null,
    executor: executor_options = {}, planner: planner_options = {}, rules = {}, onContestedClaim = () => {},
    contested_quiet_ms = 60 * 1000,
} = {}) {
    const tracker = scaffold ?? createScaffoldTracker({ zones });
    const stats = { deaths: 0, operator_messages: 0, agent_requests: 0, ignored_messages: 0, ignored_chat: 0, contested_claims: 0, contested_repeats: 0 };
    const ignored_by = new Map();      // who was not listened to -> how often (the newest 50 names)
    const contested_seen = new Map();  // "chest|item|holder" -> when the claim was last reported
    let long_term = [];
    let queued = 0;         // goals in the short-term queue
    let executor = null;
    let last_worker = null; // 'routine' | 'planner': who chose the goal that ended last
    let idle_since = null;  // when the agent ran out of queued goals

    const say = (type, data, opts) => { try { return emit(type, data, opts); } catch { return null; } };

    const goals = createGoalStore({
        storage: goal_storage, clock, ids,
        onChange(change) {
            if (change.scope === 'long_term') long_term = change.after;
            else queued = change.after.length;
            say('goal.changed', goalChangedEventData(change), { corr: executor?.corr() ?? null });
        },
    });

    const routine = routine_definition
        ? createRoutine({ agent, definition: routine_definition, catalog, zones, clock, emit: say, rules })
        : null;

    // The world as it is now, for the catalog.
    const state = () => ({ agent, view, ledger, avoid: routine?.avoid() ?? [], now: clock.now() });

    // The agent wanted items another agent has reserved. One event per claim and minute (a
    // routine asks again every round), and the hook for the request to the other agent.
    function contested(claim) {
        const now = clock.now();
        const key = `${claim.chest}|${claim.item}|${claim.holder}`;
        const last = contested_seen.get(key);
        if (last !== undefined && now - last < contested_quiet_ms) { stats.contested_repeats++; return; }
        contested_seen.set(key, now);
        if (contested_seen.size > 100) contested_seen.delete(contested_seen.keys().next().value);
        stats.contested_claims++;
        const detail = { chest: claim.chest, item: claim.item, count: claim.count, holder: claim.holder, asker: claim.asker ?? agent, held: claim.held ?? null, in_chest: claim.in_chest ?? null };
        say('agent.state', { state: 'contested_claim', detail }, { corr: executor?.corr() ?? null });
        try { onContestedClaim({ ...detail, at: now }); } catch { /* the listener's problem */ }
    }
    catalog.setContestedHook?.(contested);

    const planner = createAgentPlanner({
        agent, send, clock, catalog, state, goals,
        describe: () => ({
            role: routine_definition?.role ?? null,
            long_term,
            last_outcome: executor.lastOutcome(),
            // the routine the agent is on, or was on when it ran out of work
            routine: routine && (executor.plan() ? executor.plan().source === 'routine' : last_worker === 'routine') ? routine.snapshot() : null,
            home_distance: zones.distanceFromHome(agent, view.position()),
            memory: memory(), // the memory step is not built yet: '' keeps the slot empty
        }),
        // a reply does not replace the goal in hand, unless the routine chose it: the routine gives way
        inHand: () => (executor.plan() && executor.plan().source !== 'routine' ? executor.plan().goal.id : null),
        held: () => executor?.isHeld() ?? false,
        onGoals(queued, origin, { dropped = [] } = {}) {
            idle_since = null;
            executor.noteGoals(queued, origin);
            for (const goal of dropped) {
                say('agent.state', { state: 'goal_dropped', detail: { goal_id: goal.id, option_id: goal.option_id, reason: 'replaced_by_new_plan', source: 'planner', call_id: origin.call_id ?? null } },
                    { corr: null });
            }
            executor.wake();
        },
        onGate({ opened, closed, state: gate_state, reason }) {
            if (closed) routine?.awayStarted();
            if (opened) {
                routine?.modelReturned();
                // the routine finishes the step it is on, keeps its phase, and gives way
                if (executor.plan()?.source === 'routine') executor.requestYield('the model is back');
                // back to planning, unless goals the planner or the operator chose are still to be done
                const routine_work = executor.plan() === null ? queued === 0 : executor.plan().source === 'routine';
                if (routine_work && !planner.hasPending()) planner.trigger('model_returned');
            }
            if (opened || closed) say('agent.state', { state: opened ? 'planning' : 'on_routine', detail: { gate: gate_state, reason } }, { corr: null });
            executor.wake();
        },
        ...planner_options,
    });

    // Asked by the executor whenever the queue is empty.
    async function chooseWork() {
        const now = clock.now();
        idle_since ??= now;
        // a reply may be about to come: do not start something only to drop it
        if (planner.waitingForReply(now, idle_since)) return { idle_ms: 2000 };
        if (!routine) return null;
        const choice = routine.next(state());
        if (choice?.goal) idle_since = null;
        return choice;
    }

    executor = createExecutor({
        agent, catalog, goals, checkpoints, ops, state, emit: say, getSeq, clock, scaffold: tracker, zones, ids,
        onTrigger: ({ kind, detail }) => planner.trigger(kind, detail),
        chooseWork,
        onGoalEnd(end) {
            last_worker = end.source === 'routine' ? 'routine' : 'planner';
            if (end.source === 'routine') routine?.goalEnded(end);
            catalog.release?.(end.option_id, state()); // whatever the goal had reserved in the chest ledger is free again
        },
        // the chest ledger is not in the checkpoint any more: it is one ledger, held in the MindServer
        extras: () => ({
            routine: routine?.snapshot() ?? null,
            pending_request: planner.pending(),
            places: {},
        }),
        ...executor_options,
    });

    return {
        agent, goals, executor, planner, routine, ledger, scaffold: tracker, state,
        // Loads the checkpoint (the executor resumes the step it was on), then tells the broker
        // the agent is there and learns whether the model is. Resolves to the executor's start result.
        async start() {
            const begun = await executor.start();
            if (begun.checkpoint) routine?.restore(begun.checkpoint.routine);
            // the shared ledger as the MindServer has it (not connected: the copy starts empty and learns by looking)
            try { await ledger.sync?.(); } catch { /* the copy works on what it knows */ }
            const got = await goals.get(agent);
            if (got.ok) { long_term = got.goals.long_term; queued = got.goals.short_term.length; }
            routine?.awayStarted(); // until the broker says the model is there, it is away
            try {
                send('genesis-hello', agent, (answer) => { if (answer?.gate) planner.onGate({ state: answer.gate, reason: answer.reason ?? null }); });
            } catch { /* not connected: the gate stays AWAY and the agent works from its queue and routine */ }
            return begun;
        },
        run: () => executor.run(),
        stop: () => executor.stop(),
        // ---- what arrives over the socket ----
        onPlanContext: (request, ack) => planner.onContextRequest(request, ack),
        onPlanQueued: (message) => planner.onQueued(message),
        async onPlanResult(result) {
            const outcome = await planner.onResult(result);
            executor.wake(); // goals to start, or nothing came and the routine goes on
            return outcome;
        },
        onGate: (message) => planner.onGate(message),
        // ---- what happens to the agent ----
        // The operator said something (the panel, or chat in the game).
        operatorMessage(from, text) {
            stats.operator_messages++;
            return planner.trigger('operator_message', { from: clipText(from, 40), text: clipText(text, 400) });
        },
        // Another agent asks for something.
        agentRequest(from, text) {
            stats.agent_requests++;
            return planner.trigger('agent_request', { from: clipText(from, 40), text: clipText(text, 400) });
        },
        // The agent died at `point` (it has already respawned). The goal in hand is given up.
        async died(point) {
            stats.deaths++;
            const verdict = routine ? routine.died(point) : 'restart';
            await executor.abandon('died');
            planner.trigger('reflex_interrupt', { cause: 'death' });
            say('agent.state', { state: verdict === 'parked' ? 'parked' : 'respawned', detail: { deaths: routine?.deaths() ?? stats.deaths } }, { corr: null, severity: 'warn' });
            executor.wake();
            return verdict;
        },
        ignoredMessage() { stats.ignored_messages++; },
        // Somebody who is not the operator said something in the game: not listened to, but counted.
        ignoredChat(from) {
            stats.ignored_chat++;
            const name = clipText(from, 40);
            ignored_by.set(name, (ignored_by.get(name) ?? 0) + 1);
            if (ignored_by.size > 50) ignored_by.delete(ignored_by.keys().next().value);
        },
        // The operator's !stop. The executor holds until resume(); see genesis/executor/executor.js.
        hold: ({ by = 'operator', reason = 'operator_stop' } = {}) => executor.hold({ by, reason }),
        async resume({ by = 'operator' } = {}) {
            const released = await executor.resume({ by });
            if (!released) return false;
            // nothing was asked of the planner during the hold: an agent that comes back with nothing to do asks now
            if (queued === 0 && executor.plan() === null && planner.modelAvailable() && !planner.hasPending()) planner.trigger('model_returned');
            executor.wake();
            return true;
        },
        isHeld: () => executor.isHeld(),
        lastThought: () => planner.lastThought(),
        stats: () => ({
            ...stats, ignored_by: Object.fromEntries(ignored_by), held: executor.isHeld(),
            executor: executor.stats(), planner: planner.stats(), routine: routine?.stats() ?? null,
        }),
    };
}
