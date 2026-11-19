// Genesis: long-term goals. DECIDED:
//   - each agent's MODEL sets its own long-term goals, within its role. As everywhere, the model chooses
//     among what code offers: longTermCandidates() is the list for a role, and the reply names ids from it.
//   - ARTHUR'S first goal always points at the next rung of the building ladder ("Build the Cabin"). It is
//     computed, pinned, and follows the builds; the model chooses what stands beside it.
//   - the OPERATOR can override an agent's long-term goals in the dashboard. An override stands until the
//     operator lifts it.
//   - while the model is away an agent has its role's defaults (so it always has a long-term goal);
//     the model replaces them when it is back.
//
// Host side (this file, in the MindServer process): the small model call that makes the choice
// (kind "long_term", its own budget), and the operator's override, kept in the town file.
// Agent side: genesis/planning/long_term.js writes the goals into the agent's goal store.
//
//   genesis-goal-choose  ({ agent, role, candidates: [{ id, title }], max, facts }, ack)
//                        -> ack({ ok, chosen: [ids], reason, call_id } | { ok: false, reason })
//
// Depends only on other Genesis files.

import { SHARED_BUILDER, highestVerified, OPEN_FROM_START } from '../build/unlock.js';

export const LONG_TERM_LIMITS = Object.freeze({ max_calls: 2, window_ms: 12 * 60 * 60 * 1000, max_tokens: 90, timeout_ms: 20 * 1000, wait_ms: 30 * 1000 });
export const LONG_TERM_REASON_MAX = 140;
export const GOAL_TITLE_MAX = 60;

// What each role may choose from beside its home (id, title). Titles are at most 60 characters.
export const ROLE_GOALS = Object.freeze({
    builder: [['connect', 'Keep the town connected: steps and bridges'], ['stock_build', 'Keep building materials in the shared chest'], ['help_homes', 'Help the others get their homes built']],
    farmer: [['feed', 'Keep the town fed'], ['fields', 'Keep the field sown and harvested'], ['bread', 'Bake bread for the kit chest']],
    explorer: [['routes', 'Find routes and resources around the town'], ['supply', 'Bring back what the builds need'], ['ring', 'Walk the whole patrol ring']],
    merchant: [['chests', 'Keep the chests stocked and fair'], ['broker', 'Broker materials for the current project'], ['kits', 'Keep the kit chest full']],
});
const clip = (text) => (text.length <= GOAL_TITLE_MAX ? text : `${text.slice(0, GOAL_TITLE_MAX - 1)}…`);

// The next rung of the ladder for the shared builder: of his next home tier, his next shared project and a bridge
// the town has placed, the one of the lowest tier (his home first among equals).  -> { prefab, title, kind, tier, plot } | null
export function nextRung({ town_state, prefabs, builder = SHARED_BUILDER }) {
    const all = prefabs.names().map((name) => prefabs.get(name)).filter(Boolean);
    const done = (name) => (town_state.builds ?? []).some((b) => b.builder === builder && b.prefab === name && b.verified_at);
    const earned = highestVerified(town_state.builds ?? [], builder);
    const open = (p) => p.tier <= OPEN_FROM_START || earned >= p.tier - 1;
    const home = all.filter((p) => p.kind === 'home' && p.by === 'Generated').sort((a, b) => a.tier - b.tier).find((p) => !done(p.name)) ?? null;
    const shared = all.filter((p) => p.kind === 'shared').sort((a, b) => a.tier - b.tier).find((p) => !done(p.name) && open(p)) ?? null;
    const span = (town_state.spans ?? []).find((s) => !(town_state.builds ?? []).some((b) => b.plot === s.id && b.verified_at)) ?? null;
    const rungs = [
        home ? { prefab: home.name, title: home.title ?? home.name, kind: 'home', tier: home.tier, order: 0 } : null,
        span ? { prefab: span.prefab, title: 'Footbridge', kind: 'bridge', tier: 1, plot: span.id, order: 1 } : null,
        shared ? { prefab: shared.name, title: shared.title ?? shared.name, kind: 'shared', tier: shared.tier, order: 2 } : null,
    ].filter(Boolean).sort((a, b) => a.tier - b.tier || a.order - b.order);
    return rungs[0] ?? null;
}

