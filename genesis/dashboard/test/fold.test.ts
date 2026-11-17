import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentStatus, applyEvent, CAPS, emptyState, foldIncidents, isRoutineWork, thoughtOf } from '../src/shared/fold.js';
import { validateEvent } from '../src/server/contract.js';
import { eventMaker, fakeClock, incident } from './fakes.js';

function rig() {
    const clock = fakeClock();
    const make = eventMaker(clock);
    const state = emptyState(['Arthur', 'Mira', 'Felix', 'Nova']);
    const feed = (...args: Parameters<typeof make>) => {
        const event = make(...args);
        assert.deepEqual(validateEvent(event).errors, [], 'the test only feeds events the shared contract accepts');
        applyEvent(state, event);
        return event;
    };
    return { clock, state, feed };
}

test('the thought is the `thought` field of the planner\'s goal change (decided), never parsed out of a reason', () => {
    const { state, feed, clock } = rig();
    const g1 = { id: 'g1', title: 'Deliver 24 oak logs', option_id: 'give:Arthur:oak_log:24' };
    const g2 = { id: 'g2', title: 'Return to the ravine', option_id: 'explore_site:ravine' };
    const thought = 'Debt paid. Back to the ravine.';
    feed('Felix', 'goal.changed', { scope: 'short_term', before: [g1], after: [], reason: `replaced by a new plan (asked because: goal_complete): ${thought}`, source: 'planner', call_id: 'c7', thought });
    assert.equal(state.agents.Felix.thought?.text, thought);
    clock.advance(1000);
    const event = feed('Felix', 'goal.changed', { scope: 'short_term', before: [], after: [g2], reason: thought, source: 'planner', call_id: 'c7', thought });
    assert.deepEqual(state.agents.Felix.thought, { text: thought, at: event.ts, call_id: 'c7' });
    // a reason alone is not a thought any more: nothing is parsed out of it
    clock.advance(1000);
    feed('Felix', 'goal.changed', { scope: 'short_term', before: [g2], after: [g1], reason: 'A sentence that only sits in the reason.', source: 'planner', call_id: 'c8' });
    assert.equal(state.agents.Felix.thought?.text, thought);
    // what code wrote is never shown as a thought
    feed('Felix', 'goal.changed', { scope: 'short_term', before: [g1], after: [], reason: 'completed', source: 'executor', call_id: 'c7' });
    feed('Felix', 'goal.changed', { scope: 'short_term', before: [], after: [g1], reason: 'routine: gather near home', source: 'routine', call_id: null });
    assert.equal(state.agents.Felix.thought?.text, thought);
    assert.deepEqual([thoughtOf({ thought: '  ' }), thoughtOf({ reason: 'the planner chose' }), thoughtOf(null), thoughtOf({ thought: ' Yes. ' })], [null, null, null, 'Yes.']);
    assert.deepEqual(state.goal_changes[0].added, ['Deliver 24 oak logs']);
    assert.equal(state.goal_changes[0].source, 'routine');
});

