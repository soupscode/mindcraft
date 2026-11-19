// Genesis learning: the data the Learning screen shows (mock-up Knowledge.dc.html), put
// together from what is stored. Nothing here is generated text about the agents: every
// line is a count or a number computed from the experience and decision rows, and carries
// its n. The screen itself is not built here.
//
//   learningView({ status, versions, decisions, experiences, lessons, plays, roles, now, explore_rate })
//     status       learner.status()                     versions   learner.versions() or the learning_versions rows
//     decisions    rows of `decisions` (any order)      experiences  ended rows of `experience`
//     lessons, plays   rows of those tables (empty until that step is built)
//
//   statements(experiences, { min_side })   the computed comparisons a lesson may rest on:
//     [{ stat_id, skill, statement, value, n, share, against: { statement, value, n, share } }]
//     A comparison is only given when each side has at least `min_side` examples (20).
//
// WHAT THE MOCK-UP SHOWS THAT THIS CANNOT SUPPLY YET is listed at the end of the file.
//
// Depends only on other files of genesis/learning.

import { optionKey } from './count_table.js';

export const STATEMENT_MIN_SIDE = 20;
const DAY_MS = 24 * 60 * 60 * 1000;
const STATE_LABEL = { in_use: 'In use', kept: 'Kept', rolled_back: 'Rolled back', refused: 'Refused', candidate: 'Candidate' };
const SKILL_WORD = {
    travel: 'Travel', gather_blocks: 'Gather', craft_item: 'Craft', store_items: 'Store', fetch_items: 'Fetch', harvest_replant: 'Harvest',
    sow_field: 'Sow', build_blueprint: 'Build', smelt_item: 'Smelt', give_items: 'Hand over', ask_agent: 'Ask', offer_agent: 'Offer', play: 'Play',
};

// The two-sided questions asked of the experience rows. test(experience) -> true (side a), false (side b), null (does not apply).
export const SPLITS = Object.freeze([
    { id: 'dusk', a: 'after dusk', b: 'by day', test: (e) => (e.situation?.daylight_left ?? 1) <= 0 },
    { id: 'climb', skills: ['travel'], a: 'climb over 6', b: 'climb 6 or less', test: (e) => (e.situation?.target ? Math.abs(e.situation.target.dy ?? 0) > 6 : null) },
    { id: 'far', a: 'over 24 blocks away', b: 'within 24 blocks', test: (e) => (e.situation?.target ? (e.situation.target.dist ?? 0) > 24 : null) },
    { id: 'rain', a: 'in rain', b: 'in dry weather', test: (e) => e.situation?.rain === true },
    { id: 'stage', skills: ['build_blueprint'], a: 'with stage in hand', b: 'short of materials',
        test: (e) => (Number.isFinite(e.situation?.target?.materials_share) ? e.situation.target.materials_share >= 1 : null) },
]);

const completed = (e) => e.outcome === 'completed';
const counted = (e) => e.outcome === 'completed' || e.outcome === 'failed' || e.outcome === 'dropped';   // a replaced goal says nothing

