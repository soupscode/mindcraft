// Genesis learning: the option scorer and the exploration rule.
//
// The scorer NEVER INVENTS AN ACTION. It is handed the list the catalog offers an agent
// (catalog.offer()) and gives the same options back: ordered, and each with what is known
// about it. An option is never added, never dropped and never changed; one whose estimate
// cannot be made stays in the list, unannotated, behind the others.
//
//   rank({ agent, options, situate, chooser, need })
//       -> [{ ...option, estimate, need, score, uncertainty, label, situation, predicted }]
//       estimate   { p_ok, p_danger, secs, yield, spread, danger_max, n, new, source, net_version }
//                  from the network when it is in charge for this agent, else from the count table
//                  (genesis/learning/learner.js decides who is in charge)
//       label      the suffix the planner prompt shows: "[72% 2m]", "!" when danger is above 0.1,
//                  "new" when fewer than 20 examples stand behind the option
//       situation, predicted   what the caller stores in the experience it opens for the chosen option
//   The order is by score, highest first; equal scores keep the catalog's order. The same
//   options, situations and weights always give the same order.
//
//   score = need x p_ok x yield / minutes  -  risk x p_danger
//   `need` is computed by code, never learned: how much the option reduces what the agent's
//   project, the kit chest and the food stock are short of. The caller passes it (1 when it
//   does not); needFromShortfalls() below is the plain form.
//
//   choose({ agent, options, situate, need, started_builds })
//       The choice when the language model is away. DECIDED: the network has free choice
//       among ALL options the catalog offers, not only those of the routine's phase.
//       -> { chosen, explore, ranked, decision }      chosen is one of `options`, or null when there are none
//
// THE EXPLORATION RULE (decided: about 1 in 4, at any time)
//   For each choice a seeded draw comes up "explore" with probability explore_rate (0.25).
//   The choice then goes to an uncertain option: one of the three options the estimates are
//   least sure about (uncertainty = how far the ensemble disagrees, plus a term that is large
//   while few examples stand behind the option), drawn at random. There is no guard for night
//   or for low health: the operator chose that. The hard safety reflexes that already exist
//   in code (flee, eat, shelter: genesis/routines/engine.js, genesis/recovery) are not part of
//   this choice and are not touched by it. When the draw lands on the option that was best
//   anyway it is not marked. Every other exploratory choice carries explore: true ("Trying").
//   The other three in four choices take the best score, with the HIGHEST danger any ensemble
//   member gives in place of the mean: curious about success, careful about dying.
//
// BUILDING WHILE THE MODEL IS AWAY (decided): choose() continues a started build and never
// starts a new one. A build_blueprint option is only eligible when its plot is in started_builds.
// For the same reason the caller may hold options back (held_back): what would use up the
// materials a started build still wants is not chosen, not even as a try.
//
// Depends only on other files of genesis/learning.

import { NEW_BELOW } from './count_table.js';
import { createRng } from './rng.js';

export const SCORER_RULES = Object.freeze({
    explore_rate: 0.25,         // decided: about 1 choice in 4
    explore_among: 3,           // the exploratory choice is drawn from this many least-sure options
    risk: 2,                    // proposed: a certain danger costs as much as two full, one-minute goals are worth
    min_minutes: 0.25,
    danger_mark: 0.1,           // "!" in the label above this
    new_below: NEW_BELOW,
    explore_danger_cap: null,   // decided: no cap. A number here would keep exploration off options whose worst danger estimate is above it
});

const round = (n) => Math.round(n);

// "45s", "2m", "3h"
export function shortTime(secs) {
    if (!Number.isFinite(secs) || secs <= 0) return '?';
    if (secs < 90) return `${Math.max(1, round(secs))}s`;
    if (secs < 90 * 60) return `${round(secs / 60)}m`;
    return `${round(secs / 3600)}h`;
}

// The suffix for one option, built by code: "[72% 2m]", "[new]", "[new 60% 1m !]".
export function optionLabel(estimate, rules = SCORER_RULES) {
    if (!estimate) return '';
    const parts = [];
    if (estimate.new) parts.push('new');
    if (estimate.n > 0) parts.push(`${round(estimate.p_ok * 100)}%`, shortTime(estimate.secs));
    if (estimate.p_danger > rules.danger_mark) parts.push('!');
    return `[${parts.join(' ')}]`;
}

// How much an option helps with what is short: 1 for an option that is about nothing that is
// short, up to 2 for one that covers a whole shortfall. shortfalls: { item: count missing }.
export function needFromShortfalls(option, shortfalls = {}) {
    const args = option?.args ?? {};
    const item = args.item ?? args.type ?? args.seed ?? null;
    const short = item !== null ? shortfalls[item] ?? 0 : 0;
    if (!(short > 0)) return 1;
    const count = Number.isFinite(args.count) ? args.count : 1;
    return 1 + Math.min(1, count / short);
}

