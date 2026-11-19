// Genesis learning: the count table. The baseline that is in charge until the network
// beats it (genesis/learning/learner.js decides when), and the network's starting point:
// the network's outputs are corrections added to these estimates, so with no data the
// network says exactly what the table says.
//
// It counts outcomes at three levels and shrinks each towards the one above:
//   skill (all agents)  ->  agent and skill  ->  agent and option
// With nothing counted it gives the neutral priors below. An option here is the skill and
// what it is aimed at, without the count: "gather_blocks:oak_log" covers 8 and 16 alike.
//
//   predict(agent, option) -> { p_ok, p_danger, secs, yield, n, n_own, n_skill }
//       n        examples of this option by ANY agent (what stands behind the estimate; under
//                NEW_BELOW the option is shown as "new")
//       n_own    examples of this option by this agent
//       n_skill  examples of this skill by any agent
//   update(agent, option, labels)   labels from labelsOf() in experience.js
//   toJSON() / load(json)           kept across restarts and across a full world reset
//
// Honest scoring is the caller's job and is simple: call predict() before update().
//
// No imports.

export const NEW_BELOW = 20;            // fewer examples than this behind an option: shown as "new"

export const TABLE_PRIORS = Object.freeze({
    p_ok: 0.5,              // one success and one failure imagined per skill (Laplace)
    ok_weight: 2,
    p_danger: 0.05,         // one danger in twenty imagined
    danger_weight: 20,
    secs: 60,
    secs_weight: 1,
    yield: 0.7,
    yield_weight: 2,
    agent_strength: 4,      // an agent's own count of a skill is worth this many of the shared ones
    option_strength: 8,     // and its count of one option this many of its count of the skill
});

const ARG_KEYS = ['place', 'type', 'item', 'seed', 'crop', 'plot', 'play']; // what an option is aimed at
const PARTNER_KEYS = ['to', 'chest'];

// "gather_blocks:oak_log" for { skill: 'gather_blocks', args: { type: 'oak_log', count: 8 } }.
export function optionKey(option) {
    const skill = String(option?.skill ?? String(option?.id ?? '').split(':')[0]);
    const args = option?.args ?? {};
    const parts = [skill];
    for (const key of PARTNER_KEYS) if (typeof args[key] === 'string') parts.push(args[key]);
    for (const key of ARG_KEYS) if (typeof args[key] === 'string') { parts.push(args[key]); break; }
    if (parts.length === 1 && typeof option?.id === 'string') {
        // no arguments given: take the id without its numbers
        parts.push(...option.id.split(':').slice(1).filter((part) => !/^\d+$/.test(part)));
    }
    return parts.join(':');
}

const emptyNode = () => ({ n: 0, ok_n: 0, ok: 0, danger: 0, secs_n: 0, log_secs: 0, yield_n: 0, yield: 0 });

export function createCountTable(priors = TABLE_PRIORS) {
    const P = { ...TABLE_PRIORS, ...priors };
    let nodes = new Map();      // key -> node
    let all = emptyNode();      // everything, for the danger base rate
    const node = (key) => nodes.get(key) ?? emptyNode();
    const bump = (key, labels) => {
        let it = nodes.get(key);
        if (!it) { it = emptyNode(); nodes.set(key, it); }
        add(it, labels);
    };
    function add(it, labels) {
        it.n++;
        if (labels.ok === 0 || labels.ok === 1) { it.ok_n++; it.ok += labels.ok; }
        it.danger += labels.danger ? 1 : 0;
        if (Number.isFinite(labels.log_secs)) { it.secs_n++; it.log_secs += labels.log_secs; }
        if (Number.isFinite(labels.yield)) { it.yield_n++; it.yield += labels.yield; }
    }
    // (sum + weight * prior) / (count + weight), level by level
    const shrink = (sum, count, prior, weight) => (sum + weight * prior) / (count + weight);

    return {
        predict(agent, option) {
            const skill = String(option?.skill ?? '');
            const key = optionKey(option);
            const s = node(`s|${skill}`);
            const as = node(`a|${agent}|${skill}`);
            const ao = node(`o|${agent}|${key}`);
            const shared = node(`k|${key}`);
            const p_ok = shrink(ao.ok, ao.ok_n, shrink(as.ok, as.ok_n, shrink(s.ok, s.ok_n, P.p_ok, P.ok_weight), P.agent_strength), P.option_strength);
            // danger is rare: the base rate of everything first, then the skill, then the agent
            const base = shrink(all.danger, all.n, P.p_danger, P.danger_weight);
            const p_danger = shrink(as.danger, as.n, shrink(s.danger, s.n, base, P.danger_weight), P.danger_weight);
            const log_secs = shrink(ao.log_secs, ao.secs_n,
                shrink(as.log_secs, as.secs_n, shrink(s.log_secs, s.secs_n, Math.log(P.secs), P.secs_weight), P.agent_strength), P.agent_strength);
            const yield_ = shrink(ao.yield, ao.yield_n, shrink(as.yield, as.yield_n, shrink(s.yield, s.yield_n, P.yield, P.yield_weight), P.agent_strength), P.option_strength);
            return { p_ok, p_danger, secs: Math.exp(log_secs), yield: yield_, n: shared.n, n_own: ao.n, n_skill: s.n };
        },
        update(agent, option, labels) {
            if (!labels) return;
            const skill = String(option?.skill ?? '');
            const key = optionKey(option);
            add(all, labels);
            bump(`s|${skill}`, labels);
            bump(`a|${agent}|${skill}`, labels);
            bump(`o|${agent}|${key}`, labels);
            bump(`k|${key}`, labels);
        },
        // how many examples an agent has of a skill (the dashboard's per-domain counts)
        counts(agent, skill) { return { own: node(`a|${agent}|${skill}`).n, all: node(`s|${skill}`).n }; },
        total: () => all.n,
        baseDanger: () => shrink(all.danger, all.n, P.p_danger, P.danger_weight),
        toJSON() { return { v: 1, all: { ...all }, nodes: [...nodes.entries()].map(([key, it]) => [key, { ...it }]) }; },
        load(saved) {
            if (saved?.v !== 1 || !Array.isArray(saved.nodes)) return false;
            all = { ...emptyNode(), ...saved.all };
            nodes = new Map(saved.nodes.map(([key, it]) => [key, { ...emptyNode(), ...it }]));
            return true;
        },
    };
}
