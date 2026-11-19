// Step 5: the model gate, the planner broker with its request queue and budget, and the
// structured planner reply.
//
// The model is a stub, the clock is a fake that only moves when the test says so, and the
// call store is a list: nothing here waits for real time or touches the network, except
// the last tests, which run the thin Ollama client against a local HTTP server.
// Run from the repository root:  node --test genesis/tests/*.test.js

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { fakeClock, settle } from './helpers/fakes.mjs';
import { httpServer, silentServer, refusedPort, closeAllServers } from './helpers/stubs.mjs';
import { createPlannerBroker, BROKER_DEFAULTS, SMALL_CALL_DEFAULTS, DECISION_CALL_DEFAULTS, SMALL_KINDS } from '../broker/broker.js';
import { createModelGate, GATE_STATES, GATE_DEFAULTS } from '../broker/gate.js';
import { createRequestQueue } from '../broker/queue.js';
import { createBudget, BUDGET_DEFAULTS } from '../broker/budget.js';
import { validatePlannerReply, plannerReplySchema, buildPlannerMessages, checkOptions, REPLY_LIMITS } from '../broker/planner_reply.js';
import { CALL_RECORD_FIELDS, CALL_OUTCOMES, makeCallRecord } from '../broker/call_record.js';
import { createOllamaPlanner } from '../broker/ollama_planner.js';
import { createEmitter } from '../events/agent_emit.js';
import { validateEvent } from '../shared/events.js';

after(closeAllServers);

const OPTIONS = [
    { id: 'gather_wood', description: 'Collect oak logs near the base' },
    { id: 'build_hall', description: 'Continue the great hall' },
    { id: 'trade_mira', description: 'Ask Mira for wheat' },
    { id: 'rest', description: 'Sleep until morning' },
];
const IDS = OPTIONS.map((option) => option.id);
const goal = (option_id, extra = {}) => ({ option_id, title: `Do ${option_id}`, reason: 'it moves the hall forward', ...extra });
const reply = (...ids) => ({ thought: 'The hall needs wood first.', goals: ids.map((id) => goal(id)) });

// A model that records what it is asked. By default it answers at once with a valid reply
// naming the first option offered. `replies` queues other answers (objects, raw strings or
// Errors); `hang` makes calls never answer; `delay_ms` makes them take time on the fake clock.
function stubModel(clock) {
    const model = {
        name: 'stub-model',
        requests: [], replies: [], hang: false, delay_ms: 0, active: 0, max_active: 0,
        probes: 0, probe_ok: true,
        async probe() { model.probes++; return model.probe_ok; },
        chat(request) {
            model.requests.push(request);
            if (model.hang) return new Promise(() => {});
            const next = model.replies.length > 0 ? model.replies.shift() : reply(request.format.properties.goals.items.properties.option_id.enum[0]);
            const answer = () => {
                if (next instanceof Error) throw next;
                return { content: typeof next === 'string' ? next : JSON.stringify(next), prompt_tokens: 321, completion_tokens: 45, model: 'stub-model:latest' };
            };
            if (model.delay_ms <= 0) return Promise.resolve().then(answer);
            model.active++;
            model.max_active = Math.max(model.max_active, model.active);
            return new Promise((resolve, reject) => {
                clock.setTimeout(() => {
                    model.active--;
                    try { resolve(answer()); } catch (err) { reject(err); }
                }, model.delay_ms);
            });
        },
    };
    return model;
}

function setup(options = {}) {
    const clock = fakeClock();
    const model = stubModel(clock);
    const calls = [];
    const delivered = [];
    const events = [];
    const contexts = [];
    const broker = createPlannerBroker({
        model, clock,
        calls: { record: (record) => { calls.push(record); } },
        buildContext: async (request) => {
            contexts.push({ request, at: clock.now() });
            return { context: `context ${contexts.length} for ${request.agent}`, options: OPTIONS };
        },
        deliver: (result) => delivered.push(result),
        emit: (type, data, opts) => events.push({ type, data, ...opts }),
        ...options,
    });
    return { broker, clock, model, calls, delivered, events, contexts };
}

