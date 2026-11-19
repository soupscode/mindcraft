// Genesis: an agent's side of the message relay. It sends this agent's structured messages
// to the relay in the MindServer (genesis/relay/relay.js) and decides what to do with the
// ones that arrive. Nothing here is free text between agents: a message is a type and a
// small body, and the chat line is written by the relay.
//
// What goes out:
//   - a contested claim (genesis/catalog: the agent wanted items another agent has reserved
//     in a chest) becomes a `request` to the holder with the item, the count and the agent's
//     goal as the reason. The holder accepts (the reservation moves, in the MindServer) or
//     declines; when the request expires, the reservation stays where it was.
//   - a goal the planner chose (decided): ask_agent sends a `request` for items to a named
//     agent, offer_agent an `offer` of items the agent holds. The catalog offers them only
//     while this desk says there is room for one (talk(): an open conversation slot, message
//     budget left, not a repeat the relay would block), and the executor carries the goal out
//     as ONE step that sends the message here (sendStep). The relay's limits apply as to every
//     message; a message it rejects fails the goal with the relay's reason.
//   - request(), offer(), inform(), warn() for whatever else code wants to say
//
// What comes in:
//   request, offer   (decided) the MODEL decides accept or decline when it is available and the
//             agent has budget: one small structured call of its own kind through the broker
//             (asked of the MindServer, genesis/relay/server.js: 'genesis-msg-decide'), answered
//             with accept or decline and a short reason. That decision is recorded with source
//             "planner". When the model is away, the agent's decision limit is spent, the call
//             fails or the reply does not validate, the CODE RULE decides and is recorded with
//             source "routine" (answered_by "code_rule"). Decided: the same when the model stays busy until
//             the last 15 seconds of the message's life: the code rule answers in what is left.
//               request for items the agent carries   accept when they are SPARE: held beyond its kit, beyond
//                                                     what its goal in hand still needs, and beyond what it
//                                                     has promised; otherwise decline (why: needed_for_goal)
//               offer                                 accept (there is room to carry the items)
//               contested claim on a reservation      accept (the agent is not on its way to them)
//             What cannot or must not be done is declined by code whoever would have decided,
//             and never reaches the model: items the agent cannot spare (it keeps its tools, and
//             its food up to its reserve), an offer there is no room for, a claim on stock the
//             agent is on its way to, a request to an agent the operator holds.
//   accept    of this agent's own offer: the agent now owes the items
//   decline, or a request that expired: the asker plans again
//   inform    that items wait in a chest for this agent: a goal to fetch them is queued
//
// Accepting creates a COMMITMENT: a duty the executor carries out through the action catalog
// (give_items: handed over directly when the two agents are near each other, through the
// shared chest otherwise).
//
// Injected: agent, send(event, ...args) (the socket), clock, catalog, state() (the world now),
// goals (the goal store), executor, planner, emit(type, data, opts), limits (the relay's
// limits, to know beforehand what it would reject).
// Depends only on other Genesis files.

import { KIT_FOOD } from '../routines/routines.js';
import { clipText } from '../shared/events.js';
import { GOAL_LIMITS } from '../store/goal_store.js';
import { RELAY_LIMITS } from './relay.js';
import { DECISIONS, DECISION_REASON_MAX, modelWaitMs } from './decisions.js';

export const DESK_RULES = Object.freeze({
    food_reserve: KIT_FOOD.take,   // proposed: of its food an agent keeps this many (what a kit holds)
    send_timeout_ms: 5000,
    decide_timeout_ms: 120 * 1000, // decided: the desk waits for the model's decision until the last 15 seconds of the message's
                                   // life (genesis/relay/decisions.js, modelWaitMs): then the code rule answers. This is the longest it waits
});

// The messages a goal of the planner may send (ask_agent, offer_agent), and nothing else.
export const STEP_MESSAGE_TYPES = Object.freeze(['request', 'offer']);

