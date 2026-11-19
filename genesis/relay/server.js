// Genesis: switches the message relay on in the MindServer process. Called by the launcher
// (genesis/start.js) only when the genesis_planning setting is on and the genesis_relay
// setting does not say "enabled": false; otherwise this file is never loaded and agents
// cannot message each other at all (upstream's free-text conversation commands stay blocked
// either way: genesis/lib/config.js).
//
// It builds the relay (genesis/relay/relay.js), joins it to the agent processes over the
// sockets they already have, and, once the planning host exists (bind), lets the model
// write the spoken lines and decide incoming requests and offers through the planner broker,
// and moves chest reservations when a contested claim is accepted.
//
// Socket events (the agent's side is genesis/relay/desk.js):
//   genesis-msg-send   ({ from, to, type, body, conv }, ack) -> ack({ ok, message } | { ok: false, reason, message })
//   genesis-msg-decide ({ agent, msg_id, conv, facts }, ack) -> ack({ ok: true, decision, reason, call_id } | { ok: false, reason })
//                      the receiving agent asks the model to accept or decline a request or offer that
//                      waits for its answer (decided; genesis/relay/decisions.js). The prompt is built
//                      HERE, from the message as the relay holds it; the agent only adds a few facts
//                      about itself. Not ok (the model is away or busy, the agent's decision limit is
//                      spent, the reply failed validation): the agent's code rule decides.
//   genesis-msg        -> agent   a message for it
//   genesis-msg-state  -> agent   a request or offer (its own, or one addressed to it) was accepted, declined or expired
//   genesis-msg-speak  -> agent   { msg_id, line }: say this line in the game chat
// A message is only taken from the sending agent's own process connection.
//
// NOT RUN AGAINST A REAL MINDSERVER OR MODEL. The tests join it to stand-ins.

import { createRelay } from './relay.js';
import { LINE_LIMITS, lineMessages, lineSchema, parseLineReply, validateLine } from './lines.js';
import { DECISION_LIMITS, brokerDecisionLimits, decisionMessages, decisionSchema, parseDecisionReply, cleanFacts, modelWaitMs } from './decisions.js';
import { createEmitter } from '../events/agent_emit.js';
import { ROUTINES } from '../routines/routines.js';

// The name the relay's events (every message, every rejection) are published under. Who
// sent a message is in the event's data: from.
export const RELAY_EVENT_AGENT = 'relay';

// The writer of the spoken lines: ONE small call per message through the planner broker,
// with its own token limit and its own budget per agent (genesis/broker/broker.js, small()).
// Resolves to the model's line, or null (the model is away or busy, the budget is spent, the
// call failed, or the line does not say what the message says): the relay then uses its template.
export function createLineWriter({ broker, roles = (agent) => ROUTINES[agent]?.role ?? null, limits = LINE_LIMITS } = {}) {
    return async function writeLine(message, template) {
        const result = await broker.small({
            agent: message.from,
            trigger: { kind: 'chat_line', detail: { msg_id: message.msg_id, type: message.type, to: message.to } },
            messages: lineMessages({ message, role: roles(message.from), template, limits }),
            format: lineSchema(limits),
            max_tokens: limits.max_tokens,
            timeout_ms: limits.timeout_ms,
            validate: (raw) => validateLine(parseLineReply(raw), message, limits),
        });
        return result.ok ? parseLineReply(result.content) : null;
    };
}

// The decider of incoming requests and offers: ONE small call of its own kind through the
// planner broker, with its own budget per agent and its own token limit. Resolves to
//   { ok: true, decision: 'accept' | 'decline', reason, call_id }   the model decided
//   { ok: false, reason, call_id? }                                the code rule of the agent decides:
//       nothing_to_decide | model_away | model_busy | budget_exhausted | invalid_reply | timeout | model_error | cancelled
// It only ever decides a request or offer the relay itself holds as waiting for that agent's answer.
export function createDecider({ broker, relay, roles = (agent) => ROUTINES[agent]?.role ?? null, limits = DECISION_LIMITS, clock = { now: Date.now } } = {}) {
    return async function decide({ agent, msg_id, conv, facts } = {}) {
        const pending = typeof conv === 'string' ? relay.conversation(conv)?.pending ?? null : null;
        if (!pending || pending.msg_id !== msg_id || pending.to !== agent) return { ok: false, reason: 'nothing_to_decide' };
        // the asker's line first: the two small calls of one message never race for the model
        await relay.lineSettled(msg_id);
        if (relay.conversation(conv)?.pending?.msg_id !== msg_id) return { ok: false, reason: 'nothing_to_decide' }; // it expired meanwhile
        const result = await broker.small({
            agent,
            kind: 'message_decision',
            trigger: { kind: 'message_decision', detail: { msg_id, type: pending.type, from: pending.from, claim: pending.body?.claim === true } },
            messages: decisionMessages({ message: pending, role: roles(agent), facts: cleanFacts(facts) }),
            format: decisionSchema(),
            max_tokens: limits.max_tokens,
            timeout_ms: limits.timeout_ms,
            // decided: behind a busy model the decision waits until the last 15 seconds of the message's life; then the
            // call is given up ("model_busy") and the agent's code rule answers in what is left.
            wait_ms: modelWaitMs((Date.parse(pending.expires_at) || 0) - clock.now(), limits.wait_ms),
            validate: (raw) => parseDecisionReply(raw) !== null,
        });
        if (!result.ok) return { ok: false, reason: result.reason, call_id: result.call_id ?? null };
        return { ok: true, ...parseDecisionReply(result.content), call_id: result.call_id };
    };
}