// The long-term goals an agent may have: [{ id, title, pinned? }]. `home` is everyone's; `rung` is the shared builder's, pinned.
export function longTermCandidates({ agent, role, town_state, prefabs, shared_builder = SHARED_BUILDER }) {
    const list = [];
    if (agent === shared_builder) {
        const rung = nextRung({ town_state, prefabs, builder: agent });
        list.push({ id: 'rung', title: clip(rung ? `Build the ${rung.title}` : 'Keep every build of the town standing'), pinned: true });
    }
    const tiers = prefabs.names().map((name) => prefabs.get(name)).filter((p) => p && p.kind === 'home' && p.by === 'Generated').sort((a, b) => a.tier - b.tier);
    const mine = (town_state.builds ?? []).filter((b) => b.builder === agent && b.verified_at && tiers.some((p) => p.name === b.prefab)).reduce((top, b) => Math.max(top, b.tier), -1);
    const next = tiers.find((p) => p.tier > mine) ?? null;
    list.push({ id: 'home', title: clip(next ? `My home: build the ${next.title ?? next.name}` : 'My home: keep it in good order') });
    for (const [id, title] of ROLE_GOALS[role] ?? []) list.push({ id, title: clip(title) });
    return list;
}

// What an agent has while the model has not chosen: the pinned goal, its home, and the first of its role.
export function defaultChoice(candidates, max = 3) {
    const pinned = candidates.filter((c) => c.pinned).map((c) => c.id);
    const rest = candidates.filter((c) => !c.pinned);
    const home = rest.find((c) => c.id === 'home');
    const role = rest.filter((c) => c.id !== 'home');
    return [...pinned, ...(role[0] ? [role[0].id] : []), ...(home ? [home.id] : []), ...(role[1] ? [role[1].id] : [])].slice(0, max);
}

export function goalMessages({ agent, role, candidates, max, facts = '' }) {
    return [
        { role: 'system', content: `You are ${agent}${role ? `, the ${role},` : ''} of a small Minecraft town. Choose your own long-term goals for the coming days: 1 to ${max} of the listed ids, most important first. Reply with JSON only: {"goals": ["<id>", ...], "reason": "<one sentence, at most ${LONG_TERM_REASON_MAX} characters>"}.` },
        { role: 'user', content: `${facts ? `${String(facts).slice(0, 300)}\n` : ''}You may choose from:\n${candidates.map((c) => `- ${c.id}: ${c.title}`).join('\n')}` },
    ];
}
export const goalSchema = (ids, max) => ({
    type: 'object',
    properties: { goals: { type: 'array', minItems: 1, maxItems: max, items: { type: 'string', enum: ids } }, reason: { type: 'string', maxLength: LONG_TERM_REASON_MAX } },
    required: ['goals', 'reason'],
});
// { goals, reason } when the reply is exactly that and names only offered ids, else null.
export function parseGoalReply(raw, ids, max) {
    let parsed;
    try { parsed = JSON.parse(String(raw)); } catch { return null; }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).some((key) => key !== 'goals' && key !== 'reason')) return null;
    if (!Array.isArray(parsed.goals) || parsed.goals.length < 1 || parsed.goals.length > max || new Set(parsed.goals).size !== parsed.goals.length) return null;
    if (!parsed.goals.every((id) => typeof id === 'string' && ids.includes(id))) return null;
    if (typeof parsed.reason !== 'string' || parsed.reason.trim().length === 0 || parsed.reason.length > LONG_TERM_REASON_MAX) return null;
    return { goals: parsed.goals, reason: parsed.reason.replace(/\s+/g, ' ').trim() };
}

