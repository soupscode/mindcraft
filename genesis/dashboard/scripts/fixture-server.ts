// A development aid, never part of the image: serves the built front end with the REAL
// ingest, live view and HTTP code, fed from fixture events through in-memory stand-ins for
// Redis and Postgres. Used to look at the pages (and take screenshots) without the stack.
//   npx tsx scripts/fixture-server.ts [port]
// Everything it shows is made up here; nothing of it is in the dashboard bundle.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../src/server/app.js';
import { createIngest } from '../src/server/ingest.js';
import { createLive } from '../src/server/live.js';
import { validateEvent } from '../src/server/contract.js';
import { eventMaker, fakeClock, fakeStream, incident, memoryStore } from '../test/fakes.js';
import { createControls } from '../src/server/controls.js';
import { buildDigest } from '../../alerter/src/digest.js';

const port = Number(process.argv[2] ?? 8099);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const start = Date.now() - 40 * 60 * 1000;
const clock = fakeClock(start);
const stream = fakeStream(clock);
const pg = memoryStore();
const roster = [{ name: 'Arthur', role: 'Builder' }, { name: 'Mira', role: 'Farmer' }, { name: 'Felix', role: 'Explorer' }, { name: 'Nova', role: 'Merchant' }];
const live = createLive({ roster: roster.map((agent) => agent.name) });
const make = eventMaker(clock);
const ingest = createIngest({ stream: stream.client, store: pg.store, live, validate: validateEvent, clock, warn: () => {} });
const at = (minutes: number) => clock.set(start + minutes * 60 * 1000);
const add = (...args: Parameters<typeof make>) => stream.add(make(...args));
const goal = (id: string, title: string, option_id: string) => ({ id, title, option_id });

function plan(agent: string, id: string, title: string, source: string, skill: string, option: string, steps: string[], call_id: string | null, thought: string | null, before: any[] = []) {
    const g = goal(`g-${id}`, title, option);
    add(agent, 'goal.changed', { scope: 'short_term', before, after: [g], reason: thought ?? `routine: ${title}`, source: source === 'planner' ? 'planner' : 'routine', call_id });
    add(agent, 'agent.decision', { decision_id: id, summary: title, trigger: source, command: skill, args: [option], goal_id: g.id, call_id, steps, steps_from: 'template' }, { corr: id });
    add(agent, 'agent.state', { state: 'goal_started', detail: { goal_id: g.id, option_id: option, steps: steps.length, source } }, { corr: id });
}
function step(agent: string, id: string, i: number, of: number, command: string, ok: boolean | null) {
    add(agent, 'skill.started', { skill: command, args: [], step: i, of, attempt: 1, steps_from: 'template' }, { corr: id });
    if (ok !== null) add(agent, 'skill.result', { skill: command, ok, interrupted: false, timedout: false, output: '', duration_ms: 4200, step: i, attempt: 1 }, { corr: id, severity: ok ? 'info' : 'warn' });
}

at(0);
add('planner', 'agent.state', { state: 'model_available', detail: { reason: 'desktop_available' } });
for (const agent of roster) add(agent.name, 'agent.state', { state: 'planning', detail: { gate: 'AVAILABLE' } });
add('Arthur', 'goal.changed', { scope: 'long_term', before: [], after: [goal('l1', 'Finish the meeting hall', 'build:hall'), goal('l2', 'Wall the village', 'build:wall')], reason: 'Set by the operator at the start of the run.', source: 'operator', call_id: null });
add('Mira', 'goal.changed', { scope: 'long_term', before: [], after: [goal('l3', 'Keep 2 days of food in the shared chest', 'stock:food'), goal('l4', 'Expand the farm to 3 fields', 'farm:expand')], reason: 'Set by the operator at the start of the run.', source: 'operator', call_id: null });
add('Felix', 'goal.changed', { scope: 'long_term', before: [], after: [goal('l5', 'Map everything within 500 blocks', 'explore:500')], reason: 'Set by the operator at the start of the run.', source: 'operator', call_id: null });