export function createMessageDesk({
    agent, send, clock = { now: Date.now, setTimeout, clearTimeout }, catalog, state, goals, executor, planner,
    emit = () => null, rules: overrides = {}, limits: limit_overrides = {},
} = {}) {
    const rules = { ...DESK_RULES, ...overrides };
    const limits = { ...RELAY_LIMITS, ...limit_overrides };
    const stats = {
        sent: 0, rejected: 0, received: 0, accepted: 0, declined: 0, duties_done: 0, duties_failed: 0, claims_sent: 0, replans: 0,
        decided_by_model: 0, decided_by_rule: 0, rule_because: {}, steps_sent: 0, steps_rejected: 0,
    };
    const duties = [];         // { to, item, count, msg_id, conv, via, goal_id }: what this agent has agreed to hand over
    const pickups = new Set(); // ids of the goals that fetch what another agent left in a chest for this one
    const mine = new Map();    // msg_id -> this agent's own requests and offers that wait for an answer
    const inbox = new Map();   // msg_id -> requests and offers of other agents that wait for this agent's answer
    let sent_at = [];          // when this agent's relayed messages went out, within the relay's rate window
    const repeats = new Map(); // "to|type|item|count" -> when it was relayed, within the relay's repeat block time
    const say = (state_name, detail) => { try { emit('agent.state', { state: state_name, detail }, { corr: null }); } catch { /* an event must never disturb the desk */ } };
    const sameKey = (to, type, body) => `${to}|${type}|${body?.item ?? ''}|${body?.count ?? ''}|${body?.claim === true ? 'claim' : ''}`;
    const recentSent = (now) => { sent_at = sent_at.filter((at) => at > now - limits.rate_window_ms); return sent_at.length; };
    const recentRepeats = (key, now) => {
        const list = (repeats.get(key) ?? []).filter((at) => at > now - limits.repeat_block_ms);
        if (list.length > 0) repeats.set(key, list); else repeats.delete(key);
        return list.length;
    };

    // Sends one message. Resolves (never rejects) to the relay's answer: { ok, message } or { ok: false, reason }.
    // origin: who chose to send it, when a goal did: { by: 'planner' | 'operator' | 'routine', call_id }; kept with a request or offer that waits
    function post(to, type, body, conv = null, origin = null) {
        return new Promise((resolve) => {
            let settled = false;
            const finish = (answer) => {
                if (settled) return;
                settled = true;
                clock.clearTimeout(timer);
                if (answer?.ok) {
                    stats.sent++;
                    // what the relay counted: kept here too, so the catalog knows beforehand what it would reject
                    const now = clock.now();
                    sent_at.push(now);
                    const key = sameKey(to, type, body);
                    repeats.set(key, [...(repeats.get(key) ?? []), now]);
                    if (answer.message.state === 'pending') mine.set(answer.message.msg_id, { ...answer.message, ...(origin ? { sent_for: origin } : {}) });
                } else stats.rejected++;
                resolve(answer ?? { ok: false, reason: 'no_answer' });
            };
            const timer = clock.setTimeout(() => finish({ ok: false, reason: 'relay_timeout' }), rules.send_timeout_ms);
            try {
                send('genesis-msg-send', { from: agent, to, type, body, ...(conv ? { conv } : {}) }, finish);
            } catch {
                finish({ ok: false, reason: 'not_connected' });
            }
        });
    }

    // What the agent can part with: nothing of what it keeps for itself (tools, armour, torches),
    // and of its food only what is beyond its reserve.
    function spare(item) {
        const held = state().view.inventory()[item] ?? 0;
        if (item === KIT_FOOD.item) return Math.max(0, held - rules.food_reserve);
        return catalog.keeps(item) ? 0 : held;
    }

    // What the agent can part with beyond what it needs itself (decided, the code rule's test): what it holds, less
    // its kit (spare), less what the goal in hand still uses of it (a craft's ingredients, a build's materials), less
    // what it has already promised to others.
    function spareBeyondGoal(item) {
        const in_hand = executor.mainPlan()?.goal.option_id ?? null;
        const for_goal = in_hand && !in_hand.startsWith('give_items:') ? catalog.needOf?.(in_hand, item, state()) ?? 0 : 0;
        const promised = duties.reduce((n, duty) => n + (duty.item === item ? duty.count : 0), 0);
        return Math.max(0, spare(item) - for_goal - promised);
    }

    const giveId = (to, item, count) => `give_items:${to}:${item}:${count}`;
    const hasBody = (body) => typeof body?.item === 'string' && Number.isInteger(body.count) && body.count >= 1 && body.count <= 64;

    // A hand-over this agent owes: the goal is queued (source: who decided), and the executor carries it out.
    // decided_by: 'planner' (the model accepted, or the planner chose to offer) | 'routine' (the code rule).
    // verdict: the model's decision, when it made one (its reason and call id go into the goal's record).
    async function commit(to, body, message, decided_by, queue_goal, verdict = null) {
        const duty = { to, item: body.item, count: body.count, msg_id: message.msg_id, conv: message.conv, via: null, goal_id: null, decided_by };
        duties.push(duty);
        if (queue_goal) {
            const source = decided_by === 'planner' ? 'planner' : 'routine';
            const call_id = verdict?.call_id ?? null;
            const offered = message.type === 'offer';
            const why = verdict?.decision
                ? `accepted by the model: ${clipText(verdict.reason, DECISION_REASON_MAX)}`
                : (decided_by === 'routine' ? 'accepted by the code rule, the items are held beyond the reserve' : 'accepted');
            const pushed = await goals.pushShortTerm(agent, { title: `Give ${body.count} ${body.item} to ${to}`.slice(0, 60), option_id: giveId(to, body.item, body.count) }, {
                reason: offered ? `${to} accepted the offer of ${body.count} ${body.item} (${message.msg_id})` : `${to} asked for ${body.count} ${body.item} (${message.msg_id}): ${why}`,
                source, call_id,
            });
            if (!pushed.ok) {
                duties.splice(duties.indexOf(duty), 1);
                return null;
            }
            duty.goal_id = pushed.goals.short_term.at(-1).id;
            executor.noteGoals([pushed.goals.short_term.at(-1)], { source, call_id });
            executor.wake();
        }
        return duty;
    }

    // Tells the other agent yes or no, and records who decided: decided_by "planner" (the model's
    // decision call) or "routine" (the code rule). `verdict` is the model's decision when it made one,
    // or why the code rule decided; the model's reason is recorded here and never travels to the other agent.
    async function answer(message, accepted, decided_by, more = {}, verdict = null) {
        const body = { ...(hasBody(message.body) ? { item: message.body.item, count: message.body.count } : {}), decided_by, ...more };
        stats[accepted ? 'accepted' : 'declined']++;
        say(accepted ? 'request_accepted' : 'request_declined', {
            from: message.from, msg_id: message.msg_id, type: message.type, source: decided_by,
            answered_by: decided_by === 'planner' ? 'model' : 'code_rule', ...body,
            ...(verdict?.reason ? { reason: clipText(verdict.reason, DECISION_REASON_MAX) } : {}),
            ...(verdict?.call_id ? { call_id: verdict.call_id } : {}),
            ...(verdict?.rule_because ? { rule_because: verdict.rule_because } : {}),
        });
        return post(message.from, accepted ? 'accept' : 'decline', body, message.conv);
    }

    // Is the agent on its way to the very chest stock somebody asks it to give up?
    function usingReservation(chest, item) {
        const plan = executor.mainPlan();
        const resolved = plan ? catalog.resolve(plan.goal.option_id) : null;
        return resolved?.skill === 'fetch_items' && resolved.args.chest === chest && resolved.args.item === item;
    }

    // What is declined by code, whoever would have decided: it cannot be done, or it must not be.
    // Returns the reason, or null when there is a choice to make.
    function mustDecline(message) {
        const body = message.body ?? {};
        if (message.type === 'offer') {
            if (!hasBody(body)) return 'not_understood';
            return state().view.freeSlots() >= (catalog.config.free_slots_needed ?? 1) ? null : 'no_room';
        }
        if (body.claim === true) return usingReservation(body.chest, body.item) ? 'in_use' : null;
        if (!hasBody(body)) return 'not_understood';
        if (spare(body.item) < body.count) return 'not_spare';
        if (executor.isHeld()) return 'held'; // the operator holds the agent: it promises nothing
        return null;
    }

    // What the agent tells the model about itself for the decision (genesis/relay/decisions.js, cleanFacts).
    function factsFor(message) {
        const body = message.body ?? {};
        const now_state = state();
        const in_hand = executor.mainPlan()?.goal.title ?? null;
        const facts = { free_slots: now_state.view.freeSlots() };
        if (typeof body.item === 'string') facts.held = now_state.view.inventory()[body.item] ?? 0;
        if (message.type === 'request' && body.claim !== true && typeof body.item === 'string') facts.spare = spare(body.item);
        if (body.claim === true) facts.in_use = false; // (a claim on stock that is in use never gets this far)
        if (in_hand) facts.in_hand = in_hand;
        return facts;
    }

    // Asks the model to accept or decline (through the MindServer). Resolves (never rejects) to
    //   { decision: 'accept' | 'decline', reason, call_id }   the model decided
    //   { rule_because, call_id? }                            it did not: the code rule decides, and this is why
    function askModel(message) {
        if (!planner.modelAvailable()) return Promise.resolve({ rule_because: 'model_away' });
        if (executor.isHeld()) return Promise.resolve({ rule_because: 'held' }); // a held agent asks nothing of the model
        return new Promise((resolve) => {
            let settled = false;
            let timer = null;
            const finish = (got) => {
                if (settled) return;
                settled = true;
                clock.clearTimeout(timer);
                const decided = got?.ok === true && DECISIONS.includes(got.decision) && typeof got.reason === 'string'
                    && got.reason.length > 0 && got.reason.length <= DECISION_REASON_MAX;
                resolve(decided ? { decision: got.decision, reason: got.reason, call_id: got.call_id ?? null }
                    : { rule_because: got?.ok === true ? 'invalid_reply' : String(got?.reason ?? 'no_answer'), call_id: got?.call_id ?? null });
            };
            // the model is waited for until the last 15 seconds of the message's life: then the code rule answers
            const expires = Date.parse(message.expires_at);
            const wait = Number.isFinite(expires) ? modelWaitMs(expires - clock.now(), rules.decide_timeout_ms) : rules.decide_timeout_ms;
            timer = clock.setTimeout(() => finish({ ok: false, reason: 'decision_timeout' }), wait);
            try {
                send('genesis-msg-decide', { agent, msg_id: message.msg_id, conv: message.conv, facts: factsFor(message) }, finish);
            } catch {
                finish({ ok: false, reason: 'not_connected' });
            }
        });
    }

    // A request or an offer of another agent (a contested claim included). The model decides when it
    // can; otherwise the code rule does.
    async function decide(message) {
        const body = message.body ?? {};
        const claim = message.type === 'request' && body.claim === true;
        const more = claim ? { claim: true, chest: body.chest } : {};
        const refused = mustDecline(message);
        if (refused) return answer(message, false, 'routine', { ...more, why: refused });

        inbox.set(message.msg_id, message);
        if (message.type === 'request' && !claim) {
            // accepting would queue a hand-over: with a full queue there is nothing to decide (and no call to spend on it)
            const got = await goals.get(agent);
            if (got.ok && got.goals.short_term.length >= GOAL_LIMITS.short_term_max) {
                inbox.delete(message.msg_id);
                return answer(message, false, 'routine', { why: 'busy' });
            }
        }
        const verdict = await askModel(message);
        if (!inbox.delete(message.msg_id)) return null; // it expired while the model was asked: there is nothing to answer any more
        // the world may have moved while the model was asked
        const now_refused = mustDecline(message);
        if (now_refused) return answer(message, false, 'routine', { ...more, why: now_refused });

        const by_model = verdict.decision !== undefined;
        const decided_by = by_model ? 'planner' : 'routine';
        if (by_model) stats.decided_by_model++;
        else { stats.decided_by_rule++; stats.rule_because[verdict.rule_because] = (stats.rule_because[verdict.rule_because] ?? 0) + 1; }
        // the code rule (decided): a request for carried items is accepted when they are SPARE: held beyond the agent's
        // kit and beyond what its goal in hand still needs; otherwise it is declined. An offer is accepted when there
        // is room, a claim when the stock is not in use (both were settled above).
        const needed = !by_model && message.type === 'request' && !claim && spareBeyondGoal(body.item) < body.count;
        const accept = by_model ? verdict.decision === 'accept' : !needed;
        if (!accept) return answer(message, false, decided_by, needed ? { ...more, why: 'needed_for_goal' } : more, verdict);
        if (message.type === 'request' && !claim) {
            // accepting a request for carried items is a commitment: the hand-over is queued for the executor
            const duty = await commit(message.from, body, message, decided_by, true, verdict);
            if (!duty) return answer(message, false, 'routine', { why: 'busy' });
        }
        return answer(message, true, decided_by, more, verdict);
    }

    function replan(kind, message) {
        stats.replans++;
        const body = message.body ?? {};
        return planner.trigger(kind, { to: clipText(message.to, 40), item: body.item ?? null, count: body.count ?? null, msg_id: message.msg_id });
    }

    return {
        // ---- sending ----
        request: (to, body) => post(to, 'request', body),
        offer: (to, body) => post(to, 'offer', body),
        // The ONE step of an ask_agent or offer_agent goal (genesis/catalog/templates.js): [type, to, item, count].
        // Resolves to a step result, { ok, interrupted, timedout, output }; a message the relay rejects is a
        // failed step whose output names the relay's reason ("message_rejected: rate_limit").
        async sendStep([type, to, item, count] = [], { origin = null } = {}) {
            const failed = (reason) => { stats.steps_rejected++; return { ok: false, interrupted: false, timedout: false, output: `message_rejected: ${reason}` }; };
            if (!STEP_MESSAGE_TYPES.includes(type) || typeof to !== 'string' || !hasBody({ item, count })) return failed('invalid_message');
            if (to === agent) return failed('self_message');
            if (type === 'offer' && spare(item) < count) return failed('not_spare'); // never offer what the agent cannot part with
            const sent = await post(to, type, { item, count }, null, origin);
            if (!sent?.ok) return failed(String(sent?.reason ?? 'no_answer'));
            stats.steps_sent++;
            return { ok: true, interrupted: false, timedout: false, output: `Message ${sent.message.msg_id} (${type}) relayed to ${to}: ${count} ${item}.` };
        },
        // What the catalog needs to know before it offers ask_agent or offer_agent (state.talk): is there an
        // open conversation slot and message budget, what can be spared, and would the relay take this very
        // message. The relay stays the judge: this only keeps the planner from choosing what would be rejected.
        talk() {
            const now = clock.now();
            return {
                open: mine.size + inbox.size, max_open: limits.max_open_conversations,
                sent: recentSent(now), max_sent: limits.max_messages_per_minute,
                spare: (item) => spare(item),
                // the same request or offer still waits for its answer
                waiting: (type, to, item) => [...mine.values()].some((message) => message.type === type && message.to === to && message.body?.item === item),
                // the relay would block it as a repeat (an identical message may repeat once, then not for 10 minutes)
                repeated: (type, to, item, count) => recentRepeats(sameKey(to, type, { item, count }), now) >= 1 + limits.repeats_allowed,
            };
        },
        inform: (to, body, conv = null) => post(to, 'inform', body, conv),
        warn: (to, body, conv = null) => post(to, 'warn', body, conv),
        // The agent wanted chest stock another agent has reserved: ask the holder for it.
        async contested(claim, reason = null) {
            stats.claims_sent++;
            return post(claim.holder, 'request', {
                item: claim.item, count: claim.count, chest: claim.chest, claim: true,
                ...(reason ? { reason: clipText(reason, 60) } : {}),
            });
        },
        // ---- what arrives over the socket ----
        // A message for this agent ('genesis-msg'). Resolves to the relay's answer to what the agent replied, or null.
        async onMessage(message) {
            if (message?.to !== agent) return null;
            stats.received++;
            if (message.type === 'request' || message.type === 'offer') return decide(message);
            if (message.type === 'inform' && message.body?.handoff === 'chest' && hasBody(message.body) && typeof message.body.chest === 'string') {
                // the items wait in a chest, reserved for this agent: fetch them
                const body = message.body;
                const pushed = await goals.pushShortTerm(agent, { title: `Fetch ${body.count} ${body.item} from ${message.from}`.slice(0, 60), option_id: `fetch_items:${body.chest}:${body.item}:${body.count}` }, {
                    reason: `${message.from} left ${body.count} ${body.item} in the ${body.chest} chest (${message.msg_id})`, source: 'routine', call_id: null,
                });
                if (pushed.ok) {
                    pickups.add(pushed.goals.short_term.at(-1).id);
                    executor.noteGoals([pushed.goals.short_term.at(-1)], { source: 'routine', call_id: null });
                    executor.wake();
                }
                return null;
            }
            return null; // accept and decline are handled with the state of what they answer (onState)
        },
        // A request or offer was accepted, declined or expired ('genesis-msg-state').
        async onState(update) {
            if (!update || typeof update.msg_id !== 'string') return null;
            if (update.from === agent) {
                // this agent's own request or offer
                const sent_for = mine.get(update.msg_id)?.sent_for ?? null;
                mine.delete(update.msg_id);
                if (update.state === 'accepted') {
                    // the agent now owes what it offered. An offer the planner chose to make is the planner's commitment,
                    // recorded with the planning call that chose it; any other offer is the routine's
                    const planned = sent_for?.by === 'planner' && typeof sent_for.call_id === 'string' && sent_for.call_id.length > 0;
                    if (update.type === 'offer' && hasBody(update.body)) {
                        await commit(update.to, update.body, update, planned ? 'planner' : 'routine', true, planned ? { call_id: sent_for.call_id } : null);
                    }
                    executor.wake(); // a claim that moved, or items on their way: the agent's next look finds them
                    return 'accepted';
                }
                // decided: the asker plans again when its request is declined or nobody answered in time
                replan(update.state === 'expired' ? 'request_expired' : 'request_declined', update);
                executor.wake();
                return update.state;
            }
            // a request or offer that waited for this agent's answer is over (it expired while the model was asked)
            if (update.to === agent && update.state !== 'pending') inbox.delete(update.msg_id);
            return null;
        },
        // The catalog says how a hand-over went (genesis/catalog/templates.js, give_items).
        handedOver(args, how) {
            const duty = duties.find((entry) => entry.to === args.to && entry.item === args.item && entry.count === args.count);
            if (duty) { duty.via = how.via; duty.chest = how.chest ?? null; }
        },
        // A goal ended: when it was a hand-over, the duty is done (or failed), and the other agent is told.
        async goalEnded(end) {
            pickups.delete(end.goal_id);
            const resolved = catalog.resolve(end.option_id);
            if (resolved?.skill !== 'give_items') return null;
            const index = duties.findIndex((entry) => entry.to === resolved.args.to && entry.item === resolved.args.item && entry.count === resolved.args.count);
            if (index < 0) return null;
            const [duty] = duties.splice(index, 1);
            if (end.outcome === 'completed' && duty.via) {
                stats.duties_done++;
                say('handoff_done', { to: duty.to, item: duty.item, count: duty.count, via: duty.via, msg_id: duty.msg_id });
                return post(duty.to, 'inform', { item: duty.item, count: duty.count, handoff: duty.via, ...(duty.chest ? { chest: duty.chest } : {}), re: duty.msg_id }, duty.conv);
            }
            stats.duties_failed++;
            say('handoff_failed', { to: duty.to, item: duty.item, count: duty.count, reason: end.reason ?? end.outcome, msg_id: duty.msg_id });
            return post(duty.to, 'warn', { item: duty.item, count: duty.count, text: `I could not bring the ${duty.item.replaceAll('_', ' ')}`, re: duty.msg_id }, duty.conv);
        },
        // Is this queued goal something the agent agreed with another agent (a hand-over it owes, the fetch of
        // what was left for it)? A new plan of the planner does not replace such a goal (genesis/planning/agent_planner.js).
        owes: (goal) => duties.some((duty) => duty.goal_id !== null && duty.goal_id === goal?.id) || pickups.has(goal?.id),
        // ---- what the catalog reads (state.duties, state.talk) ----
        duties: () => duties.map((duty) => ({ to: duty.to, item: duty.item, count: duty.count })),
        waiting: () => [...mine.values()].map((message) => ({ ...message })),
        spare,
        spareBeyondGoal,
        stats: () => ({ ...stats, rule_because: { ...stats.rule_because }, duties: duties.length, waiting: mine.size, deciding: inbox.size }),
    };
}