export function statements(experiences, { min_side = STATEMENT_MIN_SIDE } = {}) {
    const found = [];
    const by_skill = new Map();
    for (const e of experiences) {
        if (!counted(e)) continue;
        if (!by_skill.has(e.skill)) by_skill.set(e.skill, []);
        by_skill.get(e.skill).push(e);
    }
    for (const [skill, rows] of by_skill) {
        const word = SKILL_WORD[skill] ?? skill;
        for (const split of SPLITS) {
            if (split.skills && !split.skills.includes(skill)) continue;
            const side = { a: { n: 0, value: 0 }, b: { n: 0, value: 0 } };
            for (const e of rows) {
                const which = split.test(e);
                if (which === null) continue;
                const s = which ? side.a : side.b;
                s.n++;
                if (completed(e)) s.value++;
            }
            if (side.a.n < min_side || side.b.n < min_side) continue;
            const make = (key, other) => ({
                stat_id: `${skill}|${split.id}|${key}`, skill, statement: `${word}, ${split[key]}`, value: side[key].value, n: side[key].n, share: side[key].value / side[key].n,
                against: { statement: `${word}, ${split[other]}`, value: side[other].value, n: side[other].n, share: side[other].value / side[other].n },
            });
            found.push(make('a', 'b'), make('b', 'a'));
        }
        // who says yes: requests by recipient
        if (skill === 'ask_agent') {
            const by_to = new Map();
            for (const e of rows) {
                const to = e.args?.to;
                if (typeof to !== 'string') continue;
                const s = by_to.get(to) ?? { n: 0, value: 0 };
                s.n++;
                if (completed(e)) s.value++;
                by_to.set(to, s);
            }
            const all = { n: rows.length, value: rows.filter(completed).length };
            for (const [to, s] of by_to) {
                if (s.n < min_side || all.n - s.n < min_side) continue;
                found.push({
                    stat_id: `ask_agent|to|${to}`, skill, statement: `Requests accepted by ${to}`, value: s.value, n: s.n, share: s.value / s.n,
                    against: { statement: 'Requests accepted by the others', value: all.value - s.value, n: all.n - s.n, share: (all.value - s.value) / (all.n - s.n) },
                });
            }
        }
    }
    // strongest first: the biggest difference between the two sides
    return found.sort((x, y) => Math.abs(y.share - y.against.share) - Math.abs(x.share - x.against.share) || x.stat_id.localeCompare(y.stat_id));
}

const idParts = (id) => String(id ?? '').split(':');

// What changed in behaviour: choices that differ from what the unlearned rule (the first option) would have taken.
export function behaviourChanges(decisions, { limit = 3 } = {}) {
    const groups = new Map();
    for (const d of decisions) {
        if (typeof d.chosen !== 'string' || typeof d.default_choice !== 'string' || d.chosen === d.default_choice) continue;
        if (d.chooser !== 'network' && d.chooser !== 'routine') continue;
        const chosen = idParts(d.chosen);
        const was = idParts(d.default_choice);
        const same_target = chosen[0] === was[0] && chosen.slice(1).filter((p) => !/^\d+$/.test(p)).join(':') === was.slice(1).filter((p) => !/^\d+$/.test(p)).join(':');
        const count = (parts) => parts.filter((p) => /^\d+$/.test(p)).pop() ?? null;
        const word = SKILL_WORD[chosen[0]] ?? chosen[0];
        let text;
        if (same_target && count(chosen) !== null && count(was) !== null) text = `${word} ${chosen.slice(1).filter((p) => !/^\d+$/.test(p)).join(' ')}: ${count(chosen)}, was ${count(was)}`;
        else if (chosen[0] === was[0]) text = `${word}: ${chosen.slice(1).join(' ')} before ${was.slice(1).join(' ')}`;
        else text = `${word} ${chosen.slice(1).join(' ')} instead of ${(SKILL_WORD[was[0]] ?? was[0]).toLowerCase()} ${was.slice(1).join(' ')}`;
        text = text.replace(/_/g, ' ');
        const g = groups.get(text) ?? { text, n: 0, explore: 0 };
        g.n++;
        if (d.explore) g.explore++;
        groups.set(text, g);
    }
    return [...groups.values()].sort((a, b) => b.n - a.n || a.text.localeCompare(b.text)).slice(0, limit);
}

// Ten bins into the three rows of the mock-up: said, happened, n.
function calibrationRows(bins) {
    const rows = [[0, 3], [3, 7], [7, 10]].map(([from, to]) => {
        let n = 0; let said = 0; let happened = 0;
        for (const bin of bins.slice(from, to)) { if (bin.n > 0) { n += bin.n; said += bin.said * bin.n; happened += bin.happened * bin.n; } }
        return { n, said: n > 0 ? said / n : null, happened: n > 0 ? happened / n : null };
    });
    return rows;
}