at(4);
plan('Arthur', 'd-arthur-1', 'Craft 96 oak planks', 'planner', 'craft_item', 'craft_item:oak_planks:96', ['!goToCoordinates', '!takeFromChest', '!craftRecipe', '!putInChest'], 'call-0412', '24 logs. Felix came through. South wall next.');
pg.planner_calls.set('call-0412', {
    call_id: 'call-0412', request_id: 'r-1', agent: 'Arthur', call_trigger: 'goal_complete',
    context: 'You are Arthur, the builder.\nPlace: camp, 12 blocks from home. Daylight: 3 h left.\nHealth 18/20, food 14/20.\nLong-term goals: 1) Finish the meeting hall; 2) Wall the village.\nLast result: retrieve_items ok.',
    options_offered: [{ id: 'craft_item:oak_planks:96', description: 'Craft 96 oak planks from the logs in the camp chest' }, { id: 'collect_wood:oak_log:32', description: 'Collect 32 oak logs in the north forest' }, { id: 'rest:bed', description: 'Sleep in the camp bed' }],
    raw_output: '{"thought": "24 logs. Felix came through. South wall next.", "goals": [{"option_id": "craft_item:oak_planks:96", "title": "Craft 96 oak planks", "reason": "The wall needs planks first."}]}',
    chosen_ids: ['craft_item:oak_planks:96'], valid: true, attempt: 1, queue_wait_ms: 610, latency_ms: 2840, prompt_tokens: 612, completion_tokens: 74, model: 'local', outcome: 'ok', errors: [], started_at: new Date(clock.now()).toISOString(),
});
step('Arthur', 'd-arthur-1', 0, 4, '!goToCoordinates', true);
step('Arthur', 'd-arthur-1', 1, 4, '!takeFromChest', true);

at(6);
plan('Mira', 'd-mira-1', 'Harvest the wheat field', 'planner', 'harvest_crops', 'harvest_crops:wheat:field', ['!goToCoordinates', '!collectBlocks', '!putInChest'], 'call-0413', 'Nearly a full field. Harvest first, then replant before dark.');
step('Mira', 'd-mira-1', 0, 3, '!goToCoordinates', true);

at(8);
add('Nova', 'agent.message', { msg_id: 'm-0417-1', conv: 'c-0417', from: 'Nova', to: 'Mira', type: 'offer', body: { give: { item: 'iron_ingot', count: 3 }, want: { item: 'wheat', count: 16 } }, chat_line: 'Mira, three iron ingots for sixteen wheat?', expires_at: new Date(Date.now() + 80 * 1000).toISOString(), state: 'pending' });
add('Arthur', 'agent.message', { msg_id: 'm-0412-1', conv: 'c-0412', from: 'Arthur', to: 'Felix', type: 'request', body: { item: 'oak_log', count: 24 }, chat_line: 'Felix, I need 24 oak logs for the hall walls.', expires_at: null, state: 'accepted' });
add('Felix', 'agent.message', { msg_id: 'm-0412-2', conv: 'c-0412', from: 'Felix', to: 'Arthur', type: 'accept', body: { item: 'oak_log', count: 24, decided_by: 'planner' }, chat_line: 'On it. Twenty-four oak logs, coming your way.', expires_at: null, state: 'delivered' });
add('Nova', 'agent.message', { msg_id: 'm-x-1', conv: 'none', from: 'Nova', to: 'Arthur', type: 'offer', body: {}, chat_line: null, expires_at: null, state: 'rejected', reason: 'rate_limit' }, { severity: 'warn' });

at(12);
add('Felix', 'agent.failure', incident('inc-stuck-1', 'Felix', 'nav.stuck', 'detected', { checks: 4 }), { severity: 'warn' });
add('Felix', 'agent.recovery', incident('inc-stuck-1', 'Felix', 'nav.stuck', 'recovery_step', { recovery: { step: 'move_away', attempt: 1, max: 1, result: 'failed' } }));
add('Felix', 'agent.recovery', incident('inc-stuck-1', 'Felix', 'nav.stuck', 'recovery_step', { recovery: { step: 'repath', attempt: 1, max: 1, result: 'ok' } }));
at(13);
add('Felix', 'agent.recovery', incident('inc-stuck-1', 'Felix', 'nav.stuck', 'resolved', { outcome: 'auto_recovered', recovery: { step: 'resume_step', attempt: 1, max: 1, result: 'ok' } }));

at(15);
add('supervisor', 'agent.failure', { ...incident('inc-login-1', 'Nova', 'login.refused', 'detected', { code: 4 }) }, { severity: 'warn' });
add('supervisor', 'agent.recovery', incident('inc-login-1', 'Nova', 'login.refused', 'recovery_step', { recovery: { step: 'login', attempt: 1, max: 3, result: 'failed' } }));
add('supervisor', 'agent.recovery', incident('inc-login-1', 'Nova', 'login.refused', 'recovery_step', { recovery: { step: 'login', attempt: 2, max: 3, result: 'failed' } }));
at(18);
add('supervisor', 'agent.failure', incident('inc-login-1', 'Nova', 'login.refused', 'escalated', { outcome: 'needs_operator', needs_operator: true, reason: 'login_refused', recovery: { step: 'login', attempt: 3, max: 3, result: 'failed' } }), { severity: 'error' });

