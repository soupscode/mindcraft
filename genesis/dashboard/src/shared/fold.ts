// The live state and how one event changes it. Pure code with no imports besides types:
// the server folds the stream into this state, and the browser folds the same events it
// receives over the SSE stream, so both always agree.
//
// Everything is bounded: lists have a fixed cap, so a long run cannot grow the memory.

import type {
    AgentView, DecisionView, Entry, GenesisEvent, Goal, Incident, LiveState, MessageView,
} from './types.js';

export const CAPS = Object.freeze({ goal_changes: 40, incidents: 150, messages: 240, decisions: 80, incident_steps: 24, agents: 32 });

// Names that publish events but are not agents (genesis/planning/server.js, genesis/recovery/server.js).
export const SERVICE_NAMES: readonly string[] = Object.freeze(['planner', 'supervisor', 'world', 'skins', 'relay']);

export function emptyState(roster: readonly string[] = []): LiveState {
    const state: LiveState = {
        cursor: null, last_event_at: null, agents: {},
        model: { state: 'unknown', since: null, reason: null },
        goal_changes: [], incidents: [], messages: [], decisions: [],
        world: { zones: null, zones_at: null, bootstrap: null, bootstrap_at: null },
        server: { waiting: {}, last_back: null },
    };
    for (const name of roster) state.agents[name] = emptyAgent(name);
    return state;
}

export function emptyAgent(name: string): AgentView {
    return {
        name, thought: null, short_term: [], long_term: [], short_change: null, long_change: null,
        plan: null, progress: null, mode: null, mode_since: null, held: null, parked: false, detour: false,
        last_state: null, last_seen: null, routine: null, skin: null,
    };
}

// Compares two stream ids ("<ms>-<n>"). Returns <0, 0 or >0.
export function compareSid(a: string, b: string): number {
    const [a_ms, a_n = '0'] = a.split('-');
    const [b_ms, b_n = '0'] = b.split('-');
    const ms = Number(a_ms) - Number(b_ms);
    return ms !== 0 ? ms : Number(a_n) - Number(b_n);
}

const text = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);
const titles = (goals: unknown): string[] => (Array.isArray(goals) ? goals.map((g) => text(g?.title, text(g?.option_id, '?'))) : []);
const goalList = (goals: unknown): Goal[] => (Array.isArray(goals)
    ? goals.slice(0, 3).map((g) => ({ id: text(g?.id) || undefined, title: text(g?.title, text(g?.option_id, '?')), option_id: text(g?.option_id) || undefined }))
    : []);

// The model's own sentence is a field of its own on the goal change that carries the planner's
// decision (decided: `thought`). Nothing is parsed out of a reason any more: an event without the
// field (one written before it existed) simply has no thought.
export function thoughtOf(data: Record<string, any> | null | undefined): string | null {
    const sentence = typeof data?.thought === 'string' ? data.thought.trim() : '';
    return sentence.length > 0 ? sentence : null;
}

function agentOf(state: LiveState, name: string): AgentView | null {
    if (SERVICE_NAMES.includes(name)) return null;
    if (!state.agents[name]) {
        if (Object.keys(state.agents).length >= CAPS.agents) return null;
        state.agents[name] = emptyAgent(name);
    }
    return state.agents[name];
}

function cap<T>(list: T[], max: number): void {
    if (list.length > max) list.length = max;
}

// ---- incidents ----

export function isIncidentEvent(event: GenesisEvent): boolean {
    return (event.type === 'agent.failure' || event.type === 'agent.recovery') && typeof event.data?.incident_id === 'string';
}

