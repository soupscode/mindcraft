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
//   - request(), offer(), inform(), warn() for whatever else code wants to say
//
// What comes in:
//   request   for a reserved chest stock (a contested claim): decided by code. Accepted unless
//             the holder is on its way to those very items.
//             for items the agent carries: declined at once when the agent cannot spare them
//             (it keeps its tools, and its food up to its reserve). Otherwise, with the model
//             AWAY, a code rule accepts (the items are held beyond the agent's own reserve) and
//             the choice is recorded with source "routine". With the model there, the request
//             is a planning trigger and the hand-over is one of the options offered: choosing
//             it is the accept, not choosing it the decline.
//   offer     decided by code: accepted when there is room to carry the items (with the model
//             there it is a planning trigger as well, so the planner knows what is coming)
//   accept    of this agent's own offer: the agent now owes the items
//   decline, or a request that expired: the asker plans again
//   inform    that items wait in a chest for this agent: a goal to fetch them is queued
//
// Accepting creates a COMMITMENT: a duty the executor carries out through the action catalog
// (give_items: handed over directly when the two agents are near each other, through the
// shared chest otherwise).
//
// Injected: agent, send(event, ...args) (the socket), clock, catalog, state() (the world now),
// goals (the goal store), executor, planner, emit(type, data, opts), ledger.
// Depends only on other Genesis files.

import { templateLine } from './lines.js';
import { KIT_FOOD } from '../routines/routines.js';
import { clipText } from '../shared/events.js';

export const DESK_RULES = Object.freeze({
    food_reserve: KIT_FOOD.take,   // proposed: of its food an agent keeps this many (what a kit holds)
    send_timeout_ms: 5000,
    inbox_per_sender: 1,           // decided: of what waits for an answer, the newest per agent is kept
});

