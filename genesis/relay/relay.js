// Genesis: the relay of agent-to-agent messages. ONE central service, in the MindServer
// process (decided). Agents coordinate through structured messages; the chat line players
// see is only how a message is displayed.
//
// Message (decided):
//   { "msg_id": "m-0412-1", "conv": "c-0412", "from": "Arthur", "to": "Felix", "type": "request",
//     "body": { "item": "oak_log", "count": 24 }, "chat_line": "Felix, I need 24 oak logs for the hall walls.",
//     "expires_at": "<ISO time>", "state": "pending" }
// Types: request, offer, accept, decline, inform, warn. Only request and offer expect a reply.
//
// The limits are enforced HERE and never in a prompt:
//   - 6 turns per conversation (decided): the 7th is rejected, and the conversation is over
//   - a request or offer expires after 120 seconds (decided)
//   - 2 open conversations per agent: a conversation is open while a request or offer in it
//     waits for its answer
//   - 6 messages per agent per minute
//   - an identical message may repeat once, then it is blocked for 10 minutes
//   - sender and receiver must differ
// A message the relay rejects becomes an agent.message event with state "rejected" and the
// named reason. It is not delivered, and it is never spoken in chat.
//
// When a conversation overflows the relay keeps the newest message per agent (decided):
// that is all it ever holds of a conversation besides the request that waits for an answer.
//
// The spoken line: every relayed message gets ONE line, said by the sender in the Minecraft
// chat. `line(message, template)` may hand back a line the model wrote; it is used only when
// it says what the message says (genesis/relay/lines.js), otherwise the template is. The
// line is never written into the message body: the structured content is what was sent.
// The message itself is delivered at once; nobody waits for the line. Lines are written one
// after the other, in the order the messages came, and the events follow in that order too;
// when more than a few lines wait, the model is not asked and the template is said.
//
// Everything outside is injected:
//   clock                    { now(), setTimeout(fn, ms), clearTimeout(handle) }
//   emit(type, data, opts)   where the agent.message events go
//   isAgent(name)            is this the name of an agent
//   deliver(agent, event, payload) -> boolean      hands something to an agent's process:
//                            'genesis-msg' (a message for it), 'genesis-msg-state' (a request or
//                            offer of its own, or addressed to it, was accepted, declined or
//                            expired), 'genesis-msg-speak' ({ msg_id, line }: say this line)
//   line(message, template) -> Promise<string | null>   the model's line, or null (optional)
//   onRelayed(message, answered)   told about every relayed message; `answered` is the request
//                            or offer an accept or decline answers (the chest ledger moves a
//                            reservation from here, genesis/relay/server.js)
// Depends only on genesis/shared/events.js and genesis/relay/lines.js.

import { MESSAGE_TYPES, REPLY_EXPECTED, clipText } from '../shared/events.js';
import { templateLine, validateLine } from './lines.js';

export const RELAY_LIMITS = Object.freeze({
    max_turns: 6,                       // decided
    expiry_ms: 120 * 1000,              // decided
    max_open_conversations: 2,          // proposed
    max_messages_per_minute: 6,         // proposed
    rate_window_ms: 60 * 1000,
    repeats_allowed: 1,                 // proposed: an identical message may repeat once ...
    repeat_block_ms: 10 * 60 * 1000,    // proposed: ... then it is blocked for 10 minutes
    max_body_bytes: 1024,               // proposed: a message body is small, structured data
    conversation_memory_ms: 30 * 60 * 1000, // proposed: how long a conversation that is over is remembered
    max_lines_waiting: 2,               // proposed: with more lines than this waiting to be written, the template is used
});

export const REJECT_REASONS = Object.freeze([
    'invalid_message', 'unknown_sender', 'unknown_recipient', 'self_message', 'rate_limit', 'repeat_blocked', 'turn_limit',
    'too_many_conversations', 'recipient_busy', 'unknown_conversation', 'not_in_conversation', 'nothing_to_answer', 'awaiting_reply',
]);

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const NAME = /^[A-Za-z0-9_]{1,40}$/;

// The same message again? Sender, receiver, type and body (with its keys in a fixed order) decide.
function sameKey(from, to, type, body) {
    const sorted = (value) => (isPlainObject(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])])) : value);
    return `${from}|${to}|${type}|${JSON.stringify(sorted(body))}`;
}