// Applies one incident event to the incident it belongs to (or starts it).
export function foldIncident(previous: Incident | null, event: GenesisEvent): Incident {
    const d = event.data;
    const incident: Incident = previous ?? {
        incident_id: String(d.incident_id), kind: String(d.kind),
        source: { type: String(d.source?.type ?? 'agent'), name: String(d.source?.name ?? event.agent) },
        is_failure: d.is_failure === true, outcome: String(d.outcome), needs_operator: d.needs_operator === true,
        phase: String(d.phase), started_at: event.ts, updated_at: event.ts, ended_at: null, reason: null, steps: [],
    };
    if (event.ts < incident.started_at) incident.started_at = event.ts;
    if (event.ts >= incident.updated_at) {
        incident.updated_at = event.ts;
        incident.phase = String(d.phase);
        incident.outcome = String(d.outcome);
    }
    incident.is_failure = incident.is_failure || d.is_failure === true;
    incident.needs_operator = incident.needs_operator || d.needs_operator === true;
    if (typeof d.reason === 'string' && d.reason) incident.reason = d.reason;
    else if (incident.reason === null && typeof d.error === 'string') incident.reason = d.error;
    if (d.phase === 'resolved') incident.ended_at = event.ts;
    const r = d.recovery;
    if (r && typeof r.step === 'string') {
        const step = { at: event.ts, step: r.step, attempt: Number(r.attempt) || 0, max: Number(r.max) || 0, result: String(r.result) };
        // the "pending" line of a step is replaced by how it ended
        const waiting = incident.steps.findIndex((s) => s.step === step.step && s.attempt === step.attempt && s.result === 'pending');
        const same = incident.steps.some((s) => s.step === step.step && s.attempt === step.attempt && s.result === step.result);
        if (waiting >= 0) incident.steps[waiting] = step;
        else if (!same) incident.steps.push(step);
        if (incident.steps.length > CAPS.incident_steps) incident.steps.splice(0, incident.steps.length - CAPS.incident_steps);
    }
    return incident;
}

// Folds a list of incident events (any order) into incidents, newest first.
export function foldIncidents(events: GenesisEvent[]): Incident[] {
    const by_id = new Map<string, Incident>();
    const sorted = [...events].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    for (const event of sorted) {
        if (!isIncidentEvent(event)) continue;
        const id = String(event.data.incident_id);
        by_id.set(id, foldIncident(by_id.get(id) ?? null, event));
    }
    return [...by_id.values()].sort((a, b) => (a.started_at < b.started_at ? 1 : -1));
}

// Still going on? A model-away period is, until the model is back. Any other event that is not
// a failure (an intended restart) is a note, never something that stays open.
export function incidentIsOpen(incident: Incident): boolean {
    if (incident.ended_at !== null) return false;
    if (!incident.is_failure) return incident.kind === 'model.away';
    return incident.outcome !== 'auto_recovered' && incident.outcome !== 'gave_up';
}

// ---- messages ----

const FIRST_STATES = ['pending', 'delivered', 'rejected'];

function foldMessage(state: LiveState, event: GenesisEvent): void {
    const d = event.data;
    if (typeof d.msg_id !== 'string') return; // the plain { to, text } form is upstream chat, not a relay message
    const key = `${d.conv}/${d.msg_id}`;
    const at = state.messages.findIndex((m) => m.key === key);
    if (at >= 0 && !FIRST_STATES.includes(d.state)) {
        const known = state.messages[at];
        known.state = String(d.state);
        known.reason = typeof d.reason === 'string' ? d.reason : known.reason;
        known.updated_at = event.ts;
        return;
    }
    const message: MessageView = {
        key, msg_id: d.msg_id, conv: String(d.conv), from: String(d.from), to: String(d.to), type: String(d.type),
        body: d.body && typeof d.body === 'object' ? d.body : {}, chat_line: typeof d.chat_line === 'string' ? d.chat_line : null,
        expires_at: typeof d.expires_at === 'string' ? d.expires_at : null, state: String(d.state),
        reason: typeof d.reason === 'string' ? d.reason : null, at: event.ts, updated_at: event.ts,
    };
    if (at >= 0) state.messages.splice(at, 1); // the relay started counting again: the old one goes
    state.messages.unshift(message);
    cap(state.messages, CAPS.messages);
}

// ---- agent.state ----

