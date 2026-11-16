// Step 8, planning calls wired in: the planner broker runs in its host (as inside the
// MindServer), the agents send it planning requests over their sockets, and the reply's
// goals go into the short-term queue.
//
// Real: the broker, its gate, queue and budget, the host, the agent runtime (executor,
// planner client, routine), the goal store, the checkpoint store, the event emitter.
// Stand-ins: the model (it counts what it is asked), the world, the clock, the sockets.
// Run from the repository root:  node --test genesis/tests/*.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeClock, settle, fakeGoalStorage } from './helpers/fakes.mjs';
import { makeTown, socketPair, stubModel } from './helpers/town.mjs';
import { GATE_STATES } from '../broker/gate.js';
import { BUDGET_DEFAULTS } from '../broker/budget.js';
import { CALL_RECORD_FIELDS } from '../broker/call_record.js';
import { validateEvent } from '../shared/events.js';
import { decodeCheckpoint } from '../store/checkpoint.js';
import {
    buildPlanContext, estimatePromptTokens, estimateTokens, planOptions, describeTrigger, PROMPT_LIMITS, MEMORY_SLOT_EMPTY,
} from '../planning/context.js';
import { createPlanningHost, createHostGoalStorage, socketGoalStorage } from '../planning/host.js';
import { PLANNER_CLIENT_DEFAULTS } from '../planning/agent_planner.js';
import { createCatalog } from '../catalog/catalog.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const goal = (option_id, title = `Do ${option_id}`.slice(0, 60)) => ({ option_id, title, reason: 'the test chose it' });
const reply = (...ids) => ({ thought: 'Wood first, then the rest.', goals: ids.map((id) => goal(id)) });
const promptOf = (request) => request.messages.map((message) => message.content).join('\n');

async function town(options = {}, { available = true } = {}) {
    const t = makeTown({ clock: fakeClock(), ...options });
    await t.start({ available });
    await settle();
    return t;
}

function assertEventsValid(agent) {
    agent.events.forEach((event, index) => {
        assert.deepEqual(validateEvent(event), { ok: true, errors: [] }, `event ${index} (${event.type})`);
        if (index > 0) assert.equal(event.seq, agent.events[index - 1].seq + 1);
    });
}

// ---- the prompt ----------------------------------------------------------------------------

test('context: the prompt stays within about 1,200 tokens and keeps 240 of them for memory', async () => {
    const t = await town({ agents: ['Arthur'] }, { available: false });
    const arthur = t.agents.Arthur;
    // an agent with a lot to say: a full inventory, three long-term goals, the longest ids on offer
    const body = t.world.body('Arthur');
    for (let i = 0; i < 28; i++) body.inventory[`some_rather_long_item_name_${i}`] = 64 - i;
    Object.assign(body.inventory, { oak_log: 30, wooden_pickaxe: 1, oak_planks: 40, raw_iron: 8, coal: 4, wheat: 9 });
    arthur.runtime.ledger.set('kits', { bread: 9, torch: 20 }, 0);
    arthur.runtime.ledger.set('shared', { cobblestone: 64 }, 0);
    const catalog = createCatalog({ zones: t.zones, blueprints: { get: () => null } });
    const options = catalog.offer(arthur.runtime.state());
    assert.ok(options.length >= 12, `only ${options.length} options`);
    const long_term = [1, 2, 3].map((n) => ({ title: `Long-term goal number ${n} with a title that uses all sixty characters` }));
    const built = buildPlanContext({
        agent: 'Arthur', role: 'builder', trigger: { kind: 'operator_message', detail: { from: 'Soup', text: 'x'.repeat(900) } },
        view: t.world.view('Arthur'), home_distance: 12, long_term, last_outcome: { title: 'Gather 8 oak_log', outcome: 'failed', reason: 'no_safe_path' },
        routine: { name: 'Site upkeep', phase: 'Gather' }, memory: '', options,
    });
    assert.deepEqual(built.options.map((option) => option.id), options.map((option) => option.id), 'the options are exactly what was offered');
    assert.ok(built.options.every((option) => option.description.length <= PROMPT_LIMITS.option_description));
    // the memory slot is there, named and empty, and its share is counted whether used or not
    assert.ok(built.context.endsWith(`Memory: ${MEMORY_SLOT_EMPTY}`));
    assert.equal(built.tokens.memory_reserved, 240);
    assert.ok(built.tokens.total <= PROMPT_LIMITS.total_tokens, `estimated ${built.tokens.total} tokens`);
    const whole = estimatePromptTokens({ agent: 'Arthur', context: built.context, options: built.options });
    assert.ok(whole - estimateTokens(MEMORY_SLOT_EMPTY) + PROMPT_LIMITS.memory_tokens <= PROMPT_LIMITS.total_tokens);
    // what had to go went in order of importance: the operator's words and the state stay
    assert.match(built.context, /the operator \(Soup\) says: "x{200,239}…"/);
    assert.match(built.context, /Health 20\/20, food 20\/20/);
    // a memory text is clipped to its share
    const with_memory = buildPlanContext({ agent: 'Arthur', view: t.world.view('Arthur'), options, memory: 'm'.repeat(5000) });
    assert.ok(estimateTokens(with_memory.context.split('Memory: ')[1]) <= PROMPT_LIMITS.memory_tokens);
    assert.ok(with_memory.tokens.total <= PROMPT_LIMITS.total_tokens);

    // a small case keeps every line
    const small = buildPlanContext({ agent: 'Mira', role: 'farmer', trigger: { kind: 'goal_complete' }, view: t.world.view('Arthur'), options: options.slice(0, 2), long_term: [{ title: 'Feed the camp' }] });
    assert.match(small.context, /^You are Mira, the farmer\.\nAsked because: the goals you had are finished\.\nAt 0, 64, 0/);
    assert.match(small.context, /Long-term goals: 1\) Feed the camp\./);
    assert.match(small.context, /Carrying: /);
    assert.equal(describeTrigger({ kind: 'step_failed', detail: { reason: 'no_safe_path' } }), 'a goal failed (no_safe_path).');
    assert.deepEqual(planOptions([{ id: 'a:b', description: 'x'.repeat(200), title: 't', skill: 's' }]), [{ id: 'a:b', description: `${'x'.repeat(79)}…` }]);
    await t.stop();
});

