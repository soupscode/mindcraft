// Genesis: the model's answer to a request or an offer of another agent (decided).
//
// When a request or an offer arrives, the model is available and the receiving agent has
// budget, the MODEL decides: accept or decline. It is a small structured call of its own
// kind ("message_decision") through the planner broker (genesis/broker/broker.js, small()),
// with its own hourly limit per agent and its own token limit. The reply is
//
//   { "decision": "accept" | "decline", "reason": "<at most 140 characters>" }
//
// and nothing else: the model decides yes or no, never what is handed over, how many, or to
// whom. Those stay the structured content of the message. A decision the model made is
// recorded with source "planner". Decided: a request or an offer WAITS for the model's answer
// when the model is busy with another call, until the LAST 15 SECONDS of the message's life
// (120 seconds): then the code rule of the message desk answers (genesis/relay/desk.js), so the
// request does not expire unanswered. The code rule also decides when the model is away, the
// limit is spent, the call fails or the reply does not validate. Whatever it decides is recorded
// with source "routine", answered_by "code_rule" and why it was its turn. A contested chest
// claim goes the same way.
//
// The model's reason is recorded (the call record, the agent's own event). It is never put
// into a message another agent receives: nothing between agents is free text.
//
//   decisionMessages(...)       the small prompt for ONE decision
//   decisionSchema()            the structured reply
//   parseDecisionReply(raw)     { decision, reason } when the reply is exactly that, else null
//   cleanFacts(facts)           what an agent may tell about itself for the prompt: a few
//                               numbers, yes/no values and short texts, and nothing else
// Depends only on genesis/relay/lines.js.

import { templateLine } from './lines.js';

// Proposed starting values, all of them: the genesis_relay.decision setting replaces any.
export const DECISION_LIMITS = Object.freeze({
    max_calls_per_hour: 20,   // proposed: decisions the model makes per agent per real hour; after that the code rule decides
    max_tokens: 80,           // proposed: the model's own token limit for a decision (Ollama's num_predict)
    timeout_ms: 15 * 1000,    // proposed: a decision that takes longer is not waited for
    wait_ms: 120 * 1000,      // the longest a decision waits for a model that is busy with another call; in effect the message's
                              // life less the code rule's 15 seconds (modelWaitMs below). A smaller value here is a shorter wait
});

// Decided: when the model stays busy for the whole wait, the agent's CODE RULE answers in the last 15 seconds of the
// message's life (of a shorter-lived message: in its last eighth), so that a request is not left to expire. The
// event of the answer says that the code rule answered, not the model.
export const RULE_MARGIN_MS = 15 * 1000;
// How long the model may be waited for, for a message with `remaining_ms` left to live.
export const modelWaitMs = (remaining_ms, limit_ms = Infinity) => Math.max(0, Math.min(limit_ms, remaining_ms - Math.min(RULE_MARGIN_MS, remaining_ms / 8)));

export const DECISION_REASON_MAX = 140; // decided: the reason is at most 140 characters
export const DECISIONS = Object.freeze(['accept', 'decline']);

// The limits as the broker names them (genesis/broker/broker.js, setSmallLimits).
export function brokerDecisionLimits(limits = DECISION_LIMITS) {
    return { max_calls: limits.max_calls_per_hour, max_tokens: limits.max_tokens, timeout_ms: limits.timeout_ms, wait_ms: limits.wait_ms };
}

// The reply the model is asked for.
export function decisionSchema() {
    return {
        type: 'object',
        properties: {
            decision: { type: 'string', enum: [...DECISIONS] },
            reason: { type: 'string', minLength: 1, maxLength: DECISION_REASON_MAX },
        },
        required: ['decision', 'reason'],
        additionalProperties: false,
    };
}

// Why a reply is not a decision, or null when it is one.
export function decisionProblem(raw) {
    let parsed;
    try { parsed = JSON.parse(String(raw)); } catch { return 'not_json'; }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return 'not_an_object';
    if (Object.keys(parsed).some((key) => key !== 'decision' && key !== 'reason')) return 'unknown_field';
    if (!DECISIONS.includes(parsed.decision)) return 'not_accept_or_decline';
    if (typeof parsed.reason !== 'string' || parsed.reason.trim().length === 0) return 'reason_missing';
    if (parsed.reason.trim().length > DECISION_REASON_MAX) return 'reason_too_long';
    if (/[\r\n]/.test(parsed.reason.trim())) return 'reason_more_than_one_line';
    return null;
}

// Reads the model's reply. Returns { decision, reason }, or null when the reply fails validation.
export function parseDecisionReply(raw) {
    if (decisionProblem(raw) !== null) return null;
    const parsed = JSON.parse(String(raw));
    return { decision: parsed.decision, reason: parsed.reason.trim() };
}

const FACT_NUMBERS = Object.freeze(['held', 'spare', 'free_slots', 'reserved']);
const FACT_FLAGS = Object.freeze(['in_use']);
const FACT_TEXTS = Object.freeze(['in_hand', 'long_term']);
const short = (text, max = 60) => { const value = String(text ?? '').replace(/\s+/g, ' ').trim(); return value.length <= max ? value : `${value.slice(0, max - 1)}…`; };

// What an agent tells about itself for the decision: only these names, only these kinds of value.
//   held        how many of the item the agent carries         spare    how many of them it can part with
//   free_slots  free inventory slots                           reserved how many it has reserved in the chest (a claim)
//   in_use      it is on its way to the reserved items         in_hand, long_term   the titles of its goals
export function cleanFacts(facts) {
    const out = {};
    if (facts === null || typeof facts !== 'object') return out;
    for (const key of FACT_NUMBERS) if (Number.isFinite(facts[key])) out[key] = Math.max(0, Math.floor(facts[key]));
    for (const key of FACT_FLAGS) if (typeof facts[key] === 'boolean') out[key] = facts[key];
    for (const key of FACT_TEXTS) if (typeof facts[key] === 'string' && facts[key].trim().length > 0) out[key] = short(facts[key]);
    return out;
}

// The prompt for one decision. `message` is the request or offer as the relay holds it,
// `role` the receiving agent's role ("explorer"), `facts` what cleanFacts let through.
export function decisionMessages({ message, role = null, facts = {} }) {
    const body = message.body ?? {};
    const claim = message.type === 'request' && body.claim === true;
    const system = [
        'You decide for a character in a Minecraft village whether it says yes or no to another character.',
        `Reply with JSON only: {"decision": "accept" or "decline", "reason": "..."}. The reason is one short sentence, at most ${DECISION_REASON_MAX} characters.`,
        'You decide yes or no and nothing else: the item, the count and the people are fixed by the message.',
        message.type === 'offer'
            ? 'Accept means the character will be given exactly these items.'
            : (claim ? 'Accept means the character gives up its claim on exactly these items in the chest.' : 'Accept means the character hands over exactly these items.'),
    ].join('\n');
    const user = [
        `You are ${message.to}${role ? `, the ${role}` : ''}. ${message.from} says: "${templateLine(message)}"`,
        `Message (${message.type}${claim ? ', a claim on what you reserved in a chest' : ''}): ${JSON.stringify(body)}`,
        `About you: ${JSON.stringify(cleanFacts(facts))}`,
    ].join('\n');
    return [{ role: 'system', content: system }, { role: 'user', content: user }];
}