export function createRelay({
    clock = { now: Date.now, setTimeout, clearTimeout }, emit = () => null, isAgent = () => true, deliver = () => false,
    line = null, onRelayed = null, ...options
} = {}) {
    const limits = { ...RELAY_LIMITS };
    for (const key of Object.keys(RELAY_LIMITS)) {
        if (options[key] !== undefined) limits[key] = options[key];
    }
    const conversations = new Map(); // conv id -> { id, members, turns, pending, timer, newest: { agent: message }, over, last_at }
    const sent = new Map();          // agent -> when its relayed messages were sent, within the rate window
    const repeats = new Map();       // sameKey -> when it was relayed, within the block time
    const stats = { relayed: 0, rejected: 0, expired: 0, accepted: 0, declined: 0, spoken: 0, model_lines: 0, template_lines: 0, rejected_by: {} };
    const lines_pending = new Map(); // msg_id -> resolves when the line of that message has been spoken
    let waiting_lines = 0;           // lines not yet written
    let in_order = Promise.resolve(); // lines and events, one after the other
    let line_writer = line;
    let on_relayed = onRelayed;
    let conv_seq = 0;

    const iso = (ms) => new Date(ms).toISOString();
    const copy = (message) => JSON.parse(JSON.stringify(message));
    const say = (data, severity = 'info') => { try { emit('agent.message', data, { severity, corr: null }); } catch { /* an event must never disturb the relay */ } };
    const hand = (agent, event, payload) => { try { return deliver(agent, event, payload) === true; } catch { return false; } };
    const isOpen = (conv) => conv.pending !== null;
    const openFor = (agent, except = null) => [...conversations.values()].filter((conv) => conv !== except && isOpen(conv) && conv.members.includes(agent)).length;
    const recent = (map, key, window, now) => {
        const list = (map.get(key) ?? []).filter((at) => at > now - window);
        if (list.length > 0) map.set(key, list); else map.delete(key);
        return list;
    };

    function sweep(now) {
        for (const [id, conv] of conversations) {
            if (!isOpen(conv) && now - conv.last_at > limits.conversation_memory_ms) conversations.delete(id);
        }
    }

    function reject(input, reason, conv_id = null) {
        stats.rejected++;
        stats.rejected_by[reason] = (stats.rejected_by[reason] ?? 0) + 1;
        const text = (value, fallback) => (typeof value === 'string' && value.trim().length > 0 ? clipText(value, 40) : fallback);
        const message = {
            msg_id: `m-x-${stats.rejected}`,
            conv: text(conv_id ?? input?.conv, 'none'),
            from: text(input?.from, 'unknown'),
            to: text(input?.to, 'unknown'),
            type: text(input?.type, 'unknown'),
            body: isPlainObject(input?.body) && JSON.stringify(input.body).length <= limits.max_body_bytes ? copy(input.body) : {},
            chat_line: null,      // a rejected message is never spoken
            expires_at: null,
            state: 'rejected',
            reason,
        };
        say(message, 'warn');
        return { ok: false, reason, message };
    }

    function expire(conv, message) {
        if (conv.pending !== message || message.state !== 'pending') return;
        message.state = 'expired';
        conv.pending = null;
        conv.timer = null;
        conv.last_at = clock.now();
        stats.expired++;
        later(() => say(copy(message)));
        // both ends learn it: the asker plans again, the other one need not answer any more
        hand(message.from, 'genesis-msg-state', copy(message));
        hand(message.to, 'genesis-msg-state', copy(message));
    }

    // Runs after everything that was put in line before it. Never rejects.
    function later(fn) {
        in_order = in_order.then(fn).catch(() => {});
        return in_order;
    }

    // The line of a relayed message: the model's when it wrote one that says the same, else the template.
    async function speak(message, state_when_sent, crowded) {
        const template = templateLine(message);
        let said = template;
        let source = 'template';
        if (line_writer && !crowded) {
            try {
                const written = await line_writer(copy(message), template);
                if (typeof written === 'string' && validateLine(written, message)) { said = written.trim(); source = 'model'; }
            } catch { /* no line from the model: the template */ }
        }
        message.chat_line = said;
        stats[source === 'model' ? 'model_lines' : 'template_lines']++;
        say({ ...copy(message), state: state_when_sent, line_source: source });
        if (hand(message.from, 'genesis-msg-speak', { msg_id: message.msg_id, conv: message.conv, line: said })) stats.spoken++;
    }

    return {
        limits,
        // Takes one message from an agent. Returns { ok: true, message } (relayed) or
        // { ok: false, reason, message } (rejected: an event, never delivered, never spoken).
        send(input) {
            const now = clock.now();
            sweep(now);
            const { from, to, type } = input ?? {};
            const body = input?.body;
            if (typeof from !== 'string' || !NAME.test(from) || typeof to !== 'string' || !NAME.test(to) || !MESSAGE_TYPES.includes(type) || !isPlainObject(body)) {
                return reject(input, 'invalid_message');
            }
            let body_text;
            try { body_text = JSON.stringify(body); } catch { return reject({ ...input, body: {} }, 'invalid_message'); }
            if (body_text.length > limits.max_body_bytes) return reject({ ...input, body: {} }, 'invalid_message');
            if (from === to) return reject(input, 'self_message');
            if (!isAgent(from)) return reject(input, 'unknown_sender');
            if (!isAgent(to)) return reject(input, 'unknown_recipient');
            if (recent(sent, from, limits.rate_window_ms, now).length >= limits.max_messages_per_minute) return reject(input, 'rate_limit');
            const key = sameKey(from, to, type, body);
            if (recent(repeats, key, limits.repeat_block_ms, now).length >= 1 + limits.repeats_allowed) return reject(input, 'repeat_blocked');

            const expects_reply = REPLY_EXPECTED.includes(type);
            const is_reply = type === 'accept' || type === 'decline';
            let conv = null;
            if (input.conv !== undefined && input.conv !== null) {
                conv = conversations.get(input.conv) ?? null;
                if (!conv) return reject(input, 'unknown_conversation');
                if (!conv.members.includes(from) || !conv.members.includes(to)) return reject(input, 'not_in_conversation');
                if (conv.over || conv.turns >= limits.max_turns) {
                    // the conversation overflows: it is over, and what stays of it is the newest message of each agent
                    conv.over = true;
                    return reject(input, 'turn_limit');
                }
            } else if (is_reply) {
                return reject(input, 'nothing_to_answer');
            }
            let answered = null;
            if (is_reply) {
                answered = conv.pending;
                if (!answered || answered.to !== from) return reject(input, 'nothing_to_answer');
            } else if (expects_reply) {
                if (conv && isOpen(conv)) return reject(input, 'awaiting_reply'); // one request or offer at a time in a conversation
                if (openFor(from, conv) >= limits.max_open_conversations) return reject(input, 'too_many_conversations', conv?.id ?? null);
                if (openFor(to, conv) >= limits.max_open_conversations) return reject(input, 'recipient_busy', conv?.id ?? null);
            }

            // ---- relayed ----
            if (!conv) {
                conv_seq++;
                conv = { id: `c-${String(conv_seq).padStart(4, '0')}`, members: [from, to], turns: 0, pending: null, timer: null, newest: {}, over: false, last_at: now };
                conversations.set(conv.id, conv);
            }
            conv.turns++;
            conv.last_at = now;
            const message = {
                msg_id: `m-${conv.id.slice(2)}-${conv.turns}`,
                conv: conv.id, from, to, type,
                body: copy(body),
                chat_line: null, // decided a moment later (see speak)
                expires_at: expects_reply ? iso(now + limits.expiry_ms) : null,
                state: expects_reply ? 'pending' : 'delivered',
            };
            conv.newest[from] = message;
            sent.set(from, [...(sent.get(from) ?? []), now]);
            repeats.set(key, [...(repeats.get(key) ?? []), now]);
            stats.relayed++;

            if (answered) {
                answered.state = type === 'accept' ? 'accepted' : 'declined';
                stats[answered.state]++;
                if (conv.timer !== null) { clock.clearTimeout(conv.timer); conv.timer = null; }
                conv.pending = null;
            }
            if (expects_reply) {
                conv.pending = message;
                conv.timer = clock.setTimeout(() => expire(conv, message), limits.expiry_ms);
                conv.timer?.unref?.();
            }
            if (on_relayed) { try { on_relayed(copy(message), answered ? copy(answered) : null); } catch { /* the listener's problem */ } }

            // the line and the event of this message come after those of every message before it
            // (put in line BEFORE the message is handed on: the receiver may answer on the spot)
            const crowded = waiting_lines >= limits.max_lines_waiting;
            const state_when_sent = message.state;
            waiting_lines++;
            const line_spoken = later(() => speak(message, state_when_sent, crowded).finally(() => { waiting_lines--; lines_pending.delete(message.msg_id); }));
            lines_pending.set(message.msg_id, line_spoken);
            hand(to, 'genesis-msg', copy(message));
            if (answered) {
                // the request or offer changed its state: an event of its own, and both ends are told
                const answered_now = copy(answered);
                later(() => say(answered_now));
                hand(answered.from, 'genesis-msg-state', { ...answered_now, answer: copy(message) });
            }
            return { ok: true, message: copy(message) };
        },
        // Refuses a message for a reason of the caller's (a sender that is not who it says: genesis/relay/server.js).
        refuse: (input, reason) => reject(input, reason),
        // Set once the planner broker exists (genesis/relay/server.js).
        setLineWriter(fn) { line_writer = typeof fn === 'function' ? fn : null; },
        setOnRelayed(fn) { on_relayed = typeof fn === 'function' ? fn : null; },
        // What the relay holds of a conversation: its turns, whether it is open, the newest message per agent.
        conversation(id) {
            const conv = conversations.get(id);
            if (!conv) return null;
            return { id: conv.id, members: [...conv.members], turns: conv.turns, open: isOpen(conv), over: conv.over, pending: conv.pending ? copy(conv.pending) : null, newest: copy(conv.newest) };
        },
        openConversations: (agent) => openFor(agent),
        // Resolves when the line of this message has been spoken (at once when it already was, or for a
        // message the relay does not know). The model's decision about a request waits for it, so the
        // asker's line is written first and the two small calls never race (genesis/relay/server.js).
        lineSettled: (msg_id) => lines_pending.get(msg_id) ?? Promise.resolve(),
        // Resolves when every line that is being written has been spoken (for tests and shutdown).
        async idle() { let seen; do { seen = in_order; await seen; } while (seen !== in_order); },
        stats: () => ({ ...stats, rejected_by: { ...stats.rejected_by }, conversations: conversations.size }),
        stop() {
            for (const conv of conversations.values()) if (conv.timer !== null) { clock.clearTimeout(conv.timer); conv.timer = null; }
        },
    };
}