// ---- the whole loop ------------------------------------------------------------------------

test('a trigger becomes one planning call, and the reply\'s goals go into the queue with source planner and the call id', async () => {
    const t = await town({ agents: ['Arthur'], inventories: { Arthur: { oak_log: 6 } } });
    const arthur = t.agents.Arthur;
    assert.equal(t.broker.gate.state(), GATE_STATES.AVAILABLE);
    assert.equal(arthur.runtime.planner.gate(), 'AVAILABLE');
    // the agent came up with nothing to do and the model there: it asked once
    assert.equal(t.model.requests.length, 1);
    await Promise.all(arthur.pending_results);

    // what the model was offered is exactly what the catalog offered when the call went out
    const offered = t.model.offered(0);
    assert.deepEqual(offered, arthur.runtime.executor ? createCatalog({ zones: t.zones }).offer(arthur.runtime.state()).map((option) => option.id) : null);
    assert.ok(offered.includes('store_items:shared:oak_log'));
    const prompt = promptOf(t.model.requests[0]);
    assert.match(prompt, /You are Arthur, the builder\./);
    assert.match(prompt, /Asked because: the planner is back/);
    assert.match(prompt, /Memory: \(nothing yet\)/);
    assert.ok(estimateTokens(prompt) <= PROMPT_LIMITS.total_tokens - PROMPT_LIMITS.memory_tokens + estimateTokens(MEMORY_SLOT_EMPTY));

    // the call is recorded, whole
    assert.equal(t.calls.length, 1);
    const [call] = t.calls;
    assert.deepEqual(Object.keys(call), [...CALL_RECORD_FIELDS]);
    assert.equal(call.outcome, 'ok');
    assert.equal(call.agent, 'Arthur');
    assert.deepEqual(call.trigger, { kind: 'model_returned', detail: {} });
    assert.deepEqual(call.options_offered.map((option) => option.id), offered);
    assert.deepEqual(call.chosen_ids, [offered[0]]);
    assert.equal(call.prompt_tokens, 600);
    assert.ok(call.context.includes('Memory: (nothing yet)'));

    // the goal is in the queue through the goal store: source planner, with the call id
    const queued = arthur.changes().find((change) => change.source === 'planner');
    assert.equal(queued.call_id, call.call_id);
    assert.equal(queued.scope, 'short_term');
    assert.equal(queued.reason, 'First things first.');
    assert.deepEqual(queued.after.map((g) => g.option_id), [offered[0]]);
    assert.deepEqual((await arthur.queue()).map((g) => g.option_id), [offered[0]]);
    assert.deepEqual(t.storage.stats().saved, 1, 'the goal change was not stored in the MindServer');

    // while the next call waits for its 90 seconds the agent does not stand still: after a short
    // grace it works from its routine (here it stores its logs)
    // one to three goals: all of them are queued, in the model's order, and carried out with no further call
    t.model.replies.push(reply('travel:plot-plot-1', 'travel:field', 'harvest_replant:field'));
    t.run();
    await t.clock.advance(150 * SECOND);
    assert.equal(t.model.requests.length, 2, 'one call for the finished goal, 90 seconds after the first');
    const chosen = arthur.eventsOf('agent.decision').filter((event) => event.data.call_id === t.calls[1].call_id);
    assert.deepEqual(chosen.map((event) => event.data.args[0]), ['travel:plot-plot-1', 'travel:field', 'harvest_replant:field']);
    assert.equal(t.world.body('Arthur').inventory.oak_log, undefined, 'the routine did not store the logs while the agent waited');
    assert.ok(chosen.every((event) => event.data.trigger === 'planner'));
    assert.ok(arthur.eventsOf('agent.decision').some((event) => event.data.trigger === 'routine'), 'the agent stood still while it waited for the gap');
    assert.equal(t.calls[1].trigger.kind, 'goal_complete');
    assert.ok(t.calls[1].queue_wait_ms >= BUDGET_DEFAULTS.min_gap_ms - 30 * SECOND, 'the second call did not wait for the 90 second gap');
    assert.equal(arthur.runtime.lastThought().text, 'Wood first, then the rest.');
    assertEventsValid(arthur);
    await t.stop();
});