function foldAgentState(state: LiveState, agent: AgentView | null, event: GenesisEvent): void {
    const name = String(event.data.state);
    const detail = (event.data.detail ?? {}) as Record<string, any>;
    // ---- what the services say (no agent of their own) ----
    if (name === 'world_zones') { state.world.zones = detail; state.world.zones_at = event.ts; return; }
    if (name === 'world_bootstrap') { state.world.bootstrap = detail; state.world.bootstrap_at = event.ts; return; }
    if (name === 'server_down_wait' && typeof detail.agent === 'string') {
        const before = state.server.waiting[detail.agent];
        state.server.waiting[detail.agent] = { since: before?.since ?? event.ts, attempt: Number(detail.attempt) || 1, message: text(detail.message) };
        return;
    }
    if (name === 'server_back' && typeof detail.agent === 'string') { delete state.server.waiting[detail.agent]; state.server.last_back = event.ts; return; }
    if ((name === 'skin_applied' || name === 'skin_failed' || name === 'skin_cleared') && typeof detail.agent === 'string') {
        const whose = state.agents[detail.agent];
        if (whose) whose.skin = { state: name === 'skin_applied' ? 'applied' : name === 'skin_failed' ? 'failed' : 'cleared', at: event.ts, reason: text(detail.reason) || null };
        return;
    }
    if (name.startsWith('model_')) {
        const gate = name.slice('model_'.length);
        if (gate === 'available' || gate === 'leaving' || gate === 'away') {
            if (state.model.state !== gate) state.model.since = event.ts;
            state.model.state = gate;
            state.model.reason = typeof detail.reason === 'string' ? detail.reason : null;
        }
        return;
    }
    if (!agent) return;
    if (name === 'goals') {
        // the agent's goals as it starts (decided: long-term goals are emitted as events)
        agent.long_term = goalList(detail.long_term);
        if (agent.short_change === null) agent.short_term = goalList(detail.short_term);
        return;
    }
    if (name === 'routine') {
        agent.routine = {
            name: text(detail.name), phase: text(detail.phase), phases: Array.isArray(detail.phases) ? detail.phases.map(String).slice(0, 12) : [],
            away: detail.away === true, parked: detail.parked === true, deaths: Number(detail.deaths) || 0,
            bounds: detail.bounds && typeof detail.bounds === 'object' ? detail.bounds : null, at: event.ts,
        };
        return;
    }
    agent.last_state = name;
    const plan = agent.plan;
    const mine = plan !== null && (detail.goal_id === undefined || detail.goal_id === null || detail.goal_id === plan.goal_id);
    switch (name) {
        case 'goal_completed': case 'goal_failed': case 'goal_abandoned': case 'routine_yielded':
            if (mine) { agent.plan = null; agent.progress = null; }
            break;
        case 'goal_dropped':
            if (plan !== null && detail.goal_id === plan.goal_id) { agent.plan = null; agent.progress = null; }
            break;
        case 'held':
            agent.held = { by: text(detail.by, 'operator'), at: text(detail.at, event.ts) };
            if (plan) plan.running = null;
            break;
        case 'hold_released': agent.held = null; break;
        case 'on_routine': agent.mode = 'routine'; agent.mode_since = event.ts; break;
        case 'planning': agent.mode = 'model'; agent.mode_since = event.ts; agent.parked = false; break;
        case 'parked': agent.parked = true; break;
        case 'respawned': agent.parked = false; break;
        case 'detour_started': agent.detour = true; break;
        case 'detour_ended': agent.detour = false; break;
        default: break;
    }
}

// ---- one event ----

// Changes `state` in place. Returns false when the entry was already applied (same or older
// stream id): delivery is at-least-once, so the same event can arrive twice.
export function applyEntry(state: LiveState, entry: Entry): boolean {
    if (state.cursor !== null && compareSid(entry.sid, state.cursor) <= 0) return false;
    state.cursor = entry.sid;
    applyEvent(state, entry.event);
    return true;
}

