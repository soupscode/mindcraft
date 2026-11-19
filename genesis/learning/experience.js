// Genesis learning: the experience record and the decision record. Written by code only.
//
// One experience per goal. It is OPENED when the goal starts, with the situation and with
// what was predicted for it, and CLOSED when the goal ends, with what happened. The
// prediction can never be written or changed after the outcome is known: openExperience
// takes it, closeExperience refuses it. Every accuracy number is computed from these two
// halves, so it is honest by construction (prediction first, outcome after).
//
// Experience (the plan's section 2.1; predicted_at is added so the order can be checked):
//   id, agent, goal_id, decision_id, call_id, option_id, skill, args,
//   chooser            planner | routine | network | operator | recovery
//   explore, play_id
//   situation          the raw snapshot at goal start (makeSituation below). Raw, not a feature
//                      vector: a new feature version re-reads these rows and retrains.
//   predicted          { net_version, source, table { p_ok, p_danger, secs, yield, n }, net { p_ok, p_danger, secs, yield, spread, danger_max } | null }
//   predicted_at, started_at, world_sha256
//   -- filled when the goal ends --
//   outcome, reason    completed | failed | dropped | abandoned, and the named failure reason
//   done, total, duration_ms
//   steps              [{ command, ok, reason, ms, attempts }]
//   died, health_min, health_lost, stuck, incident_ids
//   gained             inventory difference { item: n }
//   ended_at
//
// Decision: one row per choice, whoever made it:
//   decision_id, agent, chooser, call_id, situation,
//   offered            [{ id, p_ok, p_danger, secs, n, need, score }]   everything the catalog offered, with the estimates shown
//   chosen, default_choice    default_choice: what the unlearned rule (the first option) would have picked
//   explore, net_version, prompt_version, ts
//
// No imports.

export const EXPERIENCE_VERSION = 1;
export const CHOOSERS = Object.freeze(['planner', 'routine', 'network', 'operator', 'recovery']);
export const OUTCOMES = Object.freeze(['completed', 'failed', 'dropped', 'abandoned']);
export const DANGER_HEALTH_LOST = 6;   // losing this much health during a goal counts as danger
export const PATH_STATUSES = Object.freeze(['ok', 'partial', 'none', 'unknown']);

export const EXPERIENCE_OPEN_FIELDS = Object.freeze([
    'id', 'agent', 'goal_id', 'decision_id', 'call_id', 'option_id', 'skill', 'args', 'chooser', 'explore', 'play_id',
    'situation', 'predicted', 'predicted_at', 'started_at', 'world_sha256',
]);
export const EXPERIENCE_CLOSE_FIELDS = Object.freeze([
    'outcome', 'reason', 'done', 'total', 'duration_ms', 'steps', 'died', 'health_min', 'health_lost', 'stuck', 'incident_ids', 'gained', 'ended_at',
]);
export const EXPERIENCE_FIELDS = Object.freeze([...EXPERIENCE_OPEN_FIELDS, ...EXPERIENCE_CLOSE_FIELDS]);
export const DECISION_FIELDS = Object.freeze([
    'decision_id', 'agent', 'chooser', 'call_id', 'situation', 'offered', 'chosen', 'default_choice', 'explore', 'net_version', 'prompt_version', 'ts',
]);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.length > 0;
const num = (value, fallback = 0) => (Number.isFinite(value) ? value : fallback);
const isTime = (value) => Number.isFinite(typeof value === 'string' ? Date.parse(value) : value);
const ms = (value) => (typeof value === 'string' ? Date.parse(value) : value);
const probability = (value) => Number.isFinite(value) && value >= 0 && value <= 1;