test('the context is rebuilt when the request is dispatched, not when it was queued', async () => {
    const t = await town({ agents: ['Arthur'] }, { available: false });
    await t.host.signal('desktop_leaving');
    const arthur = t.agents.Arthur;
    arthur.runtime.operatorMessage('Soup', 'please store what you carry');
    await settle();
    assert.equal(t.broker.pending().length, 1);
    assert.equal(t.model.requests.length, 0);
    assert.equal(arthur.socket.sent.filter(([name]) => name === 'genesis-plan-request').length, 1);

    // hours later the world is another one: the agent carries iron and coal, and stands in the field
    await t.clock.advance(3 * 60 * MINUTE);
    Object.assign(t.world.body('Arthur').inventory, { raw_iron: 5, coal: 3 });
    t.world.body('Arthur').position = { x: 14, y: 64, z: 0 };
    t.model.probe_ok = true;
    await t.host.signal('desktop_available');
    await settle();
    assert.equal(t.model.requests.length, 1);
    assert.ok(t.model.offered().includes('smelt_item:raw_iron:5'), 'the options are from when the request was queued');
    assert.ok(t.model.offered().includes('store_items:shared:raw_iron'));
    assert.ok(!t.model.offered().includes('travel:field'), 'the agent stands in the field: walking there is not on offer');
    const prompt = promptOf(t.model.requests[0]);
    assert.match(prompt, /At 14, 64, 0, 14 blocks from home/);
    assert.match(prompt, /the operator \(Soup\) says: "please store what you carry"/);
    assert.equal(t.calls[0].queue_wait_ms, 3 * 60 * MINUTE);
    await t.stop();
});