export function applyEvent(state: LiveState, event: GenesisEvent): void {
    const d = event.data ?? {};
    if (state.last_event_at === null || event.ts > state.last_event_at) state.last_event_at = event.ts;
    const agent = agentOf(state, event.agent);
    if (agent) agent.last_seen = event.ts;

    if (isIncidentEvent(event)) {
        const id = String(d.incident_id);
        const at = state.incidents.findIndex((incident) => incident.incident_id === id);
        const folded = foldIncident(at >= 0 ? state.incidents[at] : null, event);
        if (at >= 0) state.incidents.splice(at, 1);
        state.incidents.unshift(folded);
        cap(state.incidents, CAPS.incidents);
        // the gate's own events are the first source; the supervisor's incident says the same
        if (d.kind === 'model.away' && state.model.state !== 'away') state.model = { state: 'away', since: event.ts, reason: text(d.reason) || null };
        if (d.kind === 'model.available' && state.model.state !== 'available') state.model = { state: 'available', since: event.ts, reason: text(d.reason) || null };
        return;
    }

    switch (event.type) {
        case 'agent.decision': {
            const decision: DecisionView = {
                decision_id: String(d.decision_id), agent: event.agent, at: event.ts, summary: text(d.summary),
                trigger: text(d.trigger) || null, command: text(d.command) || null,
                option_id: Array.isArray(d.args) && typeof d.args[0] === 'string' ? d.args[0] : null,
                goal_id: text(d.goal_id) || null, call_id: text(d.call_id) || null,
                steps: Array.isArray(d.steps) ? d.steps.map(String).slice(0, 40) : [], steps_from: text(d.steps_from) || null,
            };
            state.decisions.unshift(decision);
            cap(state.decisions, CAPS.decisions);
            if (agent) {
                agent.plan = {
                    decision_id: decision.decision_id, goal_id: decision.goal_id, title: decision.summary, source: decision.trigger,
                    call_id: decision.call_id, skill: decision.command, steps: decision.steps, steps_from: decision.steps_from,
                    cursor: 0, done_through: -1, attempt: 0, running: null, started_at: event.ts,
                };
                agent.progress = null;
            }
            break;
        }
        case 'skill.started': {
            const plan = agent?.plan;
            if (plan && event.corr === plan.decision_id && Number.isInteger(d.step)) {
                plan.cursor = d.step;
                plan.attempt = Number(d.attempt) || 1;
                plan.running = String(d.skill);
            }
            break;
        }
        case 'skill.progress': {
            if (agent) {
                agent.progress = {
                    skill: String(d.skill), done: Number(d.done) || 0, total: d.total === null ? null : Number(d.total),
                    unit: text(d.unit) || null, at: event.ts,
                };
            }
            break;
        }
        case 'skill.result': {
            const plan = agent?.plan;
            if (plan && event.corr === plan.decision_id && Number.isInteger(d.step)) {
                plan.running = null;
                if (d.ok === true && d.step > plan.done_through) plan.done_through = d.step;
            }
            break;
        }
        case 'goal.changed': {
            if (!agent) break;
            const scope = d.scope === 'long_term' ? 'long_term' : 'short_term';
            const before = titles(d.before);
            const after = titles(d.after);
            const reason = text(d.reason);
            const source = text(d.source, 'executor');
            agent[scope] = goalList(d.after);
            agent[scope === 'long_term' ? 'long_change' : 'short_change'] = { at: event.ts, reason, source };
            if (source === 'planner') {
                const sentence = thoughtOf(d);
                if (sentence) agent.thought = { text: sentence, at: event.ts, call_id: text(d.call_id) || null };
            }
            state.goal_changes.unshift({
                at: event.ts, agent: event.agent, scope, source, reason, call_id: text(d.call_id) || null,
                added: after.filter((title) => !before.includes(title)), removed: before.filter((title) => !after.includes(title)),
            });
            cap(state.goal_changes, CAPS.goal_changes);
            break;
        }
        case 'agent.message': foldMessage(state, event); break;
        case 'agent.state': foldAgentState(state, agent, event); break;
        default: break; // agent.failure / agent.recovery without the incident shape: history only
    }
}

// ---- what the Agents view says about one agent ----

export type AgentStatus = 'Held' | 'Parked' | 'Recovering' | 'Executing' | 'Waiting' | 'Offline';

export function agentStatus(state: LiveState, agent: AgentView, in_game: boolean | null = null): AgentStatus {
    if (in_game === false) return 'Offline';
    if (agent.held) return 'Held';
    if (agent.parked) return 'Parked';
    const recovering = agent.detour || state.incidents.some((incident) => incident.is_failure && incident.source.name === agent.name
        && incident.source.type === 'agent' && incidentIsOpen(incident) && !incident.needs_operator);
    if (recovering) return 'Recovering';
    return agent.plan ? 'Executing' : 'Waiting';
}

// True when the goal in hand was chosen by the role routine, not by the model.
export function isRoutineWork(agent: AgentView): boolean {
    return agent.plan ? agent.plan.source === 'routine' : agent.mode === 'routine';
}
