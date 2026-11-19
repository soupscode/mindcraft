// Genesis learning: the two small memories the network's inputs are filled from.
//
//   createPlaceMemory()   what happened where: for each 16 by 16 column cell, decayed counts of
//                         success, failure, death and stuck. Shared by all agents (a death one
//                         agent had at a place is known to all). At most 1,024 cells: a 512-block
//                         border in 16-block cells. WIPED on a full world reset (decided): the
//                         places belong to one world.
//   createHistory()       what happened lately to one agent: its last three goal outcomes, its
//                         failure streak on an option and on a skill, deaths and watchdog
//                         incidents in the last hour, the kind of its last failure.
//
// Both only ever give numbers that were true at the time they are asked: the situation
// snapshot stores them (situation.place, situation.recent) when the goal starts, so a
// training example can be rebuilt from its row alone.
//
// No imports.

export const PLACE_CELL = 16;
export const PLACE_MAX_CELLS = 1024;
export const PLACE_HALF_LIFE_MS = 3 * 24 * 60 * 60 * 1000;   // proposed: a count is worth half after three real days

const cellOf = (pos) => `${Math.floor(pos.x / PLACE_CELL)},${Math.floor(pos.z / PLACE_CELL)}`;
const KINDS = ['ok', 'fail', 'death', 'stuck'];

export function createPlaceMemory({ half_life_ms = PLACE_HALF_LIFE_MS, max_cells = PLACE_MAX_CELLS } = {}) {
    let cells = new Map();   // key -> { ok, fail, death, stuck, at }
    const decayed = (cell, now) => {
        const f = Math.pow(0.5, Math.max(0, now - cell.at) / half_life_ms);
        return { ok: cell.ok * f, fail: cell.fail * f, death: cell.death * f, stuck: cell.stuck * f };
    };
    return {
        // The counts for the cell the position lies in, as they are worth now.
        at(pos, now) {
            if (!pos) return { ok: 0, fail: 0, death: 0, stuck: 0 };
            const cell = cells.get(cellOf(pos));
            return cell ? decayed(cell, now) : { ok: 0, fail: 0, death: 0, stuck: 0 };
        },
        // One thing happened at the position: kind is ok | fail | death | stuck.
        note(pos, kind, now) {
            if (!pos || !KINDS.includes(kind)) return;
            const key = cellOf(pos);
            const before = cells.get(key);
            const next = before ? { ...decayed(before, now), at: now } : { ok: 0, fail: 0, death: 0, stuck: 0, at: now };
            next[kind] += 1;
            cells.delete(key);          // re-insert: the map's order is "least recently touched first"
            cells.set(key, next);
            while (cells.size > max_cells) cells.delete(cells.keys().next().value);
        },
        size: () => cells.size,
        wipe() { cells = new Map(); },
        toJSON() { return { v: 1, cells: [...cells.entries()] }; },
        load(saved) {
            if (saved?.v !== 1 || !Array.isArray(saved.cells)) return false;
            cells = new Map(saved.cells.slice(-max_cells));
            return true;
        },
    };
}

const HOUR_MS = 60 * 60 * 1000;

// Which of the three groups a named failure reason belongs to.
export function failureGroup(reason) {
    const text = String(reason ?? '');
    if (/path|stuck|unreachable|range|avoid/.test(text)) return 'path';
    if (/material|not_held|no_fuel|fuel|recipe|empty|contested|slots|no_/.test(text)) return 'materials';
    return 'other';
}

export function createHistory() {
    const by_agent = new Map();
    const of = (agent) => {
        if (!by_agent.has(agent)) by_agent.set(agent, { outcomes: [], streak_option: new Map(), streak_skill: new Map(), deaths: [], incidents: [], last_failure_group: null });
        return by_agent.get(agent);
    };
    const recent = (times, now) => times.filter((t) => now - t <= HOUR_MS);
    return {
        // What goes into situation.recent for this agent and this option, as of now.
        snapshot(agent, option_key, skill, now) {
            const h = of(agent);
            const last_death = h.deaths[h.deaths.length - 1];
            return {
                outcomes: h.outcomes.slice(-3).reverse(),               // newest first
                streak_option: h.streak_option.get(option_key) ?? 0,
                streak_skill: h.streak_skill.get(skill) ?? 0,
                mins_since_death: last_death === undefined ? null : Math.max(0, (now - last_death) / 60000),
                deaths_hour: recent(h.deaths, now).length,
                incidents_hour: recent(h.incidents, now).length,
                last_failure_group: h.last_failure_group,
            };
        },
        // A goal ended.
        note(agent, option_key, skill, { outcome, reason = null, died = false, stuck = false }, now) {
            const h = of(agent);
            h.outcomes.push(outcome);
            if (h.outcomes.length > 8) h.outcomes.shift();
            if (outcome === 'completed') {
                h.streak_option.delete(option_key);
                h.streak_skill.delete(skill);
            } else if (outcome === 'failed' || outcome === 'dropped') {
                h.streak_option.set(option_key, (h.streak_option.get(option_key) ?? 0) + 1);
                h.streak_skill.set(skill, (h.streak_skill.get(skill) ?? 0) + 1);
                h.last_failure_group = failureGroup(reason);
                if (h.streak_option.size > 200) h.streak_option.delete(h.streak_option.keys().next().value);
            }
            if (died) h.deaths.push(now);
            if (stuck) h.incidents.push(now);
            h.deaths = h.deaths.slice(-20);
            h.incidents = h.incidents.slice(-50);
        },
        // A full world reset: the deaths and incidents were in the old world. Streaks go too.
        wipe() { by_agent.clear(); },
    };
}