test('the 21st call in an hour is refused and recorded, and the agent carries on with its routine', async () => {
    const t = await town({ agents: ['Arthur'], inventories: { Arthur: { wooden_axe: 1, wooden_pickaxe: 1, bread: 4 } } });
    const arthur = t.agents.Arthur;
    t.world.durations = (command, args, far) => 500 + far * 200;
    t.world.regrow_ms = 4 * MINUTE;
    // the model always picks a walk: done in seconds, so the agent asks again as soon as it may
    const walk = (request, ids) => reply(ids.find((id) => id.startsWith('travel:')) ?? ids[0]);
    t.model.chat = ((chat) => (request) => { t.model.replies.push(walk); return chat(request); })(t.model.chat);
    t.run();
    await t.clock.advance(45 * MINUTE);

    assert.equal(t.model.requests.length, 20, 'the model was asked more than 20 times in the hour');
    const outcomes = t.calls.map((call) => call.outcome);
    assert.deepEqual(outcomes.slice(0, 20), Array(20).fill('ok'));
    assert.deepEqual(outcomes.slice(20), ['refused_budget'], 'the 21st call is refused once, and recorded');
    const refused = t.calls[20];
    assert.equal(refused.agent, 'Arthur');
    assert.equal(refused.raw_output, null);
    assert.match(refused.errors[0], /hourly budget used up \(20 calls per hour\)/);
    assert.equal(arthur.results.at(-1).reason, 'budget_exhausted');
    assert.equal(arthur.runtime.planner.stats().refused, 1);

    // from the refusal on the agent works from its routine, and does not ask again until the hour frees a call
    const at_refusal = Date.parse(refused.started_at);
    const routine_goals = arthur.eventsOf('agent.decision').filter((event) => event.data.trigger === 'routine' && Date.parse(event.ts) >= at_refusal);
    assert.ok(routine_goals.length >= 5, `only ${routine_goals.length} routine goals after the refusal`);
    assert.ok(arthur.changes().some((change) => change.source === 'routine' && /^routine Site upkeep, /.test(change.reason)));
    const asked = arthur.runtime.planner.stats().requests;
    await t.clock.advance(10 * MINUTE);
    assert.equal(arthur.runtime.planner.stats().requests, asked, 'the agent kept asking while its budget was used up');
    assert.ok(arthur.runtime.planner.stats().held_back > 0);
    assert.equal(t.model.requests.length, 20);

    // when the oldest call is an hour old, it may ask again
    await t.clock.advance(20 * MINUTE);
    assert.ok(t.model.requests.length > 20, 'the agent never asked again after its budget came back');
    assert.equal(t.calls.filter((call) => call.outcome === 'refused_budget').length, arthur.runtime.planner.stats().refused, 'a refusal was not recorded');
    assertEventsValid(arthur);
    await t.stop();
});

test('an option id that was not offered is rejected, retried once, then discarded', async () => {
    const t = await town({ agents: ['Arthur'], inventories: { Arthur: { wooden_axe: 1, bread: 4 } } }, { available: false });
    const arthur = t.agents.Arthur;
    t.model.replies.push(reply('build_blueprint:the-moon'), reply('gather_blocks:diamond_ore:64'));
    t.model.probe_ok = true;
    await t.host.signal('desktop_available');
    await settle();
    await Promise.all(arthur.pending_results);

    assert.equal(t.model.requests.length, 2, 'one call and one repair retry');
    assert.deepEqual(t.calls.map((call) => [call.outcome, call.attempt, call.valid]), [['invalid', 1, false], ['invalid', 2, false]]);
    assert.match(t.calls[0].errors.join(' '), /option_id "build_blueprint:the-moon" was not offered/);
    // the retry told the model what was wrong and what it may choose
    const repair = t.model.requests[1].messages.at(-1).content;
    assert.match(repair, /That reply was rejected:/);
    assert.match(repair, /was not offered/);
    // discarded: nothing of it reached the queue
    assert.deepEqual(arthur.results.map((result) => [result.ok, result.reason]), [[false, 'invalid_reply']]);
    assert.deepEqual(arthur.changes().filter((change) => change.source === 'planner'), []);
    assert.deepEqual(await arthur.queue(), []);
    assert.equal(arthur.runtime.planner.stats().discarded, 1);

    // the agent does not stand still: it works from its routine, and does not ask again at once
    t.run();
    await t.clock.advance(2 * MINUTE);
    assert.ok(arthur.eventsOf('agent.decision').length >= 1);
    assert.ok(arthur.eventsOf('agent.decision').every((event) => event.data.trigger === 'routine'));
    assert.equal(t.model.requests.length, 2);
    assert.ok(PLANNER_CLIENT_DEFAULTS.backoff_ms >= 2 * MINUTE);

    // a repair that works is taken: the goals carry the id of the second call
    const u = await town({ agents: ['Mira'] }, { available: false });
    u.model.replies.push(reply('harvest_replant:the-moon'), reply('harvest_replant:field'));
    u.model.probe_ok = true;
    await u.host.signal('desktop_available');
    await settle();
    await Promise.all(u.agents.Mira.pending_results);
    assert.deepEqual(u.calls.map((call) => call.outcome), ['invalid', 'ok']);
    const change = u.agents.Mira.changes().find((c) => c.source === 'planner');
    assert.equal(change.call_id, u.calls[1].call_id);
    assert.deepEqual(change.after.map((g) => g.option_id), ['harvest_replant:field']);
    await t.stop();
    await u.stop();
});