test('long-term goals, the routine\'s phase and bounds, the world, the server wait and the skins are read from their own events', () => {
    const { state, feed } = rig();
    // decided: long-term goals are emitted as events, also when none has changed
    feed('Mira', 'agent.state', { state: 'goals', detail: { long_term: [{ id: 'l1', title: 'Feed the village', option_id: null }], short_term: [{ id: 's1', title: 'Sow the field', option_id: 'sow_field:wheat_seeds' }] } });
    assert.deepEqual([state.agents.Mira.long_term.map((goal) => goal.title), state.agents.Mira.short_term.map((goal) => goal.title)], [['Feed the village'], ['Sow the field']]);
    // the routine's phase and bounds
    const bounds = { daylight_ticks_left: 4200, health: 18, food: 7, free_slots: 20, home_distance: 12, breached: ['food'], limits: { min_health: 10, min_food: 8, min_free_slots: 3, max_deaths: 2, range: 32 } };
    const told = feed('Mira', 'agent.state', { state: 'routine', detail: { name: 'Field round', phase: 'Shelter', phases: ['Kit check', 'Harvest', 'Bake', 'Stock', 'Shelter'], away: true, parked: false, deaths: 0, bounds } });
    assert.deepEqual(state.agents.Mira.routine, { name: 'Field round', phase: 'Shelter', phases: ['Kit check', 'Harvest', 'Bake', 'Stock', 'Shelter'], away: true, parked: false, deaths: 0, bounds, at: told.ts });
    assert.equal(state.agents.Mira.last_state, null, 'a report is not something that happened to the agent');
    // the world: two events of the service "world", which never becomes an agent card
    feed('world', 'agent.state', { state: 'world_zones', detail: { home: [40, 65, -8], floor_y: 64, plots: [{ id: 'arthur-1', owner: 'Arthur' }] } });
    feed('world', 'agent.state', { state: 'world_bootstrap', detail: { verified: true, site: { method: 'automatic' }, levelling: { blocks_changed: 519 } } });
    assert.deepEqual([state.world.zones?.home, state.world.bootstrap?.site.method, state.world.bootstrap?.levelling.blocks_changed], [[40, 65, -8], 'automatic', 519]);
    // the supervisor's plain line: an agent process waits for the Minecraft server, and comes back
    feed('supervisor', 'agent.state', { state: 'server_down_wait', detail: { agent: 'Nova', attempt: 3, delay_ms: 20000, waited_ms: 15000, message: 'Nova cannot reach the Minecraft server' } });
    assert.deepEqual(Object.keys(state.server.waiting), ['Nova']);
    assert.equal(state.server.waiting.Nova.attempt, 3);
    feed('supervisor', 'agent.state', { state: 'server_back', detail: { agent: 'Nova', waited_ms: 35000, message: 'Nova is back' } });
    assert.deepEqual(state.server.waiting, {});
    // a skin applied or failed, next to the agent it is for
    const failed = feed('skins', 'agent.state', { state: 'skin_failed', detail: { agent: 'Arthur', reason: 'no_signer' } }, { severity: 'warn' });
    assert.deepEqual(state.agents.Arthur.skin, { state: 'failed', at: failed.ts, reason: 'no_signer' });
    feed('skins', 'agent.state', { state: 'skin_applied', detail: { agent: 'Arthur', skin_name: 'genesis_arthur' } });
    assert.equal(state.agents.Arthur.skin?.state, 'applied');
    for (const service of ['world', 'supervisor', 'skins', 'planner']) assert.equal(state.agents[service], undefined, `${service} became an agent card`);
});

test('steps come from the skill template and say so; a routine choice is marked as routine', () => {
    const { state, feed } = rig();
    feed('Mira', 'agent.decision', { decision_id: 'd1', summary: 'Harvest the field', trigger: 'routine', command: 'harvest_crops', args: ['harvest_crops:wheat'], goal_id: 'g1', call_id: null, steps: ['!goToCoordinates', '!collectBlocks', '!putInChest'], steps_from: 'template' }, { corr: 'd1' });
    const plan = state.agents.Mira.plan!;
    assert.equal(plan.steps_from, 'template');
    assert.equal(isRoutineWork(state.agents.Mira), true);
    feed('Mira', 'skill.started', { skill: '!goToCoordinates', step: 0, of: 3, attempt: 1, steps_from: 'template' }, { corr: 'd1' });
    feed('Mira', 'skill.result', { skill: '!goToCoordinates', ok: true, interrupted: false, timedout: false, output: '', duration_ms: 5, step: 0 }, { corr: 'd1' });
    feed('Mira', 'skill.started', { skill: '!collectBlocks', step: 1, of: 3, attempt: 2 }, { corr: 'd1' });
    feed('Mira', 'skill.progress', { skill: 'harvest_crops', done: 12, total: 40, unit: 'wheat', step: 1 }, { corr: 'd1' });
    assert.deepEqual([plan.cursor, plan.done_through, plan.attempt, plan.running], [1, 0, 2, '!collectBlocks']);
    assert.deepEqual(state.agents.Mira.progress && [state.agents.Mira.progress.done, state.agents.Mira.progress.total, state.agents.Mira.progress.unit], [12, 40, 'wheat']);
    // a step of another plan (the scaffold clean-up, an old decision) does not move this one
    feed('Mira', 'skill.started', { skill: 'breakBlockAt', step: 2, of: 3, attempt: 1 }, { corr: 'other' });
    assert.equal(plan.cursor, 1);
    assert.equal(agentStatus(state, state.agents.Mira), 'Executing');
    feed('Mira', 'agent.state', { state: 'goal_completed', detail: { goal_id: 'g1' } }, { corr: 'd1' });
    assert.equal(state.agents.Mira.plan, null);
    assert.equal(agentStatus(state, state.agents.Mira), 'Waiting');
});