export function scoreOf(estimate, need, rules = SCORER_RULES, danger = estimate.p_danger) {
    const minutes = Math.max(rules.min_minutes, estimate.secs / 60);
    return need * estimate.p_ok * estimate.yield / minutes - rules.risk * danger;
}

// learner: { stamp(agent, option, raw, now), estimate(agent, option, situation, { chooser }), toPredicted(estimate) }
export function createScorer({ learner, rules = {}, seed = 1, clock = { now: () => Date.now() } } = {}) {
    if (!learner) throw new Error('the scorer needs the learner (or a read-only copy of it)');
    const R = { ...SCORER_RULES, ...rules };
    const rng = createRng(seed);

    function annotate(agent, option, situate, chooser, need, now) {
        const raw = typeof situate === 'function' ? situate(option) : situate;
        const situation = learner.stamp(agent, option, raw ?? {}, now);
        const est = learner.estimate(agent, option, situation, { chooser });
        const from = est.source === 'network' ? est.net : est.table;
        const estimate = {
            p_ok: from.p_ok, p_danger: from.p_danger, secs: from.secs, yield: from.yield,
            spread: est.net.spread, danger_max: est.source === 'network' ? est.net.danger_max : est.table.p_danger,
            n: est.table.n, new: est.table.n < R.new_below, source: est.source, net_version: est.net_version,
        };
        const wanted = Number.isFinite(need) && need > 0 ? need : 1;
        return {
            ...option, estimate, need: wanted,
            score: scoreOf(estimate, wanted, R),
            careful_score: scoreOf(estimate, wanted, R, estimate.danger_max),
            uncertainty: estimate.spread + 1 / Math.sqrt(1 + estimate.n),
            label: optionLabel(estimate, R),
            situation, predicted: learner.toPredicted(est),
        };
    }

    function rank({ agent, options, situate = {}, chooser = 'planner', need = null, now = clock.now() }) {
        const list = Array.isArray(options) ? options : [];
        const done = list.map((option, index) => {
            try {
                return { index, entry: annotate(agent, option, situate, chooser, typeof need === 'function' ? need(option) : 1, now) };
            } catch {
                // never dropped: it stays offered, without numbers, behind the others
                return { index, entry: { ...option, estimate: null, need: 1, score: -Infinity, careful_score: -Infinity, uncertainty: 0, label: '', situation: null, predicted: null } };
            }
        });
        done.sort((a, b) => (b.entry.score - a.entry.score) || (a.index - b.index));
        return done.map((it) => it.entry);
    }

    // held_back: option ids that stay on the list but are not chosen (what would use up the materials of a build
    // the agent has started: genesis/agent/runtime.js). They are in the decision row like every other option.
    function choose({ agent, options, situate = {}, need = null, started_builds = [], held_back = [], now = clock.now(), explore = true, decision_id = null, prompt_version = null }) {
        const ranked = rank({ agent, options, situate, chooser: 'network', need, now });
        const started = new Set(started_builds);
        const held = new Set(held_back);
        const eligible = ranked.filter((entry) => entry.estimate !== null && !held.has(entry.id) && (entry.skill !== 'build_blueprint' || started.has(entry.args?.plot)));
        const default_choice = options?.[0]?.id ?? null;        // what the unlearned rule takes: the first option
        const explore_draw = rng() < R.explore_rate;            // drawn for every choice, so the sequence does not depend on the options
        const pick_draw = rng();
        let chosen = null;
        let exploring = false;
        if (eligible.length > 0) {
            const best = eligible.reduce((a, b) => (b.careful_score > a.careful_score ? b : a));
            chosen = best;
            if (explore && explore_draw && eligible.length > 1) {
                const allowed = R.explore_danger_cap === null ? eligible : eligible.filter((entry) => entry.estimate.danger_max <= R.explore_danger_cap);
                const unsure = [...allowed].sort((a, b) => b.uncertainty - a.uncertainty).slice(0, R.explore_among);
                if (unsure.length > 0) {
                    chosen = unsure[Math.floor(pick_draw * unsure.length)];
                    exploring = chosen.id !== best.id;
                }
            }
        }
        const decision = {
            decision_id, agent, chooser: 'network', call_id: null, situation: chosen?.situation ?? null,
            offered: ranked.map((entry) => ({
                id: entry.id, p_ok: entry.estimate?.p_ok ?? null, p_danger: entry.estimate?.p_danger ?? null, secs: entry.estimate?.secs ?? null,
                n: entry.estimate?.n ?? 0, need: entry.need, score: Number.isFinite(entry.score) ? entry.score : null,
            })),
            chosen: chosen?.id ?? null, default_choice, explore: exploring,
            net_version: chosen?.estimate.net_version ?? null, prompt_version, ts: now,
        };
        return { chosen, explore: exploring, ranked, decision };
    }

    return { rules: R, rank, choose };
}