// The raw snapshot of an agent's situation at the moment a goal is about to start. Missing
// parts get neutral values, so a snapshot from an older writer still reads.
//   position {x,y,z}, dimension, home_distance, range, health, food, free_slots,
//   inventory { item: n } (catalog-known items), tools { pickaxe, axe, sword, hoe } (tier 0 to 5),
//   day_tick, daylight_left (ticks, 0 at night), rain,
//   agents_near [{ name, dist }], hostiles_near,
//   target { pos, dist, dy, home_distance, in_site, path, kind, cells, materials_share } | null,
//   queue_length, model_available,
//   recent { outcomes[3], streak_option, streak_skill, mins_since_death, deaths_hour, incidents_hour, last_failure_group },
//   place  { here { ok, fail, death, stuck }, target { ok, fail, death, stuck } },
//   recipient { kept_share, near } | null      (for a message or a hand-over)
export function makeSituation(raw = {}) {
    const position = isObject(raw.position) ? { x: num(raw.position.x), y: num(raw.position.y, 64), z: num(raw.position.z) } : { x: 0, y: 64, z: 0 };
    const target = isObject(raw.target) ? {
        pos: isObject(raw.target.pos) ? { x: num(raw.target.pos.x), y: num(raw.target.pos.y, 64), z: num(raw.target.pos.z) } : null,
        dist: Math.max(0, num(raw.target.dist)),
        dy: num(raw.target.dy),
        home_distance: Math.max(0, num(raw.target.home_distance)),
        in_site: raw.target.in_site === true,
        path: PATH_STATUSES.includes(raw.target.path) ? raw.target.path : 'unknown',
        kind: isText(raw.target.kind) ? raw.target.kind : null,
        cells: Number.isFinite(raw.target.cells) ? raw.target.cells : null,                       // a build: cells this goal would change
        materials_share: Number.isFinite(raw.target.materials_share) ? raw.target.materials_share : null, // a build: share of the stage's bill in hand
    } : null;
    const counts = (value) => ({ ok: num(value?.ok), fail: num(value?.fail), death: num(value?.death), stuck: num(value?.stuck) });
    return {
        position,
        dimension: isText(raw.dimension) ? raw.dimension : 'overworld',
        home_distance: Math.max(0, num(raw.home_distance)),
        range: Math.max(1, num(raw.range, 32)),
        health: num(raw.health, 20),
        food: num(raw.food, 20),
        free_slots: num(raw.free_slots, 36),
        inventory: isObject(raw.inventory) ? { ...raw.inventory } : {},
        tools: { pickaxe: num(raw.tools?.pickaxe), axe: num(raw.tools?.axe), sword: num(raw.tools?.sword), hoe: num(raw.tools?.hoe) },
        day_tick: num(raw.day_tick),
        daylight_left: Math.max(0, num(raw.daylight_left)),
        rain: raw.rain === true,
        agents_near: Array.isArray(raw.agents_near) ? raw.agents_near.filter(isObject).map((a) => ({ name: String(a.name), dist: num(a.dist) })) : [],
        hostiles_near: Math.max(0, num(raw.hostiles_near)),
        target,
        queue_length: Math.max(0, num(raw.queue_length)),
        model_available: raw.model_available === true,
        recent: {
            outcomes: Array.isArray(raw.recent?.outcomes) ? raw.recent.outcomes.slice(0, 3) : [],
            streak_option: num(raw.recent?.streak_option),
            streak_skill: num(raw.recent?.streak_skill),
            mins_since_death: Number.isFinite(raw.recent?.mins_since_death) ? raw.recent.mins_since_death : null,
            deaths_hour: num(raw.recent?.deaths_hour),
            incidents_hour: num(raw.recent?.incidents_hour),
            last_failure_group: ['path', 'materials', 'other'].includes(raw.recent?.last_failure_group) ? raw.recent.last_failure_group : null,
        },
        place: { here: counts(raw.place?.here), target: counts(raw.place?.target) },
        recipient: isObject(raw.recipient) ? { kept_share: probability(raw.recipient.kept_share) ? raw.recipient.kept_share : null, near: raw.recipient.near === true } : null,
    };
}