export function learningView({ status, versions = [], decisions = [], experiences = [], lessons = [], plays = [], roles = {}, now = Date.now(), explore_rate = 0.25, min_side = STATEMENT_MIN_SIDE } = {}) {
    const names = Object.keys(status.agents);
    const using = names.filter((agent) => status.in_use[agent]).length;
    const agents = names.map((agent) => {
        const a = status.agents[agent];
        const options = [...a.options];
        const sure = (o) => (o.spread ?? 0) + 1 / Math.sqrt(1 + o.n);            // the scorer's uncertainty
        const today = statements(experiences.filter((e) => e.agent === agent && (e.ended_at ?? 0) >= now - DAY_MS), { min_side });
        return {
            name: agent, role: roles[agent] ?? null,
            state: a.state === 'network' ? 'In use' : 'Table',
            examples: { own: a.own, from_others: a.from_others, label: 'Learned' },
            called_right: { window: a.called_right.n, network: a.called_right.network, table: a.called_right.table },
            error: { network: a.error, table: a.table_error, curve: a.curve, from: 0, to: a.own },
            calibration: calibrationRows(a.calibration),
            most_sure: options.filter((o) => o.n >= 20).sort((x, y) => sure(x) - sure(y)).slice(0, 2).map((o) => ({ title: o.title, key: o.key, p_ok: o.p_ok, n: o.n })),
            least_sure: options.sort((x, y) => sure(y) - sure(x)).slice(0, 2).map((o) => ({ title: o.title, key: o.key, n: o.n })),
            changed: behaviourChanges(decisions.filter((d) => d.agent === agent)),
            today: today.slice(0, 2).map((s) => ({ stat_id: s.stat_id, text: s.statement, done: s.value, of: s.n, label: 'Computed' })),
        };
    });
    const count = (rows, state) => rows.filter((r) => r.state === state).length;
    return {
        header: {
            examples: status.examples, version: status.version, updated_at: status.updated_at,
            in_use: { n: using, of: names.length }, error: status.error, table_error: status.table_error,
            trying: { rate: explore_rate, text: `1 in ${Math.round(1 / explore_rate)}` }, frozen: status.frozen,
        },
        agents,
        lessons: {
            active: count(lessons, 'active'), stale: count(lessons, 'stale'),
            list: lessons.map((l) => ({ id: l.id, agent: l.agent, at: l.created_at, text: l.body ?? l.text, written_by: 'Model', state: l.state, basis: (l.basis ?? []).map((b) => ({ ...b, label: 'Computed' })) })),
        },
        plays: {
            active: count(plays, 'active'), retired: count(plays, 'retired'),
            list: plays.map((p) => ({ id: p.id, agent: p.agent, name: p.name, steps: p.steps, worked: p.worked, tried: p.tried, state: p.state, retired_reason: p.retired_reason ?? null, last10: p.last10 ?? [] })),
        },
        versions: [...versions].sort((a, b) => b.v - a.v).map((r) => ({
            v: r.v, state: STATE_LABEL[r.state] ?? r.state, at: r.created_at, n: r.examples,
            err: r.metrics?.candidate_error ?? r.metrics?.net_error ?? null, reason: r.reason ?? null,
        })),
    };
}

// The key an experience row is grouped under on the screen ("gather_blocks:oak_log").
export const experienceKey = (e) => optionKey({ id: e.option_id, skill: e.skill, args: e.args });

// NOT SUPPLIED YET (each needs a step that is not part of this pass):
//   header "Played 52 h"            the run time is in the event stream, not in the learning tables
//   "Changed: Home 4 min earlier"   needs the earlier-shelter step (the plan's L8); only choices among options are compared here
//   "Changed: Gathers 16, was 8"    the wording is supplied, but the catalog offers one batch size today, so it cannot occur until the catalog offers several
//   Lessons (text, date, state)     written by the model in the lesson step (L10); the statements they rest on ARE supplied (statements())
//   Plays                           found by the play step (L10); the table and the shape exist
//   option titles                   the experience row has the option id; the catalog's title must be passed in when the row is written
