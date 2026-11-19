// Genesis: an agent's long-term goals, written into its goal store. The rules (decided) are in
// genesis/town/goals.js; this is the agent's side of them.
//
// review() is called at start, whenever the town changes, and when the model comes back. It brings
// the goal store's long-term list (1 to 3 goals) to what it should be right now:
//   1. the operator's override, when there is one (source "operator")
//   2. else what the agent's model chose among its role's candidates, with Arthur's pinned first goal,
//      "Build the <next rung>", in front (source "planner", the model's reason, the call id)
//   3. while the model has not chosen: the role's defaults (source "routine")
// A goal whose title is computed follows what it is computed from: when a build is verified the next
// rung's name replaces the old one (source "executor", a computed reason).
// Every change is a goal.changed event with its reason, like any other goal change.
//
// Injected: agent, role, goals (the goal store), town (genesis/town/client.js), prefabs, send (the socket),
// modelAvailable(), clock.
// Depends only on other Genesis files.

import { longTermCandidates, defaultChoice } from '../town/goals.js';

export const LONG_TERM_RULES = Object.freeze({
    ask_again_ms: 6 * 60 * 60 * 1000,   // the model is asked again after this long, and whenever a build of the agent's is verified
    retry_ms: 10 * 60 * 1000,           // after a call that brought nothing
    timeout_ms: 60 * 1000,
    max_goals: 3,
});

export function createLongTerm({
    agent, role = null, goals, town, prefabs, send, modelAvailable = () => false, clock = { now: Date.now, setTimeout, clearTimeout }, rules: overrides = {},
} = {}) {
    const R = { ...LONG_TERM_RULES, ...overrides };
    const stats = { reviews: 0, changes: 0, asked: 0, chosen: 0, defaults: 0, overrides: 0, errors: 0 };
    let chosen = null;          // { ids, by: 'planner' | 'routine', at, reason, call_id }
    let asked_at = -Infinity;
    let asked_for = null;       // how many verified builds the agent had when the model was last asked
    let busy = false;

    const mine = () => (town.state().builds ?? []).filter((b) => b.builder === agent && b.verified_at).length;
    const candidates = () => longTermCandidates({ agent, role, town_state: town.state(), prefabs });
    const titlesOf = (ids, list) => ids.map((id) => list.find((c) => c.id === id)?.title).filter(Boolean);

    async function write(titles, meta) {
        const now = await goals.get(agent);
        if (!now.ok) return false;
        const have = now.goals.long_term.map((goal) => goal.title);
        if (have.length === titles.length && have.every((title, i) => title === titles[i])) return false;
        const done = await goals.setLongTerm(agent, titles.map((title) => ({ title })), meta);
        if (done.ok) stats.changes++;
        return done.ok;
    }

    const ask = (payload) => new Promise((resolve) => {
        let settled = false;
        const finish = (value) => { if (settled) return; settled = true; clock.clearTimeout(timer); resolve(value); };
        const timer = clock.setTimeout(() => finish(null), R.timeout_ms);
        timer?.unref?.();
        try { send('genesis-goal-choose', payload, (answer) => finish(answer ?? null)); } catch { finish(null); }
    });

    async function review(why = 'review') {
        if (busy) return 'busy';
        busy = true;
        stats.reviews++;
        try {
            const state = town.state();
            // 1. the operator's word stands
            const override = state.goals?.[agent]?.override ?? null;
            if (Array.isArray(override) && override.length > 0) {
                if (await write(override.slice(0, R.max_goals), { reason: 'set by the operator in the dashboard', source: 'operator', call_id: null })) stats.overrides++;
                return 'operator';
            }
            const list = candidates();
            const pinned = list.filter((c) => c.pinned).map((c) => c.id);
            const free = list.filter((c) => !c.pinned);
            // what was chosen before this process started is in the town file
            if (chosen === null) {
                const kept = state.goals?.[agent] ?? null;
                if (Array.isArray(kept?.chosen) && kept.chosen.length > 0) chosen = { ids: kept.chosen.filter((id) => free.some((c) => c.id === id)), by: kept.chosen_by ?? 'routine', at: clock.now(), reason: null, call_id: null };
                if (chosen && chosen.ids.length === 0) chosen = null;
                if (chosen?.by === 'planner') { asked_at = clock.now(); asked_for = mine(); }
            }
            // 2. the model chooses, when it is there and has not chosen for the agent as it stands now
            const now = clock.now();
            const due = asked_for !== mine() || now - asked_at >= R.ask_again_ms || chosen === null || chosen.by !== 'planner';
            if (modelAvailable() && due && now - asked_at >= R.retry_ms) {
                asked_at = now;
                stats.asked++;
                const home = state.homes?.[agent];
                const answer = await ask({ agent, role, max: R.max_goals - pinned.length - 0, facts: `Your home: ${home ? `the ${home.title}` : 'none yet'}. Builds of yours that stand: ${mine()}.` });
                if (answer?.ok && Array.isArray(answer.chosen) && answer.chosen.length > 0) {
                    const ids = answer.chosen.filter((id) => free.some((c) => c.id === id)).slice(0, R.max_goals - pinned.length);
                    if (ids.length > 0) {
                        chosen = { ids, by: 'planner', at: now, reason: String(answer.reason ?? 'the planner chose'), call_id: answer.call_id ?? null };
                        asked_for = mine();
                        stats.chosen++;
                        try { send('genesis-goal-chosen', { agent, ids, by: 'planner' }); } catch { /* kept in memory only */ }
                        await write(titlesOf([...pinned, ...ids], list), { reason: chosen.reason, source: 'planner', call_id: chosen.call_id });
                        return 'planner';
                    }
                }
            }
            // 3. no choice of the model's yet: the role's defaults
            if (chosen === null) {
                const ids = defaultChoice(list, R.max_goals).filter((id) => !pinned.includes(id));
                chosen = { ids, by: 'routine', at: now, reason: null, call_id: null };
                stats.defaults++;
                try { send('genesis-goal-chosen', { agent, ids, by: 'routine' }); } catch { /* kept in memory only */ }
                await write(titlesOf([...pinned, ...ids], list), { reason: `role default${role ? ` for the ${role}` : ''}: the model has not chosen yet`, source: 'routine', call_id: null });
                return 'default';
            }
            // the same choice, with the titles as they are computed now (the next rung, the next home tier)
            const titles = titlesOf([...pinned, ...chosen.ids], list).slice(0, R.max_goals);
            if (titles.length > 0 && await write(titles, { reason: `${why}: the goals follow what was built`, source: 'executor', call_id: null })) return 'computed';
            return 'unchanged';
        } catch {
            stats.errors++;
            return 'error';
        } finally {
            busy = false;
        }
    }

    return { review, rules: R, chosen: () => (chosen ? { ...chosen } : null), stats: () => ({ ...stats }) };
}