// relay_settings: the genesis_relay setting (may be undefined: every value then has its default)
// agents:         the names of the agents (the profiles the launcher starts); null: whoever is connected
// event_sink:     where events go when the genesis_events setting is on (the hub's accept), or null
// Injectable for the tests: clock.
export function startRelay(relay_settings = {}, { agents = null, event_sink = null, clock = null, emit = null } = {}) {
    const emitter = event_sink ? createEmitter({ agent: RELAY_EVENT_AGENT, send: event_sink, ...(clock ? { now: clock.now } : {}) }) : null;
    const sockets = new Map(); // agent -> the socket of its process
    const stats = { sends: 0, refused_sender: 0, decisions_asked: 0, decisions_made: 0 };
    const decision_limits = { ...DECISION_LIMITS, ...(relay_settings?.decision ?? {}) };
    let decider = null; // set once the planner broker exists (bind), unless "model_decisions" is false
    const roster = Array.isArray(agents) && agents.length > 0 ? new Set(agents) : null;
    const line_limits = { ...LINE_LIMITS, ...(relay_settings?.line ?? {}) };

    const relay = createRelay({
        ...(clock ? { clock } : {}),
        emit: emit ?? (emitter ? emitter.emit : () => null),
        isAgent: (name) => (roster ? roster.has(name) : sockets.has(name)),
        deliver(agent, event, payload) {
            const socket = sockets.get(agent);
            if (!socket || socket.connected === false) return false;
            socket.emit(event, payload);
            return true;
        },
        ...(relay_settings?.limits ?? {}),
    });

    return {
        relay,
        // Added to every connection to the MindServer (genesis/planning/server.js, `extensions`).
        attach(socket, { isAgentSocket = () => true } = {}) {
            const own = (agent) => typeof agent === 'string' && agent.length > 0 && isAgentSocket(agent);
            socket.on('genesis-hello', (agent) => { if (own(agent)) sockets.set(agent, socket); });
            socket.on('genesis-msg-send', (input, ack) => {
                stats.sends++;
                const answer = typeof ack === 'function' ? ack : () => {};
                if (!own(input?.from)) {
                    // somebody else's name: refused, and told like every other rejection
                    stats.refused_sender++;
                    answer(relay.refuse(input, 'unknown_sender'));
                    return;
                }
                sockets.set(input.from, socket);
                answer(relay.send(input));
            });
            socket.on('genesis-msg-decide', (input, ack) => {
                if (typeof ack !== 'function') return;
                if (!own(input?.agent)) { ack({ ok: false, reason: 'unknown_sender' }); return; }
                stats.decisions_asked++;
                if (!decider) { ack({ ok: false, reason: 'model_decisions_off' }); return; }
                decider(input).then((answer) => { if (answer.ok) stats.decisions_made++; ack(answer); }, () => ack({ ok: false, reason: 'model_error' }));
            });
            socket.on('disconnect', () => {
                for (const [agent, known] of sockets) if (known === socket) sockets.delete(agent);
            });
        },
        // Called once the planning host exists: the model writes the lines through its broker, and
        // the one chest ledger follows what the agents agree on.
        //   - incoming requests and offers are decided by the model (unless "model_decisions": false)
        //   - a contested claim that is accepted: the reservation moves from the holder to the asker
        //   - items left in a chest for another agent: reserved for that agent
        bind({ broker = null, ledger = null, ledgerUpdated = () => {} } = {}) {
            if (broker && relay_settings?.model_lines !== false) relay.setLineWriter(createLineWriter({ broker, limits: line_limits }));
            if (broker && relay_settings?.model_decisions !== false) {
                // the decision call's own hourly limit and token limit, as the genesis_relay.decision setting has them
                broker.setSmallLimits?.('message_decision', brokerDecisionLimits(decision_limits));
                decider = createDecider({ broker, relay, limits: decision_limits, ...(clock ? { clock } : {}) });
            }
            if (ledger) {
                relay.setOnRelayed((message, answered) => {
                    const body = message.body ?? {};
                    let changed = false;
                    if (message.type === 'accept' && answered?.type === 'request' && answered.body?.claim === true && typeof answered.body.chest === 'string') {
                        changed = ledger.transfer(message.from, message.to, { chest: answered.body.chest, item: answered.body.item, count: answered.body.count }).ok;
                    } else if (message.type === 'inform' && body.handoff === 'chest' && typeof body.chest === 'string') {
                        changed = ledger.reserve(message.to, { chest: body.chest, item: body.item, count: body.count }).ok;
                    }
                    if (changed) ledgerUpdated();
                });
            }
        },
        stats: () => ({ ...stats, connected: sockets.size, relay: relay.stats() }),
        stop() { relay.stop(); },
    };
}