// A broker whose gate is AVAILABLE (start-up asks the desktop once, the probe passes).
async function setupAvailable(options) {
    const h = setup(options);
    await h.broker.start();
    await settle();
    assert.equal(h.broker.gate.state(), GATE_STATES.AVAILABLE);
    h.events.length = 0;
    return h;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;

test('the decided numbers are the defaults', () => {
    assert.deepEqual({ ...BUDGET_DEFAULTS }, { max_calls: 40, window_ms: 3600000, min_gap_ms: 90000 });
    assert.equal(BROKER_DEFAULTS.call_timeout_ms, 90000);
    assert.equal(BROKER_DEFAULTS.repair_retries, 1);
    assert.deepEqual({ ...REPLY_LIMITS }, { thought: 160, title: 60, reason: 140, min_goals: 1, max_goals: 3 });
});

// ---- the gate ----

test('gate: after desktop_leaving the model receives zero requests until desktop_available plus a passing probe', async () => {
    const h = await setupAvailable();
    h.broker.submit({ agent: 'Arthur', trigger: 'idle' });
    await settle();
    assert.equal(h.model.requests.length, 1); // the gate was open

    await h.broker.signal('desktop_leaving');
    assert.equal(h.broker.gate.state(), GATE_STATES.AWAY);
    const probes_when_away = h.model.probes;
    for (const agent of ['Arthur', 'Mira', 'Felix', 'Nova']) h.broker.submit({ agent, trigger: 'idle' });
    await h.clock.advance(3 * 60 * MINUTE); // three hours of nothing
    assert.equal(h.model.requests.length, 1, 'a request was sent while the desktop was away');
    assert.equal(h.model.probes, probes_when_away, 'the desktop was probed after it said it was leaving');
    assert.equal(h.broker.pending().length, 4);

    // desktop_available alone is not enough: the probe has to pass first
    h.model.probe_ok = false;
    await h.broker.signal('desktop_available');
    assert.equal(h.broker.gate.state(), GATE_STATES.AWAY);
    await h.clock.advance(MINUTE);
    assert.equal(h.model.requests.length, 1, 'a request was sent before a probe passed');
    assert.ok(h.model.probes > probes_when_away);

    h.model.probe_ok = true;
    await h.clock.advance(BROKER_DEFAULTS.probe_interval_ms);
    assert.equal(h.broker.gate.state(), GATE_STATES.AVAILABLE);
    assert.equal(h.model.requests.length, 5);
    assert.equal(h.broker.pending().length, 0);
    // nothing about any of this is a failure or an alert
    assert.ok(h.events.length > 0);
    assert.ok(h.events.every((event) => event.severity === 'info' && event.type === 'agent.state'));
});

test('gate: a call in flight at desktop_leaving is cancelled and re-queued once', async () => {
    const h = await setupAvailable();
    h.model.hang = true;
    const { request } = h.broker.submit({ agent: 'Arthur', trigger: 'idle' });
    await h.clock.advance(20 * SECOND);
    assert.equal(h.model.requests.length, 1);
    assert.equal(h.broker.inFlight(), request);
    assert.equal(h.model.requests[0].signal.aborted, false);

    await h.broker.signal('desktop_leaving');
    assert.equal(h.model.requests[0].signal.aborted, true, 'the call was not cancelled');
    assert.equal(h.broker.gate.state(), GATE_STATES.AWAY);
    assert.equal(h.broker.inFlight(), null);
    assert.deepEqual(h.broker.pending(), [request]);                // back in the queue, exactly once
    assert.deepEqual(h.delivered, []);                              // the agent is not told anything failed
    assert.deepEqual(h.calls.map((c) => [c.outcome, c.attempt, c.valid]), [['cancelled', 1, false]]);
    assert.equal(h.calls[0].latency_ms, 20 * SECOND);
    assert.deepEqual(h.broker.budget.usage('Arthur', h.clock.now()), { used: 0, limit: 40 }); // a cancelled call is not counted
    assert.deepEqual(h.broker.pendingFor('Arthur'), { id: request.id, kind: 'plan', queued_at: new Date(request.queued_at).toISOString() });

    await h.clock.advance(10 * MINUTE);
    assert.equal(h.model.requests.length, 1);

    // the desktop comes back: the same request goes out once more, with a context built anew
    h.model.hang = false;
    await h.broker.signal('desktop_available');
    await h.clock.advance(10 * MINUTE);
    assert.equal(h.model.requests.length, 2);
    assert.equal(h.contexts.length, 2);
    assert.equal(h.contexts[1].request, request);
    assert.deepEqual(h.delivered.map((d) => [d.ok, d.request.id]), [[true, request.id]]);
    assert.deepEqual(h.calls.map((c) => c.outcome), ['cancelled', 'ok']);
    assert.equal(h.broker.pending().length, 0);
    assert.equal(h.broker.stats().requeued, 1);
});

test('gate: a request the agent replaced while its call was out is not re-queued, the newer one is kept', async () => {
    const h = await setupAvailable();
    h.model.hang = true;
    const first = h.broker.submit({ agent: 'Arthur', trigger: 'idle' }).request;
    await settle();
    const second = h.broker.submit({ agent: 'Arthur', trigger: 'attacked' }).request;
    await h.broker.signal('desktop_leaving');
    assert.deepEqual(h.broker.pending(), [second]);
    assert.deepEqual(h.delivered.map((d) => [d.request.id, d.reason]), [[first.id, 'replaced']]);
});

test('gate: two failed probes with no warning give AWAY and exactly one low-severity event', async () => {
    const h = await setupAvailable();
    const stamp = createEmitter({ agent: 'broker', send: () => {}, warn: () => {} });

    // one failed probe is not enough, and a passing one in between starts the count again
    h.model.probe_ok = false;
    await h.clock.advance(BROKER_DEFAULTS.probe_interval_ms);
    assert.equal(h.broker.gate.state(), GATE_STATES.AVAILABLE);
    h.model.probe_ok = true;
    await h.clock.advance(BROKER_DEFAULTS.probe_interval_ms);
    h.model.probe_ok = false;
    await h.clock.advance(BROKER_DEFAULTS.probe_interval_ms);
    assert.equal(h.broker.gate.state(), GATE_STATES.AVAILABLE);
    assert.deepEqual(h.events, []);

    await h.clock.advance(BROKER_DEFAULTS.probe_interval_ms); // the second failure in a row
    assert.equal(h.broker.gate.state(), GATE_STATES.AWAY);
    assert.equal(h.broker.gate.awayReason(), 'probe_failed');
    assert.equal(h.events.length, 1);

    await h.clock.advance(6 * 60 * MINUTE); // away all night: still that one event
    assert.equal(h.events.length, 1, `events: ${JSON.stringify(h.events)}`);
    const [event] = h.events;
    assert.equal(event.severity, 'info');
    assert.equal(event.type, 'agent.state');
    assert.deepEqual(event.data, { state: 'model_away', detail: { reason: 'probe_failed', failed_probes: 2 } });
    assert.ok(stamp.emit(event.type, event.data, { severity: event.severity }), 'the event does not fit the envelope');

    // nothing is sent while away, and no agent.failure exists anywhere
    h.broker.submit({ agent: 'Arthur', trigger: 'idle' });
    await h.clock.advance(MINUTE);
    assert.equal(h.model.requests.length, 0);

    // back through a passing probe alone: nobody has to say desktop_available
    h.model.probe_ok = true;
    await h.clock.advance(BROKER_DEFAULTS.probe_interval_ms);
    assert.equal(h.broker.gate.state(), GATE_STATES.AVAILABLE);
    assert.equal(h.model.requests.length, 1, 'the waiting request did not go out when the gate reopened');
    assert.deepEqual(h.events.map((e) => [e.data.state, e.data.detail.reason, e.severity]),
        [['model_away', 'probe_failed', 'info'], ['model_available', 'probe_passed', 'info']]);
});

test('gate: after desktop_leaving a passing probe does not reopen the gate, only desktop_available does', async () => {
    const h = await setupAvailable();
    // first lost without warning, then the launcher says the desktop is leaving after all
    h.model.probe_ok = false;
    await h.clock.advance(2 * BROKER_DEFAULTS.probe_interval_ms);
    assert.equal(h.broker.gate.awayReason(), 'probe_failed');
    await h.broker.signal('desktop_leaving');
    assert.equal(h.broker.gate.awayReason(), 'desktop_leaving');

    h.model.probe_ok = true;
    const probes = h.model.probes;
    h.broker.submit({ agent: 'Arthur', trigger: 'idle' });
    await h.clock.advance(60 * MINUTE);
    assert.equal(h.broker.gate.state(), GATE_STATES.AWAY);
    assert.equal(h.model.probes, probes, 'the desktop was probed after it said it was leaving');
    assert.equal(h.model.requests.length, 0);

    await h.broker.signal('desktop_available');
    await settle();
    assert.equal(h.broker.gate.state(), GATE_STATES.AVAILABLE);
    assert.equal(h.model.requests.length, 1);
});

test('gate: a call in flight when the probes fail is cancelled and re-queued too', async () => {
    const h = await setupAvailable();
    h.model.hang = true;
    const { request } = h.broker.submit({ agent: 'Mira', trigger: 'idle' });
    await settle();
    h.model.probe_ok = false;
    await h.clock.advance(2 * BROKER_DEFAULTS.probe_interval_ms);
    assert.equal(h.broker.gate.state(), GATE_STATES.AWAY);
    assert.deepEqual(h.broker.pending(), [request]);
    assert.deepEqual(h.calls.map((c) => c.outcome), ['cancelled']);
    assert.deepEqual(h.delivered, []);
});

test('gate: starts AWAY, a hanging probe counts as failed, and a signal overrules a probe that is still out', async () => {
    const clock = fakeClock();
    const events = [];
    let answer = () => true;
    const gate = createModelGate({ probe: () => answer(), clock, emit: (type, data, opts) => events.push({ type, data, ...opts }) });
    assert.equal(gate.state(), GATE_STATES.AWAY);
    assert.equal(gate.isAvailable(), false);
    await gate.tick();                       // nobody said the desktop is there: no probe, no change
    assert.equal(gate.state(), GATE_STATES.AWAY);

    answer = () => new Promise(() => {});    // never answers
    const pending = gate.desktopAvailable();
    await clock.advance(5000);
    assert.equal(await pending, GATE_STATES.AWAY);
    answer = () => { throw new Error('ECONNREFUSED'); };
    assert.equal(await gate.tick(), GATE_STATES.AWAY);
    assert.deepEqual(events, []);            // a missing model is not reported at all

    answer = () => true;
    assert.equal(await gate.tick(), GATE_STATES.AVAILABLE);
    assert.deepEqual(events.map((e) => e.data.state), ['model_available']);

    // desktop_leaving while a probe is out: the probe's answer no longer counts
    let release;
    answer = () => new Promise((resolve) => { release = resolve; });
    const probe = gate.tick();
    await settle(2);
    await gate.desktopLeaving();
    release(true);
    await probe;
    assert.equal(gate.state(), GATE_STATES.AWAY);
    assert.equal(gate.awayReason(), 'desktop_leaving');
    assert.deepEqual(events.map((e) => e.data.state), ['model_available', 'model_leaving', 'model_away']);
    assert.ok(events.every((e) => e.severity === 'info'));
});

test('gate: probe_recovery (on by default) lets passing probes bring the gate back by themselves', async () => {
    assert.equal(GATE_DEFAULTS.probe_recovery, true);
    for (const probe_recovery of [false, true, undefined]) {
        const h = await setupAvailable(probe_recovery === undefined ? {} : { gate: { probe_recovery } });
        h.model.probe_ok = false;
        await h.clock.advance(2 * BROKER_DEFAULTS.probe_interval_ms);
        assert.equal(h.broker.gate.state(), GATE_STATES.AWAY);
        h.model.probe_ok = true;
        await h.clock.advance(2 * BROKER_DEFAULTS.probe_interval_ms);
        assert.equal(h.broker.gate.state(), probe_recovery === false ? GATE_STATES.AWAY : GATE_STATES.AVAILABLE);
    }
});

test('gate: the broker takes the desktop signals from an injected event source', async () => {
    const signals = new EventEmitter();
    const h = setup({ signals });
    await h.broker.start({ probe_first: false });
    assert.equal(h.broker.gate.state(), GATE_STATES.AWAY);
    h.broker.submit({ agent: 'Nova', trigger: 'idle' });
    await h.clock.advance(MINUTE);
    assert.equal(h.model.requests.length, 0);
    signals.emit('desktop_available');
    await settle();
    assert.equal(h.broker.gate.state(), GATE_STATES.AVAILABLE);
    assert.equal(h.model.requests.length, 1);
    signals.emit('desktop_leaving');
    await settle();
    assert.equal(h.broker.gate.state(), GATE_STATES.AWAY);
});

// ---- the budget ----

test('budget: the 41st call in an hour for one agent is refused and recorded (a repair retry counts)', async () => {
    const h = await setupAvailable();
    const first_call_at = h.clock.now();
    // 90 seconds between calls allow at most 40 in an hour, so the limit is only reached with repair
    // retries: each of these 20 requests gets an invalid reply first, and its one retry counts as a call
    for (let i = 0; i < 20; i++) {
        h.model.replies.push('this is not JSON');
        h.broker.submit({ agent: 'Arthur', trigger: `need ${i + 1}` });
        await h.clock.advance(91 * SECOND);
    }
    assert.equal(h.model.requests.length, 40);
    assert.equal(h.delivered.filter((d) => d.ok).length, 20);
    assert.deepEqual(h.calls.map((c) => c.attempt), Array.from({ length: 40 }, (_, i) => (i % 2) + 1));
    assert.ok(h.clock.now() - first_call_at < 60 * MINUTE);

    const { request } = h.broker.submit({ agent: 'Arthur', trigger: 'need 21' });
    await h.clock.advance(5 * MINUTE);
    assert.equal(h.model.requests.length, 40, 'the 41st call reached the model');
    const refused = h.delivered.at(-1);
    assert.deepEqual([refused.ok, refused.reason, refused.request.id], [false, 'budget_exhausted', request.id]);
    assert.equal(refused.retry_at, new Date(first_call_at + 60 * MINUTE).toISOString());
    const record = h.calls.at(-1);
    assert.equal(h.calls.length, 41);
    assert.equal(record.outcome, 'refused_budget');
    assert.equal(record.agent, 'Arthur');
    assert.equal(record.trigger, 'need 21');
    assert.equal(record.request_id, request.id);
    assert.equal(record.valid, false);
    assert.equal(record.raw_output, null);
    assert.match(record.errors[0], /hourly budget used up \(40 calls per hour\)/);
    assert.equal(h.broker.pending().length, 0); // refused, not parked

    // the budget is per agent: Mira is not affected
    h.broker.submit({ agent: 'Mira', trigger: 'idle' });
    await settle();
    assert.equal(h.model.requests.length, 41);
    assert.equal(h.calls.at(-1).agent, 'Mira');
    assert.equal(h.calls.at(-1).outcome, 'ok');

    // one real hour after Arthur's first call, he may call again
    await h.clock.advance(first_call_at + 60 * MINUTE - h.clock.now() + SECOND);
    h.broker.submit({ agent: 'Arthur', trigger: 'need 22' });
    await settle();
    assert.equal(h.model.requests.length, 42);
    assert.equal(h.delivered.at(-1).ok, true);
});

test('budget: 40 calls an hour is what the 90 seconds allow: without a repair retry no call is ever refused', async () => {
    const h = await setupAvailable();
    for (let i = 0; i < 45; i++) {
        h.broker.submit({ agent: 'Arthur', trigger: `need ${i + 1}` });
        await h.clock.advance(90 * SECOND); // each goes out the moment the 90 seconds are over
    }
    assert.equal(h.model.requests.length, 45);
    assert.equal(h.calls.filter((c) => c.outcome === 'refused_budget').length, 0);
    // 90 seconds after the 45th call the sliding hour holds the 39 calls before it that are not an hour old yet
    assert.deepEqual(h.broker.budget.usage('Arthur', h.clock.now()), { used: 39, limit: 40 });
});

test('budget: a second call inside 90 seconds is delayed, not dropped', async () => {
    const h = await setupAvailable();
    h.broker.submit({ agent: 'Arthur', trigger: 'first' });
    await settle();
    assert.equal(h.model.requests.length, 1);
    const first_ended = h.clock.now();

    await h.clock.advance(10 * SECOND);
    const { request } = h.broker.submit({ agent: 'Arthur', trigger: 'second' });
    await h.clock.advance(79 * SECOND);                  // 89 seconds after the first call
    assert.equal(h.model.requests.length, 1, 'the second call went out early');
    assert.deepEqual(h.broker.pending(), [request]);     // waiting, not dropped
    assert.equal(h.delivered.length, 1);

    // somebody else's request does not wait for Arthur's 90 seconds
    h.broker.submit({ agent: 'Mira', trigger: 'idle' });
    await settle();
    assert.equal(h.model.requests.length, 2);
    assert.equal(h.calls.at(-1).agent, 'Mira');

    await h.clock.advance(2 * SECOND);                   // 91 seconds
    assert.equal(h.model.requests.length, 3);
    assert.equal(h.contexts.at(-1).at, first_ended + 90 * SECOND); // sent the moment the 90 seconds were over
    const record = h.calls.at(-1);
    assert.deepEqual([record.agent, record.trigger, record.outcome], ['Arthur', 'second', 'ok']);
    assert.equal(record.queue_wait_ms, 80 * SECOND);
    assert.deepEqual(h.delivered.map((d) => d.ok), [true, true, true]);
    assert.equal(h.broker.pending().length, 0);
});

test('budget: usage survives a restart through the checkpoint snapshot', () => {
    const budget = createBudget();
    const t0 = 1_000_000;
    for (let i = 0; i < 40; i++) budget.finish(budget.spend('Arthur', t0 + i * 50_000), t0 + i * 50_000 + 5000);
    budget.finish(budget.spend('Mira', t0), t0 + 1000);
    const now = t0 + 40 * 50_000;
    const snapshot = JSON.parse(JSON.stringify(budget.snapshot(now)));

    const restored = createBudget();
    restored.restore(snapshot);
    assert.deepEqual(restored.check('Arthur', now), { ok: false, reason: 'hourly_limit', retry_at: t0 + 3600000 });
    assert.deepEqual(restored.check('Mira', now), { ok: true });
    assert.deepEqual(restored.check('Arthur', t0 + 3600000), { ok: true }); // the first call has left the hour
    assert.deepEqual(restored.check('Felix', now), { ok: true });
    assert.deepEqual(restored.check('Mira', t0 + 60_000), { ok: false, reason: 'min_gap', retry_at: t0 + 1000 + 90_000 });
    for (const junk of [null, undefined, {}, { Arthur: null }, { Arthur: { calls: 'x' } }, { Arthur: { calls: [['a', 'b'], null] } }]) {
        assert.doesNotThrow(() => restored.restore(junk));
        assert.deepEqual(restored.check('Arthur', now), { ok: true });
    }
});

// ---- the reply ----

test('reply: an option id that was not offered is rejected and retried once', async () => {
    const h = await setupAvailable();
    h.model.replies.push(reply('gather_wood', 'dig_to_bedrock'), reply('gather_wood', 'build_hall'));
    const { request } = h.broker.submit({ agent: 'Arthur', trigger: 'idle' });
    await settle();

    assert.equal(h.model.requests.length, 2);
    assert.deepEqual(h.calls.map((c) => [c.attempt, c.outcome, c.valid]), [[1, 'invalid', false], [2, 'ok', true]]);
    assert.match(h.calls[0].errors.join('\n'), /goals\[1\]\.option_id "dig_to_bedrock" was not offered/);
    assert.deepEqual(h.calls[0].chosen_ids, ['gather_wood']); // only ids that were offered are ever "chosen"
    assert.equal(h.calls[1].request_id, request.id);
    assert.notEqual(h.calls[0].call_id, h.calls[1].call_id);

    // the retry shows the model its rejected reply and what was wrong with it
    const retry = h.model.requests[1].messages;
    assert.equal(retry.length, 4);
    assert.equal(retry[2].role, 'assistant');
    assert.equal(retry[2].content, h.calls[0].raw_output);
    assert.match(retry[3].content, /"dig_to_bedrock" was not offered/);
    assert.deepEqual(h.model.requests[1].format, h.model.requests[0].format);

    assert.equal(h.delivered.length, 1);
    assert.equal(h.delivered[0].ok, true);
    assert.equal(h.delivered[0].call_id, h.calls[1].call_id);
    assert.deepEqual(h.delivered[0].chosen_ids, ['gather_wood', 'build_hall']);
    assert.deepEqual(h.delivered[0].reply, reply('gather_wood', 'build_hall'));
});

test('reply: once means once: a second invalid reply ends the request', async () => {
    const h = await setupAvailable();
    h.model.replies.push(reply('dig_to_bedrock'), 'Sure! Here are my goals: wood.', reply('gather_wood'));
    h.broker.submit({ agent: 'Arthur', trigger: 'idle' });
    await h.clock.advance(MINUTE);
    assert.equal(h.model.requests.length, 2, 'there was a second retry');
    assert.deepEqual(h.calls.map((c) => [c.attempt, c.outcome]), [[1, 'invalid'], [2, 'invalid']]);
    assert.deepEqual([h.delivered[0].ok, h.delivered[0].reason], [false, 'invalid_reply']);
    assert.match(h.delivered[0].errors[0], /not JSON/);
    assert.equal(h.broker.budget.usage('Arthur', h.clock.now()).used, 2); // both calls count
});

test('reply: validation accepts only the decided shape', () => {
    const ok = (value) => validatePlannerReply(JSON.stringify(value), IDS);
    assert.deepEqual(ok(reply('rest')), { ok: true, reply: reply('rest'), chosen_ids: ['rest'], errors: [] });
    assert.equal(ok(reply('rest', 'build_hall', 'gather_wood')).ok, true);
    assert.equal(ok({ thought: '', goals: [goal('rest')] }).ok, true);
    assert.equal(ok({ thought: 'x'.repeat(160), goals: [goal('rest', { title: 't'.repeat(60), reason: 'r'.repeat(140) })] }).ok, true);

    const broken = {
        'not offered': reply('fly_to_moon'),
        'no goals': { thought: 'hm', goals: [] },
        'four goals': reply('rest', 'build_hall', 'gather_wood', 'trade_mira'),
        'same option twice': reply('rest', 'rest'),
        'thought too long': { thought: 'x'.repeat(161), goals: [goal('rest')] },
        'title too long': { thought: 'hm', goals: [goal('rest', { title: 't'.repeat(61) })] },
        'reason too long': { thought: 'hm', goals: [goal('rest', { reason: 'r'.repeat(141) })] },
        'empty reason': { thought: 'hm', goals: [goal('rest', { reason: ' ' })] },
        'missing title': { thought: 'hm', goals: [{ option_id: 'rest', reason: 'because' }] },
        'no thought': { goals: [goal('rest')] },
        'thought not a string': { thought: 7, goals: [goal('rest')] },
        'extra top-level field': { ...reply('rest'), command: '!newAction' },
        'extra goal field': { thought: 'hm', goals: [goal('rest', { code: 'x' })] },
        'goal not an object': { thought: 'hm', goals: ['rest'] },
        'goals not a list': { thought: 'hm', goals: goal('rest') },
        'option id not a string': { thought: 'hm', goals: [goal(3)] },
        'a list': [reply('rest')],
    };
    for (const [name, value] of Object.entries(broken)) {
        const result = ok(value);
        assert.equal(result.ok, false, `accepted: ${name}`);
        assert.equal(result.reply, null);
        assert.ok(result.errors.length > 0);
    }
    for (const raw of ['', '   ', 'null', '42', '"rest"', '{"thought": "cut off', '```json\n{}\n```', undefined, null, 7, {}]) {
        assert.equal(validatePlannerReply(raw, IDS).ok, false, `accepted raw ${JSON.stringify(raw)}`);
    }
    // an id is only valid for the call that offered it
    assert.equal(validatePlannerReply(JSON.stringify(reply('rest')), ['gather_wood']).ok, false);
});

test('reply: the schema sent to the model allows only the ids offered in this call', () => {
    const schema = plannerReplySchema(['a', 'b']);
    assert.deepEqual(schema.required, ['thought', 'goals']);
    assert.equal(schema.additionalProperties, false);
    assert.equal(schema.properties.thought.maxLength, 160);
    assert.deepEqual([schema.properties.goals.minItems, schema.properties.goals.maxItems], [1, 2]); // two options: at most two goals
    assert.equal(plannerReplySchema(IDS).properties.goals.maxItems, 3);
    const item = schema.properties.goals.items;
    assert.deepEqual(item.properties.option_id.enum, ['a', 'b']);
    assert.deepEqual(item.required, ['option_id', 'title', 'reason']);
    assert.deepEqual([item.properties.title.maxLength, item.properties.reason.maxLength], [60, 140]);

    const messages = buildPlannerMessages({ agent: 'Arthur', context: 'Night is coming.', options: OPTIONS });
    assert.deepEqual(messages.map((m) => m.role), ['system', 'user']);
    assert.match(messages[0].content, /Arthur/);
    assert.match(messages[1].content, /Night is coming\./);
    for (const option of OPTIONS) assert.ok(messages[1].content.includes(`- ${option.id}: ${option.description}`));

    assert.deepEqual(checkOptions(OPTIONS), []);
    for (const bad of [null, [], [{ id: '' }], [{ id: 'a', description: 'x' }, { id: 'a', description: 'y' }], [{ id: 'a' }], ['a']]) {
        assert.ok(checkOptions(bad).length > 0, `accepted options ${JSON.stringify(bad)}`);
    }
});

// ---- the queue ----

test('queue: a newer request replaces the older pending one', async () => {
    const h = setup();
    await h.broker.start({ probe_first: false }); // the gate is AWAY: requests wait
    const older = h.broker.submit({ agent: 'Arthur', trigger: 'idle' });
    h.broker.submit({ agent: 'Mira', trigger: 'idle' });
    await h.clock.advance(30 * SECOND);
    const newer = h.broker.submit({ agent: 'Arthur', trigger: 'attacked by a zombie' });

    assert.equal(older.replaced, null);
    assert.equal(newer.replaced, older.request);
    assert.deepEqual(h.broker.pending().map((r) => [r.agent, r.trigger]), [['Arthur', 'attacked by a zombie'], ['Mira', 'idle']]);
    assert.deepEqual(h.broker.pendingFor('Arthur').id, newer.request.id);
    assert.deepEqual(h.delivered.map((d) => [d.request.id, d.ok, d.reason, d.replaced_by]),
        [[older.request.id, false, 'replaced', newer.request.id]]);
    assert.equal(h.contexts.length, 0); // nothing is built while a request waits

    await h.clock.advance(5 * MINUTE);
    await h.broker.signal('desktop_available');
    await settle();
    // one call for Arthur, for the newer request, with a context built at dispatch time
    const arthur_calls = h.calls.filter((c) => c.agent === 'Arthur');
    assert.equal(arthur_calls.length, 1);
    assert.equal(arthur_calls[0].trigger, 'attacked by a zombie');
    assert.equal(arthur_calls[0].request_id, newer.request.id);
    assert.equal(h.contexts[0].request, newer.request);
    assert.equal(h.contexts[0].at, h.clock.now());
    assert.equal(arthur_calls[0].queue_wait_ms, 5 * MINUTE); // measured from the newer request
    assert.equal(h.model.requests.length, 2);
});

test('queue: one pending request per agent, served in the order the agents started waiting', () => {
    const queue = createRequestQueue();
    const request = (agent, queued_at, id = `${agent}-${queued_at}`) => ({ id, agent, kind: 'plan', trigger: null, queued_at });
    assert.equal(queue.put(request('Arthur', 100)), null);
    assert.equal(queue.put(request('Mira', 200)), null);
    assert.equal(queue.put(request('Felix', 300)), null);
    const replaced = queue.put(request('Arthur', 400));
    assert.equal(replaced.id, 'Arthur-100');
    assert.equal(queue.size(), 3);
    assert.deepEqual(queue.list().map((r) => r.id), ['Arthur-400', 'Mira-200', 'Felix-300']); // Arthur keeps his place
    const mira = queue.get('Mira');
    assert.equal(queue.remove(mira), true);
    assert.equal(queue.remove(mira), false);
    assert.equal(queue.requeue(mira), true);
    assert.equal(queue.requeue(request('Felix', 250)), false); // Felix already has a newer one waiting
    assert.deepEqual(queue.list().map((r) => r.id), ['Arthur-400', 'Mira-200', 'Felix-300']);
    assert.deepEqual(setup().broker.submit({ agent: '' }), { ok: false, error: 'agent must be a non-empty string' });
});

// ---- the broker as a whole ----

test('broker: one model call at a time, whoever asks', async () => {
    const h = await setupAvailable();
    h.model.delay_ms = 20 * SECOND;
    for (const agent of ['Arthur', 'Mira', 'Felix', 'Nova']) h.broker.submit({ agent, trigger: 'idle' });
    await h.clock.advance(1);
    assert.equal(h.model.requests.length, 1);
    assert.equal(h.broker.stats().in_flight, true);
    await h.clock.advance(5 * MINUTE);
    assert.equal(h.model.requests.length, 4);
    assert.equal(h.model.max_active, 1);
    assert.deepEqual(h.calls.map((c) => c.agent), ['Arthur', 'Mira', 'Felix', 'Nova']);
    assert.deepEqual(h.calls.map((c) => c.queue_wait_ms), [0, 20 * SECOND, 40 * SECOND, 60 * SECOND]);
    assert.ok(h.calls.every((c) => c.latency_ms === 20 * SECOND));
});

test('broker: every call is recorded with all the decided fields', async () => {
    const h = await setupAvailable();
    h.model.delay_ms = 7 * SECOND;
    await h.clock.advance(3 * SECOND);
    const { request } = h.broker.submit({ agent: 'Nova', trigger: 'market opened' });
    await h.clock.advance(MINUTE);
    assert.equal(h.calls.length, 1);
    const [record] = h.calls;
    assert.deepEqual(Object.keys(record), [...CALL_RECORD_FIELDS]);
    assert.match(record.call_id, /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    assert.deepEqual({ ...record, call_id: null }, {
        call_id: null,
        request_id: request.id,
        agent: 'Nova',
        trigger: 'market opened',
        context: 'context 1 for Nova',
        options_offered: OPTIONS,
        raw_output: JSON.stringify(reply('gather_wood')),
        chosen_ids: ['gather_wood'],
        valid: true,
        attempt: 1,
        queue_wait_ms: 0,
        latency_ms: 7 * SECOND,
        prompt_tokens: 321,
        completion_tokens: 45,
        model: 'stub-model:latest',
        outcome: 'ok',
        errors: [],
        started_at: new Date(request.queued_at).toISOString(),
    });
    // what the model was given: the context and options of this call, and the schema as `format`
    const sent = h.model.requests[0];
    assert.deepEqual(sent.format, plannerReplySchema(IDS));
    assert.match(sent.messages[1].content, /context 1 for Nova/);
    assert.equal(sent.timeout_ms, 90000);
    assert.ok(sent.signal instanceof AbortSignal);
    for (const outcome of CALL_OUTCOMES) assert.equal(makeCallRecord({ call_id: 'c', agent: 'a', outcome }).outcome, outcome);
    assert.deepEqual(Object.keys(makeCallRecord({ call_id: 'c', agent: 'a' })), [...CALL_RECORD_FIELDS]);
});

test('broker: a call with no reply is given up after 90 seconds, and the next request goes on', async () => {
    const h = await setupAvailable();
    h.model.hang = true;
    h.broker.submit({ agent: 'Arthur', trigger: 'idle' });
    h.broker.submit({ agent: 'Mira', trigger: 'idle' });
    await h.clock.advance(89 * SECOND);
    assert.equal(h.calls.length, 0);
    h.model.hang = false;
    await h.clock.advance(2 * SECOND);
    assert.equal(h.model.requests[0].signal.aborted, true);
    assert.deepEqual(h.calls.map((c) => [c.agent, c.outcome, c.latency_ms]), [['Arthur', 'timeout', 90 * SECOND], ['Mira', 'ok', 0]]);
    assert.deepEqual(h.delivered.map((d) => [d.request.agent, d.ok, d.reason ?? null]), [['Arthur', false, 'timeout'], ['Mira', true, null]]);
    assert.equal(h.model.requests.length, 2); // no retry after a timeout
    assert.equal(h.broker.gate.state(), GATE_STATES.AVAILABLE); // the probe still passes
});

test('broker: a failing model call, a failing call store and a failing receiver stop nothing', async () => {
    let fail_store = true;
    const h = await setupAvailable({
        calls: { record: () => { if (fail_store) throw new Error('postgres is down'); return Promise.reject(new Error('postgres is slow and down')); } },
        deliver: () => { throw new Error('the agent went away'); },
    });
    h.model.replies.push(new Error('socket hang up'));
    h.broker.submit({ agent: 'Arthur', trigger: 'idle' });
    await settle();
    fail_store = false;
    h.broker.submit({ agent: 'Mira', trigger: 'idle' });
    await settle();
    assert.equal(h.model.requests.length, 2);
    const stats = h.broker.stats();
    assert.equal(stats.errors, 1);
    assert.equal(stats.valid, 1);
    assert.equal(stats.record_failures, 2);
    assert.equal(stats.in_flight, false);
});

test('broker: a context that cannot be built ends the request without a model call', async () => {
    let build = async () => { throw new Error('no position yet'); };
    const h = await setupAvailable({ buildContext: (request) => build(request) });
    h.broker.submit({ agent: 'Arthur', trigger: 'idle' });
    await settle();
    build = async () => ({ context: 'ok', options: [] });
    h.broker.submit({ agent: 'Mira', trigger: 'idle' });
    await settle();
    assert.equal(h.model.requests.length, 0);
    assert.deepEqual(h.delivered.map((d) => d.reason), ['context_error', 'context_error']);
    assert.match(h.delivered[0].error, /no position yet/);
    assert.match(h.delivered[1].error, /options must be a non-empty list/);
});

test('broker: stop() ends the timers and keeps the queue', async () => {
    const h = await setupAvailable();
    await h.broker.signal('desktop_leaving');
    h.broker.submit({ agent: 'Arthur', trigger: 'idle' });
    h.broker.stop();
    assert.equal(h.clock.pending(), 0);
    assert.equal(h.broker.pending().length, 1);
});

// ---- the thin Ollama client (a real HTTP exchange with a local server) ----

// ---- the small calls: the spoken line, and the decision about a request or offer ----

const DECISION_FORMAT = { type: 'object', properties: { decision: { type: 'string', enum: ['accept', 'decline'] }, reason: { type: 'string' } }, required: ['decision', 'reason'] };
const decide = (broker, agent, more = {}) => broker.small({
    agent, kind: 'message_decision', trigger: { kind: 'message_decision', detail: { msg_id: 'm-0001-1' } },
    messages: [{ role: 'system', content: 'decide' }, { role: 'user', content: `for ${agent}` }], format: DECISION_FORMAT,
    validate: (raw) => { try { return ['accept', 'decline'].includes(JSON.parse(raw).decision); } catch { return false; } }, ...more,
});
const YES = JSON.stringify({ decision: 'accept', reason: 'It can be spared.' });

test('small calls: the decision is a kind of its own, with its own named hourly limit and token limit', async () => {
    assert.deepEqual([...SMALL_KINDS], ['chat_line', 'message_decision']);
    assert.deepEqual({ ...DECISION_CALL_DEFAULTS }, { max_calls: 20, window_ms: 3600000, min_gap_ms: 0, timeout_ms: 15000, max_tokens: 80, wait_ms: 120000 });
    const h = await setupAvailable({ decision: { max_calls: 2 } });
    assert.deepEqual(h.broker.smallLimits('message_decision'), { ...DECISION_CALL_DEFAULTS, max_calls: 2 });
    assert.equal(h.broker.smallLimits('chat_line').max_calls, SMALL_CALL_DEFAULTS.max_calls);
    assert.equal(h.broker.smallLimits('gossip'), null);

    h.model.replies.push(YES);
    const first = await decide(h.broker, 'Felix');
    assert.deepEqual([first.ok, first.content], [true, YES]);
    // the model was given the decision's own token limit and time-out, and the reply's schema
    assert.deepEqual([h.model.requests[0].max_tokens, h.model.requests[0].timeout_ms, h.model.requests[0].format], [80, 15000, DECISION_FORMAT]);
    // recorded like every call, as its own kind
    assert.deepEqual([h.calls[0].agent, h.calls[0].trigger.kind, h.calls[0].outcome, h.calls[0].valid, h.calls[0].call_id], ['Felix', 'message_decision', 'ok', true, first.call_id]);
    // a reply that fails validation is not used, and it counts
    h.model.replies.push('{"decision":"perhaps","reason":"hm"}');
    const second = await decide(h.broker, 'Felix');
    assert.deepEqual([second.ok, second.reason], [false, 'invalid_reply']);
    assert.equal(h.calls[1].outcome, 'invalid');

    // the limit is spent (2 an hour here): refused at once, the model is not asked
    const third = await decide(h.broker, 'Felix');
    assert.deepEqual([third.ok, third.reason], [false, 'budget_exhausted']);
    assert.equal(h.model.requests.length, 2);
    assert.deepEqual(h.broker.decisionBudget.usage('Felix', h.clock.now()), { used: 2, limit: 2 });
    // it is per agent, and it is not the line budget or the planning budget
    h.model.replies.push(YES);
    assert.equal((await decide(h.broker, 'Mira')).ok, true);
    assert.equal(h.broker.smallBudget.usage('Felix', h.clock.now()).used, 0);
    assert.equal(h.broker.budget.usage('Felix', h.clock.now()).used, 0);
    h.model.replies.push('{"line":"Hello."}');
    const line = await h.broker.small({ agent: 'Felix', messages: [{ role: 'user', content: 'say hello' }], validate: () => true });
    assert.equal(line.ok, true, 'a line was refused because the decisions were spent');
    assert.equal(h.model.requests.at(-1).max_tokens, SMALL_CALL_DEFAULTS.max_tokens);
    assert.deepEqual([h.broker.stats().decision_calls, h.broker.stats().decision_refused, h.broker.stats().small_calls], [3, 1, 4]);

    // an hour later the agent may decide again; the limits can be set from a setting, and only known kinds have any
    await h.clock.advance(60 * MINUTE + SECOND);
    h.model.replies.push(YES);
    assert.equal((await decide(h.broker, 'Felix')).ok, true);
    assert.deepEqual(h.broker.setSmallLimits('message_decision', { max_calls: 5, max_tokens: 40, timeout_ms: 9000, wait_ms: 1000, min_gap_ms: 77, nonsense: 1 }),
        { ...DECISION_CALL_DEFAULTS, max_calls: 5, max_tokens: 40, timeout_ms: 9000, wait_ms: 1000 });
    assert.equal(h.broker.decisionBudget.usage('Felix', h.clock.now()).limit, 5);
    assert.equal(h.broker.setSmallLimits('gossip', { max_calls: 99 }), null);
    assert.deepEqual((await h.broker.small({ agent: 'Felix', kind: 'gossip', messages: [] })), { ok: false, reason: 'bad_request' });
});

test('small calls: a decision waits its turn behind a busy model, goes before the next planning call, and never waits for a model that is away', async () => {
    const h = await setupAvailable();
    h.model.delay_ms = 10 * SECOND;
    // Arthur's planning call is out, Mira's request waits behind it
    h.model.replies.push(reply('gather_wood'), YES, reply('rest'));
    h.broker.submit({ agent: 'Arthur', trigger: 'idle' });
    await settle();
    h.broker.submit({ agent: 'Mira', trigger: 'idle' });
    await settle();
    assert.equal(h.model.requests.length, 1);

    // a line never waits: the template is used
    assert.deepEqual(await h.broker.small({ agent: 'Felix', messages: [{ role: 'user', content: 'say hello' }] }), { ok: false, reason: 'model_busy' });
    // a decision waits (20 seconds at most), and is next when the model is free: before Mira's planning call
    let decided = null;
    decide(h.broker, 'Felix').then((result) => { decided = result; });
    await h.clock.advance(9 * SECOND);
    assert.equal(decided, null);
    assert.equal(h.model.requests.length, 1, 'two calls at the same time');
    await h.clock.advance(2 * SECOND);  // Arthur's call has ended
    assert.equal(h.model.requests.length, 2);
    assert.deepEqual(h.model.requests[1].format, DECISION_FORMAT, 'the planning call that waited went before the decision');
    assert.equal(h.model.max_active, 1);
    await h.clock.advance(10 * SECOND); // the decision has ended, Mira's call is out
    assert.deepEqual([decided.ok, decided.content], [true, YES]);
    assert.equal(h.model.requests.length, 3);
    await h.clock.advance(11 * SECOND);
    assert.deepEqual(h.delivered.map((d) => [d.request.agent, d.ok]), [['Arthur', true], ['Mira', true]]);
    assert.equal(h.model.max_active, 1, 'more than one model call at a time');
    assert.equal(h.broker.stats().small_waited, 1);

    // a model that stays busy longer than the wait: the decision is given up (the caller's code rule decides)
    h.model.delay_ms = 60 * SECOND;
    h.broker.submit({ agent: 'Arthur', trigger: 'again' });
    await h.clock.advance(91 * SECOND); // (past the 90 seconds between Arthur's calls: his call is out now)
    const calls = h.model.requests.length;
    let late = null;
    // (decided: the wait is up to the message's expiry, 120 seconds; here a shorter one is set, as the relay does for a message with less life left)
    h.broker.setSmallLimits('message_decision', { wait_ms: 20 * SECOND });
    decide(h.broker, 'Felix').then((result) => { late = result; });
    await h.clock.advance(19 * SECOND);
    assert.equal(late, null);
    await h.clock.advance(2 * SECOND);
    assert.deepEqual(late, { ok: false, reason: 'model_busy' });
    assert.equal(h.model.requests.length, calls, 'the decision went out after it was given up');
    assert.equal(h.broker.decisionBudget.usage('Felix', h.clock.now()).used, 1, 'a decision that was never made was counted');

    // the desktop leaves while a decision waits: answered at once, nothing is sent
    let left = null;
    decide(h.broker, 'Felix').then((result) => { left = result; });
    await settle();
    await h.broker.signal('desktop_leaving');
    await settle();
    assert.deepEqual(left, { ok: false, reason: 'model_away' });
    // and with the gate shut no decision is ever sent
    assert.deepEqual(await decide(h.broker, 'Felix'), { ok: false, reason: 'model_away' });
    assert.equal(h.model.requests.length, calls);
});

test('ollama planner: sends the schema in the documented `format` field and reads the reply and token counts', async () => {
    const seen = [];
    const server = await httpServer((req, res, body) => {
        seen.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/api/version') return res.end(JSON.stringify({ version: '0.5.1' }));
        res.end(JSON.stringify({
            model: 'planner:latest', created_at: '2026-01-01T00:00:00Z',
            message: { role: 'assistant', content: JSON.stringify(reply('rest')) },
            done_reason: 'stop', done: true, prompt_eval_count: 412, eval_count: 38,
        }));
    });
    const planner = createOllamaPlanner({ url: server.url, model: 'planner', options: { temperature: 0 } });
    assert.equal(planner.name, 'planner');
    assert.equal(await planner.probe(), true);
    const messages = buildPlannerMessages({ agent: 'Arthur', context: 'Night.', options: OPTIONS });
    const answer = await planner.chat({ messages, format: plannerReplySchema(IDS), timeout_ms: 5000 });
    assert.deepEqual(answer, { content: JSON.stringify(reply('rest')), prompt_tokens: 412, completion_tokens: 38, model: 'planner:latest' });
    assert.equal(validatePlannerReply(answer.content, IDS).ok, true);

    assert.deepEqual(seen.map((s) => [s.method, s.url]), [['GET', '/api/version'], ['POST', '/api/chat']]);
    assert.deepEqual(seen[1].body, {
        model: 'planner', messages, stream: false, format: plannerReplySchema(IDS), options: { temperature: 0 },
    });
    // without options, the request carries none
    await createOllamaPlanner({ url: server.url, model: 'planner' }).chat({ messages, format: plannerReplySchema(IDS), timeout_ms: 5000 });
    assert.deepEqual(Object.keys(seen[2].body), ['model', 'messages', 'stream', 'format']);
});

test('ollama planner: typed errors, a probe that never throws, and cancelling through the signal', { timeout: 20000 }, async () => {
    const dead = createOllamaPlanner({ url: `http://127.0.0.1:${await refusedPort()}`, model: 'planner', probe_timeout_ms: 500 });
    assert.equal(await dead.probe(), false);
    await assert.rejects(dead.chat({ messages: [], format: {}, timeout_ms: 500 }), { name: 'ModelUnavailableError' });

    const silent = await silentServer();
    const mute = createOllamaPlanner({ url: silent.url, model: 'planner', probe_timeout_ms: 200 });
    assert.equal(await mute.probe(), false);
    await assert.rejects(mute.chat({ messages: [], format: {}, timeout_ms: 200 }), { name: 'ModelTimeoutError' });
    const controller = new AbortController();
    const started = Date.now();
    const call = mute.chat({ messages: [], format: {}, signal: controller.signal, timeout_ms: 10000 });
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(call, { name: 'ModelUnavailableError', message: /cancelled/ });
    assert.ok(Date.now() - started < 3000);

    const odd = await httpServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ done: true })); });
    await assert.rejects(createOllamaPlanner({ url: odd.url, model: 'planner' }).chat({ messages: [], format: {}, timeout_ms: 2000 }),
        { name: 'ModelInvalidResponseError' });
    const missing = await httpServer((req, res) => { res.statusCode = 404; res.end('{"error":"model \\"planner\\" not found"}'); });
    await assert.rejects(createOllamaPlanner({ url: missing.url, model: 'planner' }).chat({ messages: [], format: {}, timeout_ms: 2000 }),
        { name: 'ModelUnavailableError', status: 404 });
});