export function createMessageDesk({
    agent, send, clock = { now: Date.now, setTimeout, clearTimeout }, catalog, state, goals, executor, planner,
    emit = () => null, rules: overrides = {},
} = {}) {
    const rules = { ...DESK_RULES, ...overrides };
    const stats = { sent: 0, rejected: 0, received: 0, accepted: 0, declined: 0, duties_done: 0, duties_failed: 0, claims_sent: 0, replans: 0 };
    const asks = new Map();    // sender -> the request of that agent that waits for the planner's choice (the newest one)
    const duties = [];         // { to, item, count, msg_id, conv, via, goal_id }: what this agent has agreed to hand over
    const mine = new Map();    // msg_id -> this agent's own requests and offers that wait for an answer
    const say = (state_name, detail) => { try { emit('agent.state', { state: state_name, detail }, { corr: null }); } catch { /* an event must never disturb the desk */ } };

    // Sends one message. Resolves (never rejects) to the relay's answer: { ok, message } or { ok: false, reason }.
    function post(to, type, body, conv = null) {
        return new Promise((resolve) => {
            let settled = false;
            const finish = (answer) => {
                if (settled) return;
                settled = true;
                clock.clearTimeout(timer);
                if (answer?.ok) {
                    stats.sent++;
                    if (answer.message.state === 'pending') mine.set(answer.message.msg_id, answer.message);
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

    const giveId = (to, item, count) => `give_items:${to}:${item}:${count}`;
    const hasBody = (body) => typeof body?.item === 'string' && Number.isInteger(body.count) && body.count >= 1 && body.count <= 64;

    // A hand-over this agent owes: the goal is queued (source: who decided), and the executor carries it out.
    async function commit(to, body, message, decided_by, queue_goal) {
        const duty = { to, item: body.item, count: body.count, msg_id: message.msg_id, conv: message.conv, via: null, goal_id: null, decided_by };
        duties.push(duty);
        if (queue_goal) {
            const source = decided_by === 'planner' ? 'planner' : 'routine';
            const pushed = await goals.pushShortTerm(agent, { title: `Give ${body.count} ${body.item} to ${to}`.slice(0, 60), option_id: giveId(to, body.item, body.count) }, {
                reason: `${to} asked for ${body.count} ${body.item} (${message.msg_id}): ${decided_by === 'routine' ? 'accepted by the code rule, the items are held beyond the reserve' : 'accepted'}`,
                source, call_id: null,
            });
            if (!pushed.ok) {
                duties.splice(duties.indexOf(duty), 1);
                return null;
            }
            duty.goal_id = pushed.goals.short_term.at(-1).id;
            executor.noteGoals([pushed.goals.short_term.at(-1)], { source, call_id: null });
            executor.wake();
        }
        return duty;
    }

    async function answer(message, accepted, decided_by, more = {}) {
        const body = { ...(hasBody(message.body) ? { item: message.body.item, count: message.body.count } : {}), decided_by, ...more };
        stats[accepted ? 'accepted' : 'declined']++;
        say(accepted ? 'request_accepted' : 'request_declined', { from: message.from, msg_id: message.msg_id, type: message.type, decided_by, ...body });
        return post(message.from, accepted ? 'accept' : 'decline', body, message.conv);
    }

    // Is the agent on its way to the very chest stock somebody asks it to give up?
    function usingReservation(chest, item) {
        const plan = executor.mainPlan();
        const resolved = plan ? catalog.resolve(plan.goal.option_id) : null;
        return resolved?.skill === 'fetch_items' && resolved.args.chest === chest && resolved.args.item === item;
    }

    async function onRequest(message) {
        const body = message.body ?? {};
        if (body.claim === true) {
            // a contested claim on what this agent reserved in a chest: code decides, whatever the model does
            const in_use = usingReservation(body.chest, body.item);
            return answer(message, !in_use, 'routine', { claim: true, chest: body.chest, ...(in_use ? { why: 'in_use' } : {}) });
        }
        if (!hasBody(body)) return answer(message, false, 'routine', { why: 'not_understood' });
        if (spare(body.item) < body.count) return answer(message, false, 'routine', { why: 'not_spare' });
        if (executor.isHeld()) return answer(message, false, 'routine', { why: 'held' }); // the operator holds the agent: it promises nothing
        if (!planner.modelAvailable()) {
            // the model is away: the code rule decides (the items are held beyond the agent's own reserve)
            const duty = await commit(message.from, body, message, 'routine', true);
            return duty ? answer(message, true, 'routine') : answer(message, false, 'routine', { why: 'busy' });
        }
        // the model is there: the request is a planning trigger, and the hand-over one of its options
        asks.set(message.from, message); // the newest request of an agent replaces an older one that still waited
        planner.trigger('agent_request', { from: clipText(message.from, 40), text: clipText(templateLine({ ...message, to: agent }), 400), msg_id: message.msg_id, item: body.item, count: body.count });
        return null;
    }

    async function onOffer(message) {
        const body = message.body ?? {};
        const room = state().view.freeSlots() >= (catalog.config.free_slots_needed ?? 1);
        const take = hasBody(body) && room;
        // an offer that is taken is something the planner should know of: items are on their way
        if (take && planner.modelAvailable() && !executor.isHeld()) {
            planner.trigger('agent_request', { from: clipText(message.from, 40), text: clipText(templateLine({ ...message, to: agent }), 400), msg_id: message.msg_id, item: body.item, count: body.count });
        }
        return answer(message, take, 'routine', room ? {} : { why: 'no_room' });
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
            if (message.type === 'request') return onRequest(message);
            if (message.type === 'offer') return onOffer(message);
            if (message.type === 'inform' && message.body?.handoff === 'chest' && hasBody(message.body) && typeof message.body.chest === 'string') {
                // the items wait in a chest, reserved for this agent: fetch them
                const body = message.body;
                const pushed = await goals.pushShortTerm(agent, { title: `Fetch ${body.count} ${body.item} from ${message.from}`.slice(0, 60), option_id: `fetch_items:${body.chest}:${body.item}:${body.count}` }, {
                    reason: `${message.from} left ${body.count} ${body.item} in the ${body.chest} chest (${message.msg_id})`, source: 'routine', call_id: null,
                });
                if (pushed.ok) { executor.noteGoals([pushed.goals.short_term.at(-1)], { source: 'routine', call_id: null }); executor.wake(); }
                return null;
            }
            return null; // accept and decline are handled with the state of what they answer (onState)
        },
        // A request or offer was accepted, declined or expired ('genesis-msg-state').
        async onState(update) {
            if (!update || typeof update.msg_id !== 'string') return null;
            if (update.from === agent) {
                // this agent's own request or offer
                mine.delete(update.msg_id);
                if (update.state === 'accepted') {
                    if (update.type === 'offer' && hasBody(update.body)) await commit(update.to, update.body, update, 'routine', true); // the agent now owes what it offered
                    executor.wake(); // a claim that moved, or items on their way: the agent's next look finds them
                    return 'accepted';
                }
                // decided: the asker plans again when its request is declined or nobody answered in time
                replan(update.state === 'expired' ? 'request_expired' : 'request_declined', update);
                executor.wake();
                return update.state;
            }
            if (update.to === agent && update.state === 'expired' && asks.get(update.from)?.msg_id === update.msg_id) asks.delete(update.from);
            return null;
        },
        // The planner answered a request that carried an agent's request: the hand-over it chose is
        // the accept, every other pending request is declined. `added` are the goals the reply queued;
        // null means no reply came (the budget, a timeout): the code rule decides instead.
        async onPlanned(added) {
            const waiting = [...asks.values()];
            asks.clear();
            for (const message of waiting) {
                const body = message.body;
                if (added === null) {
                    const duty = spare(body.item) >= body.count ? await commit(message.from, body, message, 'routine', true) : null;
                    await answer(message, duty !== null, 'routine', duty ? {} : { why: 'not_spare' });
                    continue;
                }
                const goal = added.find((queued) => queued.option_id === giveId(message.from, body.item, body.count));
                if (goal) {
                    const duty = await commit(message.from, body, message, 'planner', false);
                    duty.goal_id = goal.id;
                    await answer(message, true, 'planner');
                } else {
                    await answer(message, false, 'planner');
                }
            }
        },
        // The catalog says how a hand-over went (genesis/catalog/templates.js, give_items).
        handedOver(args, how) {
            const duty = duties.find((entry) => entry.to === args.to && entry.item === args.item && entry.count === args.count);
            if (duty) { duty.via = how.via; duty.chest = how.chest ?? null; }
        },
        // A goal ended: when it was a hand-over, the duty is done (or failed), and the other agent is told.
        async goalEnded(end) {
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
        // ---- what the catalog reads (state.asks, state.duties) ----
        asks: () => [...asks.values()].filter((message) => hasBody(message.body)).map((message) => ({ to: message.from, item: message.body.item, count: message.body.count })),
        duties: () => duties.map((duty) => ({ to: duty.to, item: duty.item, count: duty.count })),
        waiting: () => [...mine.values()].map((message) => ({ ...message })),
        hasAsks: () => asks.size > 0,
        stats: () => ({ ...stats, asks: asks.size, duties: duties.length, waiting: mine.size }),
    };
}
