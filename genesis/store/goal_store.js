// Genesis: the goal store. Per agent: 1 to 3 long-term goals and a short-term queue of up
// to 3 goals. Every change is recorded with before, after, a REQUIRED reason, a source
// (planner, executor, routine, operator), the planner call id and a timestamp.
// A change without a reason is refused, and so is one that would leave an agent with no
// long-term goal or with more than 3 goals in either list.
//
// Goal: { id, title, option_id }   title up to 60 chars; option_id is the planner option
//                                   the goal came from, or null
// Change record: { id, agent, scope, before, after, reason, source, call_id, ts }
//
// Storage is injected:
//   load(agent) -> Promise<{ long_term: [...], short_term: [...] } | null>
//   save(agent, goals, change) -> Promise     stores the new lists and appends the change, as one step
// genesis/adapters/pg_stores.js holds the Postgres one; the tests use an in-memory one.
//
// Nothing here throws at the caller: every method resolves to { ok: true, ... } or
// { ok: false, code, error }.

import { GOAL_SCOPES, GOAL_SOURCES, createUlidFactory } from '../shared/events.js';

export const GOAL_LIMITS = Object.freeze({ long_term_min: 1, long_term_max: 3, short_term_max: 3, title: 60 });

const refusal = (code, error) => ({ ok: false, code, error });
const copy = (value) => JSON.parse(JSON.stringify(value));
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// The data of the goal.changed event for a change record (genesis/shared/events.js).
export function goalChangedEventData(change) {
    return {
        scope: change.scope, before: change.before, after: change.after,
        reason: change.reason, source: change.source, call_id: change.call_id,
    };
}

