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
import { makeTown } from './helpers/town.mjs';
import { validateEvent, MESSAGE_TYPES, MESSAGE_STATES, REPLY_EXPECTED } from '../shared/events.js';
import { createRelay, RELAY_LIMITS, REJECT_REASONS } from '../relay/relay.js';
import { templateLine, validateLine, lineProblem, lineMessages, lineSchema, parseLineReply, LINE_LIMITS } from '../relay/lines.js';
import { startRelay, RELAY_EVENT_AGENT } from '../relay/server.js';
import { SMALL_CALL_DEFAULTS } from '../broker/broker.js';
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
    // the hand-over is a template beside the eight of the first catalog
    assert.equal(TEMPLATE_NAMES.length, 8);
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

test('receiving a request with the model there: it is a planning trigger, the hand-over is one of the options, and the reply is the answer', async () => {
    const t = await relayTown({ agents: ['Arthur', 'Felix'], inventories: { Felix: { oak_log: 10, stone_sword: 1 } } }, { available: true });
    t.world.durations = () => 1 * SECOND;
    await t.clock.advance(5 * SECOND);
    const { Arthur: arthur, Felix: felix } = t.agents;
    await t.clock.advance(2 * MINUTE); // (past the 90 seconds between an agent's planning calls)
    const calls_before = t.model.requests.length;

    // the planner chooses the hand-over: that is the accept
    t.model.replies.push((request, offered) => ({ thought: 'Arthur needs logs for the hall.', goals: [{ option_id: offered.find((id) => id.startsWith('give_items:')), title: 'Give Arthur logs', reason: 'he asked' }] }));
    const asked = await arthur.runtime.messages().request('Felix', { item: 'oak_log', count: 4, reason: 'the hall walls' });
    await t.settleMessages();
    assert.deepEqual(planKinds(felix).at(-1), 'agent_request');
    await t.clock.advance(3 * SECOND);
    await Promise.all(felix.pending_results);
    await t.settleMessages();
    assert.equal(t.model.requests.length, calls_before + 1);
    assert.ok(t.model.offered().includes('give_items:Arthur:oak_log:4'), 'the hand-over was not offered to the planner');
    const prompt = t.model.requests.at(-1).messages.map((message) => message.content).join('\n');
    assert.match(prompt, /Arthur asks: "Felix, I need 4 oak logs for the hall walls\."/);
    const accept = t.messages.find((event) => event.data.type === 'accept');
    assert.deepEqual([accept.data.body.decided_by, accept.data.conv], ['planner', asked.message.conv]);
    assert.equal(felix.changes().find((change) => change.after.some((goal) => goal.option_id === 'give_items:Arthur:oak_log:4')).source, 'planner');
    // without a request nothing of the kind is ever offered
    assert.ok(!t.model.requests.slice(0, calls_before).some((request) => request.format.properties.goals.items.properties.option_id.enum.some((id) => id.startsWith('give_items:'))));

    // the planner chooses something else: that is the decline
    await t.clock.advance(3 * MINUTE);
    const before = t.messages.length;
    t.model.replies.push((request, offered) => ({ thought: 'I have my own work.', goals: [{ option_id: offered.find((id) => !id.startsWith('give_items:')), title: 'My own work', reason: 'first' }] }));
    await arthur.runtime.messages().request('Felix', { item: 'oak_log', count: 2 });
    await t.settleMessages();
    await t.clock.advance(3 * SECOND);
    await Promise.all(felix.pending_results);
    await t.settleMessages();
    const decline = t.messages.slice(before).find((event) => event.data.type === 'decline');
    assert.deepEqual([decline.data.body.item, decline.data.body.count, decline.data.body.decided_by], ['oak_log', 2, 'planner']);
    assert.ok(planKinds(arthur).includes('request_declined'));
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

test('settings: genesis_relay is optional, takes known values only, and is checked', () => {
    assert.deepEqual(checkSettings({ genesis_relay: { enabled: true, model_lines: false, limits: { max_open_conversations: 3, repeat_block_ms: 60000 }, line: { max_chars: 100 } } }), []);
    const problems = checkSettings({ genesis_relay: { enabled: 1, model_lines: 'no', turns: 9, limits: { max_turn: 8, expiry_ms: '2m' }, line: { max_tokens: -5 } } });
    assert.equal(problems.length, 6, problems.join('\n'));
    assert.match(problems.join('\n'), /"genesis_relay.enabled" must be true or false/);
    assert.match(problems.join('\n'), /"genesis_relay.turns" is not a setting/);
    assert.match(problems.join('\n'), /"genesis_relay.limits.max_turn" is not a setting/);
    assert.match(problems.join('\n'), /"genesis_relay.limits.expiry_ms" must be a number/);
    assert.match(problems.join('\n'), /"genesis_relay.line.max_tokens" must be a number/);
});