function checkEstimate(estimate, label, problems) {
    if (!isObject(estimate)) { problems.push(`${label} must be an object`); return; }
    for (const key of ['p_ok', 'p_danger']) if (!probability(estimate[key])) problems.push(`${label}.${key} must be a probability`);
    if (!(Number.isFinite(estimate.secs) && estimate.secs > 0)) problems.push(`${label}.secs must be a positive number`);
}

// The prediction stored with a goal. The count table always predicts; the network's part is
// null only when no network was loaded.
export function checkPredicted(predicted) {
    const problems = [];
    if (!isObject(predicted)) return ['predicted must be an object'];
    if (predicted.net_version !== null && !Number.isInteger(predicted.net_version)) problems.push('predicted.net_version must be a whole number or null');
    checkEstimate(predicted.table, 'predicted.table', problems);
    if (isObject(predicted.table) && !Number.isFinite(predicted.table.n)) problems.push('predicted.table.n must be a number');
    if (predicted.net !== null && predicted.net !== undefined) checkEstimate(predicted.net, 'predicted.net', problems);
    return problems;
}

// The first half: { ok: true, experience } or { ok: false, problems }.
export function openExperience(fields) {
    const problems = [];
    if (!isObject(fields)) return { ok: false, problems: ['an experience must be an object'] };
    for (const key of ['id', 'agent', 'option_id', 'skill']) if (!isText(fields[key])) problems.push(`${key} must be a non-empty string`);
    if (!CHOOSERS.includes(fields.chooser)) problems.push(`chooser must be one of ${CHOOSERS.join(', ')}`);
    if (!isObject(fields.situation)) problems.push('situation must be an object');
    problems.push(...checkPredicted(fields.predicted));
    if (!isTime(fields.predicted_at)) problems.push('predicted_at must be a time');
    if (!isTime(fields.started_at)) problems.push('started_at must be a time');
    for (const key of EXPERIENCE_CLOSE_FIELDS) {
        if (fields[key] !== undefined && fields[key] !== null) problems.push(`${key} belongs to the end of the goal: it cannot be set when the goal starts`);
    }
    if (problems.length > 0) return { ok: false, problems };
    return {
        ok: true,
        experience: {
            id: fields.id, agent: fields.agent, goal_id: fields.goal_id ?? null, decision_id: fields.decision_id ?? null, call_id: fields.call_id ?? null,
            option_id: fields.option_id, skill: fields.skill, args: isObject(fields.args) ? { ...fields.args } : {},
            chooser: fields.chooser, explore: fields.explore === true, play_id: fields.play_id ?? null,
            situation: fields.situation, predicted: fields.predicted,
            predicted_at: ms(fields.predicted_at), started_at: ms(fields.started_at), world_sha256: fields.world_sha256 ?? null,
            outcome: null, reason: null, done: null, total: null, duration_ms: null, steps: [],
            died: false, health_min: null, health_lost: 0, stuck: false, incident_ids: [], gained: {}, ended_at: null,
        },
    };
}

// The second half: { ok: true, experience } (a new object) or { ok: false, problems }.
export function closeExperience(open, end) {
    const problems = [];
    if (!isObject(open) || !isObject(end)) return { ok: false, problems: ['closeExperience needs the open experience and what happened'] };
    if (open.outcome !== null) problems.push('this experience has already ended');
    for (const key of ['predicted', 'predicted_at', 'situation']) {
        if (end[key] !== undefined) problems.push(`${key} was fixed when the goal started and cannot be changed afterwards`);
    }
    if (!OUTCOMES.includes(end.outcome)) problems.push(`outcome must be one of ${OUTCOMES.join(', ')}`);
    if (!isTime(end.ended_at)) problems.push('ended_at must be a time');
    else if (ms(end.ended_at) < open.predicted_at) problems.push('the goal cannot end before its prediction was made');
    if (problems.length > 0) return { ok: false, problems };
    const ended_at = ms(end.ended_at);
    return {
        ok: true,
        experience: {
            ...open,
            outcome: end.outcome,
            reason: end.reason ?? null,
            done: Number.isFinite(end.done) ? end.done : null,
            total: Number.isFinite(end.total) ? end.total : null,
            duration_ms: Number.isFinite(end.duration_ms) ? end.duration_ms : Math.max(0, ended_at - open.started_at),
            steps: Array.isArray(end.steps) ? end.steps.map((s) => ({ command: s.command, ok: s.ok === true, reason: s.reason ?? null, ms: num(s.ms), attempts: num(s.attempts, 1) })) : [],
            died: end.died === true,
            health_min: Number.isFinite(end.health_min) ? end.health_min : null,
            health_lost: Math.max(0, num(end.health_lost)),
            stuck: end.stuck === true,
            incident_ids: Array.isArray(end.incident_ids) ? [...end.incident_ids] : [],
            gained: isObject(end.gained) ? { ...end.gained } : {},
            ended_at,
        },
    };
}