test('with the gate AWAY no request reaches the model, and the agent falls through to its routine', async () => {
    const t = await town({ agents: ['Arthur', 'Mira'], inventories: { Arthur: { wooden_axe: 1, bread: 4 }, Mira: { wooden_hoe: 1, bread: 4 } } }, { available: false });
    await t.host.signal('desktop_leaving');
    assert.equal(t.broker.gate.state(), GATE_STATES.AWAY);
    t.world.durations = (command, args, far) => 500 + far * 200;
    t.run();
    await t.clock.advance(60 * MINUTE);

    assert.equal(t.model.requests.length, 0, 'a request reached the model while the gate was AWAY');
    assert.equal(t.calls.length, 0);
    for (const name of ['Arthur', 'Mira']) {
        const agent = t.agents[name];
        const decisions = agent.eventsOf('agent.decision');
        assert.ok(decisions.length >= 10, `${name} chose only ${decisions.length} goals in an hour`);
        assert.ok(decisions.every((event) => event.data.trigger === 'routine'));
        const added = agent.changes().filter((change) => change.after.length > change.before.length);
        assert.ok(added.length >= 10 && added.every((change) => change.source === 'routine' && change.call_id === null), 'a routine choice was not recorded with source routine');
        // its request waits at the broker, one per agent, and is not sent again for every finished goal
        assert.equal(t.broker.pending().filter((request) => request.agent === name).length, 1);
        assert.equal(agent.socket.sent.filter(([event]) => event === 'genesis-plan-request').length, 1);
        assert.equal(agent.runtime.planner.pending().kind, 'plan');
        const checkpoint = decodeCheckpoint(t.files.store.get(`/checkpoints/${name}.checkpoint.json`)).checkpoint;
        assert.equal(checkpoint.pending_request.id, t.broker.pendingFor(name).id, 'the checkpoint does not know the pending request');
        assert.ok(checkpoint.routine.name.length > 0);
        assertEventsValid(agent);
    }
    await t.stop();
});

test('a newer trigger replaces the pending request', async () => {
    const t = await town({ agents: ['Arthur'], inventories: { Arthur: { oak_log: 3 } } }, { available: false });
    await t.host.signal('desktop_leaving');
    const arthur = t.agents.Arthur;
    const planner = arthur.runtime.planner;

    assert.equal(planner.trigger('goal_complete', { outcome: 'completed', option_id: 'travel:field' }), true);
    await settle();
    const [first] = t.broker.pending();
    assert.equal(first.trigger.kind, 'goal_complete');
    assert.equal(planner.pending().id, first.id);

    // another finished goal changes nothing: the request that waits will see the world as it is then
    assert.equal(planner.trigger('goal_complete', { outcome: 'completed', option_id: 'travel:home' }), false);
    assert.deepEqual(t.broker.pending(), [first]);

    // the operator speaks: this request replaces the one that waited
    assert.equal(arthur.runtime.operatorMessage('Soup', 'come to the field'), true);
    await settle();
    const [second] = t.broker.pending();
    assert.equal(t.broker.pending().length, 1);
    assert.notEqual(second.id, first.id);
    assert.equal(second.trigger.kind, 'operator_message');
    assert.equal(planner.pending().id, second.id);
    assert.deepEqual(arthur.results.map((result) => [result.request_id, result.reason]), [[first.id, 'replaced']]);
    assert.equal(planner.hasPending(), true, 'being replaced by its own newer request cleared the agent\'s pending request');
    assert.equal(t.broker.stats().replaced, 1);

    // only the newer one is ever answered
    t.model.probe_ok = true;
    await t.host.signal('desktop_available');
    await settle();
    await Promise.all(arthur.pending_results);
    assert.equal(t.model.requests.length, 1);
    assert.equal(t.calls.length, 1);
    assert.equal(t.calls[0].request_id, second.id);
    assert.match(promptOf(t.model.requests[0]), /the operator \(Soup\) says: "come to the field"/);
    assert.equal(planner.hasPending(), false);
    await t.stop();
});

