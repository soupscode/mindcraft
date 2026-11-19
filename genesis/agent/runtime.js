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
//   learning               the agent's end of the socket to the learner (genesis/learning/client.js). Left out: nothing is
//                          recorded and nothing is scored; the agent works exactly as it did before there was a learner.
//   town, building         the agent's copy of the town (genesis/town/client.js: createTownClient) and what the building ladder
//                          is asked from it (building()). The zones and the catalog handed in must then be the town's
//                          (townZones, townBlueprints). Left out: the world file's plots as they are, and no ladder.
//   learned_choice         false: the learner records and annotates, but the routine's own rule chooses while the model is away
//   recovery_ops           what the watchdog's ladder moves the bot with (genesis/adapters/bot_recovery.js):
//                          { interrupt(), moveAway(blocks), surfaceOrHome(home), restartProcess(reason) }
//                          Left out (the older tests): no watchdog runs.
//
// Recovery (genesis/recovery): the watchdog compares the agent's progress every 10 seconds and
// climbs its ladder when there is none; a death is followed by a detour (walk home, re-equip
// from the kits chest) after which a goal the planner or the operator chose goes on at the
// same step, with no model call; every recovery action is an agent.failure or agent.recovery
// event in the incident shape.
//
// Agent messages (genesis/relay; only with `messaging: true`): the agent talks to other agents
// through structured messages that the relay in the MindServer carries and limits. A contested
// claim becomes a request to the holder. The planner may choose to send a request or an offer
// as a goal (ask_agent, offer_agent: the catalog offers them while the desk has room for one,
// and the goal's one step is sent from here, never by the bot). A request or offer that
// arrives is decided by the model with a small call of its own (source "planner"), and by a
// code rule when the model cannot (source "routine"); what the agent accepts becomes a goal
// the executor carries out.
// Depends only on other Genesis files.

import { createExecutor } from '../executor/executor.js';
import { createScaffoldTracker } from '../executor/scaffold.js';
import { createLedger } from '../catalog/ledger.js';
import { createGoalStore, goalChangedEventData } from '../store/goal_store.js';
import { createAgentPlanner } from '../planning/agent_planner.js';
import { createRoutine } from '../routines/engine.js';
import { routineFor } from '../routines/routines.js';
import { SHELTER } from '../routines/engine.js';
import { clipText } from '../shared/events.js';
import { createIncidentReporter, INCIDENT_KINDS } from '../recovery/incidents.js';
import { createWatchdog, progressSignature, SIGNATURE_DEFAULTS, BLOCKED_REASONS } from '../recovery/watchdog.js';
import { createDeathRecovery, DEATH_RULES } from '../recovery/death.js';
import { createMessageDesk } from '../relay/desk.js';
import { MESSAGE_STEP } from '../catalog/ops.js';
import { PATROL_OPTION } from '../catalog/zones.js';
import { createRecorder } from '../learning/recorder.js';
import { PROMPT_VERSION } from '../planning/context.js';
import { needOf, NEED } from '../learning/need.js';
import { createBuildTracker } from '../town/tracker.js';
import { createLongTerm } from './../planning/long_term.js';