at(20);
add('planner', 'agent.state', { state: 'model_leaving', detail: { reason: 'desktop_leaving' } });
add('planner', 'agent.state', { state: 'model_away', detail: { reason: 'desktop_leaving' } });
add('supervisor', 'agent.failure', { incident_id: 'inc-away-1', source: { type: 'service', name: 'planner' }, kind: 'model.away', phase: 'detected', is_failure: false, recovery: null, outcome: 'expected', needs_operator: false, reason: 'desktop_leaving' });
for (const agent of ['Arthur', 'Mira', 'Felix']) add(agent, 'agent.state', { state: 'on_routine', detail: { gate: 'AWAY', reason: 'desktop_leaving' } });

at(22);
plan('Felix', 'd-felix-2', 'Collect 16 oak logs near home', 'routine', 'collect_wood', 'collect_wood:oak_log:16', ['!goToCoordinates', '!collectBlocks', '!goToCoordinates', '!putInChest'], null, null);
step('Felix', 'd-felix-2', 0, 4, '!goToCoordinates', true);
step('Felix', 'd-felix-2', 1, 4, '!collectBlocks', null);
add('Felix', 'skill.progress', { skill: 'collect_wood', done: 9, total: 16, unit: 'oak logs', step: 1 }, { corr: 'd-felix-2' });

at(30);
step('Mira', 'd-mira-1', 1, 3, '!collectBlocks', null);
add('Mira', 'skill.progress', { skill: 'harvest_crops', done: 26, total: 40, unit: 'wheat', step: 1 }, { corr: 'd-mira-1' });
step('Arthur', 'd-arthur-1', 2, 4, '!craftRecipe', null);
add('Arthur', 'skill.progress', { skill: 'craft_item', done: 48, total: 96, unit: 'oak planks', step: 2 }, { corr: 'd-arthur-1' });

await ingest.step({ block_ms: 0 });
live.setHealth({ mindserver_ok: true });
live.setProcesses([
    { name: 'Arthur', in_game: true, socket_connected: true, pos: [238, 68, -87], health: 20, food: 17, action: 'action:craftRecipe' },
    { name: 'Mira', in_game: true, socket_connected: true, pos: [255, 68, -74], health: 20, food: 19, action: 'action:collectBlocks' },
    { name: 'Felix', in_game: true, socket_connected: true, pos: [236, 70, -203], health: 18, food: 14, action: 'action:collectBlocks' },
    { name: 'Nova', in_game: false, socket_connected: false, pos: null, health: null, food: null, action: null },
]);

// Controls with a stand-in for the MindServer socket: commands are logged, nothing is sent anywhere.
let n = 0;
const controls = createControls({
    link: { connected: () => true, emit: () => {}, ask: async () => ({ settings: { narrate_behavior: true, chat_ingame: true, log_all_prompts: false, max_messages: 15, allow_insecure_coding: false } }) },
    store: pg.store, live, ids: () => `ctl-${++n}`,
});
await controls.execute({ action: 'stop', agent: 'Nova' }, 'tailscale');
await controls.execute({ action: 'message', agent: 'Arthur', text: 'Bake bread before dark.' }, 'tailscale');
await controls.execute({ action: 'restart', agent: 'Nova' }, 'lan');

// One digest, built by the alerter's own code from the same fixture events.
const end = Date.now();
const facts = [...pg.rows.values()].map((entry) => entry.event);
const body = buildDigest({ facts: facts as any, alerts: [], warning_pushes: 1, start: end - 24 * 3600 * 1000, end, tz: 'America/Chicago', roster: roster.map((agent) => agent.name) });
body.totals.critical = 1; body.totals.warnings = 2; body.alerts = { critical: 1, warnings: 2, warning_pushes: 1 };
pg.digest_rows.push({ period_end: body.period_end, period_start: body.period_start, tz: body.tz, local_date: body.local_date, body, created_at: new Date(end).toISOString(), pushed_at: new Date(end).toISOString() });

pg.alert_rows.push(
    { id: 'al-2', problem_key: 'incident:inc-login-1', severity: 'critical', title: 'Nova · Login refused · needs operator', subject: 'Nova', kind: 'login.refused', opened_at: new Date(start + 18 * 60000).toISOString(), updated_at: new Date(start + 18 * 60000).toISOString(), closed_at: null, occurrences: 1, push_state: 'sent', pushed_at: new Date(start + 18 * 60000).toISOString() },
    { id: 'al-1', problem_key: 'failure:Mira:Model call failed:ModelTimeoutError', severity: 'warning', title: 'Mira · Model call failed · ModelTimeoutError', subject: 'Mira', kind: 'model', opened_at: new Date(start + 9 * 60000).toISOString(), updated_at: new Date(start + 11 * 60000).toISOString(), closed_at: null, occurrences: 3, push_state: 'queued', pushed_at: null },
);

const app = await buildApp({ live, store: pg.store, controls, roster, public_dir: path.join(root, 'dist/public') });
await app.listen({ host: '127.0.0.1', port });
console.log(`fixture dashboard on http://127.0.0.1:${port}`);