export function createGoalStore({ storage, clock = { now: Date.now }, ids = null, onChange = null } = {}) {
    const nextId = ids ?? createUlidFactory({ now: clock.now });
    const cache = new Map();   // agent -> { long_term, short_term }
    const chains = new Map();  // agent -> promise of the change being applied: one at a time per agent

    async function current(agent) {
        if (!cache.has(agent)) {
            const stored = await storage.load(agent);
            cache.set(agent, {
                long_term: Array.isArray(stored?.long_term) ? copy(stored.long_term) : [],
                short_term: Array.isArray(stored?.short_term) ? copy(stored.short_term) : [],
            });
        }
        return cache.get(agent);
    }

    // Returns the cleaned list, or a refusal.
    function cleanGoals(goals, scope) {
        if (!Array.isArray(goals)) return refusal('bad_goals', 'goals must be a list');
        const seen = new Set();
        const cleaned = [];
        for (const [index, goal] of goals.entries()) {
            if (!isPlainObject(goal)) return refusal('bad_goals', `goals[${index}] must be an object`);
            if (typeof goal.title !== 'string' || goal.title.trim().length === 0) {
                return refusal('bad_goals', `goals[${index}].title must be a non-empty string`);
            }
            if (goal.title.length > GOAL_LIMITS.title) {
                return refusal('bad_goals', `goals[${index}].title is longer than ${GOAL_LIMITS.title} characters`);
            }
            if (goal.id !== undefined && (typeof goal.id !== 'string' || goal.id.length === 0)) {
                return refusal('bad_goals', `goals[${index}].id must be a non-empty string`);
            }
            if (goal.option_id !== undefined && goal.option_id !== null && typeof goal.option_id !== 'string') {
                return refusal('bad_goals', `goals[${index}].option_id must be a string or null`);
            }
            const id = goal.id ?? nextId();
            if (seen.has(id)) return refusal('bad_goals', `goals[${index}].id "${id}" is in the list twice`);
            seen.add(id);
            cleaned.push({ id, title: goal.title, option_id: goal.option_id ?? null });
        }
        if (scope === 'long_term') {
            if (cleaned.length < GOAL_LIMITS.long_term_min) {
                return refusal('too_few', `an agent keeps at least ${GOAL_LIMITS.long_term_min} long-term goal`);
            }
            if (cleaned.length > GOAL_LIMITS.long_term_max) {
                return refusal('too_many', `an agent has at most ${GOAL_LIMITS.long_term_max} long-term goals, got ${cleaned.length}`);
            }
        } else if (cleaned.length > GOAL_LIMITS.short_term_max) {
            return refusal('too_many', `the short-term queue holds at most ${GOAL_LIMITS.short_term_max} goals, got ${cleaned.length}`);
        }
        return { ok: true, goals: cleaned };
    }

    // `next` is the new list, or a function (current list) -> new list.
    async function apply(agent, scope, next, { reason, source, call_id = null } = {}) {
        if (typeof agent !== 'string' || agent.trim().length === 0) return refusal('bad_agent', 'agent must be a non-empty string');
        if (!GOAL_SCOPES.includes(scope)) return refusal('bad_scope', `scope must be one of ${GOAL_SCOPES.join(', ')}`);
        if (typeof reason !== 'string' || reason.trim().length === 0) {
            return refusal('reason_required', 'a goal change needs a reason');
        }
        if (!GOAL_SOURCES.includes(source)) return refusal('bad_source', `source must be one of ${GOAL_SOURCES.join(', ')}`);
        if (call_id !== null && (typeof call_id !== 'string' || call_id.length === 0)) {
            return refusal('bad_call_id', 'call_id must be a non-empty string or null');
        }
        if (source === 'planner' && call_id === null) {
            return refusal('call_id_required', 'a change made by the planner needs the id of the planner call');
        }

        let state;
        try {
            state = await current(agent);
        } catch (err) {
            return refusal('storage_error', `goals could not be loaded: ${err?.message ?? err}`);
        }
        const before = state[scope];
        let wanted;
        try {
            wanted = typeof next === 'function' ? next(copy(before)) : next;
        } catch (err) {
            return refusal('bad_goals', String(err?.message ?? err));
        }
        const cleaned = cleanGoals(wanted, scope);
        if (!cleaned.ok) return cleaned;
        if (JSON.stringify(cleaned.goals) === JSON.stringify(before)) return refusal('no_change', 'the goals are already like that');

        const change = {
            id: nextId(), agent, scope, before: copy(before), after: copy(cleaned.goals),
            reason: reason.trim(), source, call_id, ts: new Date(clock.now()).toISOString(),
        };
        const new_state = { ...state, [scope]: cleaned.goals };
        try {
            await storage.save(agent, copy(new_state), copy(change));
        } catch (err) {
            return refusal('storage_error', `the change was not stored, the goals are unchanged: ${err?.message ?? err}`);
        }
        cache.set(agent, new_state); // only what is stored counts
        if (onChange) {
            try { onChange(copy(change)); } catch { /* the listener's problem */ }
        }
        return { ok: true, change, goals: copy(new_state) };
    }

    // Changes of one agent are applied one after the other, so "before" is always right.
    function inTurn(agent, work) {
        const turn = (chains.get(agent) ?? Promise.resolve()).then(work, work);
        chains.set(agent, turn.catch(() => {}));
        return turn.catch((err) => refusal('internal_error', String(err?.message ?? err)));
    }

    const change = (agent, scope, next, meta) => inTurn(agent, () => apply(agent, scope, next, meta));

    return {
        // The agent's goals: { long_term: [...], short_term: [...] } (both empty for an agent never seen).
        async get(agent) {
            try {
                return { ok: true, goals: copy(await current(agent)) };
            } catch (err) {
                return refusal('storage_error', `goals could not be loaded: ${err?.message ?? err}`);
            }
        },
        // meta: { reason, source, call_id }
        setLongTerm: (agent, goals, meta) => change(agent, 'long_term', goals, meta),
        setShortTerm: (agent, goals, meta) => change(agent, 'short_term', goals, meta),
        // Adds a goal at the end of the short-term queue. Refused when the queue is full.
        pushShortTerm: (agent, goal, meta) => change(agent, 'short_term', (queue) => [...queue, goal], meta),
        // Takes the first goal off the short-term queue (done, or given up: the reason says which).
        shiftShortTerm: (agent, meta) => change(agent, 'short_term', (queue) => queue.slice(1), meta),
    };
}
