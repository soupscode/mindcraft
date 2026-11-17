// Step 11, structured agent messages: the relay and its limits, the spoken line, the
// receiving side, the contested claim, and the hand-over of items.
//
// The relay is the real one (genesis/relay/relay.js), on the fake clock. In the town tests it
// sits in the planning host as the launcher puts it there, the agents run their real runtime
// with their message desk against the stand-in world, and the model is the stub that counts
// what it is asked.
// Run from the repository root:  node --test genesis/tests/*.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeClock, settle } from './helpers/fakes.mjs';
import { makeTown, BLUEPRINTS } from './helpers/town.mjs';
import { validateEvent, MESSAGE_TYPES, MESSAGE_STATES, REPLY_EXPECTED } from '../shared/events.js';
import { createRelay, RELAY_LIMITS, REJECT_REASONS } from '../relay/relay.js';
import { templateLine, validateLine, lineProblem, lineMessages, lineSchema, parseLineReply, LINE_LIMITS } from '../relay/lines.js';
import {
    DECISION_LIMITS, DECISION_REASON_MAX, DECISIONS, decisionSchema, decisionProblem, parseDecisionReply, decisionMessages, cleanFacts, brokerDecisionLimits,
} from '../relay/decisions.js';
import { startRelay, RELAY_EVENT_AGENT } from '../relay/server.js';
import { SMALL_CALL_DEFAULTS, DECISION_CALL_DEFAULTS } from '../broker/broker.js';
import { DESK_RULES } from '../relay/desk.js';
import { createCatalog } from '../catalog/catalog.js';
import { createSharedLedger } from '../catalog/shared_ledger.js';
import { checkSettings, REQUIRED_BLOCKED_ACTIONS } from '../lib/config.js';
import { TEMPLATE_NAMES } from '../catalog/templates.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const NAMES = ['Arthur', 'Mira', 'Felix', 'Nova'];

// A relay on its own: what it emits, what it hands to which agent, and what it tells them to say.
function bareRelay(options = {}) {
    const clock = fakeClock();
    const events = [];
    const handed = [];
    const relay = createRelay({
        clock, emit: (type, data, opts) => events.push({ type, data, ...opts }), isAgent: (name) => NAMES.includes(name),
        deliver: (agent, event, payload) => { handed.push({ agent, event, payload }); return true; }, ...options,
    });
    const spoken = () => handed.filter((entry) => entry.event === 'genesis-msg-speak').map((entry) => [entry.agent, entry.payload.msg_id, entry.payload.line]);
    const delivered = () => handed.filter((entry) => entry.event === 'genesis-msg').map((entry) => [entry.agent, entry.payload.msg_id]);
    return { clock, events, handed, relay, spoken, delivered };
}

