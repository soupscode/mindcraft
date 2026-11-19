// Genesis: the agent's side of planning. It turns triggers into planning requests, answers
// the broker's question "what are your options right now", and puts the planner's reply
// into the short-term queue.
//
// The planner broker runs in the MindServer process (genesis/planning/host.js). The two
// talk over the socket the agent process already has; `send` and the on...() methods below
// are the two directions of that socket, so the tests can join them directly.
//
//   agent -> broker   genesis-plan-request  { agent, trigger: { kind, detail }, local_id }
//   broker -> agent   genesis-plan-queued   { local_id, request_id, queued_at }          onQueued
//   broker -> agent   genesis-plan-context  (request, ack)                               onContextRequest
//                     the agent answers with { context, options } built at that moment
//   broker -> agent   genesis-plan-result   { ok, request_id, call_id, reply | reason }  onResult
//   broker -> agent   genesis-gate          { state, reason }                            onGate
//
// Triggers: goal_complete, step_failed, reflex_interrupt, agent_request, operator_message,
// model_returned (the routine yields and the agent goes back to planning), and
// request_declined / request_expired (what the agent asked of another agent came to nothing).
// One request is pending per agent; a newer trigger replaces it (the broker keeps the place
// in the line). Nothing here waits for the model: when no reply comes, the agent works on.
//
// Re-planning (decided): every goal that completes is a trigger, also while goals still wait
// in the queue. The reply REPLACES the goals that are still waiting: each of them is taken
// out with its own change record (a reason, source "planner", the call id), then the reply's
// goals go in. The goal the agent has in hand is finished first: it is not one of the goals
// "still queued" (a routine goal in hand is not kept: the routine gives way to the planner).
// A request the budget refuses, a reply that is discarded, or a model that is away changes
// nothing: the agent keeps the queue it has.
// One kind of waiting goal is not the plan's to replace: what the agent has agreed with another
// agent (a hand-over it accepted or offered, the fetch of items left for it: genesis/relay/desk.js).
// `keeps(goal)` says so; such a goal stays in the queue, ahead of the reply's goals.
//
// While the operator holds the agent (!stop) no request is sent at all: `held()` says so.
//
// Injected: send(event, payload), clock, catalog, state() (the world now), goals (the goal
// store), buildContext(input) (genesis/planning/context.js), describe() -> { role, long_term,
// last_outcome, routine, home_distance, memory }, onGoals(queued goals, origin), onGate(state, before),
// inHand() -> the id of the goal being carried out that a reply must not replace, or null,
// keeps(goal) -> true for a waiting goal a reply must not replace (a commitment to another agent),
// held() -> true while the operator holds the agent,
// rank(options, state) -> Promise<[{ id, label, estimate, score, need }] | null>: the learner's order and annotations
// for what the catalog offered (genesis/learning; left out: the catalog's order, no annotation),
// onDecision({ call_id, offered, chosen, default_choice }): told what a valid reply chose among what was offered.
// Depends only on other Genesis files.

import { buildPlanContext } from './context.js';
import { GOAL_LIMITS } from '../store/goal_store.js';

export const PLANNER_CLIENT_DEFAULTS = Object.freeze({
    grace_ms: 20 * 1000,          // how long an idle agent waits for a reply before it turns to its routine
    backoff_ms: 3 * 60 * 1000,    // after a call that failed or was discarded: no new request for this long
    failed_memory_ms: 10 * 60 * 1000, // proposed: an option that failed is not offered again for this long, unless what it depends on changes
});

const GATE_AVAILABLE = 'AVAILABLE';
// triggers that always replace the pending request (they carry something the planner must see)
const URGENT = new Set(['operator_message', 'agent_request', 'step_failed', 'reflex_interrupt',
    'request_declined', 'request_expired']); // the agent's own request to another agent came to nothing (genesis/relay/desk.js)