// What the network is trained on, from recorded outcomes only.
//   ok        1 completed, 0 failed or dropped, null for a goal a new plan replaced (censored)
//   yield     done / total, 0 to 1, or null when the goal has no measure
//   log_secs  natural log of the seconds from start to end, completed goals only
//   danger    1 when the agent died, lost DANGER_HEALTH_LOST or more health, or was parked as stuck
//   died, hurt, stuck   the three parts of danger, kept apart so the head can be split later
export function labelsOf(experience) {
    const ended = OUTCOMES.includes(experience?.outcome);
    if (!ended) return null;
    const ok = experience.outcome === 'completed' ? 1 : experience.outcome === 'abandoned' ? null : 0;
    const measured = Number.isFinite(experience.done) && Number.isFinite(experience.total) && experience.total > 0;
    const hurt = num(experience.health_lost) >= DANGER_HEALTH_LOST;
    return {
        ok,
        yield: measured ? Math.min(1, Math.max(0, experience.done / experience.total)) : (ok === 1 ? 1 : null),
        log_secs: ok === 1 && experience.duration_ms > 0 ? Math.log(Math.max(1, experience.duration_ms / 1000)) : null,
        danger: experience.died === true || hurt || experience.stuck === true ? 1 : 0,
        died: experience.died === true, hurt, stuck: experience.stuck === true,
    };
}

// { ok: true, decision } or { ok: false, problems }.
export function makeDecision(fields) {
    const problems = [];
    if (!isObject(fields)) return { ok: false, problems: ['a decision must be an object'] };
    for (const key of ['decision_id', 'agent']) if (!isText(fields[key])) problems.push(`${key} must be a non-empty string`);
    if (!CHOOSERS.includes(fields.chooser)) problems.push(`chooser must be one of ${CHOOSERS.join(', ')}`);
    if (!Array.isArray(fields.offered)) problems.push('offered must be a list');
    const ids = new Set((Array.isArray(fields.offered) ? fields.offered : []).map((o) => o?.id));
    // nothing can be chosen that was not offered: the model and the network only pick from the list
    for (const key of ['chosen', 'default_choice']) {
        const value = fields[key];
        const list = value === null || value === undefined ? [] : Array.isArray(value) ? value : [value];
        for (const id of list) if (!ids.has(id)) problems.push(`${key} names ${id}, which was not offered`);
    }
    if (!isTime(fields.ts)) problems.push('ts must be a time');
    if (problems.length > 0) return { ok: false, problems };
    return {
        ok: true,
        decision: {
            decision_id: fields.decision_id, agent: fields.agent, chooser: fields.chooser, call_id: fields.call_id ?? null,
            situation: fields.situation ?? null,
            offered: fields.offered.map((o) => ({
                id: o.id, p_ok: o.p_ok ?? null, p_danger: o.p_danger ?? null, secs: o.secs ?? null, n: o.n ?? 0, need: o.need ?? null, score: o.score ?? null,
            })),
            chosen: fields.chosen ?? null, default_choice: fields.default_choice ?? null,
            explore: fields.explore === true, net_version: fields.net_version ?? null, prompt_version: fields.prompt_version ?? null, ts: ms(fields.ts),
        },
    };
}