test('triggers: a step that failed after its retries, a reflex, another agent and the operator each ask once', async () => {
    const t = await town({ agents: ['Arthur'], inventories: { Arthur: { oak_log: 5 } } }, { available: false });
    await t.host.signal('desktop_leaving');
    const arthur = t.agents.Arthur;
    const requests = () => arthur.socket.sent.filter(([name]) => name === 'genesis-plan-request').map(([, message]) => message.trigger.kind);

    // a goal whose walk fails three times
    t.world.body('Arthur').position = { x: 20, y: 64, z: 20 };
    t.world.fail = (call) => (call.command === 'goToPosition' ? { output: 'no_safe_path: there is no way to the goal without breaking blocks. Not digging.' } : null);
    const pushed = await arthur.runtime.goals.pushShortTerm('Arthur', { title: 'Store the logs', option_id: 'store_items:shared:oak_log' }, { reason: 'the operator asked', source: 'operator' });
    arthur.runtime.executor.noteGoals(pushed.goals.short_term, { source: 'operator' });
    for (let i = 0; i < 4; i++) await arthur.runtime.executor.runOnce();
    assert.deepEqual(requests(), ['step_failed']);
    assert.deepEqual(t.broker.pending()[0].trigger, { kind: 'step_failed', detail: { reason: 'no_safe_path', option_id: 'store_items:shared:oak_log', command: 'goToPosition' } });
    t.world.fail = null;

    arthur.runtime.agentRequest('Mira', 'can you bring me a hoe?');
    assert.deepEqual(requests(), ['step_failed', 'agent_request']);
    await arthur.runtime.died({ x: 20, y: 64, z: 20 });
    assert.deepEqual(requests(), ['step_failed', 'agent_request', 'reflex_interrupt']);
    arthur.runtime.operatorMessage('Soup', 'are you all right?');
    assert.deepEqual(requests(), ['step_failed', 'agent_request', 'reflex_interrupt', 'operator_message']);
    await settle();
    assert.equal(t.broker.pending().length, 1, 'the broker holds more than one request for an agent');
    assert.equal(t.model.requests.length, 0);
    await t.stop();
});

test('a reply that arrives while a goal is in hand replaces the queue after the step that is running', async () => {
    const t = await town({ agents: ['Arthur'], inventories: { Arthur: { oak_log: 5, wooden_axe: 1 } } });
    const arthur = t.agents.Arthur;
    await Promise.all(arthur.pending_results);
    t.world.durations = () => 20 * SECOND; // the gather takes minutes: the reply comes in the middle of it
    t.model.delay_ms = 4 * SECOND;
    t.model.replies.push(() => reply('store_items:shared:oak_log'));
    // the first goal (the model's default choice) is being carried out when the operator speaks
    await arthur.runtime.goals.setShortTerm('Arthur', [{ title: 'Gather wood', option_id: 'gather_blocks:oak_log:8' }], { reason: 'seeded', source: 'operator' });
    t.run();
    await t.clock.advance(12 * SECOND);
    assert.equal(arthur.runtime.executor.plan().goal.option_id, 'gather_blocks:oak_log:8');
    arthur.runtime.operatorMessage('Soup', 'store the logs now');
    await t.clock.advance(170 * SECOND);
    const states = arthur.eventsOf('agent.state').map((event) => event.data.state);
    assert.ok(states.includes('goal_abandoned'));
    const steps = arthur.eventsOf('skill.result');
    assert.ok(steps.every((event) => event.data.interrupted === false), 'the step that was running was cut short');
    assert.equal(t.world.body('Arthur').inventory.oak_log, undefined, 'the planner\'s goal was not carried out');
    const replaced = arthur.changes().find((change) => change.source === 'planner' && change.after[0]?.option_id === 'store_items:shared:oak_log');
    assert.deepEqual(replaced.before.map((g) => g.option_id), ['gather_blocks:oak_log:8'], 'the reply did not replace the goal in hand');
    await t.stop();
});

// ---- the host ------------------------------------------------------------------------------

test('host: an agent\'s requests are only taken from that agent\'s own connection', async () => {
    const clock = fakeClock();
    const model = stubModel(clock);
    const host = createPlanningHost({ model, clock });
    const { client, server } = socketPair();
    host.attach(server, { isAgentSocket: (name) => name === 'Arthur' });
    let gate = null;
    client.emit('genesis-hello', 'Mira', () => { gate = 'answered'; });
    client.emit('genesis-plan-request', { agent: 'Mira', trigger: { kind: 'goal_complete' }, local_id: 'x' });
    let loaded = null;
    client.emit('genesis-goals-save', 'Mira', { long_term: [], short_term: [] }, {}, () => { loaded = 'saved'; });
    await settle();
    assert.deepEqual([gate, loaded, host.broker.pending().length], [null, null, 0]);
    assert.equal(host.stats().refused_sender, 3);
    client.emit('genesis-hello', 'Arthur', (answer) => { gate = answer.gate; });
    client.emit('genesis-plan-request', { agent: 'Arthur', trigger: { kind: 'goal_complete' }, local_id: 'y' });
    assert.equal(gate, 'AWAY');
    assert.equal(host.broker.pending().length, 1);
    // the desktop launcher's signals reach the gate
    client.emit('genesis-desktop', 'desktop_available');
    client.emit('genesis-desktop', 'format_the_disk');
    await settle();
    assert.equal(host.broker.gate.state(), GATE_STATES.AVAILABLE);
    host.stop();
});