export function createTownGoals({ town, prefabs, roles = {}, agents = Object.keys(roles), emit = () => null, clock = { now: Date.now } } = {}) {
    let broker = null;
    const stats = { asked: 0, chosen: 0, refused: 0, overrides: 0 };

    async function choose({ agent, role = roles[agent] ?? null, max = 2, facts = '' }) {
        stats.asked++;
        if (!agents.includes(agent)) return { ok: false, reason: 'unknown_agent' };
        const candidates = longTermCandidates({ agent, role, town_state: town.state(), prefabs }).filter((c) => !c.pinned);
        if (candidates.length === 0) return { ok: false, reason: 'nothing_to_choose' };
        if (!broker?.small) return { ok: false, reason: 'no_model' };
        const ids = candidates.map((c) => c.id);
        const limit = Math.max(1, Math.min(max, ids.length));
        const result = await broker.small({
            kind: 'long_term', agent, trigger: { kind: 'long_term' }, messages: goalMessages({ agent, role, candidates, max: limit, facts }), format: goalSchema(ids, limit),
            validate: (raw) => parseGoalReply(raw, ids, limit) !== null,
        });
        if (!result.ok) { stats.refused++; return { ok: false, reason: result.reason, call_id: result.call_id ?? null }; }
        const reply = parseGoalReply(result.content, ids, limit);
        stats.chosen++;
        return { ok: true, chosen: reply.goals, reason: reply.reason, call_id: result.call_id };
    }

    return {
        choose,
        // The operator's override: 1 to 3 titles, or null to lift it. Kept in the town file; every agent's copy carries it.
        async override(agent, titles) {
            if (typeof agent !== 'string' || !agents.includes(agent)) return { ok: false, reason: 'unknown_agent' };
            let clean = null;
            if (titles !== null) {
                if (!Array.isArray(titles)) return { ok: false, reason: 'bad_titles' };
                clean = titles.map((title) => String(title ?? '').replace(/\s+/g, ' ').trim()).filter((title) => title.length > 0).map((title) => title.slice(0, GOAL_TITLE_MAX));
                if (clean.length < 1 || clean.length > 3) return { ok: false, reason: 'one_to_three_goals' };
            }
            stats.overrides++;
            await town.update((t) => { t.goals[agent] = { ...(t.goals[agent] ?? {}), override: clean, override_at: new Date(clock.now()).toISOString() }; });
            try { emit('agent.state', { state: 'long_term_override', detail: { agent, titles: clean }, about: agent }, { corr: null }); } catch { /* an event never disturbs this */ }
            return { ok: true, agent, titles: clean };
        },
        attach(socket, { isAgentSocket = () => true } = {}) {
            socket.on('genesis-goal-choose', (message, ack) => {
                if (typeof message?.agent !== 'string' || !isAgentSocket(message.agent) || typeof ack !== 'function') return;
                choose(message).then((answer) => ack(answer), (err) => ack({ ok: false, reason: String(err?.message ?? err) }));
            });
            // what the agent's model (or its defaults) chose, kept so that it is there again after a restart
            socket.on('genesis-goal-chosen', (message) => {
                if (typeof message?.agent !== 'string' || !isAgentSocket(message.agent) || !Array.isArray(message.ids)) return;
                town.update((t) => { t.goals[message.agent] = { ...(t.goals[message.agent] ?? {}), chosen: message.ids.filter((id) => typeof id === 'string').slice(0, 3), chosen_by: message.by === 'planner' ? 'planner' : 'routine', chosen_at: new Date(clock.now()).toISOString() }; });
            });
        },
        bind(more = {}) {
            if (more.broker) { broker = more.broker; broker.addSmallKind?.('long_term', LONG_TERM_LIMITS); }
        },
        stop() {},
        stats: () => ({ ...stats }),
    };
}