test('status: held by the operator, recovering, parked, offline', () => {
    const { state, feed } = rig();
    feed('Felix', 'agent.state', { state: 'held', detail: { by: 'operator', reason: 'operator_stop', at: '2026-11-16T11:00:00.000Z' } });
    assert.equal(agentStatus(state, state.agents.Felix), 'Held');
    feed('Felix', 'agent.state', { state: 'hold_released', detail: { by: 'operator' } });
    feed('Felix', 'agent.failure', incident('i1', 'Felix', 'nav.stuck', 'detected'), { severity: 'warn' });
    assert.equal(agentStatus(state, state.agents.Felix), 'Recovering');
    feed('Felix', 'agent.recovery', incident('i1', 'Felix', 'nav.stuck', 'resolved', { outcome: 'auto_recovered' }));
    assert.equal(agentStatus(state, state.agents.Felix), 'Waiting');
    feed('Felix', 'agent.state', { state: 'parked', detail: { deaths: 2 } }, { severity: 'warn' });
    assert.equal(agentStatus(state, state.agents.Felix), 'Parked');
    assert.equal(agentStatus(state, state.agents.Felix, false), 'Offline');
});

test('the model gate is read from the planner\'s events and never becomes an agent card', () => {
    const { state, feed } = rig();
    feed('planner', 'agent.state', { state: 'model_away', detail: { reason: 'desktop_leaving' } });
    feed('supervisor', 'agent.failure', { incident_id: 'a1', source: { type: 'service', name: 'planner' }, kind: 'model.away', phase: 'detected', is_failure: false, recovery: null, outcome: 'expected', needs_operator: false, reason: 'desktop_leaving' });
    assert.equal(state.model.state, 'away');
    assert.equal(state.model.reason, 'desktop_leaving');
    assert.deepEqual(Object.keys(state.agents), ['Arthur', 'Mira', 'Felix', 'Nova']);
    feed('supervisor', 'agent.recovery', { incident_id: 'a1', source: { type: 'service', name: 'planner' }, kind: 'model.available', phase: 'resolved', is_failure: false, recovery: null, outcome: 'expected', needs_operator: false });
    assert.equal(state.model.state, 'available');
    assert.equal(state.incidents.length, 1, 'away and back are one incident');
    assert.equal(state.incidents[0].kind, 'model.away');
    assert.ok(state.incidents[0].ended_at);
});

test('an incident is the fold of its events; a pending step is replaced by how it ended', () => {
    const { feed, clock } = rig();
    const events = [
        feed('supervisor', 'agent.failure', incident('i3', 'Nova', 'login.refused', 'detected')),
        feed('supervisor', 'agent.recovery', incident('i3', 'Nova', 'login.refused', 'recovery_step', { recovery: { step: 'login', attempt: 1, max: 3, result: 'pending' } })),
        (clock.advance(1000), feed('supervisor', 'agent.recovery', incident('i3', 'Nova', 'login.refused', 'recovery_step', { recovery: { step: 'login', attempt: 1, max: 3, result: 'failed' } }))),
        (clock.advance(1000), feed('supervisor', 'agent.failure', incident('i3', 'Nova', 'login.refused', 'escalated', { outcome: 'needs_operator', needs_operator: true, recovery: { step: 'login', attempt: 3, max: 3, result: 'failed' } }), { severity: 'error' })),
    ];
    const [folded] = foldIncidents([...events].reverse());
    assert.equal(folded.outcome, 'needs_operator');
    assert.equal(folded.needs_operator, true);
    assert.deepEqual(folded.steps.map((step) => `${step.step} ${step.attempt} ${step.result}`), ['login 1 failed', 'login 3 failed']);
    assert.equal(folded.started_at, events[0].ts);
});

test('messages: a reply updates the message it answers; the live state stays bounded', () => {
    const { state, feed } = rig();
    const message = (id: string, st: string, more = {}) => ({ msg_id: id, conv: 'c-0001', from: 'Nova', to: 'Mira', type: 'offer', body: { item: 'wheat', count: 16 }, chat_line: 'Sixteen wheat?', expires_at: null, state: st, ...more });
    feed('Nova', 'agent.message', message('m-0001-1', 'pending'));
    feed('Nova', 'agent.message', message('m-0001-1', 'accepted'));
    assert.equal(state.messages.length, 1);
    assert.equal(state.messages[0].state, 'accepted');
    feed('Nova', 'agent.message', { to: 'Mira', text: 'upstream chat, not a relay message' });
    assert.equal(state.messages.length, 1);
    for (let i = 0; i < CAPS.goal_changes + 50; i++) {
        feed('Arthur', 'goal.changed', { scope: 'short_term', before: [], after: [{ id: `g${i}`, title: `Goal ${i}` }], reason: 'r', source: 'executor', call_id: null });
        feed('Arthur', 'agent.failure', incident(`x${i}`, 'Arthur', 'nav.stuck', 'detected'));
    }
    for (let i = 0; i < CAPS.incidents; i++) feed('Arthur', 'agent.failure', incident(`y${i}`, 'Arthur', 'nav.stuck', 'detected'));
    assert.equal(state.goal_changes.length, CAPS.goal_changes);
    assert.equal(state.incidents.length, CAPS.incidents);
});
