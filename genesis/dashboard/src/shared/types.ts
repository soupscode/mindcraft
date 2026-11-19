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
    // how the goal was chosen while the model was away: "learned" (the learner's estimate) or "trying" (an option
    // it is unsure about); null for everything else
    learned: 'learned' | 'trying' | null;
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
    routine: RoutineView | null;        // the role routine's phase and bounds, from its own event
    skin: { state: 'applied' | 'failed' | 'cleared'; at: string; reason: string | null } | null;   // from the skin service's events
    // the learner's last choice for this agent that has not started yet (its "learned_choice" event comes before the goal's decision)
    learned_choice: { option_id: string; explore: boolean; at: string } | null;
}

// The role routine as its "routine" event says it (genesis/routines/engine.js).
export interface RoutineView {
    name: string;
    phase: string;
    phases: string[];
    away: boolean;
    parked: boolean;
    deaths: number;
    bounds: {
        daylight_ticks_left: number; health: number; food: number; free_slots: number; home_distance: number | null; breached: string[];
        limits: { min_health: number; min_food: number; min_free_slots: number; max_deaths: number; range: number | null };
    } | null;
    at: string;
}

// The site and the bootstrap, from the two events of the name "world" (genesis/world/announce.js).
export interface WorldView {
    zones: Record<string, any> | null;
    zones_at: string | null;
    bootstrap: Record<string, any> | null;
    bootstrap_at: string | null;
}

// Agent processes that wait for a Minecraft server that is down (the supervisor's own lines).
export interface ServerView {
    waiting: Record<string, { since: string; attempt: number; message: string }>;
    last_back: string | null;
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
    world: WorldView;
    server: ServerView;
    learning: LearningTick;
    town: TownTick;
}

// The Learning and Town screens read their data from the MindServer when asked; these say WHEN to ask again
// (every event of the learner or the town moves the tick) and carry the learner's short summary.
export interface LearningTick {
    tick: number;
    at: string | null;
    summary: { version: number; examples: number; frozen: boolean; error: number | null; table_error: number | null; explore_rate: number | null } | null;
}
export interface TownTick {
    tick: number;
    at: string | null;
    last: string | null;         // the last thing that happened: town_plan | plot_proposed | build_progress | build_verified | home_changed
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
