// Types shared by the dashboard server and the browser code.
// The event envelope is the one of genesis/shared/events.js (the contract; never redefined here).

export type Severity = 'info' | 'warn' | 'error';

export interface GenesisEvent {
    v: number;
    id: string;
    ts: string;
    agent: string;
    seq: number;
    type: string;
    corr: string | null;
    severity: Severity;
    data: Record<string, any>;
}

// One event with its place in the Redis stream. `sid` is the stream entry id
// ("<milliseconds>-<counter>"): the one total order every reader agrees on, used as the
// SSE event id and as the cursor for replay.
export interface Entry {
    sid: string;
    event: GenesisEvent;
}

export interface Goal {
    id?: string;
    title: string;
    option_id?: string;
}

export interface GoalChange {
    at: string;
    agent: string;
    scope: 'long_term' | 'short_term';
    source: string;          // planner | executor | routine | operator
    reason: string;
    call_id: string | null;
    added: string[];
    removed: string[];
}

export interface PlanView {
    decision_id: string;
    goal_id: string | null;
    title: string;
    source: string | null;       // planner | routine | operator | recovery ...
    call_id: string | null;
    skill: string | null;        // the catalog skill of the goal
    steps: string[];             // commands of the skill template
    steps_from: string | null;   // "template": the steps are code, never the model's
    cursor: number;              // index of the step in hand
    done_through: number;        // index of the last step that ended ok (-1: none)
    attempt: number;
    running: string | null;      // the command running right now
    started_at: string;
}

export interface ProgressView {
    skill: string;
    done: number;
    total: number | null;
    unit: string | null;
    at: string;
}

export interface AgentView {
    name: string;
    thought: { text: string; at: string; call_id: string | null } | null;
    short_term: Goal[];
    long_term: Goal[];
    short_change: { at: string; reason: string; source: string } | null;
    long_change: { at: string; reason: string; source: string } | null;
    plan: PlanView | null;
    progress: ProgressView | null;
    mode: 'routine' | 'model' | null;   // from on_routine / planning
    mode_since: string | null;
    held: { by: string; at: string } | null;
    parked: boolean;
    detour: boolean;
    last_state: string | null;
    last_seen: string | null;
}

export interface IncidentStep {
    at: string;
    step: string;
    attempt: number;
    max: number;
    result: string;
}

export interface Incident {
    incident_id: string;
    kind: string;
    source: { type: string; name: string };
    is_failure: boolean;
    outcome: string;
    needs_operator: boolean;
    phase: string;
    started_at: string;
    updated_at: string;
    ended_at: string | null;
    reason: string | null;
    steps: IncidentStep[];
}

export interface MessageView {
    key: string;
    msg_id: string;
    conv: string;
    from: string;
    to: string;
    type: string;
    body: Record<string, any>;
    chat_line: string | null;
    expires_at: string | null;
    state: string;
    reason: string | null;
    at: string;
    updated_at: string;
}

export interface DecisionView {
    decision_id: string;
    agent: string;
    at: string;
    summary: string;
    trigger: string | null;
    command: string | null;
    option_id: string | null;
    goal_id: string | null;
    call_id: string | null;
    steps: string[];
    steps_from: string | null;
}

export interface ModelView {
    state: 'available' | 'leaving' | 'away' | 'unknown';
    since: string | null;
    reason: string | null;
}

export interface LiveState {
    cursor: string | null;
    last_event_at: string | null;
    agents: Record<string, AgentView>;
    model: ModelView;
    goal_changes: GoalChange[];
    incidents: Incident[];
    messages: MessageView[];
    decisions: DecisionView[];
}

export interface Health {
    redis_ok: boolean | null;
    postgres_ok: boolean | null;
    redis_down_since: string | null;
    postgres_down_since: string | null;
    mindserver_ok: boolean | null;
    ingested: number;
    rejected: number;
    unstored: number;
}

// What the MindServer itself says about an agent process (its own status and state calls).
export interface ProcessStatus {
    name: string;
    in_game: boolean;
    socket_connected: boolean;
    pos: [number, number, number] | null;
    health: number | null;
    food: number | null;
    action: string | null;
}