test('host: an agent that does not answer with its options costs no model call', async () => {
    const clock = fakeClock();
    const model = stubModel(clock);
    const host = createPlanningHost({ model, clock, context_timeout_ms: 2000 });
    await host.start();
    const { client, server } = socketPair();
    host.attach(server);
    const results = [];
    client.on('genesis-plan-result', (result) => results.push(result));
    client.on('genesis-plan-context', () => { /* never answers */ });
    client.emit('genesis-plan-request', { agent: 'Felix', trigger: { kind: 'goal_complete' }, local_id: 'a' });
    await clock.advance(3000);
    assert.deepEqual(results.map((result) => [result.ok, result.reason]), [[false, 'context_error']]);
    assert.match(results[0].errors[0], /did not answer with its options within 2000 ms/);
    // an agent with nothing it can do says so
    client.peer.fire('disconnect');
    const again = socketPair();
    host.attach(again.server);
    again.client.on('genesis-plan-result', (result) => results.push(result));
    again.client.on('genesis-plan-context', (request, ack) => ack({ error: 'no_options: nothing can be started right now' }));
    again.client.emit('genesis-plan-request', { agent: 'Felix', trigger: { kind: 'goal_complete' }, local_id: 'b' });
    await clock.advance(2 * MINUTE);
    assert.match(results[1].errors[0], /no_options/);
    assert.equal(model.requests.length, 0);
    host.stop();
});

test('host: goals are kept in memory first and written through to the durable storage, which never holds anything up', async () => {
    const clock = fakeClock();
    const durable = fakeGoalStorage();
    const storage = createHostGoalStorage({ durable, clock, retry_ms: 5000 });
    const change = (n) => ({ id: `c${n}`, agent: 'Nova', scope: 'short_term', before: [], after: [], reason: `r${n}`, source: 'executor', call_id: null, ts: '2026-01-01T00:00:00.000Z' });
    durable.goals.set('Nova', { long_term: [{ id: 'g', title: 'Keep the chest full', option_id: null }], short_term: [] });
    assert.equal((await storage.load('Nova')).long_term[0].title, 'Keep the chest full');
    assert.equal(await storage.load('Unknown'), null);

    durable.failing = true;
    await storage.save('Nova', { long_term: [], short_term: [{ id: 'a', title: 'A', option_id: null }] }, change(1));
    await storage.save('Nova', { long_term: [], short_term: [] }, change(2));
    await settle();
    assert.deepEqual(await storage.load('Nova'), { long_term: [], short_term: [] }, 'the newest goals are served while the database is down');
    assert.equal(storage.stats().waiting, 2);
    assert.equal(durable.changes.length, 0);
    durable.failing = false;
    await clock.advance(5000);
    assert.deepEqual(durable.changes.map((c) => c.id), ['c1', 'c2'], 'the changes reach the database in order once it is back');
    assert.equal(storage.stats().waiting, 0);
    storage.stop();

    // the agent's end of it: the goal store's storage over the socket, with a timeout
    const { client, server } = socketPair();
    const host = createPlanningHost({ model: stubModel(clock), clock, goal_storage: storage });
    host.attach(server);
    const remote = socketGoalStorage({ socket: client, clock, timeout_ms: 1000 });
    await remote.save('Nova', { long_term: [], short_term: [{ id: 'b', title: 'B', option_id: null }] }, change(3));
    assert.equal((await remote.load('Nova')).short_term[0].id, 'b');
    const dead = socketGoalStorage({ socket: { emit() {} }, clock, timeout_ms: 1000 });
    const waiting = assert.rejects(dead.load('Nova'), /did not answer genesis-goals-load within 1000 ms/);
    await clock.advance(1000);
    await waiting;
    host.stop();
});