export function createAgentRuntime({
    agent, zones, catalog, view, ops, goal_storage, checkpoints, send, emit = () => null, getSeq = () => 0,
    clock = { now: Date.now, setTimeout, clearTimeout }, ledger = createLedger(), scaffold = null,
    routine: routine_definition = routineFor(agent), memory = () => '', ids = null,
    executor: executor_options = {}, planner: planner_options = {}, rules = {}, onContestedClaim = () => {},
    contested_quiet_ms = 60 * 1000, recovery_ops = null, watchdog: watchdog_options = {}, death: death_options = {},
    messaging = false, desk: desk_options = {}, relay_limits = {}, learning = null, learned_choice = true,
    town = null, building = null, tracker: tracker_options = {}, prefabs = null, long_term: long_term_options = {},
} = {}) {
    const tracker = scaffold ?? createScaffoldTracker({ zones });
    const stats = { deaths: 0, deaths_without_request: 0, operator_messages: 0, agent_requests: 0, ignored_messages: 0, ignored_chat: 0, contested_claims: 0, contested_repeats: 0, learned_choices: 0, learned_tries: 0 };
    const ignored_by = new Map();      // who was not listened to -> how often (the newest 50 names)
    const contested_seen = new Map();  // "chest|item|holder" -> when the claim was last reported
    let long_term = [];
    let queued = 0;         // goals in the short-term queue
    let short_term = [];    // the queue itself, as of its last change
    let executor = null;
    let last_worker = null; // 'routine' | 'planner': who chose the goal that ended last
    let idle_since = null;  // when the agent ran out of queued goals
    let watchdog = null;    // genesis/recovery/watchdog.js (only with recovery_ops)
    let death = null;       // { incident, point, plan_id, count } while the re-equip after a death runs
    let died_on = null;     // { plan_id, count }: how often the agent died on the goal it has in hand
    let desk = null;        // genesis/relay/desk.js (only with messaging)
    const death_rules = { ...DEATH_RULES, ...death_options };
    const signature_rules = { ...SIGNATURE_DEFAULTS };
    for (const key of Object.keys(SIGNATURE_DEFAULTS)) if (watchdog_options[key] !== undefined) signature_rules[key] = watchdog_options[key];

    // learning (genesis/learning; only with a learning client): every goal is recorded, with the situation it started
    // in and what became of it. `choices` remembers how a goal was chosen until it starts or ends.
    let recorder = null;
    let builds = null;          // genesis/town/tracker.js (only with a town)
    let long_term_goals = null; // genesis/planning/long_term.js (only with a town and the prefabs)
    let town_seen = -1;         // the version of the town the long-term goals were last brought up to
    let town_timer = null;
    const choices = new Map();  // option id -> { chooser, explore, decision_id, call_id }
    let decision_counter = 0;
    const choiceOf = (option_id, source) => {
        const choice = choices.get(option_id) ?? null;
        if (!choice) return null;
        // (a routine goal the learner picked is the "network"'s choice; anybody else's goal with the same option is not)
        return choice.chooser === 'network' ? (source === 'routine' ? choice : null) : (source === 'planner' ? choice : null);
    };

    const say = (type, data, opts) => { try { return emit(type, data, opts); } catch { return null; } };
    const reporter = createIncidentReporter({ emit: say, source: { type: 'agent', name: agent }, clock, ids });

    const goals = createGoalStore({
        storage: goal_storage, clock, ids,
        onChange(change) {
            if (change.scope === 'long_term') long_term = change.after;
            else { queued = change.after.length; short_term = change.after; }
            say('goal.changed', goalChangedEventData(change), { corr: executor?.corr() ?? null });
        },
    });

    const routine = routine_definition
        ? createRoutine({ agent, definition: routine_definition, catalog, zones, clock, emit: say, rules })
        : null;

    // The world as it is now, for the catalog. duties: what the agent agreed to hand over (the
    // give_items option only exists for those). talk: the message desk's view of what may be sent
    // right now (ask_agent and offer_agent are only offered with it); null without a desk.
    // building: the town's builds as the ladder is asked about them (genesis/town/client.js); without a town there is no ladder.
    const state = () => ({
        agent, view, ledger, avoid: routine?.avoid() ?? [], now: clock.now(),
        duties: desk?.duties() ?? [], talk: desk?.talk() ?? null, handedOver: (args, how) => desk?.handedOver(args, how),
        ...(building ? { building } : {}),
        // the agent put its bed in its home (the furnish_home goal): the town is told
        furnished: (what) => { if (what === 'bed') town?.op({ kind: 'home', bed_placed: true }).catch(() => {}); },
    });

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
        // the request to the holder: the item, the count, and the agent's goal as the reason. It goes out once
        // the goal that was refused has ended with all its bookkeeping: what that goal gives back must
        // not be what the holder hands over a moment later
        if (desk) {
            // the goal the agent wanted the items for: the one in its queue that fetches them, else its first long-term goal
            const wanted = short_term.find((goal) => typeof goal.option_id === 'string' && goal.option_id.startsWith(`fetch_items:${claim.chest}:${claim.item}:`));
            const reason = wanted?.title ?? long_term[0]?.title ?? null;
            executor.afterTurn(() => { desk.contested(detail, reason).catch(() => {}); });
        }
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
        // (a goal kept through a recovery detour is still the goal in hand)
        inHand: () => { const kept = executor.mainPlan(); return kept && kept.source !== 'routine' ? kept.goal.id : null; },
        // what the agent agreed with another agent is not the plan's to replace: an accepted hand-over stays queued
        keeps: (goal) => desk?.owes(goal) ?? false,
        held: () => executor?.isHeld() ?? false,
        // the learner orders and annotates the options the model is shown; a learner that does not answer changes nothing
        rank: learning ? async (options, now_state) => {
            const situations = Object.fromEntries(options.map((option) => [option.id, recorder.situate(option)]));
            // need is computed by code, never learned (genesis/learning/need.js): the agent's own work comes before a walk to
            // the camp or a craft nothing asked for, however quick and sure those are
            const inventory = now_state.view.inventory();
            const holds = (suffix) => Object.keys(inventory).some((item) => item.endsWith(suffix) && inventory[item] > 0);
            const need = Object.fromEntries(options.map((option) => [option.id, needOf(option, { role: routine_definition?.role ?? null, holds })]));
            return learning.rank({ options: options.map(({ id, skill, args, title }) => ({ id, skill, args, title })), situations, need, chooser: 'planner' });
        } : null,
        onDecision(decision) {
            if (!learning) return;
            const decision_id = `${agent}-d-${clock.now()}-${++decision_counter}`;
            learning.decision({
                decision_id, chooser: 'planner', call_id: decision.call_id, offered: decision.offered, chosen: decision.chosen, default_choice: decision.default_choice,
                situation: recorder.situate({ id: decision.chosen[0] ?? '', skill: '', args: {} }), prompt_version: PROMPT_VERSION,
            });
            for (const option_id of decision.added) choices.set(option_id, { chooser: 'planner', explore: false, decision_id, call_id: decision.call_id });
            if (choices.size > 24) choices.delete(choices.keys().next().value);
        },
        onGoals(queued, origin, { dropped = [], stale = [] } = {}) {
            if (queued.length > 0 || stale.length === 0) idle_since = null;
            executor.noteGoals(queued, origin);
            // a goal of the reply that could no longer be started when the reply arrived: said, never queued, not a failure
            for (const goal of stale) {
                say('agent.state', { state: 'goal_not_started', detail: { option_id: goal.option_id, reason: goal.reason, source: 'planner', call_id: origin.call_id ?? null } }, { corr: null });
            }
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

    // WHILE THE MODEL IS AWAY THE LEARNER CHOOSES (decided: free choice among ALL options the catalog offers, not only
    // those of the routine's phase). The routine's own pick is still worked out: it is what the unlearned rule would
    // have done (the decision row keeps it), it counts for more in the choice (genesis/learning/need.js), and it is
    // what happens when the learner does not answer. Never chosen for: a hard safety rule of the routine (parked,
    // the walk home after a death, the shelter when a bound is breached), which stays exactly as it was. Building:
    // a build that was started may be continued, a new one is never started (the scorer sees to it).
    // Returns the learner's choice in the shape of the routine's, or null (then the routine's own choice stands).
    // What the learner does not choose although it is offered: an option that would use up what a build this agent
    // has STARTED still wants (a craft from its planks, storing or offering its materials). Decided: a started build is
    // continued while the model is away; a learner that turned the builder's planks into sticks between two build goals
    // would end it. What leads to the build's own materials (a door from planks for a build that wants a door) is not held back.
    function heldBack(options, world, started) {
        const mine = started.filter((plot) => zones.plot(plot)?.owner === agent);
        if (mine.length === 0) return [];
        const wants = (item) => typeof item === 'string' && mine.some((plot) => catalog.needOf(`build_blueprint:${plot}`, item, world) > 0);
        return options.filter((option) => {
            if (option.for_build) return false;
            if (option.skill === 'craft_item') { let used = {}; try { used = view.ingredients?.(option.args.item) ?? {}; } catch { used = {}; } return Object.keys(used).some(wants); }
            if (option.skill === 'store_items' || option.skill === 'offer_agent' || option.skill === 'smelt_item') return wants(option.args.item);
            return false;
        }).map((option) => option.id);
    }

    async function learnedChoice(world, choice) {
        if (!learning || !recorder || learned_choice === false || planner.modelAvailable() || choice?.reflex) return null;
        try {
            const pick_id = choice?.goal?.option_id ?? null;
            // what failed this round is not offered again in it, as the routine has it
            const failed_now = new Set(routine.skipped());
            let options = catalog.offer(world, failed_now.size > 0 ? { exclude: failed_now } : {});
            // the routine's pick is a catalog option whose preconditions were just checked: it is on the list
            if (pick_id !== null && !options.some((option) => option.id === pick_id)) {
                const checked = catalog.check(pick_id, world);
                if (checked.ok) options = [checked.option, ...options];
            }
            if (options.length === 0) return null;
            const inventory = view.inventory();
            const holds = (suffix) => Object.keys(inventory).some((item) => item.endsWith(suffix) && inventory[item] > 0);
            const role = routine_definition?.role ?? null;
            const need = Object.fromEntries(options.map((option) => [option.id, needOf(option, { role, routine_pick: pick_id, holds })]));
            const situations = Object.fromEntries(options.map((option) => [option.id, recorder.situate(option)]));
            const started = world.building?.startedPlots?.() ?? [];
            const answer = await learning.choose({
                options: options.map(({ id, skill, args, title }) => ({ id, skill, args, title })), situations, need,
                started_builds: started, held_back: heldBack(options, world, started), default_choice: pick_id,
            });
            const option = answer?.chosen ? options.find((it) => it.id === answer.chosen) ?? null : null;
            if (!option) return null; // no answer, or nothing eligible: the routine's own choice stands. Never anything that was not offered.
            // nothing worth doing: when the routine's own rule has nothing either and the best there is serves nothing by
            // itself (a walk to the camp, taking things out of a chest), the agent waits as the routine would. A try is a try.
            if (pick_id === null && !answer.explore && (need[option.id] ?? 1) < NEED.some) return null;
            choices.set(option.id, { chooser: 'network', explore: answer.explore, decision_id: answer.decision_id, call_id: null });
            if (choices.size > 24) choices.delete(choices.keys().next().value);
            stats.learned_choices++;
            if (answer.explore) stats.learned_tries++;
            say('agent.state', { state: 'learned_choice', detail: { option_id: option.id, title: option.title, explore: answer.explore, decision_id: answer.decision_id, routine_pick: pick_id, differs: pick_id !== option.id } }, { corr: null });
            return { goal: { title: option.title, option_id: option.id }, reason: answer.reason ?? 'learned estimate', routine: choice?.routine ?? routine.snapshot(), learned: true, explore: answer.explore };
        } catch {
            return null;
        }
    }

    // Asked by the executor whenever the queue is empty.
    async function chooseWork() {
        const now = clock.now();
        idle_since ??= now;
        // a reply may be about to come: do not start something only to drop it
        if (planner.waitingForReply(now, idle_since)) return { idle_ms: 2000 };
        if (!routine) return null;
        const world = state();
        const own = routine.next(world);
        const choice = (await learnedChoice(world, own)) ?? own;
        // a safety rule's pick is a decision too: the one option it had
        if (learning && recorder && choice === own && own?.reflex && own.goal) {
            try {
                learning.decision({ chooser: 'routine', offered: [{ id: own.goal.option_id }], chosen: own.goal.option_id, default_choice: own.goal.option_id, situation: recorder.situate({ id: own.goal.option_id, skill: '', args: {} }), prompt_version: null });
            } catch { /* recording never stops the work */ }
        }
        if (choice?.goal) idle_since = null;
        return choice;
    }

    // The step runner the executor is given. A step that is not an upstream skill never reaches the bot:
    // the message of an ask_agent or offer_agent goal goes to the relay through the desk, which records
    // who chose to send it (the origin of the goal in hand).
    const stepper = {
        run(command, args, context) {
            if (command !== MESSAGE_STEP) return ops.run(command, args, context);
            if (!desk) return Promise.resolve({ ok: false, interrupted: false, timedout: false, output: 'message_rejected: no_messaging' });
            const goal = executor.plan()?.goal ?? null;
            return desk.sendStep(args, { origin: goal ? { by: goal.origin ?? null, call_id: goal.call_id ?? null } : null });
        },
    };

    executor = createExecutor({
        agent, catalog, goals, checkpoints, ops: stepper, state, emit: say, getSeq, clock, scaffold: tracker, zones, ids,
        onTrigger: ({ kind, detail }) => planner.trigger(kind, detail),
        chooseWork,
        onGoalStart(start) {
            recorder?.started(start, choiceOf(start.option_id, start.source));
            try { builds?.goalStarted(start); } catch { /* the town never stops a goal */ }
        },
        onStep() { recorder?.step(); },
        onGoalEnd(end) {
            // the outcome goes to the learner first, with the world as the goal left it
            recorder?.ended(end, choiceOf(end.option_id, end.origin ?? end.source));
            choices.delete(end.option_id);
            try { builds?.goalEnded(end); } catch { /* the town never stops a goal */ }
            catalog.release?.(end.option_id, state()); // whatever the goal had reserved in the chest ledger is free again
            desk?.goalEnded(end).catch(() => {});      // a hand-over that ended: the other agent is told
            if (end.origin === 'recovery') return; // a goal of a recovery detour is nobody's work
            // what just failed is not offered again while nothing has changed (the planner asked for the same goal four times in a row)
            if ((end.outcome === 'failed' || end.outcome === 'dropped') && end.source !== 'routine') planner.noteFailure?.(end.option_id, end.reason, end.title ?? null, end.outcome === 'dropped' ? 'not_started' : 'failed');
            last_worker = end.source === 'routine' ? 'routine' : 'planner';
            if (end.source === 'routine') routine?.goalEnded(end);
            // (decided: a patrol waypoint that could not be reached is skipped quietly: no incident)
            const patrol_skip = end.source === 'routine' && PATROL_OPTION.test(end.option_id ?? '');
            if (end.outcome === 'failed' && end.parked && !patrol_skip) {
                // decided: a step is tried 3 times, then it is parked and ONE incident is logged
                const stuck = end.reason === 'stuck';
                const incident = reporter.detected({
                    kind: INCIDENT_KINDS.STEP_PARKED, outcome: 'gave_up', reason: end.reason, option_id: end.option_id, command: end.parked.command,
                    recovery: { step: stuck ? 'park_step' : 'retry', attempt: end.parked.attempts, max: end.parked.max_attempts, result: 'failed' },
                });
                void incident;
            }
        },
        // the chest ledger is not in the checkpoint any more: it is one ledger, held in the MindServer
        extras: () => ({
            routine: routine?.snapshot() ?? null,
            pending_request: planner.pending(),
            places: {},
            recovery: recoverySnapshot(),
        }),
        ...executor_options,
    });

    // the town (genesis/town; only with a town client): this agent's builds are told to it and verified, and plots it wants are proposed
    if (town) builds = createBuildTracker({ agent, town, catalog, zones, state, view, scaffold: tracker, clock, emit: say, rules: tracker_options });
    // long-term goals (genesis/planning/long_term.js; with a town and the prefabs): the model's own choice within the
    // role, Arthur's next rung of the ladder pinned in front, the operator's override above both
    if (town && prefabs) {
        long_term_goals = createLongTerm({ agent, role: routine_definition?.role ?? null, goals, town, prefabs, send, modelAvailable: () => planner.modelAvailable(), clock, rules: long_term_options });
    }
    if (learning) {
        recorder = createRecorder({ agent, client: learning, view, zones, catalog, state, clock, queueLength: () => queued, modelAvailable: () => planner.modelAvailable() });
    }
    if (messaging) {
        desk = createMessageDesk({ agent, send, clock, catalog, state, goals, executor, planner, emit: say, rules: desk_options, limits: relay_limits });
    }

    // ---- recovery ----

    // What the checkpoint keeps of a recovery that is under way (null: nothing is).
    function recoverySnapshot() {
        const watch = watchdog?.snapshot() ?? null;
        const dying = death ? { incident_id: death.incident.incident_id, point: death.point, plan_id: death.plan_id, count: death.count } : null;
        return watch || dying ? { watchdog: watch, death: dying } : null;
    }

    // Is the agent shut in? Nothing in hand, and the last goal ended because the agent could not get there.
    function blocked() {
        const last = executor.lastOutcome();
        // (a patrol waypoint that was skipped is not the agent being shut in: the watchdog does not count it as stuck)
        return last !== null && (last.outcome === 'failed' || last.outcome === 'dropped') && BLOCKED_REASONS.includes(last.reason)
            && !PATROL_OPTION.test(last.option_id ?? '');
    }

    // Why the agent is not stuck even when nothing moves, or null when it is trying to work.
    function watchStatus() {
        if (executor.isHeld()) return 'held';       // the operator's !stop
        if (executor.isPaused()) return 'down';     // dead, waiting for the respawn
        const plan = executor.plan();
        if (plan) {
            const step = plan.steps[plan.cursor] ?? null;
            return step && step.status === 'active' && signature_rules.stationary_commands.includes(step.command) ? 'stationary_step' : null;
        }
        if (routine && routine.phase() === SHELTER && view.dayTicksLeft() <= 0) return 'sheltering'; // at home for the night
        if (planner.modelAvailable() && planner.hasPending()) return 'waiting_model';
        if (blocked()) return null;
        return 'idle';
    }

    // The re-equip after a death: walk home, look into the kit chest, take what is missing.
    function startDeathDetour(incident, point, plan_id, count) {
        const chooser = createDeathRecovery({ agent, catalog, zones, state, rules: death_rules });
        death = { incident, point: point ?? null, plan_id, count };
        return executor.detour({
            reason: 'died',
            next(info) {
                const choice = chooser.next(info);
                if (choice?.goal) reporter.step(incident, { step: choice.step, attempt: info.goals_run + 1, max: death_rules.max_detour_goals, result: 'pending' }, { option_id: choice.goal.option_id });
                return choice;
            },
            onEnd({ resumed, abandoned, goals_run, plan_id: resumed_plan, step }) {
                death = null;
                if (abandoned) return;
                reporter.resolved(incident, {
                    recovery: { step: 'resume', attempt: count, max: death_rules.max_deaths_per_goal, result: resumed ? 'ok' : 'skipped' },
                    outcome: 'auto_recovered', plan_id: resumed_plan, plan_step: step, detour_goals: goals_run,
                });
            },
        });
    }

    if (recovery_ops) {
        const stoppedStep = (reason) => executor.expectInterrupt(reason);
        watchdog = createWatchdog({
            clock, reporter,
            signature: () => progressSignature({ position: view.position(), inventory: view.inventory(), step: executor.stats().steps_done }, signature_rules.cell_size),
            status: watchStatus,
            actions: {
                // 1: the step is stopped and tried afresh, which searches a new path
                async repath() {
                    if (!stoppedStep('watchdog_repath')) return { ok: false, skipped: true, detail: 'no step in hand' };
                    return { ok: (await recovery_ops.interrupt()) !== false };
                },
                // 2: a few blocks away, then the step is tried again
                async move_away() {
                    stoppedStep('watchdog_move_away');
                    return { ok: (await recovery_ops.moveAway(signature_rules.move_away_blocks)) === true };
                },
                // 3: to the surface, or home
                async surface_or_home() {
                    stoppedStep('watchdog_surface_or_home');
                    return { ok: (await recovery_ops.surfaceOrHome(zones.home(agent))) === true };
                },
                // 4: the step is parked, its goal ends as failed ("stuck"), the next one starts
                async park_step() {
                    if (!executor.park('stuck')) return { ok: false, skipped: true, detail: 'no step in hand' };
                    await recovery_ops.interrupt();
                    return { ok: true };
                },
                // 5: the process ends and is started again; the checkpoint carries the goal and this incident.
                // (decided: the supervisor does not count this restart toward its crash cap; the ladder's hourly cap bounds it)
                async restart_process() {
                    await executor.saveNow();
                    await recovery_ops.restartProcess('the watchdog found no progress after four recovery steps');
                    return { ok: true };
                },
            },
            ...watchdog_options,
        });
    }

    return {
        agent, goals, executor, planner, routine, ledger, scaffold: tracker, state, reporter,
        recorder: () => recorder,
        watchdog: () => watchdog,
        watchStatus,
        // Loads the checkpoint (the executor resumes the step it was on), then tells the broker
        // the agent is there and learns whether the model is. Resolves to the executor's start result.
        async start() {
            const begun = await executor.start();
            if (begun.checkpoint) routine?.restore(begun.checkpoint.routine);
            const saved = begun.checkpoint?.recovery ?? null;
            if (saved?.watchdog) watchdog?.restore(saved.watchdog);
            if (saved?.death && typeof saved.death.incident_id === 'string') {
                // the process ended while the agent was re-equipping after a death: that goes on first
                died_on = { plan_id: saved.death.plan_id ?? null, count: Number(saved.death.count) || 1 };
                startDeathDetour({ incident_id: saved.death.incident_id, source: { type: 'agent', name: agent }, kind: INCIDENT_KINDS.DEATH },
                    saved.death.point ?? null, died_on.plan_id, died_on.count);
            }
            // the shared ledger as the MindServer has it (not connected: the copy starts empty and learns by looking)
            try { await ledger.sync?.(); } catch { /* the copy works on what it knows */ }
            // the town as the MindServer has it (not connected: the world file's zones as they are)
            try { await town?.sync(); } catch { /* without the town the agent works from the world file alone */ }
            const got = await goals.get(agent);
            if (got.ok) {
                long_term = got.goals.long_term; queued = got.goals.short_term.length; short_term = got.goals.short_term;
                // decided: long-term goals are emitted as events. A change is a goal.changed; this is the list as the
                // agent starts with it, so that a reader knows the goals of an agent that has changed none yet
                say('agent.state', { state: 'goals', detail: { long_term: got.goals.long_term, short_term: got.goals.short_term } }, { corr: null });
            }
            // every agent has a long-term goal from its first minute: the operator's, the model's earlier choice, or its role's defaults
            if (long_term_goals) { town_seen = town.version(); await long_term_goals.review('start'); }
            routine?.awayStarted(); // until the broker says the model is there, it is away
            try {
                send('genesis-hello', agent, (answer) => { if (answer?.gate) planner.onGate({ state: answer.gate, reason: answer.reason ?? null }); });
            } catch { /* not connected: the gate stays AWAY and the agent works from its queue and routine */ }
            return begun;
        },
        run() {
            watchdog?.start();
            if (builds && town_timer === null) {
                const work = async () => {
                    await builds.tick().catch(() => {});
                    // the long-term goals follow the town (a verified build moves the next rung; the operator's override arrives)
                    if (long_term_goals && (town.version() !== town_seen || planner.modelAvailable())) { town_seen = town.version(); await long_term_goals.review('the town changed'); }
                };
                const again = () => { town_timer = clock.setTimeout(() => { work().catch(() => {}).then(() => { if (town_timer !== null) again(); }); }, builds.rules.tick_ms); town_timer?.unref?.(); };
                again();
            }
            return executor.run();
        },
        stop() {
            watchdog?.stop();
            if (town_timer !== null) { clock.clearTimeout(town_timer); town_timer = null; }
            executor.stop();
        },
        builds: () => builds,
        longTerm: () => long_term_goals,
        // ---- what arrives over the socket ----
        onPlanContext: (request, ack) => planner.onContextRequest(request, ack),
        onPlanQueued: (message) => planner.onQueued(message),
        async onPlanResult(result) {
            const outcome = await planner.onResult(result);
            executor.wake(); // goals to start, or nothing came and the routine goes on
            return outcome;
        },
        // ---- agent messages (genesis/relay) ----
        messages: () => desk,
        onMessage: (message) => (desk ? desk.onMessage(message) : Promise.resolve(null)),
        onMessageState: (update) => (desk ? desk.onState(update) : Promise.resolve(null)),
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
        // The agent is dying (it has not respawned yet): nothing runs until died() has decided.
        deathBegan() { recorder?.died(); executor.pause('died'); },
        // The agent died at `point` (it has already respawned). Decided: respawn, walk home,
        // re-equip from the kits chest, resume from the checkpoint, with no model call.
        //   - a goal the planner or the operator chose is KEPT: a detour walks home and re-equips,
        //     then that goal goes on at the step it was at. No planning trigger.
        //   - a goal the routine chose is given up: the routine starts again at its Kit check
        //   - the second death (in one model-away period, or on one goal) gives the goal up
        // Decided: a death with no goal of the planner or the operator to resume (the agent was on its
        // routine, or idle) sends NO planning request. The agent respawns, re-equips and returns to its
        // routine. Only when a goal the planner or the operator chose is given up over a death (the
        // second death on it, or the agent is parked) is the planner told, as for any goal of its own that ended.
        // Returns the routine's verdict: 'restart' or 'parked'.
        async died(point) {
            stats.deaths++;
            recorder?.died();
            const verdict = routine ? routine.died(point) : 'restart';
            const kept = executor.mainPlan();
            const count = kept && died_on?.plan_id === kept.id ? died_on.count + 1 : 1;
            died_on = kept ? { plan_id: kept.id, count } : null;
            const resume = verdict !== 'parked' && kept !== null && kept.source !== 'routine' && count < death_rules.max_deaths_per_goal;
            const deaths = routine?.deaths() ?? stats.deaths;
            if (resume) {
                const incident = { incident_id: reporter.newId(), source: { type: 'agent', name: agent }, kind: INCIDENT_KINDS.DEATH };
                reporter.step(incident, { step: 'respawn', attempt: count, max: death_rules.max_deaths_per_goal, result: 'ok' },
                    { goal_id: kept.goal.id, option_id: kept.goal.option_id, plan_step: kept.cursor });
                executor.cutDetour('died'); // died again while re-equipping: the re-equip starts anew
                startDeathDetour(incident, point ? { x: point.x, y: point.y, z: point.z } : null, kept.id, count);
                say('agent.state', { state: 'respawned', detail: { deaths, resuming: kept.goal.id, step: kept.cursor } }, { corr: null, severity: 'warn' });
            } else {
                await executor.abandon('died');
                died_on = null;
                // only a goal the planner or the operator chose, given up here, is the planner's to hear of
                if (kept !== null && kept.source !== 'routine') planner.trigger('reflex_interrupt', { cause: 'death', gave_up: kept.goal.option_id });
                else stats.deaths_without_request++;
                if (verdict !== 'parked') {
                    // the routine's own rule takes over (walk home, Kit check); told as one recovery step
                    reporter.step({ incident_id: reporter.newId(), source: { type: 'agent', name: agent }, kind: INCIDENT_KINDS.DEATH },
                        { step: 'respawn', attempt: Math.max(1, count), max: death_rules.max_deaths_per_goal, result: 'ok' },
                        { outcome: 'auto_recovered', gave_up: kept ? kept.goal.option_id : null });
                }
                say('agent.state', { state: verdict === 'parked' ? 'parked' : 'respawned', detail: { deaths } }, { corr: null, severity: 'warn' });
            }
            executor.unpause();
            executor.wake();
            return verdict;
        },
        // Upstream's own stuck detection fired (src/agent/modes.js): the watchdog's ladder takes it.
        stuck(reason = 'upstream_unstuck') { watchdog?.nudge(reason); return watchdog !== null; },
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
        // Is the agent on its routine right now? (a routine goal in hand, or nothing in hand while the model is away)
        onRoutine: () => { const plan = executor.plan(); return plan ? plan.source === 'routine' : !planner.modelAvailable(); },
        lastThought: () => planner.lastThought(),
        stats: () => ({
            ...stats, ignored_by: Object.fromEntries(ignored_by), held: executor.isHeld(),
            executor: executor.stats(), planner: planner.stats(), routine: routine?.stats() ?? null,
            messages: desk?.stats() ?? null,
        }),
    };
}