function assertMessageEvents(events) {
    for (const event of events) {
        assert.equal(event.type, 'agent.message');
        const checked = validateEvent({ v: 1, id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', ts: '2026-01-01T00:00:00.000Z', agent: RELAY_EVENT_AGENT, seq: 1, type: event.type, corr: null, severity: event.severity ?? 'info', data: event.data });
        assert.deepEqual(checked, { ok: true, errors: [] }, JSON.stringify(event.data));
    }
}

test('the message and the limits are the decided ones', () => {
    assert.deepEqual([...MESSAGE_TYPES], ['request', 'offer', 'accept', 'decline', 'inform', 'warn']);
    assert.deepEqual([...REPLY_EXPECTED], ['request', 'offer']);
    assert.deepEqual([RELAY_LIMITS.max_turns, RELAY_LIMITS.expiry_ms, RELAY_LIMITS.max_open_conversations, RELAY_LIMITS.max_messages_per_minute, RELAY_LIMITS.repeats_allowed, RELAY_LIMITS.repeat_block_ms],
        [6, 120 * SECOND, 2, 6, 1, 10 * MINUTE]);
    for (const reason of ['turn_limit', 'self_message', 'repeat_blocked', 'too_many_conversations', 'rate_limit']) assert.ok(REJECT_REASONS.includes(reason));
    // agent-to-agent talk goes only through the relay: upstream's free-text conversation commands stay blocked
    for (const action of ['!newAction', '!startConversation', '!endConversation']) assert.ok(REQUIRED_BLOCKED_ACTIONS.includes(action));
    // the hand-over is a template beside the nine skill templates
    assert.equal(TEMPLATE_NAMES.length, 9);
    assert.ok(!TEMPLATE_NAMES.includes('give_items'));

    // the decided example, as the relay makes it
    const { relay, events, clock } = bareRelay();
    const sent = relay.send({ from: 'Arthur', to: 'Felix', type: 'request', body: { item: 'oak_log', count: 24, reason: 'the hall walls' } });
    assert.equal(sent.ok, true);
    assert.deepEqual(Object.keys(sent.message), ['msg_id', 'conv', 'from', 'to', 'type', 'body', 'chat_line', 'expires_at', 'state']);
    assert.deepEqual([sent.message.msg_id, sent.message.conv, sent.message.state], ['m-0001-1', 'c-0001', 'pending']);
    assert.equal(sent.message.expires_at, new Date(clock.now() + 120 * SECOND).toISOString());
    return relay.idle().then(() => {
        assert.equal(events[0].data.chat_line, 'Felix, I need 24 oak logs for the hall walls.');
        assert.ok(MESSAGE_STATES.includes(events[0].data.state));
        assertMessageEvents(events);
        relay.stop();
    });
});

test('the 7th turn, a self-message and a third identical request are each rejected with a named reason, and nothing of them is spoken', async () => {
    const { relay, events, spoken, delivered, clock } = bareRelay();
    // one conversation of six turns
    const first = relay.send({ from: 'Arthur', to: 'Felix', type: 'request', body: { item: 'oak_log', count: 24 } });
    const conv = first.message.conv;
    const turns = [
        { from: 'Felix', to: 'Arthur', type: 'decline', body: { item: 'oak_log', count: 24 } },
        { from: 'Arthur', to: 'Felix', type: 'request', body: { item: 'oak_log', count: 12 } },
        { from: 'Felix', to: 'Arthur', type: 'decline', body: { item: 'oak_log', count: 12 } },
        { from: 'Arthur', to: 'Felix', type: 'inform', body: { text: 'then I will cut them myself' } },
        { from: 'Felix', to: 'Arthur', type: 'warn', body: { text: 'the wood is full of spiders' } },
    ];
    for (const turn of turns) assert.equal(relay.send({ ...turn, conv }).ok, true, JSON.stringify(turn));
    assert.equal(relay.conversation(conv).turns, 6);

    // the 7th turn
    const seventh = relay.send({ from: 'Arthur', to: 'Felix', type: 'inform', body: { text: 'thanks for the warning' }, conv });
    assert.deepEqual([seventh.ok, seventh.reason, seventh.message.state, seventh.message.chat_line], [false, 'turn_limit', 'rejected', null]);
    // the conversation is over, and what the relay keeps of it is the newest message of each agent
    const kept = relay.conversation(conv);
    assert.deepEqual([kept.turns, kept.over, kept.open], [6, true, false]);
    assert.deepEqual(Object.fromEntries(Object.entries(kept.newest).map(([agent, message]) => [agent, message.msg_id])), { Arthur: 'm-0001-5', Felix: 'm-0001-6' });
    assert.equal(relay.send({ from: 'Felix', to: 'Arthur', type: 'inform', body: { text: 'any time' }, conv }).reason, 'turn_limit');

    // a message to oneself
    const self = relay.send({ from: 'Arthur', to: 'Arthur', type: 'request', body: { item: 'bread', count: 2 } });
    assert.deepEqual([self.ok, self.reason], [false, 'self_message']);

    // an identical request: once more is fine, the third is blocked, for 10 minutes
    await clock.advance(61 * SECOND); // (a new minute, so the rate limit is not what refuses)
    const same = { from: 'Arthur', to: 'Mira', type: 'request', body: { item: 'bread', count: 2 } };
    assert.equal(relay.send(same).ok, true);
    assert.equal(relay.send({ ...same, body: { count: 2, item: 'bread' } }).ok, true, 'the same body with its keys in another order is the same message');
    const third = relay.send(same);
    assert.deepEqual([third.ok, third.reason], [false, 'repeat_blocked']);
    await clock.advance(9 * MINUTE);
    assert.equal(relay.send(same).reason, 'repeat_blocked');
    await clock.advance(61 * SECOND);
    assert.equal(relay.send(same).ok, true, 'the block did not end after 10 minutes');

    await relay.idle();
    // nothing rejected was delivered or spoken; everything relayed was, once
    const rejected = events.filter((event) => event.data.state === 'rejected');
    assert.deepEqual(rejected.map((event) => event.data.reason), ['turn_limit', 'turn_limit', 'self_message', 'repeat_blocked', 'repeat_blocked']);
    assert.ok(rejected.every((event) => event.data.chat_line === null && event.severity === 'warn'));
    const relayed_ids = events.filter((event) => event.data.line_source !== undefined).map((event) => event.data.msg_id);
    assert.equal(relayed_ids.length, 9);
    assert.deepEqual(spoken().map(([, msg_id]) => msg_id), relayed_ids);
    assert.deepEqual(delivered().map(([, msg_id]) => msg_id), relayed_ids);
    assert.ok(spoken().every(([agent, , line]) => NAMES.includes(agent) && line.length > 0));
    assert.equal(relay.stats().relayed, 9);
    assert.equal(relay.stats().rejected, 5);
    assertMessageEvents(events);
    relay.stop();
});

test('a third open conversation for one agent is refused, and the 7th message in a minute is refused', async () => {
    const { relay, events, clock } = bareRelay();
    // ---- open conversations: a request or offer that waits for its answer ----
    const one = relay.send({ from: 'Arthur', to: 'Felix', type: 'request', body: { item: 'oak_log', count: 8 } });
    const two = relay.send({ from: 'Arthur', to: 'Mira', type: 'request', body: { item: 'bread', count: 2 } });
    assert.deepEqual([one.ok, two.ok, relay.openConversations('Arthur')], [true, true, 2]);
    const three = relay.send({ from: 'Arthur', to: 'Nova', type: 'request', body: { item: 'torch', count: 4 } });
    assert.deepEqual([three.ok, three.reason], [false, 'too_many_conversations']);
    // the same holds for the one a message is for
    const to_busy = relay.send({ from: 'Nova', to: 'Arthur', type: 'offer', body: { item: 'torch', count: 4 } });
    assert.deepEqual([to_busy.ok, to_busy.reason], [false, 'recipient_busy']);
    // a message that expects no answer opens nothing
    assert.equal(relay.send({ from: 'Arthur', to: 'Nova', type: 'inform', body: { text: 'the kit chest is low' } }).ok, true);
    // an answer closes one, and then there is room again
    assert.equal(relay.send({ from: 'Felix', to: 'Arthur', type: 'accept', body: { item: 'oak_log', count: 8 }, conv: one.message.conv }).ok, true);
    assert.equal(relay.openConversations('Arthur'), 1);
    assert.equal(relay.send({ from: 'Arthur', to: 'Nova', type: 'request', body: { item: 'torch', count: 4 } }).ok, true);
    // only the one who was asked can answer, and only once
    assert.equal(relay.send({ from: 'Arthur', to: 'Mira', type: 'accept', body: {}, conv: two.message.conv }).reason, 'nothing_to_answer');
    assert.equal(relay.send({ from: 'Felix', to: 'Arthur', type: 'decline', body: {}, conv: one.message.conv }).reason, 'nothing_to_answer');
    assert.equal(relay.send({ from: 'Nova', to: 'Mira', type: 'inform', body: { text: 'hello' }, conv: two.message.conv }).reason, 'not_in_conversation');
    assert.equal(relay.send({ from: 'Nova', to: 'Mira', type: 'inform', body: { text: 'hello' }, conv: 'c-9999' }).reason, 'unknown_conversation');
    assert.equal(relay.send({ from: 'Nova', to: 'Steve', type: 'inform', body: { text: 'hello' } }).reason, 'unknown_recipient');
    assert.equal(relay.send({ from: 'Nova', to: 'Mira', type: 'chat', body: { text: 'hello' } }).reason, 'invalid_message');
    assert.equal(relay.send({ from: 'Nova', to: 'Mira', type: 'inform', body: 'hello, how are you today?' }).reason, 'invalid_message');

    // ---- 6 messages per agent per minute ----
    await clock.advance(5 * MINUTE);
    const results = [];
    for (let i = 1; i <= 7; i++) {
        results.push(relay.send({ from: 'Mira', to: ['Arthur', 'Felix', 'Nova'][i % 3], type: 'inform', body: { text: `the field has ${i} rows ready` } }));
        await clock.advance(5 * SECOND);
    }
    assert.deepEqual(results.map((result) => result.ok), [true, true, true, true, true, true, false]);
    assert.equal(results[6].reason, 'rate_limit');
    // another agent is not held back by it, and a minute after her first message Mira may speak again
    assert.equal(relay.send({ from: 'Felix', to: 'Mira', type: 'inform', body: { text: 'noted' } }).ok, true);
    await clock.advance(30 * SECOND);
    assert.equal(relay.send({ from: 'Mira', to: 'Arthur', type: 'inform', body: { text: 'the field has 8 rows ready' } }).ok, true);
    await relay.idle();
    assertMessageEvents(events);
    relay.stop();
});

test('a request that nobody answers expires at 120 seconds; an answered one does not', async () => {
    const { relay, events, handed, clock } = bareRelay();
    const asked = relay.send({ from: 'Arthur', to: 'Felix', type: 'request', body: { item: 'oak_log', count: 24 } });
    const offered = relay.send({ from: 'Mira', to: 'Nova', type: 'offer', body: { item: 'bread', count: 6 } });
    await clock.advance(60 * SECOND);
    assert.equal(relay.send({ from: 'Nova', to: 'Mira', type: 'accept', body: { item: 'bread', count: 6 }, conv: offered.message.conv }).ok, true);
    await clock.advance(59 * SECOND);
    assert.equal(relay.conversation(asked.message.conv).open, true);
    assert.equal(events.filter((event) => event.data.state === 'expired').length, 0);
    await clock.advance(1 * SECOND);
    const expired = events.filter((event) => event.data.state === 'expired');
    assert.deepEqual(expired.map((event) => [event.data.msg_id, event.data.type, event.data.from, event.data.to]), [[asked.message.msg_id, 'request', 'Arthur', 'Felix']]);
    assert.equal(relay.conversation(asked.message.conv).open, false);
    // both ends are told; the answer comes too late now
    const told = handed.filter((entry) => entry.event === 'genesis-msg-state' && entry.payload.state === 'expired').map((entry) => entry.agent);
    assert.deepEqual(told, ['Arthur', 'Felix']);
    assert.equal(relay.send({ from: 'Felix', to: 'Arthur', type: 'accept', body: { item: 'oak_log', count: 24 }, conv: asked.message.conv }).reason, 'nothing_to_answer');
    await clock.advance(10 * MINUTE);
    assert.equal(events.filter((event) => event.data.state === 'expired').length, 1);
    assert.deepEqual(events.filter((event) => event.data.state === 'accepted').map((event) => event.data.msg_id), [offered.message.msg_id]);
    assertMessageEvents(events);
    relay.stop();
});

test('lines: the template says what the message says, and a line that changes the item or the count, or looks like a command, is refused', () => {
    const request = { from: 'Arthur', to: 'Felix', type: 'request', body: { item: 'oak_log', count: 24, reason: 'the hall walls' } };
    assert.equal(templateLine(request), 'Felix, I need 24 oak logs for the hall walls.');
    const lines = {
        offer: 'Felix, I can give you 24 oak logs.', accept: 'Felix, yes, 24 oak logs are yours.', decline: 'Felix, sorry, I cannot spare 24 oak logs.',
        inform: 'Felix, 24 oak logs are in the shared chest for you.',
    };
    for (const [type, line] of Object.entries(lines)) assert.equal(templateLine({ ...request, type }), line);
    assert.equal(templateLine({ from: 'Nova', to: 'Mira', type: 'warn', body: { text: 'a creeper is by the field' } }), 'Mira, careful: a creeper is by the field.');
    assert.equal(templateLine({ from: 'Nova', to: 'Mira', type: 'request', body: { item: 'bread', count: 1 } }), 'Mira, I need 1 bread.');
    assert.equal(templateLine({ from: 'Nova', to: 'Mira', type: 'request', body: { item: 'torch', count: 8, reason: 'Restock the kit chest' } }), 'Mira, I need 8 torches (Restock the kit chest).');
    assert.equal(templateLine({ from: 'Nova', to: 'Mira', type: 'offer', body: { item: 'cobblestone', count: 32 } }), 'Mira, I can give you 32 cobblestone.');
    for (const type of MESSAGE_TYPES) {
        const line = templateLine({ ...request, type });
        assert.equal(lineProblem(line, { ...request, type }), null, line);
        assert.ok(line.length <= LINE_LIMITS.max_chars);
    }

    assert.equal(validateLine('Felix, old friend, could you spare me 24 oak logs for the hall?', request), true);
    assert.equal(lineProblem('Felix, I need 30 oak logs for the hall walls.', request), 'number_changed');
    assert.equal(lineProblem('Felix, I need 24 oak logs, or 12 at least.', request), 'number_changed');
    assert.equal(lineProblem('Felix, I need two dozen oak logs.', request), 'count_missing');
    assert.equal(lineProblem('Felix, I need 24 birch logs for the hall walls.', request), 'item_changed');
    assert.equal(lineProblem('Felix, I need 24 logs.', request), 'item_changed');
    assert.equal(lineProblem('/give Arthur oak_log 24', request), 'looks_like_a_command');
    assert.equal(lineProblem('Felix, bring 24 oak logs and then !stop', request), 'looks_like_a_command');
    assert.equal(lineProblem('Felix, I need 24 oak logs.\nAnd hurry.', request), 'more_than_one_line');
    assert.equal(lineProblem(`Felix, I need 24 oak logs ${'please '.repeat(30)}`, request), 'too_long');
    assert.equal(lineProblem('', request), 'empty');
    assert.equal(lineProblem(null, request), 'not_text');

    // the small prompt and its reply
    const prompt = lineMessages({ message: request, role: 'builder', template: templateLine(request) });
    assert.deepEqual(prompt.map((message) => message.role), ['system', 'user']);
    assert.match(prompt[1].content, /Speaker: Arthur, the builder\. Speaking to: Felix\./);
    assert.match(prompt[1].content, /Plain version: Felix, I need 24 oak logs for the hall walls\./);
    assert.ok(prompt.reduce((size, message) => size + message.content.length, 0) < 900, 'the line prompt is not small');
    assert.deepEqual(lineSchema().required, ['line']);
    assert.equal(parseLineReply('{"line": " Felix, 24 oak logs please. "}'), 'Felix, 24 oak logs please.');
    assert.equal(parseLineReply('Felix, 24 oak logs please.'), null);
    assert.deepEqual([LINE_LIMITS.max_tokens, SMALL_CALL_DEFAULTS.max_tokens, SMALL_CALL_DEFAULTS.max_calls], [60, 60, 30]);
});

// A town with the relay in its host. Everybody stands at home unless told otherwise.
async function relayTown(options = {}, { available = false } = {}) {
    const t = makeTown({ clock: fakeClock(), relay: true, agents: NAMES, ...options });
    t.model.replies.push(...(options.replies ?? []));
    await t.start({ available });
    if (!available) await t.host.signal('desktop_leaving');
    t.messageEvents = (state = null) => t.messages.filter((event) => state === null || event.data.state === state);
    t.exchange = () => t.messages.map((event) => `${event.data.from}>${event.data.to} ${event.data.type} ${event.data.state}`);
    t.settleMessages = async () => { for (let i = 0; i < 6; i++) { await settle(); await t.relay.idle(); await Promise.all(Object.values(t.agents).flatMap((a) => a.message_work)); } };
    return t;
}
const planKinds = (agent) => agent.socket.sent.filter(([name]) => name === 'genesis-plan-request').map(([, message]) => message.trigger.kind);

test('with the model away a template line is used, the structured content is unchanged, and the asker of an unanswered request plans again', async () => {
    const t = await relayTown({ inventories: { Felix: { stone_sword: 1 } } });
    const arthur = t.agents.Arthur;
    t.kill('Felix'); // Felix's process is gone: nobody will answer
    const body = { item: 'oak_log', count: 24, reason: 'the hall walls' };
    const sent = await arthur.runtime.messages().request('Felix', body);
    assert.equal(sent.ok, true);
    await t.settleMessages();
    assert.deepEqual(t.exchange(), ['Arthur>Felix request pending']);
    const event = t.messages[0];
    assert.deepEqual([event.data.chat_line, event.data.line_source], ['Felix, I need 24 oak logs for the hall walls.', 'template']);
    assert.deepEqual(event.data.body, body);
    assert.deepEqual(arthur.said, ['Felix, I need 24 oak logs for the hall walls.']);
    assert.equal(t.model.line_requests.length, 0, 'the model was asked for a line while it is away');

    // nobody answers: at 120 seconds the request expires, and Arthur plans again
    await t.clock.advance(119 * SECOND);
    assert.deepEqual(planKinds(arthur).filter((kind) => kind.startsWith('request_')), []);
    await t.clock.advance(2 * SECOND);
    await t.settleMessages();
    assert.deepEqual(t.exchange(), ['Arthur>Felix request pending', 'Arthur>Felix request expired']);
    assert.deepEqual(planKinds(arthur).filter((kind) => kind.startsWith('request_')), ['request_expired']);
    assert.deepEqual(t.broker.pending().find((request) => request.agent === 'Arthur').trigger, { kind: 'request_expired', detail: { to: 'Felix', item: 'oak_log', count: 24, msg_id: sent.message.msg_id } });
    assert.equal(arthur.runtime.messages().stats().waiting, 0);
    assert.equal(t.model.requests.length, 0);
    assertMessageEvents(t.messages);
    await t.stop();
});

test('with the model there it writes one line per message through the broker; a line that alters the item or count is discarded for the template', async () => {
    const t = await relayTown({ agents: ['Arthur', 'Felix'], inventories: { Felix: { stone_sword: 1 } }, host: { broker: { small: { max_calls: 4 } } } }, { available: true });
    await t.clock.advance(5 * SECOND);
    const arthur = t.agents.Arthur;
    const planning_calls = t.model.requests.length;
    const records_before = t.calls.length;
    const body = { item: 'oak_log', count: 24, reason: 'the hall walls' };
    const ask = async (line) => {
        t.model.lines.push(line);
        const before = t.messages.length;
        const sent = await arthur.runtime.messages().inform('Felix', body);
        assert.equal(sent.ok, true, sent.reason);
        await t.settleMessages();
        await t.clock.advance(61 * SECOND); // a new minute for the rate limit; nothing else moves
        return t.messages.slice(before).find((event) => event.data.msg_id === sent.message.msg_id);
    };

    // the model's own words, saying the same thing: spoken as written
    const fine = await ask('Felix, you old fox, 24 oak logs sit in the shared chest for you.');
    assert.deepEqual([fine.data.chat_line, fine.data.line_source], ['Felix, you old fox, 24 oak logs sit in the shared chest for you.', 'model']);
    assert.deepEqual(fine.data.body, body);
    assert.equal(arthur.said.at(-1), fine.data.chat_line);
    // the count altered: the template
    body.reason = 'the hall roof';
    const more = await ask('Felix, 30 oak logs sit in the shared chest for you.');
    assert.deepEqual([more.data.chat_line, more.data.line_source], ['Felix, 24 oak logs are in the shared chest for you.', 'template']);
    assert.deepEqual(more.data.body, body, 'the line changed the structured content');
    assert.equal(arthur.said.at(-1), 'Felix, 24 oak logs are in the shared chest for you.');
    // the item altered: the template
    body.reason = 'the hall door';
    const other = await ask('Felix, 24 birch logs sit in the shared chest for you.');
    assert.deepEqual([other.data.line_source, other.data.body.item, other.data.body.count], ['template', 'oak_log', 24]);
    // a command: the template
    body.reason = 'the hall floor';
    const command = await ask('/give Felix oak_log 24');
    assert.equal(command.data.line_source, 'template');
    assert.ok(!arthur.said.some((line) => line.startsWith('/')));

    // one small call per message, each recorded as its own kind of call, none of them a planning call
    assert.equal(t.model.line_requests.length, 4);
    assert.equal(t.model.requests.length, planning_calls, 'a line was written with a planning call');
    const records = t.calls.slice(records_before);
    assert.deepEqual(records.map((record) => [record.trigger.kind, record.agent, record.outcome, record.valid]), [
        ['chat_line', 'Arthur', 'ok', true], ['chat_line', 'Arthur', 'invalid', false], ['chat_line', 'Arthur', 'invalid', false], ['chat_line', 'Arthur', 'invalid', false],
    ]);
    assert.ok(t.model.line_requests.every((request) => request.max_tokens === LINE_LIMITS.max_tokens && request.timeout_ms === LINE_LIMITS.timeout_ms));
    assert.equal(t.broker.budget.usage('Arthur', t.clock.now()).used <= planning_calls, true, 'lines were counted against the planning budget');

    // the line budget of an agent is spent (4 an hour here): the template, and the model is not asked
    body.reason = 'the hall beams';
    const spent = await ask('Felix, 24 oak logs, as promised, in the shared chest.');
    assert.deepEqual([spent.data.line_source, spent.data.chat_line], ['template', 'Felix, 24 oak logs are in the shared chest for you.']);
    assert.equal(t.model.line_requests.length, 4);
    assert.equal(t.broker.stats().small_refused, 1);
    assertMessageEvents(t.messages);
    await t.stop();
});

test('a contested claim: request then accept and the reservation moves; request then decline, or no answer, and it stays', async () => {
    const t = await relayTown({ agents: ['Arthur', 'Mira', 'Nova'] });
    const { Arthur: arthur, Mira: mira, Nova: nova } = t.agents;
    const step = async (a, times) => { const done = []; for (let i = 0; i < times; i++) done.push((await a.runtime.executor.runOnce()).kind); return done; };
    const reserved = () => t.host.ledger.reservations().map((held) => [held.holder, held.item, held.count]).sort();
    const want = async (a, option_id, title) => {
        const set = await a.runtime.goals.setShortTerm(a.agent, [{ title, option_id }], { reason: 'seeded', source: 'operator' });
        a.runtime.executor.noteGoals(set.goals.short_term, { source: 'operator' });
    };
    t.world.get(2, 64, 2).contents = { bread: 8, torch: 6 };
    await want(nova, 'travel:chest-shared', 'Count the shared chest');
    assert.deepEqual(await step(nova, 4), ['goal_started', 'step_done', 'step_done', 'goal_completed']);

    // ---- decline: Mira is on her way to the bread she reserved ----
    await want(mira, 'fetch_items:shared:bread:8', 'Fetch bread for the field hands');
    assert.deepEqual(await step(mira, 2), ['goal_started', 'step_done']);
    assert.deepEqual(reserved(), [['Mira', 'bread', 8]]);
    await want(arthur, 'fetch_items:shared:bread:4', 'Fetch bread for the long night');
    assert.deepEqual(await step(arthur, 1), ['goal_dropped']);
    await t.settleMessages();
    assert.deepEqual(t.exchange(), ['Arthur>Mira request pending', 'Mira>Arthur decline delivered', 'Arthur>Mira request declined']);
    // the request carries the item, the count and Arthur's goal as the reason
    assert.deepEqual(t.messages[0].data.body, { item: 'bread', count: 4, chest: 'shared', claim: true, reason: 'Fetch bread for the long night' });
    assert.equal(t.messages[0].data.chat_line, 'Mira, I need 4 bread from the shared chest (Fetch bread for the long night).');
    assert.deepEqual([t.messages[1].data.body.decided_by, t.messages[1].data.body.why], ['routine', 'in_use']);
    assert.deepEqual(reserved(), [['Mira', 'bread', 8]], 'a declined claim moved the reservation');
    assert.deepEqual(planKinds(arthur).filter((kind) => kind.startsWith('request_')), ['request_declined']);
    assert.deepEqual([arthur.said.length, mira.said.length], [1, 1]);
    assert.deepEqual(await step(mira, 2), ['step_done', 'goal_completed']);
    assert.deepEqual(reserved(), []);

    // ---- accept: Nova holds torches she is not fetching (a claim left over) ----
    nova.ledger.reserve('shared', 'torch', 6);
    await settle();
    assert.deepEqual(reserved(), [['Nova', 'torch', 6]]);
    const before = t.messages.length;
    await want(arthur, 'fetch_items:shared:torch:4', 'Fetch torches for the mine');
    assert.deepEqual(await step(arthur, 1), ['goal_dropped']);
    await t.settleMessages();
    assert.deepEqual(t.exchange().slice(before), ['Arthur>Nova request pending', 'Nova>Arthur accept delivered', 'Arthur>Nova request accepted']);
    assert.deepEqual(t.messages[before].data.body, { item: 'torch', count: 4, chest: 'shared', claim: true, reason: 'Fetch torches for the mine' });
    assert.equal(t.messages[before + 1].data.body.decided_by, 'routine');
    // the reservation moved: 4 of Nova's 6 are Arthur's now, in the one ledger and in every agent's copy
    assert.deepEqual(reserved(), [['Arthur', 'torch', 4], ['Nova', 'torch', 2]]);
    assert.equal(arthur.ledger.available('shared', 'torch'), 4);
    assert.equal(mira.ledger.available('shared', 'torch'), 0);
    // and Arthur's next try gets them
    await want(arthur, 'fetch_items:shared:torch:4', 'Fetch torches for the mine');
    assert.deepEqual(await step(arthur, 4), ['goal_started', 'step_done', 'step_done', 'goal_completed']);
    assert.equal(t.world.body('Arthur').inventory.torch, 4);

    // ---- no answer: the holder's process is gone; the claim expires and the reservation stays where it was ----
    await t.clock.advance(11 * MINUTE); // (reservations last 10 minutes: only a fresh one is looked at)
    mira.ledger.reserve('shared', 'torch', 2);
    await settle();
    t.kill('Mira');
    await settle();
    // (a process that is gone holds nothing: its reservations are freed, so the claim is made against one that stays)
    t.host.ledger.reserve('Mira', { chest: 'shared', item: 'torch', count: 2 });
    t.host.ledgerUpdated();
    const again = t.messages.length;
    await want(arthur, 'fetch_items:shared:torch:2', 'Fetch more torches');
    assert.deepEqual(await step(arthur, 1), ['goal_dropped']);
    await t.settleMessages();
    await t.clock.advance(121 * SECOND);
    await t.settleMessages();
    assert.deepEqual(t.exchange().slice(again), ['Arthur>Mira request pending', 'Arthur>Mira request expired']);
    assert.deepEqual(reserved(), [['Mira', 'torch', 2]]);

    // the whole exchange is there as agent.message events, each one valid
    assert.equal(t.messageEvents('rejected').length, 0);
    assertMessageEvents(t.messages);
    await t.stop();
});

test('receiving a request with the model away: a code rule accepts what is held beyond the reserve (source routine), and the items are handed over directly', async () => {
    const t = await relayTown({ agents: ['Arthur', 'Felix'], inventories: { Felix: { oak_log: 10, stone_sword: 1, bread: 5 } } });
    t.world.durations = () => 1 * SECOND;
    const { Arthur: arthur, Felix: felix } = t.agents;
    // Felix keeps his sword, and bread up to his reserve: declined at once, by code
    const sword = await arthur.runtime.messages().request('Felix', { item: 'stone_sword', count: 1 });
    await t.settleMessages();
    const bread = await arthur.runtime.messages().request('Felix', { item: 'bread', count: 3 });
    await t.settleMessages();
    assert.deepEqual(t.messages.filter((event) => event.data.type === 'decline').map((event) => [event.data.body.item, event.data.body.decided_by, event.data.body.why]),
        [['stone_sword', 'routine', 'not_spare'], ['bread', 'routine', 'not_spare']]);
    assert.ok(sword.ok && bread.ok);

    // logs he can spare: accepted by the code rule, a commitment queued with source "routine"
    const asked = await arthur.runtime.messages().request('Felix', { item: 'oak_log', count: 4, reason: 'the hall walls' });
    await t.settleMessages();
    const accept = t.messages.find((event) => event.data.type === 'accept');
    assert.deepEqual(accept.data.body, { item: 'oak_log', count: 4, decided_by: 'routine' });
    assert.equal(accept.data.conv, asked.message.conv);
    const queued = felix.changes().find((change) => change.after.some((goal) => goal.option_id === 'give_items:Arthur:oak_log:4'));
    assert.equal(queued.source, 'routine');
    assert.match(queued.reason, /Arthur asked for 4 oak_log .*accepted by the code rule/);
    assert.equal(t.model.requests.length, 0);

    // the executor carries it out through the catalog: the two stand near each other, so it is handed over
    for (let i = 0; i < 3; i++) { const run = felix.runtime.executor.runOnce(); await t.clock.advance(2 * SECOND); await run; }
    await t.settleMessages();
    assert.deepEqual(t.world.calls.filter((call) => call.agent === 'Felix' && call.command === 'giveToPlayer').map((call) => call.args), [['oak_log', 'Arthur', 4]]);
    assert.equal(t.world.body('Arthur').inventory.oak_log, 4);
    assert.equal(t.world.body('Felix').inventory.oak_log, 6);
    const decision = felix.eventsOf('agent.decision').find((event) => event.data.args[0] === 'give_items:Arthur:oak_log:4');
    assert.deepEqual([decision.data.trigger, decision.data.steps], ['routine', ['giveToPlayer']]);
    // the conversation, start to end: request, accept, and the word that the items are there
    const conv = t.messages.filter((event) => event.data.conv === asked.message.conv).map((event) => `${event.data.from}>${event.data.to} ${event.data.type} ${event.data.state}`);
    assert.deepEqual(conv, ['Arthur>Felix request pending', 'Felix>Arthur accept delivered', 'Arthur>Felix request accepted', 'Felix>Arthur inform delivered']);
    assert.deepEqual(t.messages.at(-1).data.body, { item: 'oak_log', count: 4, handoff: 'direct', re: asked.message.msg_id });
    assert.equal(felix.said.at(-1), 'Arthur, here are 4 oak logs.');
    assert.equal(felix.runtime.messages().stats().duties, 0);
    assertMessageEvents(t.messages);
    await t.stop();
});

test('hand-over through the shared chest when the two are far apart: stored, reserved for the asker, fetched', async () => {
    const t = await relayTown({ agents: ['Arthur', 'Felix'], inventories: { Felix: { oak_log: 10 } }, positions: { Felix: { x: 60, y: 64, z: 0 } } });
    t.world.durations = () => 1 * SECOND;
    const { Arthur: arthur, Felix: felix } = t.agents;
    arthur.runtime.routine.modelReturned(); // (keeps the routines quiet: only the commitment is looked at)
    await arthur.runtime.hold({ by: 'test' });
    await arthur.runtime.resume({ by: 'test' });
    const asked = await arthur.runtime.messages().request('Felix', { item: 'oak_log', count: 4 });
    await t.settleMessages();
    const give = await felix.runtime.executor.runOnce();
    assert.equal(give.kind, 'goal_started');
    const plan = felix.runtime.executor.plan();
    assert.deepEqual([plan.goal.option_id, plan.steps.map((step) => step.command)], ['give_items:Arthur:oak_log:4', ['goToPosition', 'putInChest']]);
    for (let i = 0; i < 3; i++) { const run = felix.runtime.executor.runOnce(); await t.clock.advance(2 * SECOND); await run; }
    await t.settleMessages();
    assert.equal(t.world.get(2, 64, 2).contents.oak_log, 4);
    assert.equal(t.world.body('Felix').inventory.oak_log, 6);
    // told, and the stock is reserved for Arthur in the one ledger
    const inform = t.messages.find((event) => event.data.type === 'inform');
    assert.deepEqual(inform.data.body, { item: 'oak_log', count: 4, handoff: 'chest', chest: 'shared', re: asked.message.msg_id });
    assert.equal(inform.data.chat_line, 'Arthur, 4 oak logs are in the shared chest for you.');
    assert.deepEqual(t.host.ledger.reservations().map((held) => [held.holder, held.item, held.count]), [['Arthur', 'oak_log', 4]]);
    // Arthur's side: a goal to fetch them, queued by code
    const queue = await arthur.queue();
    assert.deepEqual(queue.map((goal) => goal.option_id), ['fetch_items:shared:oak_log:4']);
    assert.equal(arthur.changes().at(-1).source, 'routine');
    for (let i = 0; i < 4; i++) { const run = arthur.runtime.executor.runOnce(); await t.clock.advance(2 * SECOND); await run; }
    assert.equal(t.world.body('Arthur').inventory.oak_log, 4);
    assert.deepEqual(t.host.ledger.reservations(), []);
    assertMessageEvents(t.messages);
    await t.stop();
});

// ---- incoming requests and offers: the model decides, the code rule when it cannot (decided) ----

const stateOf = (agent, name) => agent.eventsOf('agent.state').filter((event) => event.data.state === name).map((event) => event.data.detail);
const decisionCalls = (t) => t.calls.filter((call) => call.trigger?.kind === 'message_decision');
const promptOf = (request) => request.messages.map((message) => message.content).join('\n');

test('the decision call: accept or decline with a reason of at most 140 characters, and nothing else', () => {
    assert.deepEqual([...DECISIONS], ['accept', 'decline']);
    assert.equal(DECISION_REASON_MAX, 140);
    // its own named, configurable hourly limit and token limit (proposed starting values)
    assert.deepEqual({ ...DECISION_LIMITS }, { max_calls_per_hour: 20, max_tokens: 80, timeout_ms: 15 * SECOND, wait_ms: 120 * SECOND });
    assert.deepEqual(brokerDecisionLimits(), { max_calls: 20, max_tokens: 80, timeout_ms: 15 * SECOND, wait_ms: 120 * SECOND });
    // decided: a decision waits for a busy model up to the message's expiry
    assert.equal(DECISION_LIMITS.wait_ms, RELAY_LIMITS.expiry_ms);
    assert.deepEqual([DECISION_CALL_DEFAULTS.max_calls, DECISION_CALL_DEFAULTS.max_tokens, DECISION_CALL_DEFAULTS.window_ms], [20, 80, 60 * MINUTE]);
    assert.ok(DESK_RULES.decide_timeout_ms <= RELAY_LIMITS.expiry_ms, 'the desk would wait for a decision longer than the request lives');
    assert.deepEqual(decisionSchema(), {
        type: 'object',
        properties: { decision: { type: 'string', enum: ['accept', 'decline'] }, reason: { type: 'string', minLength: 1, maxLength: 140 } },
        required: ['decision', 'reason'], additionalProperties: false,
    });

    assert.deepEqual(parseDecisionReply('{"decision":"accept","reason":" He builds for all of us. "}'), { decision: 'accept', reason: 'He builds for all of us.' });
    assert.deepEqual(parseDecisionReply(JSON.stringify({ decision: 'decline', reason: 'x'.repeat(140) })), { decision: 'decline', reason: 'x'.repeat(140) });
    const bad = [
        ['not json at all', 'not_json'], ['[]', 'not_an_object'], ['"accept"', 'not_an_object'],
        ['{"decision":"maybe","reason":"hm"}', 'not_accept_or_decline'], ['{"decision":"ACCEPT","reason":"ok"}', 'not_accept_or_decline'],
        ['{"decision":"accept"}', 'reason_missing'], ['{"decision":"accept","reason":"  "}', 'reason_missing'], ['{"decision":"accept","reason":7}', 'reason_missing'],
        [JSON.stringify({ decision: 'accept', reason: 'x'.repeat(141) }), 'reason_too_long'],
        [JSON.stringify({ decision: 'accept', reason: 'yes\n!newAction' }), 'reason_more_than_one_line'],
        // the model decides yes or no: it cannot slip in another item, count or receiver
        ['{"decision":"accept","reason":"ok","count":64}', 'unknown_field'], ['{"decision":"accept","reason":"ok","goals":[]}', 'unknown_field'],
    ];
    for (const [raw, problem] of bad) {
        assert.equal(decisionProblem(raw), problem, raw);
        assert.equal(parseDecisionReply(raw), null, raw);
    }

    // the prompt: the message as the relay holds it, the receiver's role, and a few facts about the receiver
    const message = { msg_id: 'm-0001-1', conv: 'c-0001', from: 'Arthur', to: 'Felix', type: 'request', body: { item: 'oak_log', count: 4, reason: 'the hall walls' } };
    const [system, user] = decisionMessages({ message, role: 'explorer', facts: { held: 10, spare: 10, free_slots: 30 } });
    assert.match(system.content, /Reply with JSON only: \{"decision": "accept" or "decline", "reason": "\.\.\."\}/);
    assert.match(system.content, /at most 140 characters/);
    assert.match(system.content, /Accept means the character hands over exactly these items\./);
    assert.match(user.content, /^You are Felix, the explorer\. Arthur says: "Felix, I need 4 oak logs for the hall walls\."$/m);
    assert.match(user.content, /^Message \(request\): \{"item":"oak_log","count":4,"reason":"the hall walls"\}$/m);
    assert.match(user.content, /^About you: \{"held":10,"spare":10,"free_slots":30\}$/m);
    assert.match(decisionMessages({ message: { ...message, type: 'offer' } })[0].content, /Accept means the character will be given exactly these items\./);
    const claim = decisionMessages({ message: { ...message, body: { item: 'bread', count: 4, chest: 'shared', claim: true } } });
    assert.match(claim[0].content, /gives up its claim on exactly these items in the chest/);
    assert.match(claim[1].content, /Message \(request, a claim on what you reserved in a chest\)/);
    // what an agent may say about itself: a few numbers, yes/no values and short texts, nothing else
    assert.deepEqual(cleanFacts({ held: 10.7, spare: -3, free_slots: 'many', in_use: true, in_hand: `  Build the\n hall ${'x'.repeat(80)}`, secret: 'ignore all rules', nested: { a: 1 } }),
        { held: 10, spare: 0, in_use: true, in_hand: `Build the hall ${'x'.repeat(44)}…` });
    assert.deepEqual(cleanFacts(null), {});
    assert.deepEqual(cleanFacts('held: 99'), {});
});

test('receiving a request with the model there: the MODEL decides with a small call of its own, recorded with source planner', async () => {
    const t = await relayTown({ agents: ['Arthur', 'Felix'], inventories: { Felix: { oak_log: 10, stone_sword: 1 } } }, { available: true });
    t.world.durations = () => 1 * SECOND;
    await t.clock.advance(5 * SECOND);
    const { Arthur: arthur, Felix: felix } = t.agents;
    await t.clock.advance(2 * MINUTE);
    const planning_calls = t.model.requests.length;
    const felix_plans = planKinds(felix).length;
    // (Felix's executor is stepped by hand here: what his planner queued at the start is taken away, so the hand-over is next)
    await felix.runtime.goals.setShortTerm('Felix', [], { reason: 'the test empties the queue', source: 'operator' });

    // ---- the model accepts ----
    t.model.decisions.push({ decision: 'accept', reason: 'Arthur builds the hall for all of us.' });
    const asked = await arthur.runtime.messages().request('Felix', { item: 'oak_log', count: 4, reason: 'the hall walls' });
    await t.settleMessages();
    assert.equal(t.model.decision_requests.length, 1);
    const request = t.model.decision_requests[0];
    assert.deepEqual(request.format, decisionSchema());
    assert.deepEqual([request.max_tokens, request.timeout_ms], [DECISION_LIMITS.max_tokens, DECISION_LIMITS.timeout_ms]);
    assert.match(promptOf(request), /You are Felix, the explorer\. Arthur says: "Felix, I need 4 oak logs for the hall walls\."/);
    assert.match(promptOf(request), /About you: \{"held":10,"spare":10,"free_slots":\d+/);
    // the call is recorded as its own kind, against Felix, and is no planning call and no line
    const [record] = decisionCalls(t);
    assert.deepEqual([record.agent, record.outcome, record.valid, record.trigger.detail.msg_id, record.trigger.detail.type, record.trigger.detail.from],
        ['Felix', 'ok', true, asked.message.msg_id, 'request', 'Arthur']);
    assert.equal(t.model.requests.length, planning_calls, 'the decision was made with a planning call');
    assert.equal(planKinds(felix).length, felix_plans, 'a request of another agent is no planning trigger any more');
    assert.deepEqual(t.broker.decisionBudget.usage('Felix', t.clock.now()), { used: 1, limit: 20 });
    assert.equal(t.broker.decisionBudget.usage('Arthur', t.clock.now()).used, 0);
    // the asker's line was written first: the two small calls of one message never race
    assert.equal(t.messages[0].data.line_source, 'model');
    assert.ok(t.calls.findIndex((call) => call.trigger?.kind === 'chat_line') < t.calls.indexOf(record));

    // the answer: accept, decided by the planner; the model's reason is recorded, and never sent to the other agent
    const accept = t.messages.find((event) => event.data.type === 'accept');
    assert.deepEqual(accept.data.body, { item: 'oak_log', count: 4, decided_by: 'planner' });
    assert.equal(accept.data.conv, asked.message.conv);
    assert.deepEqual(stateOf(felix, 'request_accepted'), [{
        from: 'Arthur', msg_id: asked.message.msg_id, type: 'request', source: 'planner', item: 'oak_log', count: 4, decided_by: 'planner',
        reason: 'Arthur builds the hall for all of us.', call_id: record.call_id,
    }]);
    assert.ok(!JSON.stringify(t.messages).includes('builds the hall for all of us'), 'the model\'s reason travelled in a message');
    // the commitment: a goal queued with source planner and the decision's call id
    const queued = felix.changes().find((change) => change.after.some((goal) => goal.option_id === 'give_items:Arthur:oak_log:4'));
    assert.deepEqual([queued.source, queued.call_id], ['planner', record.call_id]);
    assert.match(queued.reason, /Arthur asked for 4 oak_log \(m-\d+-1\): accepted by the model: Arthur builds the hall for all of us\./);
    // and the executor carries it out
    for (let i = 0; i < 6 && t.world.body('Arthur').inventory.oak_log !== 4; i++) { const run = felix.runtime.executor.runOnce(); await t.clock.advance(2 * SECOND); await run; }
    await t.settleMessages();
    assert.equal(t.world.body('Arthur').inventory.oak_log, 4);
    const carried = felix.eventsOf('agent.decision').find((event) => event.data.args[0] === 'give_items:Arthur:oak_log:4');
    assert.deepEqual([carried.data.trigger, carried.data.call_id], ['planner', record.call_id]);

    // ---- the model declines ----
    await t.clock.advance(61 * SECOND);
    const before = t.messages.length;
    t.model.decisions.push({ decision: 'decline', reason: 'I need these logs for the patrol fires.' });
    const second = await arthur.runtime.messages().request('Felix', { item: 'oak_log', count: 2 });
    await t.settleMessages();
    const decline = t.messages.slice(before).find((event) => event.data.type === 'decline');
    assert.deepEqual(decline.data.body, { item: 'oak_log', count: 2, decided_by: 'planner' });
    assert.deepEqual(stateOf(felix, 'request_declined').map((detail) => [detail.msg_id, detail.source, detail.reason]), [[second.message.msg_id, 'planner', 'I need these logs for the patrol fires.']]);
    assert.ok(!felix.changes().some((change) => change.after.some((goal) => goal.option_id === 'give_items:Arthur:oak_log:2')), 'a declined request left a commitment');
    assert.ok(planKinds(arthur).includes('request_declined'), 'the asker did not plan again');
    assert.equal(felix.runtime.messages().stats().decided_by_model, 2);

    // ---- what cannot be done never reaches the model: declined by code ----
    await t.clock.advance(61 * SECOND);
    const asked_model = t.model.decision_requests.length;
    await arthur.runtime.messages().request('Felix', { item: 'stone_sword', count: 1 });
    await t.settleMessages();
    assert.deepEqual([t.messages.at(-1).data.type, t.messages.at(-1).data.body.item], ['request', 'stone_sword']);
    const refused = t.messages.filter((event) => event.data.type === 'decline').at(-1);
    assert.deepEqual(refused.data.body, { item: 'stone_sword', count: 1, decided_by: 'routine', why: 'not_spare' });
    assert.equal(t.model.decision_requests.length, asked_model, 'the model was asked about a tool the agent keeps');
    assertMessageEvents(t.messages);
    for (const event of felix.events) assert.deepEqual(validateEvent(event).errors, []);
    await t.stop();
});

test('when the reply fails validation, the limit is spent or the model does not answer, the code rule decides and is recorded with source routine', async () => {
    const t = await relayTown({
        agents: ['Arthur', 'Felix'], inventories: { Felix: { oak_log: 40 } },
        relay: { decision: { max_calls_per_hour: 3 } },
    }, { available: true });
    await t.clock.advance(5 * SECOND);
    const { Arthur: arthur, Felix: felix } = t.agents;
    // the limit is the setting's, not the default
    assert.equal(t.broker.smallLimits('message_decision').max_calls, 3);
    assert.equal(t.broker.smallLimits('message_decision').max_tokens, 80);
    let count = 0;
    const ask = async (decision) => {
        if (decision !== undefined) t.model.decisions.push(decision);
        await t.clock.advance(61 * SECOND);
        // (Felix's executor is not run here: his queue is emptied, so that every request finds room for a commitment)
        await felix.runtime.goals.setShortTerm('Felix', [], { reason: 'the test empties the queue', source: 'operator' });
        const sent = await arthur.runtime.messages().request('Felix', { item: 'oak_log', count: ++count });
        assert.equal(sent.ok, true, sent.reason);
        await t.settleMessages();
        const answer = t.messages.filter((event) => ['accept', 'decline'].includes(event.data.type)).at(-1);
        const detail = [...stateOf(felix, 'request_accepted'), ...stateOf(felix, 'request_declined')].find((entry) => entry.msg_id === sent.message.msg_id);
        return { sent, answer, detail };
    };

    // a reply that is not accept or decline: the code rule decides (accept: the logs are held beyond the reserve)
    const invalid = await ask('{"decision":"maybe","reason":"hm"}');
    assert.deepEqual(invalid.answer.data.body, { item: 'oak_log', count: 1, decided_by: 'routine' });
    assert.deepEqual([invalid.detail.source, invalid.detail.rule_because, invalid.detail.reason], ['routine', 'invalid_reply', undefined]);
    assert.deepEqual(decisionCalls(t).map((call) => [call.outcome, call.valid]), [['invalid', false]]);
    const by_rule = felix.changes().find((change) => change.after.some((goal) => goal.option_id === 'give_items:Arthur:oak_log:1'));
    assert.equal(by_rule.source, 'routine');
    assert.match(by_rule.reason, /accepted by the code rule, the items are held beyond the reserve/);
    // a reason of 141 characters fails validation too
    const long = await ask({ decision: 'decline', reason: 'x'.repeat(141) });
    assert.deepEqual([long.answer.data.type, long.detail.source, long.detail.rule_because], ['accept', 'routine', 'invalid_reply']);
    // a valid one is the model's
    const fine = await ask('decline');
    assert.deepEqual([fine.answer.data.type, fine.detail.source, fine.detail.rule_because], ['decline', 'planner', undefined]);
    assert.equal(t.model.decision_requests.length, 3);

    // the agent's decision limit is spent (3 an hour here): the model is not asked, the code rule decides
    const spent = await ask();
    assert.deepEqual([spent.answer.data.type, spent.detail.source, spent.detail.rule_because], ['accept', 'routine', 'budget_exhausted']);
    assert.equal(t.model.decision_requests.length, 3, 'the model was asked beyond the agent\'s decision limit');
    assert.equal(t.broker.stats().decision_refused, 1);
    // the limit is per agent and of its own: Arthur's decisions, the lines and the planning calls are not touched
    assert.equal(t.broker.decisionBudget.usage('Arthur', t.clock.now()).used, 0);
    assert.ok(t.model.line_requests.length >= 4, 'lines were refused because decisions were spent');

    // an hour later Felix may decide again; a model that fails is the code rule's turn as well
    await t.clock.advance(60 * MINUTE);
    const failed = await ask(new Error('the model fell over'));
    assert.deepEqual([failed.answer.data.type, failed.detail.source, failed.detail.rule_because], ['accept', 'routine', 'model_error']);
    assert.deepEqual(felix.runtime.messages().stats().rule_because, { invalid_reply: 2, budget_exhausted: 1, model_error: 1 });
    assert.deepEqual([felix.runtime.messages().stats().decided_by_model, felix.runtime.messages().stats().decided_by_rule], [1, 4]);

    // the model goes away: no call at all, the code rule (as before)
    await t.host.signal('desktop_leaving');
    const asked_model = t.model.decision_requests.length;
    const away = await ask();
    assert.deepEqual([away.answer.data.type, away.detail.source, away.detail.rule_because], ['accept', 'routine', 'model_away']);
    assert.equal(t.model.decision_requests.length, asked_model);
    assertMessageEvents(t.messages);
    await t.stop();
});

test('a request that expires while the model is asked is not answered, and "model_decisions": false leaves every decision to the code rule', async () => {
    const t = await relayTown({ agents: ['Arthur', 'Felix'], inventories: { Felix: { oak_log: 10 } }, relay: { limits: { expiry_ms: 10 * SECOND } } }, { available: true });
    await t.clock.advance(5 * SECOND);
    const { Arthur: arthur, Felix: felix } = t.agents;
    t.model.decision_delay_ms = 14 * SECOND; // slower than the request lives (and inside the call's own 15 seconds)
    const sent = await arthur.runtime.messages().request('Felix', { item: 'oak_log', count: 4 });
    await t.clock.advance(11 * SECOND);
    assert.deepEqual(t.exchange(), ['Arthur>Felix request pending', 'Arthur>Felix request expired']);
    await t.clock.advance(10 * SECOND);
    await t.settleMessages();
    assert.deepEqual(t.exchange(), ['Arthur>Felix request pending', 'Arthur>Felix request expired'], 'an expired request was answered');
    assert.equal(t.messageEvents('rejected').length, 0, 'the late answer was sent and rejected');
    assert.ok(!felix.changes().some((change) => change.after.some((goal) => String(goal.option_id).startsWith('give_items:'))), 'a commitment was made for a request that had expired');
    assert.equal(felix.runtime.messages().stats().deciding, 0);
    assert.equal(sent.ok, true);
    await t.stop();

    const off = await relayTown({ agents: ['Arthur', 'Felix'], inventories: { Felix: { oak_log: 10 } }, relay: { model_decisions: false } }, { available: true });
    await off.clock.advance(5 * SECOND);
    await off.agents.Arthur.runtime.messages().request('Felix', { item: 'oak_log', count: 4 });
    await off.settleMessages();
    assert.equal(off.model.decision_requests.length, 0);
    assert.deepEqual(off.messages.find((event) => event.data.type === 'accept').data.body, { item: 'oak_log', count: 4, decided_by: 'routine' });
    assert.deepEqual(stateOf(off.agents.Felix, 'request_accepted').map((detail) => [detail.source, detail.rule_because]), [['routine', 'model_decisions_off']]);
    await off.stop();
});

test('an offer and a contested claim go the same way: the model decides when it can, code declines what cannot be done', async () => {
    const t = await relayTown({ agents: ['Arthur', 'Felix', 'Nova'], inventories: { Arthur: { oak_planks: 20 } } }, { available: true });
    t.world.durations = () => 1 * SECOND;
    await t.clock.advance(5 * SECOND);
    const { Arthur: arthur, Felix: felix, Nova: nova } = t.agents;
    const reserved = () => t.host.ledger.reservations().map((held) => [held.holder, held.item, held.count]).sort();

    // ---- an offer: the model declines, then accepts ----
    t.model.decisions.push({ decision: 'decline', reason: 'My hands are full with the patrol.' });
    const first = await arthur.runtime.messages().offer('Felix', { item: 'oak_planks', count: 4 });
    await t.settleMessages();
    assert.match(promptOf(t.model.decision_requests[0]), /Arthur says: "Felix, I can give you 4 oak planks\."/);
    assert.match(promptOf(t.model.decision_requests[0]), /Accept means the character will be given exactly these items\./);
    assert.deepEqual(t.messages.find((event) => event.data.type === 'decline').data.body, { item: 'oak_planks', count: 4, decided_by: 'planner' });
    assert.deepEqual(stateOf(felix, 'request_declined').map((detail) => [detail.type, detail.source, detail.reason]), [['offer', 'planner', 'My hands are full with the patrol.']]);
    assert.equal(first.ok, true);
    await t.clock.advance(61 * SECOND);
    const second = await arthur.runtime.messages().offer('Felix', { item: 'oak_planks', count: 6 });
    await t.settleMessages();
    assert.deepEqual(t.messages.find((event) => event.data.type === 'accept').data.body, { item: 'oak_planks', count: 6, decided_by: 'planner' });
    // the offer was accepted: Arthur owes the planks (an offer code made, so the commitment is recorded as the routine's)
    const owed = arthur.changes().find((change) => change.after.some((goal) => goal.option_id === 'give_items:Felix:oak_planks:6'));
    assert.equal(owed.source, 'routine');
    assert.match(owed.reason, new RegExp(`Felix accepted the offer of 6 oak_planks \\(${second.message.msg_id}\\)`));
    // no room to carry it: declined by code, and the model is not asked
    const asked_model = t.model.decision_requests.length;
    for (let i = 0; i < 36; i++) t.world.body('Felix').inventory[`thing_${i}`] = 1;
    await t.clock.advance(61 * SECOND);
    await arthur.runtime.messages().offer('Felix', { item: 'oak_planks', count: 2 });
    await t.settleMessages();
    assert.deepEqual(t.messages.filter((event) => event.data.type === 'decline').at(-1).data.body, { item: 'oak_planks', count: 2, decided_by: 'routine', why: 'no_room' });
    assert.equal(t.model.decision_requests.length, asked_model);

    // ---- a contested claim: Nova holds torches in the shared chest that she is not fetching ----
    t.world.get(2, 64, 2).contents = { torch: 6, bread: 8 };
    nova.ledger.set('shared', { torch: 6, bread: 8 }, t.clock.now());
    nova.ledger.reserve('shared', 'torch', 6);
    await settle();
    assert.deepEqual(reserved(), [['Nova', 'torch', 6]]);
    // the model declines: the reservation stays where it was
    await t.clock.advance(61 * SECOND);
    t.model.decisions.push({ decision: 'decline', reason: 'The kits need these torches tonight.' });
    await arthur.runtime.messages().contested({ chest: 'shared', item: 'torch', count: 4, holder: 'Nova' }, 'Fetch torches for the mine');
    await t.settleMessages();
    const claim_prompt = promptOf(t.model.decision_requests.at(-1));
    assert.match(claim_prompt, /You are Nova, the merchant\. Arthur says: "Nova, I need 4 torches from the shared chest \(Fetch torches for the mine\)\."/);
    assert.match(claim_prompt, /a claim on what you reserved in a chest/);
    assert.match(claim_prompt, /"in_use":false/);
    assert.deepEqual(t.messages.at(-2).data.body, { item: 'torch', count: 4, decided_by: 'planner', claim: true, chest: 'shared' });
    assert.equal(t.messages.at(-2).data.type, 'decline');
    assert.deepEqual(reserved(), [['Nova', 'torch', 6]], 'a declined claim moved the reservation');
    assert.deepEqual(stateOf(nova, 'request_declined').map((detail) => [detail.claim, detail.source, detail.reason]), [[true, 'planner', 'The kits need these torches tonight.']]);
    // the model accepts: the reservation moves, as it does when the code rule accepts
    await t.clock.advance(61 * SECOND);
    await arthur.runtime.messages().contested({ chest: 'shared', item: 'torch', count: 3, holder: 'Nova' }, 'Fetch torches for the mine');
    await t.settleMessages();
    assert.deepEqual(t.messages.filter((event) => event.data.type === 'accept').at(-1).data.body, { item: 'torch', count: 3, decided_by: 'planner', claim: true, chest: 'shared' });
    assert.deepEqual(reserved(), [['Arthur', 'torch', 3], ['Nova', 'torch', 3]]);
    assert.ok(decisionCalls(t).filter((call) => call.agent === 'Nova').every((call) => call.trigger.detail.claim === true));

    // Nova is on her way to the bread she reserved: declined by code, whatever the model would say
    const set = await nova.runtime.goals.setShortTerm('Nova', [{ title: 'Fetch bread for the kits', option_id: 'fetch_items:shared:bread:8' }], { reason: 'seeded', source: 'operator' });
    nova.runtime.executor.noteGoals(set.goals.short_term, { source: 'operator' });
    assert.equal((await nova.runtime.executor.runOnce()).kind, 'goal_started');
    { const run = nova.runtime.executor.runOnce(); await t.clock.advance(2 * SECOND); await run; } // she sets out, and reserves
    assert.ok(reserved().some(([holder, item]) => holder === 'Nova' && item === 'bread'));
    const model_before = t.model.decision_requests.length;
    await t.clock.advance(61 * SECOND);
    await arthur.runtime.messages().contested({ chest: 'shared', item: 'bread', count: 4, holder: 'Nova' }, 'Fetch bread for the long night');
    await t.settleMessages();
    assert.deepEqual(t.messages.filter((event) => event.data.type === 'decline').at(-1).data.body, { item: 'bread', count: 4, decided_by: 'routine', claim: true, chest: 'shared', why: 'in_use' });
    assert.equal(t.model.decision_requests.length, model_before, 'the model was asked about stock the agent is on its way to');
    assertMessageEvents(t.messages);
    await t.stop();
});

test('a new plan arriving mid-goal replaces the goals still waiting, but not what the agent agreed with another agent', async () => {
    const t = await relayTown({ agents: ['Arthur', 'Felix'], inventories: { Felix: { oak_log: 30, wooden_axe: 1 } } }, { available: true });
    await t.clock.advance(5 * SECOND);
    const { Arthur: arthur, Felix: felix } = t.agents;
    await Promise.all(felix.pending_results);
    t.world.durations = () => 20 * SECOND; // the gather takes minutes: everything below happens in the middle of it
    // Felix is carrying out a gather, and a walk waits behind it
    const seeded = await felix.runtime.goals.setShortTerm('Felix', [
        { title: 'Gather wood', option_id: 'gather_blocks:oak_log:8' }, { title: 'Walk to the field', option_id: 'travel:field' },
    ], { reason: 'seeded', source: 'operator' });
    const [in_hand, waiting] = seeded.goals.short_term;
    t.run();
    await t.clock.advance(12 * SECOND);
    assert.equal(felix.runtime.executor.plan().goal.id, in_hand.id);
    // Arthur asks, Felix's model says yes: the hand-over is queued behind the goal in hand
    const asked = await arthur.runtime.messages().request('Felix', { item: 'oak_log', count: 4 });
    await t.settleMessages();
    assert.deepEqual((await felix.queue()).map((goal) => goal.option_id), ['gather_blocks:oak_log:8', 'travel:field', 'give_items:Arthur:oak_log:4']);
    const owed = (await felix.queue())[2];
    assert.equal(felix.runtime.messages().owes(owed), true);
    assert.equal(felix.runtime.messages().owes(waiting), false);

    // the operator speaks: a new plan arrives while the gather still runs
    t.model.replies.push((request, offered) => ({ thought: 'Store the logs now.', goals: [{ option_id: offered.find((id) => id.startsWith('store_items:')), title: 'Store the logs', reason: 'the operator asked' }] }));
    felix.runtime.operatorMessage('Soup', 'store the logs now');
    await t.clock.advance(100 * SECOND);
    await Promise.all(felix.pending_results);
    const queue = (await felix.queue()).map((goal) => goal.option_id);
    // the goal in hand goes on, the walk that waited is replaced, and the hand-over Felix agreed to is still there, ahead of the new plan
    assert.equal(felix.runtime.executor.plan().goal.id, in_hand.id, 'the goal in hand was given up for the new plan');
    assert.ok(!queue.includes('travel:field'), 'a goal that was still waiting survived the new plan');
    assert.deepEqual(queue.slice(0, 2), ['gather_blocks:oak_log:8', 'give_items:Arthur:oak_log:4']);
    assert.match(queue[2], /^store_items:/);
    const dropped = felix.eventsOf('agent.state').filter((event) => event.data.state === 'goal_dropped').map((event) => [event.data.detail.goal_id, event.data.detail.reason]);
    assert.deepEqual(dropped, [[waiting.id, 'replaced_by_new_plan']]);
    // and it is carried out: Arthur gets what he was promised
    t.world.durations = () => 1 * SECOND;
    await t.clock.advance(3 * MINUTE);
    await t.settleMessages();
    const handed = t.world.calls.filter((call) => call.agent === 'Felix' && ['giveToPlayer', 'putInChest'].includes(call.command) && call.args[0] === 'oak_log' && call.args.includes(4));
    assert.equal(handed.length, 1, 'the hand-over Felix agreed to was never carried out');
    assert.ok(t.messages.some((event) => event.data.type === 'inform' && event.data.body.re === asked.message.msg_id), 'Arthur was not told the items are there');
    assert.equal(felix.runtime.messages().stats().duties, 0);
    await t.stop();
});

// ---- the planner starts agent-to-agent messages (decided): ask_agent and offer_agent ----

test('ask_agent: the planner asks a named agent for what its build is short of, through the relay, and the items arrive', async () => {
    const prefer = (prefix) => (request, offered) => {
        const id = offered.find((option) => option.startsWith(prefix)) ?? offered[0];
        return { thought: 'I will ask for what I am short of.', goals: [{ option_id: id, title: `Do ${id}`.slice(0, 60), reason: 'the test chose it' }] };
    };
    const t = await relayTown({
        agents: ['Arthur', 'Felix'], inventories: { Arthur: { stone_axe: 1, bread: 4 }, Felix: { oak_planks: 20, stone_sword: 1, bread: 4 } },
        replies: [prefer('ask_agent:Felix:'), prefer('ask_agent:')],
    }, { available: true });
    t.world.durations = () => 1 * SECOND;
    const { Arthur: arthur, Felix: felix } = t.agents;
    await t.clock.advance(1 * SECOND);
    // Arthur's plot wants oak planks, he holds none and no chest has any: asking for them is on offer
    // (two agents at a time; when his process started Felix was not in the world yet, so the world file's order decided)
    const offered = t.model.requests[0].format.properties.goals.items.properties.option_id.enum;
    // (decided: an agent may ask for ANYTHING the catalog knows. After what its own work is short of comes one more ask, for something else it has none of)
    assert.deepEqual(offered.filter((id) => id.startsWith('ask_agent:')), ['ask_agent:Mira:oak_planks:8', 'ask_agent:Felix:oak_planks:8', 'ask_agent:Mira:oak_log:4']);
    // with Felix in sight, he comes first
    assert.deepEqual(createCatalog({ zones: t.zones, blueprints: BLUEPRINTS }).offer(arthur.runtime.state()).map((option) => option.id).filter((id) => id.startsWith('ask_agent:')),
        ['ask_agent:Felix:oak_planks:8', 'ask_agent:Mira:oak_planks:8', 'ask_agent:Felix:oak_log:4']);
    assert.ok(!offered.some((id) => id.startsWith('build_blueprint:')), 'the build was on offer although the planks are missing');
    assert.match(t.model.requests[0].messages.at(-1).content, /ask_agent:Felix:oak_planks:8: Ask Felix for 8 oak_planks \(for plot plot-1\): Felix may say no/);
    // Felix's own work is short of nothing: what he is offered to ask for is only the "anything else" kind (4 at a time), never the planks
    const felix_asks = t.model.requests[1].format.properties.goals.items.properties.option_id.enum.filter((id) => id.startsWith('ask_agent:'));
    assert.ok(felix_asks.length <= 3 && felix_asks.every((id) => id.endsWith(':4') && !id.includes('oak_planks')), felix_asks.join(' '));
    assert.deepEqual((await arthur.queue()).map((goal) => goal.option_id), ['ask_agent:Felix:oak_planks:8']);

    t.run();
    await t.clock.advance(40 * SECOND);
    await t.settleMessages();
    // the goal is ONE step, carried out by Genesis's own code: nothing of it reaches the bot
    const decision = arthur.eventsOf('agent.decision').find((event) => event.data.args[0] === 'ask_agent:Felix:oak_planks:8');
    assert.deepEqual([decision.data.trigger, decision.data.command, decision.data.steps, decision.data.steps_from], ['planner', 'ask_agent', ['relayMessage'], 'template']);
    assert.ok(decision.data.call_id, 'the goal does not carry the planning call that chose it');
    assert.equal(t.world.calls.some((call) => call.command === 'relayMessage'), false);
    const result = arthur.eventsOf('skill.result').find((event) => event.data.skill === 'relayMessage');
    assert.equal(result.data.ok, true);
    assert.match(result.data.output, /^Message m-\d+-1 \(request\) relayed to Felix: 8 oak_planks\.$/);
    assert.ok(arthur.eventsOf('agent.state').some((event) => event.data.state === 'goal_completed' && event.data.detail.option_id === 'ask_agent:Felix:oak_planks:8' && event.data.detail.done === 1));
    // through the relay, with everything it does for any message: a structured request, a line, an answer
    const conv = t.messages.filter((event) => event.data.conv === t.messages[0].data.conv).map((event) => `${event.data.from}>${event.data.to} ${event.data.type} ${event.data.state}`);
    assert.deepEqual(conv, ['Arthur>Felix request pending', 'Felix>Arthur accept delivered', 'Arthur>Felix request accepted', 'Felix>Arthur inform delivered']);
    assert.deepEqual(t.messages[0].data.body, { item: 'oak_planks', count: 8 });
    assert.equal(arthur.said[0], 'Well, Felix, I need 8 oak planks.');
    // Felix's model said yes, his executor handed them over, and Arthur has what he asked for
    assert.equal(t.messages[1].data.body.decided_by, 'planner');
    assert.equal(t.world.body('Arthur').inventory.oak_planks, 8);
    const handed = t.world.calls.filter((call) => call.agent === 'Felix' && ['giveToPlayer', 'putInChest'].includes(call.command) && call.args[0] === 'oak_planks');
    assert.ok(handed.length >= 1 && handed[0].args.includes(8), 'Felix did not hand over the 8 planks he said yes to');
    // upstream's own free-text conversation commands were never involved, and stay blocked
    for (const action of ['!startConversation', '!endConversation', '!newAction']) assert.ok(REQUIRED_BLOCKED_ACTIONS.includes(action));
    assertMessageEvents(t.messages);
    for (const a of [arthur, felix]) for (const event of a.events) assert.deepEqual(validateEvent(event).errors, []);
    await t.stop();
});

test('offer_agent: the planner offers what the agent holds beyond its reserve; accepted, the hand-over is the planner\'s commitment', async () => {
    const prefer = (prefix) => (request, offered) => {
        const id = offered.find((option) => option.startsWith(prefix)) ?? offered[0];
        return { thought: 'Somebody can use these.', goals: [{ option_id: id, title: `Do ${id}`.slice(0, 60), reason: 'the test chose it' }] };
    };
    // (Arthur holds the planks his plot wants, so he asks for nothing)
    const t = await relayTown({
        agents: ['Arthur', 'Felix'], inventories: { Arthur: { oak_planks: 16 }, Felix: { oak_log: 12, stone_sword: 1, bread: 5, torch: 4 } },
        replies: [(request, offered) => prefer('travel:')(request, offered), prefer('offer_agent:')],
    }, { available: true });
    t.world.durations = () => 1 * SECOND;
    const { Arthur: arthur, Felix: felix } = t.agents;
    await t.clock.advance(1 * SECOND);
    // what Felix can spare: his logs, and of his bread only what is beyond the reserve of 4. Never the sword or the torches
    const felix_offered = t.model.requests[1].format.properties.goals.items.properties.option_id.enum;
    assert.deepEqual(felix_offered.filter((id) => id.startsWith('offer_agent:')), ['offer_agent:Arthur:oak_log:8']);
    assert.match(t.model.requests[1].messages.at(-1).content, /offer_agent:Arthur:oak_log:8: Offer 8 of your 12 oak_log to Arthur: handed over if Arthur says yes/);
    const catalog = felix.runtime.state;
    const check = (id) => { const checked = createCatalog({ zones: t.zones }).check(id, catalog()); return checked.ok ? null : checked.reason; };
    assert.equal(check('offer_agent:Arthur:oak_log:12'), null);
    assert.equal(check('offer_agent:Arthur:oak_log:13'), 'not_spare');
    assert.equal(check('offer_agent:Arthur:bread:1'), null);
    assert.equal(check('offer_agent:Arthur:bread:2'), 'not_spare', 'food up to the reserve stays');
    assert.equal(check('offer_agent:Arthur:stone_sword:1'), 'not_spare', 'a tool is never offered');
    assert.equal(check('offer_agent:Arthur:torch:1'), 'not_spare');
    assert.equal(check('offer_agent:Felix:oak_log:4'), 'self_message');
    assert.equal(check('offer_agent:Herobrine:oak_log:4'), 'unknown_agent');

    t.run();
    await t.clock.advance(40 * SECOND);
    await t.settleMessages();
    const conv = t.messages.filter((event) => event.data.conv === t.messages[0].data.conv).map((event) => `${event.data.from}>${event.data.to} ${event.data.type} ${event.data.state}`);
    assert.deepEqual(conv, ['Felix>Arthur offer pending', 'Arthur>Felix accept delivered', 'Felix>Arthur offer accepted', 'Felix>Arthur inform delivered']);
    assert.deepEqual(t.messages[0].data.body, { item: 'oak_log', count: 8 });
    assert.equal(t.messages[1].data.body.decided_by, 'planner', 'Arthur\'s model decided about the offer');
    // the offer was the planner's choice, so the hand-over it leads to is the planner's too
    const owed = felix.changes().find((change) => change.after.some((goal) => goal.option_id === 'give_items:Arthur:oak_log:8'));
    assert.equal(owed.source, 'planner');
    assert.equal(owed.call_id, felix.eventsOf('agent.decision').find((event) => event.data.args[0] === 'offer_agent:Arthur:oak_log:8').data.call_id, 'the commitment does not carry the planning call that chose the offer');
    assert.match(owed.reason, /Arthur accepted the offer of 8 oak_log/);
    // handed over (directly, or through the shared chest when Arthur had walked off): the 8 logs left Felix
    const handed = t.world.calls.filter((call) => call.agent === 'Felix' && ['giveToPlayer', 'putInChest'].includes(call.command) && call.args[0] === 'oak_log');
    assert.ok(handed.length >= 1 && handed[0].args.includes(8), 'Felix did not hand over the 8 logs he offered');
    assert.equal(felix.runtime.messages().stats().steps_sent, 1);
    assertMessageEvents(t.messages);
    await t.stop();
});

test('the relay\'s limits hold for messages the planner starts: they are not offered when they would be refused, and a refusal fails the goal once', async () => {
    const t = await relayTown({ agents: ['Arthur', 'Felix', 'Nova'], inventories: { Arthur: { stone_axe: 1 } } });
    const arthur = t.agents.Arthur;
    t.kill('Felix'); // nobody answers: what Arthur asks stays open
    t.kill('Nova');
    const catalog = createCatalog({ zones: t.zones, blueprints: { get: (name) => (name === 'hut' ? { name: 'hut', blocks: [[['oak_planks']]] } : null) } });
    const reason = (id) => { const checked = catalog.check(id, arthur.runtime.state()); return checked.ok ? null : checked.reason; };
    const talk = () => { const view = arthur.runtime.state().talk; return [view.open, view.max_open, view.sent, view.max_sent]; };
    assert.deepEqual(talk(), [0, 2, 0, 6]);
    assert.equal(reason('ask_agent:Felix:oak_planks:8'), null);

    // sent as a goal (as the planner's reply would queue it): the message goes out once
    const seed = async (option_id) => {
        const set = await arthur.runtime.goals.setShortTerm('Arthur', [{ title: `Do ${option_id}`.slice(0, 60), option_id }], { reason: 'seeded', source: 'planner', call_id: 'call-1' });
        arthur.runtime.executor.noteGoals(set.goals.short_term, { source: 'planner', call_id: 'call-1' });
        const done = [];
        for (let i = 0; i < 6; i++) { const outcome = await arthur.runtime.executor.runOnce(); done.push(outcome); if (['goal_completed', 'goal_failed', 'goal_dropped'].includes(outcome.kind)) break; }
        await t.settleMessages();
        return done;
    };
    assert.deepEqual((await seed('ask_agent:Felix:oak_planks:8')).map((outcome) => outcome.kind), ['goal_started', 'step_done', 'goal_completed']);
    assert.deepEqual(t.exchange(), ['Arthur>Felix request pending']);
    assert.deepEqual(talk(), [1, 2, 1, 6]);
    // the same request still waits for its answer: not on offer, and dropped before it starts if it was queued
    assert.equal(reason('ask_agent:Felix:oak_planks:8'), 'already_waiting');
    assert.deepEqual((await seed('ask_agent:Felix:oak_planks:8')).map((outcome) => [outcome.kind, outcome.reason]), [['goal_dropped', 'already_waiting']]);
    assert.equal(t.messages.length, 1, 'a message went out for a goal that was dropped');
    // a second conversation is open: with two open, nothing more may be started
    assert.deepEqual((await seed('ask_agent:Nova:oak_planks:8')).map((outcome) => outcome.kind), ['goal_started', 'step_done', 'goal_completed']);
    assert.deepEqual(talk(), [2, 2, 2, 6]);
    assert.equal(reason('ask_agent:Felix:cobblestone:8'), 'no_conversation_slot');
    assert.ok(!catalog.offer(arthur.runtime.state()).some((option) => option.id.startsWith('ask_agent:') || option.id.startsWith('offer_agent:')));

    // both expire unanswered (Arthur plans again), the slots are free; the same request may repeat once, then the relay would block it
    await t.clock.advance(121 * SECOND);
    await t.settleMessages();
    assert.deepEqual(talk(), [0, 2, 0, 6]);
    assert.deepEqual(planKinds(arthur).filter((kind) => kind.startsWith('request_')), ['request_expired', 'request_expired']);
    assert.equal(reason('ask_agent:Felix:oak_planks:8'), null);
    assert.deepEqual((await seed('ask_agent:Felix:oak_planks:8')).map((outcome) => outcome.kind), ['goal_started', 'step_done', 'goal_completed']);
    await t.clock.advance(121 * SECOND);
    await t.settleMessages();
    assert.equal(reason('ask_agent:Felix:oak_planks:8'), 'repeat_blocked');
    assert.equal(reason('ask_agent:Felix:oak_planks:4'), null, 'another count is another message');

    // the message budget: 6 a minute, counted where the relay counts them
    for (let i = 1; i <= 6; i++) assert.equal((await arthur.runtime.messages().inform('Felix', { text: `note ${i}` })).ok, true);
    assert.deepEqual(talk(), [0, 2, 6, 6]);
    assert.equal(reason('ask_agent:Felix:oak_planks:4'), 'message_budget_spent');
    await t.clock.advance(61 * SECOND);
    assert.equal(reason('ask_agent:Felix:oak_planks:4'), null);

    // what the relay itself refuses fails the goal ONCE, with the relay's reason: no second try, nothing spoken.
    // (Mira is in the world file, but the relay does not know her here.)
    const said_before = arthur.said.length;
    const refused = await seed('ask_agent:Mira:oak_planks:8');
    assert.deepEqual(refused.map((outcome) => [outcome.kind, outcome.reason]), [['goal_started', undefined], ['goal_failed', 'relay_unknown_recipient']]);
    const failed = arthur.eventsOf('agent.state').filter((event) => event.data.state === 'goal_failed').at(-1).data.detail;
    assert.deepEqual([failed.reason, failed.command, failed.attempts], ['relay_unknown_recipient', 'relayMessage', 1]);
    const rejected = t.messageEvents('rejected').at(-1).data;
    assert.deepEqual([rejected.from, rejected.to, rejected.type, rejected.reason, rejected.chat_line], ['Arthur', 'Mira', 'request', 'unknown_recipient', null]);
    assert.equal(arthur.said.length, said_before, 'a rejected message was spoken');
    assert.equal(planKinds(arthur).at(-1), 'step_failed');
    assert.deepEqual([arthur.runtime.messages().stats().steps_sent, arthur.runtime.messages().stats().steps_rejected], [3, 1]);
    assertMessageEvents(t.messages);
    await t.stop();
});

test('the relay in the MindServer: a message is only taken from the sender\'s own connection, and the ledger follows what was agreed', async () => {
    const clock = fakeClock();
    const published = [];
    const service = startRelay({ limits: { expiry_ms: 30 * SECOND }, model_lines: false }, { agents: NAMES, clock, event_sink: (event) => published.push(event) });
    assert.equal(service.relay.limits.expiry_ms, 30 * SECOND);
    assert.equal(service.relay.limits.max_turns, 6);
    const connect = (name) => {
        const handlers = {};
        const socket = { connected: true, got: [], on: (event, fn) => { handlers[event] = fn; }, emit: (event, payload) => socket.got.push([event, payload]) };
        service.attach(socket, { isAgentSocket: (agent) => agent === name });
        handlers['genesis-hello'](name);
        return { socket, send: (input) => new Promise((resolve) => handlers['genesis-msg-send'](input, resolve)), close: () => handlers.disconnect() };
    };
    const arthur = connect('Arthur');
    const mira = connect('Mira');
    const ledger = createSharedLedger({ clock });
    ledger.apply('Nova', { kind: 'observe', chest: 'shared', contents: { bread: 8 }, at: clock.now() });
    ledger.reserve('Mira', { chest: 'shared', item: 'bread', count: 8 });
    let updates = 0;
    const broker = { small: async () => { throw new Error('model_lines is off: the broker must not be asked'); } };
    service.bind({ broker, ledger, ledgerUpdated: () => { updates++; } });

    // somebody else's name is refused, as an event with a named reason
    const forged = await arthur.send({ from: 'Mira', to: 'Felix', type: 'warn', body: { text: 'run' } });
    assert.deepEqual([forged.ok, forged.reason], [false, 'unknown_sender']);
    // a claim that is accepted moves the reservation; nothing else does
    const claim = await arthur.send({ from: 'Arthur', to: 'Mira', type: 'request', body: { item: 'bread', count: 3, chest: 'shared', claim: true } });
    assert.deepEqual(mira.socket.got.map(([event, payload]) => [event, payload.msg_id]), [['genesis-msg', claim.message.msg_id]]);
    assert.equal(updates, 0);
    await mira.send({ from: 'Mira', to: 'Arthur', type: 'accept', body: { item: 'bread', count: 3 }, conv: claim.message.conv });
    assert.deepEqual(ledger.reservations().map((held) => [held.holder, held.count]).sort(), [['Arthur', 3], ['Mira', 5]]);
    assert.equal(updates, 1);
    await service.relay.idle();
    // the events go out under the relay's own name, in order, every one valid; the rejection among them
    assert.deepEqual(published.map((event) => [event.agent, event.type, event.data.from, event.data.type, event.data.state]), [
        ['relay', 'agent.message', 'Mira', 'warn', 'rejected'],
        ['relay', 'agent.message', 'Arthur', 'request', 'pending'],
        ['relay', 'agent.message', 'Mira', 'accept', 'delivered'],
        ['relay', 'agent.message', 'Arthur', 'request', 'accepted'],
    ]);
    for (const event of published) assert.deepEqual(validateEvent(event), { ok: true, errors: [] });
    assert.deepEqual(published.map((event) => event.seq), [1, 2, 3, 4]);
    assert.ok(published.slice(1).every((event) => event.data.state !== 'pending' || event.data.line_source === 'template'));
    // each sender is told its line; the forged message was spoken by nobody
    assert.deepEqual(arthur.socket.got.filter(([event]) => event === 'genesis-msg-speak').map(([, said]) => said.line), ['Mira, I need 3 bread from the shared chest.']);
    assert.deepEqual(mira.socket.got.filter(([event]) => event === 'genesis-msg-speak').map(([, said]) => said.line), ['Arthur, yes, 3 bread are yours.']);
    service.stop();
});

test('the relay in the MindServer decides only what waits for that agent\'s answer, and takes the decision limits from the setting', async () => {
    const clock = fakeClock();
    const service = startRelay({ model_lines: false, decision: { max_calls_per_hour: 7, max_tokens: 50 } }, { agents: NAMES, clock });
    const connect = (name) => {
        const handlers = {};
        const socket = { connected: true, got: [], on: (event, fn) => { handlers[event] = fn; }, emit: (event, payload) => socket.got.push([event, payload]) };
        service.attach(socket, { isAgentSocket: (agent) => agent === name });
        handlers['genesis-hello'](name);
        return {
            socket, send: (input) => new Promise((resolve) => handlers['genesis-msg-send'](input, resolve)),
            decide: (input) => new Promise((resolve) => handlers['genesis-msg-decide'](input, resolve)),
        };
    };
    const arthur = connect('Arthur');
    const felix = connect('Felix');
    const mira = connect('Mira');
    const asked = [];
    const limits = [];
    const broker = {
        setSmallLimits: (kind, values) => { limits.push([kind, values]); return values; },
        small: async (input) => { asked.push(input); return { ok: true, content: '{"decision":"decline","reason":"Not today."}', call_id: 'call-9' }; },
    };

    const request = await arthur.send({ from: 'Arthur', to: 'Felix', type: 'request', body: { item: 'oak_log', count: 4 } });
    const about = { agent: 'Felix', msg_id: request.message.msg_id, conv: request.message.conv, facts: { held: 10, spare: 10, secret: 'x' } };
    // before the planner broker exists nothing is decided here: the agent's code rule decides
    assert.deepEqual(await felix.decide(about), { ok: false, reason: 'model_decisions_off' });
    service.bind({ broker });
    // the decision call's own hourly limit and token limit come from the genesis_relay.decision setting
    assert.deepEqual(limits, [['message_decision', { max_calls: 7, max_tokens: 50, timeout_ms: 15 * SECOND, wait_ms: 120 * SECOND }]]);

    // Felix asks about the request that waits for his answer: decided
    assert.deepEqual(await felix.decide(about), { ok: true, decision: 'decline', reason: 'Not today.', call_id: 'call-9' });
    assert.equal(asked.length, 1);
    assert.deepEqual([asked[0].agent, asked[0].kind, asked[0].trigger.kind, asked[0].max_tokens, asked[0].timeout_ms, asked[0].wait_ms], ['Felix', 'message_decision', 'message_decision', 50, 15 * SECOND, 120 * SECOND]); // the whole life of the message
    assert.deepEqual(asked[0].format, decisionSchema());
    // the prompt is built from the message as the relay holds it; of what the agent says about itself only the known facts get in
    const prompt = asked[0].messages.map((message) => message.content).join('\n');
    assert.match(prompt, /You are Felix, the explorer\. Arthur says: "Felix, I need 4 oak logs\."/);
    assert.match(prompt, /About you: \{"held":10,"spare":10\}/);
    assert.equal(asked[0].validate('{"decision":"accept","reason":"ok"}'), true);
    assert.equal(asked[0].validate('{"decision":"accept","reason":"ok","count":64}'), false);

    // nobody decides for somebody else, about a message that is not theirs to answer, or about one that is over
    assert.deepEqual(await mira.decide(about), { ok: false, reason: 'unknown_sender' }, 'Mira decided under Felix\'s name');
    assert.deepEqual(await mira.decide({ ...about, agent: 'Mira' }), { ok: false, reason: 'nothing_to_decide' });
    assert.deepEqual(await arthur.decide({ ...about, agent: 'Arthur' }), { ok: false, reason: 'nothing_to_decide' }, 'the asker decided its own request');
    assert.deepEqual(await felix.decide({ ...about, msg_id: 'm-9999-1' }), { ok: false, reason: 'nothing_to_decide' });
    assert.deepEqual(await felix.decide({ ...about, conv: 'c-9999' }), { ok: false, reason: 'nothing_to_decide' });
    await felix.send({ from: 'Felix', to: 'Arthur', type: 'decline', body: { item: 'oak_log', count: 4 }, conv: request.message.conv });
    assert.deepEqual(await felix.decide(about), { ok: false, reason: 'nothing_to_decide' }, 'an answered request was decided again');
    assert.equal(asked.length, 1, 'the model was asked about something that was not there to decide');
    // a model that cannot be asked: the reason goes back, and the agent's code rule decides
    broker.small = async () => ({ ok: false, reason: 'budget_exhausted' });
    const again = await arthur.send({ from: 'Arthur', to: 'Felix', type: 'offer', body: { item: 'bread', count: 2 } });
    assert.deepEqual(await felix.decide({ agent: 'Felix', msg_id: again.message.msg_id, conv: again.message.conv }), { ok: false, reason: 'budget_exhausted', call_id: null });
    assert.deepEqual([service.stats().decisions_asked, service.stats().decisions_made], [8, 1]);
    service.stop();

    // "model_decisions": false: the broker is never asked, whatever arrives
    const off = startRelay({ model_decisions: false }, { agents: NAMES, clock });
    const handlers = {};
    off.attach({ connected: true, on: (event, fn) => { handlers[event] = fn; }, emit() {} }, { isAgentSocket: () => true });
    off.bind({ broker: { setSmallLimits() { throw new Error('not to be set'); }, small: async () => { throw new Error('not to be asked'); } } });
    assert.deepEqual(await new Promise((resolve) => handlers['genesis-msg-decide']({ agent: 'Felix', msg_id: 'm-0001-1', conv: 'c-0001' }, resolve)), { ok: false, reason: 'model_decisions_off' });
    off.stop();
});

test('settings: genesis_relay is optional, takes known values only, and is checked', () => {
    assert.deepEqual(checkSettings({ genesis_relay: { enabled: true, model_lines: false, limits: { max_open_conversations: 3, repeat_block_ms: 60000 }, line: { max_chars: 100 } } }), []);
    // the decision call: a switch, and its own named limits
    assert.deepEqual(checkSettings({ genesis_relay: { model_decisions: false, decision: { max_calls_per_hour: 40, max_tokens: 120, timeout_ms: 20000, wait_ms: 0 } } }), []);
    const decision_problems = checkSettings({ genesis_relay: { model_decisions: 'yes', decision: { max_calls: 40, max_tokens: 'many', max_reason_chars: 500 } } }).join('\n');
    assert.match(decision_problems, /"genesis_relay.model_decisions" must be true or false/);
    assert.match(decision_problems, /"genesis_relay.decision.max_calls" is not a setting \(known: max_calls_per_hour, max_tokens, timeout_ms, wait_ms\)/);
    assert.match(decision_problems, /"genesis_relay.decision.max_tokens" must be a number/);
    assert.match(decision_problems, /"genesis_relay.decision.max_reason_chars" is not a setting/, 'the 140 characters are decided, not a setting');
    const problems = checkSettings({ genesis_relay: { enabled: 1, model_lines: 'no', turns: 9, limits: { max_turn: 8, expiry_ms: '2m' }, line: { max_tokens: -5 } } });
    assert.equal(problems.length, 6, problems.join('\n'));
    assert.match(problems.join('\n'), /"genesis_relay.enabled" must be true or false/);
    assert.match(problems.join('\n'), /"genesis_relay.turns" is not a setting/);
    assert.match(problems.join('\n'), /"genesis_relay.limits.max_turn" is not a setting/);
    assert.match(problems.join('\n'), /"genesis_relay.limits.expiry_ms" must be a number/);
    assert.match(problems.join('\n'), /"genesis_relay.line.max_tokens" must be a number/);
});
