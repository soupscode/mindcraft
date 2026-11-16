// Genesis: the planning budget of each agent.
//   - 40 planning calls per agent per real hour (a sliding hour; decided, it was 20). The
//     call that would be the 41st is refused.
//   - at least 90 seconds between an agent's calls, counted from the end of the last one.
//     A call that comes sooner is delayed, not refused. The one repair retry after an invalid
//     reply need not wait, and it counts as a call.
//   With these two numbers the 90 seconds alone hold an agent to 40 calls in an hour: the
//   hourly limit is only ever reached when repair retries were made.
// A call that was cancelled because the desktop left is given back (refund).
// Times are milliseconds from the injected clock. No imports.

export const BUDGET_DEFAULTS = Object.freeze({
    max_calls: 40,              // decided
    window_ms: 60 * 60 * 1000,
    min_gap_ms: 90 * 1000,
});

export function createBudget(options = {}) {
    const config = { ...BUDGET_DEFAULTS };
    for (const key of Object.keys(BUDGET_DEFAULTS)) {
        if (options[key] !== undefined) config[key] = options[key];
    }
    const calls = new Map(); // agent -> [{ started_at, ended_at }]

    function recent(agent, now) {
        const list = (calls.get(agent) ?? []).filter((call) => call.started_at > now - config.window_ms);
        if (list.length > 0) calls.set(agent, list); else calls.delete(agent);
        return list;
    }

    return {
        config,
        // May this agent start a call now?
        //   { ok: true }
        //   { ok: false, reason: 'hourly_limit', retry_at }   refuse the call
        //   { ok: false, reason: 'min_gap', retry_at }        delay the call until retry_at
        // repair: true for the one retry after an invalid reply, which need not wait 90 seconds.
        check(agent, now, { repair = false } = {}) {
            const list = recent(agent, now);
            if (list.length >= config.max_calls) {
                return { ok: false, reason: 'hourly_limit', retry_at: list[0].started_at + config.window_ms };
            }
            if (!repair && list.length > 0) {
                const last_end = Math.max(...list.map((call) => call.ended_at ?? call.started_at));
                if (now < last_end + config.min_gap_ms) {
                    return { ok: false, reason: 'min_gap', retry_at: last_end + config.min_gap_ms };
                }
            }
            return { ok: true };
        },
        // Counts a call that starts now. Returns the entry to hand to finish() or refund().
        spend(agent, now) {
            const entry = { agent, started_at: now, ended_at: null };
            if (!calls.has(agent)) calls.set(agent, []);
            calls.get(agent).push(entry);
            return entry;
        },
        finish(entry, now) { entry.ended_at = now; },
        refund(entry) {
            const list = calls.get(entry.agent) ?? [];
            const index = list.indexOf(entry);
            if (index >= 0) list.splice(index, 1);
        },
        usage(agent, now) {
            return { used: recent(agent, now).length, limit: config.max_calls };
        },
        // What the checkpoint keeps under "budgets", and the way back after a restart.
        snapshot(now) {
            const out = {};
            for (const agent of [...calls.keys()]) {
                const list = recent(agent, now);
                if (list.length > 0) out[agent] = { calls: list.map((call) => [call.started_at, call.ended_at]) };
            }
            return out;
        },
        restore(snapshot) {
            calls.clear();
            for (const [agent, saved] of Object.entries(snapshot ?? {})) {
                if (!Array.isArray(saved?.calls)) continue;
                const list = saved.calls
                    .filter((pair) => Array.isArray(pair) && Number.isFinite(pair[0]))
                    .map(([started_at, ended_at]) => ({ agent, started_at, ended_at: Number.isFinite(ended_at) ? ended_at : started_at }));
                if (list.length > 0) calls.set(agent, list);
            }
        },
    };
}