export function createAgentPlanner({
    agent, send, clock, catalog, state, goals, describe = () => ({}), onGoals = () => {}, onGate = () => {},
    buildContext = buildPlanContext, inHand = () => null, held = () => false, keeps = () => false, rank = null, onDecision = () => {}, ...options
} = {}) {
    const config = { ...PLANNER_CLIENT_DEFAULTS };
    for (const key of Object.keys(PLANNER_CLIENT_DEFAULTS)) {
        if (options[key] !== undefined) config[key] = options[key];
    }
    const stats = { triggers: 0, requests: 0, kept: 0, held_back: 0, replies: 0, goals_queued: 0, goals_dropped: 0, stale: 0, withheld: 0, refused: 0, discarded: 0, replaced: 0, send_failed: 0, on_hold: 0 };

    let gate = 'AWAY';          // until the broker says otherwise
    let pending = null;         // { local_id, request_id, kind: 'plan', trigger, queued_at (ms), since (ms) }
    let quiet_until = 0;        // no new request before this time (budget used up, or a call just failed)
    let last_trigger = null;
    let last_thought = null;    // { text, at } the model's own sentence, from its last valid reply
    let last_failure = null;    // { reason, at } of the last request that brought no goals
    let counter = 0;
    let last_offer = null;      // what the model was shown for the request in hand: { request_id, offered, default_choice } (for the decision row)
    // What just could not be done: option id -> { reason, kind, title, at, stamp }.
    //   kind 'failed'       it was tried and failed. Not offered again until what the reason depends on changes
    //                       (stamp), or failed_memory_ms have passed.
    //   kind 'not_started'  its preconditions were gone when its turn came (seen on the live run: the model chose
    //                       to store planks that the routine had stored while the model was thinking, four times
    //                       in a row). The world changed under the planner once already: not offered again for
    //                       failed_memory_ms, whatever changes.
    const failed = new Map();
    // What a reason depends on, as text: for a reason about items, how many the agent holds of the item the
    // option names (or everything it carries); for every other reason (no way there, out of range, a chest
    // that is not reached), roughly where the agent stands.
    const ITEM_REASONS = /held|missing|ingredient|material|fuel|seed|ledger|contested|full|claim/;
    const stampOf = (option_id, reason, now_state) => {
        try {
            if (!ITEM_REASONS.test(String(reason))) {
                const at = now_state.view.position();
                return `at:${Math.round(at.x / 16)},${Math.round(at.z / 16)}`;
            }
            const inventory = now_state.view.inventory();
            const item = catalog.resolve?.(option_id)?.args?.item ?? null;
            if (item) return `held:${item}:${inventory[item] ?? 0}`;
            return JSON.stringify(Object.entries(inventory).filter(([, count]) => count > 0).sort());
        } catch { return ''; }
    };
    // a goal a reply leaves where it is: the goal in hand, and what the agent agreed with another agent
    const stays = (goal) => { try { return goal.id === inHand() || keeps(goal) === true; } catch { return goal.id === inHand(); } };

    function submit(trigger) {
        const now = clock.now();
        const local_id = `${agent}-${now}-${++counter}`;
        pending = { local_id, request_id: null, kind: 'plan', trigger, queued_at: now, since: now };
        stats.requests++;
        try {
            send('genesis-plan-request', { agent, trigger, local_id });
        } catch {
            stats.send_failed++;
            pending = null; // not connected: the next trigger tries again
        }
    }

    // A goal failed, or could not be started any more: it is not offered again while nothing it depends on has changed.
    function noteFailure(option_id, reason, title = null, kind = 'failed') {
        if (typeof option_id !== 'string' || option_id.length === 0) return;
        let stamp = '';
        try { stamp = stampOf(option_id, reason, state()); } catch { /* remembered without the stamp */ }
        failed.delete(option_id);
        failed.set(option_id, { reason: String(reason ?? 'failed'), kind: kind === 'not_started' ? 'not_started' : 'failed', title: title ?? option_id, at: clock.now(), stamp });
        if (failed.size > 12) failed.delete(failed.keys().next().value);
    }

    return {
        // Something changed. Returns true when a request went to the broker.
        trigger(kind, detail = {}) {
            const now = clock.now();
            const trigger = { kind, detail };
            stats.triggers++;
            last_trigger = { ...trigger, at: now };
            if (held()) {
                // the operator holds the agent: no planning request leaves it until it is resumed
                stats.on_hold++;
                return false;
            }
            if (pending && !URGENT.has(kind)) {
                // a request already waits and will be answered from the world as it is then
                stats.kept++;
                return false;
            }
            if (now < quiet_until && !URGENT.has(kind)) {
                stats.held_back++;
                return false;
            }
            submit(trigger);
            return pending !== null;
        },
        onQueued(message) {
            if (pending && message?.local_id === pending.local_id) {
                pending.request_id = message.request_id ?? null;
                if (Number.isFinite(Date.parse(message.queued_at))) pending.queued_at = Date.parse(message.queued_at);
            }
        },
        // The broker dispatches this agent's request now: what can the agent do right now?
        // ack({ context, options }) or ack({ error }).
        onContextRequest(request, ack) {
            try {
                const now_state = state();
                // what could not be done a moment ago, for a reason that has not changed, is not offered again (the same
                // goal was chosen four times in a row on the live run): its place goes to the next candidate
                for (const [id, entry] of failed) {
                    const changed = entry.kind === 'failed' && entry.stamp !== stampOf(id, entry.reason, now_state);
                    if (changed || clock.now() - entry.at > config.failed_memory_ms) failed.delete(id);
                }
                let options = catalog.offer(now_state, { exclude: new Set(failed.keys()) });
                if (options.length === 0 && failed.size > 0) options = catalog.offer(now_state); // rather the same again than nothing
                else stats.withheld += failed.size;
                if (options.length === 0) { ack({ error: 'no_options: nothing can be started right now' }); return; }
                // The learner orders and annotates what the catalog offered (genesis/learning). THE SAME options: one it
                // leaves out stays in the list behind the others, one it names that was not offered is ignored.
                const finish = (ranked) => {
                    try {
                        const by_id = new Map(options.map((option) => [option.id, option]));
                        const shown = [];
                        for (const entry of Array.isArray(ranked) ? ranked : []) {
                            const option = by_id.get(entry?.id);
                            if (!option || shown.some((it) => it.id === option.id)) continue;
                            shown.push({ ...option, ...(typeof entry.label === 'string' && entry.label.length > 0 ? { label: entry.label } : {}), estimate: entry.estimate ?? null, score: entry.score ?? null, need: entry.need ?? null });
                        }
                        for (const option of options) if (!shown.some((it) => it.id === option.id)) shown.push(option);
                        const about = describe() ?? {};
                        const built = buildContext({
                            agent, role: about.role ?? null, trigger: request?.trigger ?? pending?.trigger ?? last_trigger,
                            view: now_state.view, home_distance: about.home_distance ?? null, long_term: about.long_term ?? [],
                            last_outcome: about.last_outcome ?? null, routine: about.routine ?? null, memory: about.memory ?? '', options: shown,
                            recent_failures: [...failed.values()].slice(-2).map((entry) => ({ title: entry.title, reason: entry.reason, kind: entry.kind })),
                        });
                        last_offer = {
                            request_id: request?.id ?? null, default_choice: options[0].id, annotated: Array.isArray(ranked),
                            offered: shown.map((option) => ({ id: option.id, p_ok: option.estimate?.p_ok ?? null, p_danger: option.estimate?.p_danger ?? null, secs: option.estimate?.secs ?? null, n: option.estimate?.n ?? 0, need: option.need ?? null, score: option.score ?? null })),
                        };
                        ack({ context: built.context, options: built.options, tokens: built.tokens });
                    } catch (err) {
                        ack({ error: `context could not be built: ${err?.message ?? err}` });
                    }
                };
                if (typeof rank !== 'function') { finish(null); return; }
                let asked;
                try { asked = Promise.resolve(rank(options, now_state)); } catch { asked = Promise.resolve(null); }
                asked.then(finish, () => finish(null));
            } catch (err) {
                ack({ error: `context could not be built: ${err?.message ?? err}` });
            }
        },
        // The outcome of a request. Resolves to what was done with it.
        async onResult(result) {
            const mine = pending !== null && ((result?.local_id ?? null) !== null
                ? result.local_id === pending.local_id
                : result?.request_id === pending.request_id);
            if (result?.ok !== true) {
                if (result?.reason === 'replaced') { stats.replaced++; return { kind: 'replaced' }; } // a newer request of this agent stands
                if (mine) pending = null;
                const now = clock.now();
                last_failure = { reason: result?.reason ?? 'unknown', at: now };
                if (result?.reason === 'budget_exhausted') {
                    stats.refused++;
                    const retry_at = Date.parse(result.retry_at);
                    quiet_until = Number.isFinite(retry_at) ? retry_at : now + config.backoff_ms;
                } else {
                    stats.discarded++;
                    quiet_until = now + config.backoff_ms;
                }
                return { kind: 'no_goals', reason: last_failure.reason };
            }
            const asked_because = mine ? pending.trigger?.kind ?? null : null;
            if (mine) pending = null;
            stats.replies++;
            last_failure = null;
            last_thought = { text: String(result.reply?.thought ?? ''), at: clock.now() };
            const wanted_all = (result.reply?.goals ?? []).slice(0, GOAL_LIMITS.short_term_max)
                .map((goal) => ({ title: String(goal.title).slice(0, GOAL_LIMITS.title), option_id: goal.option_id }));
            // The reply was made for the world as it was when the call went out, and the agent worked on meanwhile
            // (its routine does not stand still): a goal that can no longer be started is left out here, quietly.
            // It is not a failure and gets no turn (decided after the live run).
            const stale = [];
            let now_state = null;
            try { now_state = state(); } catch { /* without the world nothing is left out: the executor checks at the start */ }
            const wanted = now_state === null ? wanted_all : wanted_all.filter((goal) => {
                let checked = null;
                try { checked = catalog.check?.(goal.option_id, now_state) ?? null; } catch { checked = null; }
                if (!checked || checked.ok !== false) return true;
                stale.push({ ...goal, reason: checked.reason });
                return false;
            });
            for (const goal of stale) noteFailure(goal.option_id, goal.reason, goal.title, 'not_started');
            stats.stale += stale.length;
            const thought = last_thought.text.trim() || 'the planner chose';
            const said = last_thought.text.trim() || null; // the model's own sentence: a field of its own on the change (decided)
            const why = asked_because ?? last_trigger?.kind ?? 'a new plan';

            // 1. the goals still waiting are replaced: each one goes with its own record
            const before = await goals.get(agent);
            if (!before.ok) return { kind: 'not_stored', code: before.code, error: before.error };
            const dropped = [];
            for (const goal of before.goals.short_term) {
                if (stays(goal)) continue; // the goal in hand is finished first; a commitment to another agent is not the plan's to drop
                // (asked again inside the change: the executor may have taken this goal in hand a moment ago)
                const gone = await goals.setShortTerm(agent, (queue) => queue.filter((queued) => queued.id !== goal.id || stays(queued)), {
                    reason: `replaced by a new plan (asked because: ${why}): ${thought}`, source: 'planner', call_id: result.call_id, thought: said,
                });
                if (gone.ok) dropped.push(goal);
                else if (gone.code !== 'no_change') return { kind: 'not_stored', code: gone.code, error: gone.error, dropped };
            }
            stats.goals_dropped += dropped.length;

            // 2. the planner's 1 to 3 goals follow the goal in hand and the commitments (which the queue's size still counts)
            const change = await goals.setShortTerm(agent, (queue) => {
                const kept = queue.filter((goal) => stays(goal));
                // a goal the reply names again while it is being carried out is not queued a second time
                const fresh = wanted.filter((goal) => !kept.some((mine) => mine.option_id === goal.option_id)).slice(0, GOAL_LIMITS.short_term_max - kept.length);
                return [...kept, ...fresh];
            }, { reason: thought, source: 'planner', call_id: result.call_id, thought: said });
            if (!change.ok && change.code !== 'no_change') return { kind: 'not_stored', code: change.code, error: change.error, dropped };
            const queued = change.ok ? change.goals.short_term : (await goals.get(agent)).goals?.short_term ?? [];
            // only the goals this reply put in are the planner's with this call id; the goal in hand keeps its own origin
            const added = change.ok ? queued.filter((goal) => !change.change.before.some((old) => old.id === goal.id)) : [];
            stats.goals_queued += added.length;
            // the choice, with everything that was on offer and what the learner said about it (the decision row)
            if (last_offer && (last_offer.request_id === null || last_offer.request_id === result.request_id)) {
                const offer = last_offer;
                last_offer = null;
                try { onDecision({ call_id: result.call_id ?? null, offered: offer.offered, default_choice: offer.default_choice, annotated: offer.annotated, chosen: wanted_all.map((goal) => goal.option_id), added: added.map((goal) => goal.option_id) }); } catch { /* the listener's problem */ }
            }
            onGoals(added, { source: 'planner', call_id: result.call_id }, { dropped, kept: queued.length - added.length, stale });
            return { kind: 'goals', goals: queued, added, dropped, stale, call_id: result.call_id };
        },
        // The model gate changed. Returns { opened, closed }.
        onGate(message) {
            const before = gate;
            const next = String(message?.state ?? 'AWAY');
            gate = next;
            const opened = before !== GATE_AVAILABLE && next === GATE_AVAILABLE;
            const closed = before === GATE_AVAILABLE && next !== GATE_AVAILABLE;
            if (opened) {
                quiet_until = 0; // a new period: the hour budget is the broker's to keep
                if (pending) pending.since = clock.now(); // the request starts to be worked on only now
            }
            try { onGate({ state: next, before, opened, closed, reason: message?.reason ?? null }); } catch { /* the listener's problem */ }
            return { opened, closed };
        },
        noteFailure,
        recentFailures: () => [...failed.keys()],
        gate: () => gate,
        modelAvailable: () => gate === GATE_AVAILABLE,
        // True while an idle agent should wait a moment for its reply instead of starting routine
        // work. The moment runs from when the request could first be worked on, or from when
        // the agent ran out of work (idle_since), whichever is later.
        // The agent waits once per request: after that it works on until the reply is there.
        waitingForReply(now = clock.now(), idle_since = null) {
            if (gate !== GATE_AVAILABLE || pending === null || pending.waited) return false;
            if (now - Math.max(pending.since, idle_since ?? pending.since) < config.grace_ms) return true;
            pending.waited = true;
            return false;
        },
        // The checkpoint's pending_request.
        pending() {
            if (!pending) return null;
            return { id: pending.request_id ?? pending.local_id, kind: pending.kind, queued_at: new Date(pending.queued_at).toISOString() };
        },
        hasPending: () => pending !== null,
        lastThought: () => (last_thought ? { ...last_thought } : null),
        lastFailure: () => (last_failure ? { ...last_failure } : null),
        stats: () => ({ ...stats, gate, pending: pending !== null }),
    };
}
