// Genesis learning, in the MindServer process: the ONE learner of all agents, joined to the
// agent processes over the sockets they already have (the agent's side is
// genesis/learning/client.js and genesis/learning/recorder.js).
//
// For one goal:
//   genesis-learn-begin   the agent's raw situation arrives. The learner fills in place memory and
//                         recent history (stamp), says what it expects (estimate), and the experience
//                         is OPENED in the store with that prediction. Only then is the agent answered.
//   genesis-learn-end     the outcome arrives. The experience is CLOSED (the store has no way to
//                         change what was predicted), and the learner scores the stored prediction and
//                         then learns from the outcome (observe).
// An outcome for a goal whose start never arrived is dropped and counted: no prediction was
// stored for it, so it cannot be scored honestly and is not learned from.
//
// For a choice:
//   genesis-learn-rank    the options the catalog offered come back ordered and annotated. THE SAME
//                         options: none added, none dropped, none changed (genesis/learning/scorer.js).
//   genesis-learn-choose  the learner's own pick among them (the model is away). The decision row,
//                         with everything that was on offer, is written here.
//   genesis-learn-decision  a choice somebody else made (the planner's reply), with what was on offer.
//
// What is kept (see keep() and restore()): the count table, the examples seen and who is in
// charge under the name "learner"; the place memory under the name "places" (a full world
// reset removes that one and nothing else); every version of the network as a file
// (genesis/learning/versions.js) and as a row. Written through, never waited for by an agent.
//
// Events (agent.state, named states that carry a view; the dashboard's Learning screen folds them):
//   experience        one goal that ended, compact, with what was predicted for it
//   learning_update   the header and the four agents' numbers (after every `update_every` goals,
//                     and whenever a version, the freeze or who is in charge changes)
//   learning_version  a version was published, refused or rolled back
//
// Injected: learner, scorer, store (genesis/learning/store.js), versions (the version store, or
// null), clock, emit(type, data, opts), warn.
// Depends only on other files of genesis/learning.

import { labelsOf } from './experience.js';
import { optionKey } from './count_table.js';
import { FEATURE_VERSION } from './features.js';
import { learningView } from './views.js';

export const LEARNING_SERVICE_DEFAULTS = Object.freeze({
    update_every: 5,            // goals between two learning_update events
    keep_every: 20,             // goals between two writes of the kept state
    max_options: 64,            // options one rank or choose call may hold
});
export const STATE_LEARNER = 'learner';
export const STATE_PLACES = 'places';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 120) => (typeof value === 'string' ? value.slice(0, max) : null);

export function createLearningService({
    learner, scorer, store, versions = null, clock = { now: Date.now }, emit = () => {}, warn = () => {}, world_sha256 = null, ...options
} = {}) {
    if (!learner || !scorer || !store) throw new Error('the learning service needs the learner, the scorer and the store');
    const config = { ...LEARNING_SERVICE_DEFAULTS };
    for (const key of Object.keys(LEARNING_SERVICE_DEFAULTS)) if (options[key] !== undefined) config[key] = options[key];
    const stats = { begun: 0, ended: 0, refused: 0, without_start: 0, ranked: 0, chosen: 0, decisions: 0, store_failures: 0, kept: 0 };
    const opening = new Map();      // experience id -> the promise of its opening (an end waits for it)
    const titles = new Map();       // option key -> the catalog's title, for the screen
    const known = new Set(learner.agents);
    let since_update = 0;
    let since_keep = 0;
    let decision_counter = 0;
    let writes = Promise.resolve(); // version files and rows, one after the other

    const say = (state, detail, agent = null) => {
        try { emit('agent.state', { state, detail, ...(agent ? { about: agent } : {}) }, { corr: null }); } catch { /* an event must never disturb the learner */ }
    };
    const failed = (what, err) => { stats.store_failures++; try { warn(`learning: ${what} (${err?.message ?? err})`); } catch { /* nothing more to do */ } };
    const cleanOption = (option) => (isObject(option) && typeof option.id === 'string' && typeof option.skill === 'string'
        ? { id: option.id.slice(0, 160), skill: option.skill.slice(0, 40), args: isObject(option.args) ? option.args : {}, title: text(option.title, 80) } : null);

    // The header and the per-agent numbers of the Learning screen, without the long lists.
    function summary() {
        const s = learner.status();
        return {
            version: s.version, examples: s.examples, frozen: s.frozen, feature_version: s.feature_version, updated_at: s.updated_at,
            error: s.error, table_error: s.table_error, scored: s.scored, explore_rate: scorer.rules.explore_rate,
            agents: Object.fromEntries(Object.entries(s.agents).map(([agent, a]) => [agent, {
                state: a.state, own: a.own, from_others: a.from_others, error: a.error, table_error: a.table_error, called_right: a.called_right,
            }])),
        };
    }
    function update() { since_update = 0; say('learning_update', summary()); }

    async function keep() {
        since_keep = 0;
        const saved = learner.exportState();
        try {
            await store.setState(STATE_LEARNER, { v: saved.v, table: saved.table, examples: saved.examples, version: saved.version, in_use: saved.in_use, titles: Object.fromEntries(titles), world_sha256 }, clock.now());
            await store.setState(STATE_PLACES, { v: 1, place: saved.place, world_sha256 }, clock.now());
            stats.kept++;
        } catch (err) { failed('the state could not be kept', err); }
    }

    // A version the learner published, refused or rolled back to (createLearner's onVersion).
    function onVersion(record) {
        const row = { v: record.v, feature_version: record.feature_version ?? FEATURE_VERSION, parent: record.parent ?? null, examples: record.examples, metrics: record.metrics ?? {}, sha256: record.sha256, state: record.state, reason: record.reason ?? null, created_at: record.created_at };
        writes = writes.then(async () => {
            try {
                if (versions && record.weights && record.state === 'in_use') {
                    if (Number.isInteger(record.rolled_back_from)) await versions.point(record.v);
                    else await versions.save({ v: record.v, feature_version: row.feature_version, arch: record.arch, created_at: record.created_at, examples: record.examples, parent: row.parent, metrics: row.metrics, weights: record.weights });
                }
                await store.saveVersion(row);
                if (Number.isInteger(record.rolled_back_from)) await store.markVersion(record.rolled_back_from, 'rolled_back', record.reason ?? null);
                else if (record.state === 'in_use' && Number.isInteger(row.parent) && row.parent !== record.v) await store.markVersion(row.parent, 'kept', null);
            } catch (err) { failed(`version ${record.v} could not be written`, err); }
        });
        say('learning_version', { v: row.v, state: row.state, reason: row.reason, examples: row.examples, metrics: row.metrics, at: row.created_at, rolled_back_from: record.rolled_back_from ?? null });
    }

    async function begin(message) {
        const option = cleanOption(message?.option);
        if (!known.has(message?.agent) || !option || typeof message.id !== 'string') { stats.refused++; return { ok: false, error: 'not an experience of a known agent' }; }
        const now = clock.now();
        const situation = learner.stamp(message.agent, option, isObject(message.situation) ? message.situation : {}, now);
        const estimate = learner.estimate(message.agent, option, situation, { chooser: message.chooser });
        const predicted = learner.toPredicted(estimate);
        if (option.title) titles.set(optionKey(option), option.title);
        if (titles.size > 400) titles.delete(titles.keys().next().value);
        const work = store.beginExperience({
            id: message.id, agent: message.agent, goal_id: text(message.goal_id), decision_id: text(message.decision_id), call_id: text(message.call_id),
            option_id: option.id, skill: option.skill, args: option.args, chooser: message.chooser, explore: message.explore === true, play_id: null,
            situation, predicted, predicted_at: now, started_at: Number.isFinite(message.started_at) ? Math.min(message.started_at, now) : now, world_sha256,
        });
        opening.set(message.id, work.then(() => true, () => false));
        if (opening.size > 200) opening.delete(opening.keys().next().value);
        try {
            await work;
            stats.begun++;
            return { ok: true, predicted };
        } catch (err) {
            stats.refused++;
            return { ok: false, error: String(err?.message ?? err) };
        }
    }

    async function end(message) {
        if (!known.has(message?.agent) || typeof message.id !== 'string' || !isObject(message.end)) { stats.refused++; return { ok: false, error: 'not the end of an experience' }; }
        const opened = opening.get(message.id);
        if (opened !== undefined) await opened;         // the prediction is in the store before the outcome is
        opening.delete(message.id);
        let closed;
        try {
            const mine = await store.experience(message.id);
            if (!mine || mine.agent !== message.agent) throw new Error(`experience ${message.id} was never started by ${message.agent}`);
            closed = await store.endExperience(message.id, { ...message.end, ended_at: Math.max(clock.now(), mine.predicted_at) });
        } catch (err) {
            stats.without_start++;
            return { ok: false, error: String(err?.message ?? err) };
        }
        stats.ended++;
        const before = learner.status();
        try { learner.observe(closed); } catch (err) { failed('an outcome could not be learned from', err); }
        const labels = labelsOf(closed);
        const key = optionKey({ id: closed.option_id, skill: closed.skill, args: closed.args });
        say('experience', {
            id: closed.id, option_id: closed.option_id, skill: closed.skill, title: titles.get(key) ?? closed.option_id, chooser: closed.chooser, explore: closed.explore,
            outcome: closed.outcome, reason: closed.reason, done: closed.done, total: closed.total, secs: closed.duration_ms === null ? null : Math.round(closed.duration_ms / 1000),
            died: closed.died, health_lost: closed.health_lost, stuck: closed.stuck, danger: labels?.danger === 1,
            predicted: { source: closed.predicted.source, net_version: closed.predicted.net_version, p_ok: closed.predicted[closed.predicted.source === 'network' ? 'net' : 'table'].p_ok,
                p_danger: closed.predicted[closed.predicted.source === 'network' ? 'net' : 'table'].p_danger, secs: Math.round(closed.predicted.table.secs), n: closed.predicted.table.n },
            at: closed.ended_at,
        }, closed.agent);
        const after = learner.status();
        since_update++;
        since_keep++;
        const changed = before.version !== after.version || Object.keys(after.in_use).some((agent) => after.in_use[agent] !== before.in_use[agent]);
        if (changed || since_update >= config.update_every) update();
        if (changed || since_keep >= config.keep_every) keep();
        return { ok: true };
    }

    function annotated(message, chooser) {
        const options = (Array.isArray(message?.options) ? message.options : []).slice(0, config.max_options).map(cleanOption).filter(Boolean);
        const situations = isObject(message?.situations) ? message.situations : {};
        const need = isObject(message?.need) ? message.need : {};
        for (const option of options) if (option.title) titles.set(optionKey(option), option.title);
        return { options, situate: (option) => situations[option.id] ?? {}, need: (option) => (Number.isFinite(need[option.id]) && need[option.id] > 0 ? need[option.id] : 1), chooser };
    }
    const shown = (entry) => ({
        id: entry.id, label: entry.label, need: entry.need, score: Number.isFinite(entry.score) ? entry.score : null,
        estimate: entry.estimate ? { p_ok: entry.estimate.p_ok, p_danger: entry.estimate.p_danger, secs: entry.estimate.secs, n: entry.estimate.n, new: entry.estimate.new, source: entry.estimate.source } : null,
    });

    function rank(message) {
        if (!known.has(message?.agent)) { stats.refused++; return { ok: false, error: 'unknown agent' }; }
        const { options, situate, need, chooser } = annotated(message, ['planner', 'routine', 'network', 'operator', 'recovery'].includes(message.chooser) ? message.chooser : 'planner');
        stats.ranked++;
        return { ok: true, net_version: learner.version(), ranked: scorer.rank({ agent: message.agent, options, situate, chooser, need }).map(shown) };
    }

    function choose(message) {
        if (!known.has(message?.agent)) { stats.refused++; return { ok: false, error: 'unknown agent' }; }
        const { options, situate, need } = annotated(message, 'network');
        const decision_id = `d-${clock.now()}-${++decision_counter}`;
        const picked = scorer.choose({
            agent: message.agent, options, situate, need, decision_id,
            started_builds: Array.isArray(message.started_builds) ? message.started_builds.filter((plot) => typeof plot === 'string') : [],
            held_back: Array.isArray(message.held_back) ? message.held_back.filter((id) => typeof id === 'string') : [],
        });
        stats.chosen++;
        // what the unlearned rule (the routine's own pick) would have taken, when the agent says so and it was on offer
        const default_choice = typeof message.default_choice === 'string' && options.some((option) => option.id === message.default_choice) ? message.default_choice : picked.decision.default_choice;
        store.recordDecision({ ...picked.decision, default_choice }).then(() => { stats.decisions++; }, (err) => failed('a decision could not be written', err));
        const est = picked.chosen?.estimate ?? null;
        return {
            ok: true, chosen: picked.chosen?.id ?? null, explore: picked.explore, decision_id, net_version: learner.version(), need: picked.chosen?.need ?? null,
            // the computed sentence the goal carries as its reason
            reason: est ? `learned estimate: ${Math.round(est.p_ok * 100)}% ok, about ${Math.max(1, Math.round(est.secs / 60))} min, from ${est.n} example${est.n === 1 ? '' : 's'}${picked.explore ? ' (trying an option it is unsure about)' : ''}` : null,
            ranked: picked.ranked.map(shown),
        };
    }

    function decision(message) {
        if (!known.has(message?.agent) || !Array.isArray(message.offered)) { stats.refused++; return; }
        const ids = new Set(message.offered.map((o) => o?.id));
        const chosen = (Array.isArray(message.chosen) ? message.chosen : [message.chosen]).filter((id) => ids.has(id));
        store.recordDecision({
            decision_id: text(message.decision_id) ?? `d-${clock.now()}-${++decision_counter}`, agent: message.agent,
            chooser: ['planner', 'routine', 'network', 'operator', 'recovery'].includes(message.chooser) ? message.chooser : 'planner', call_id: text(message.call_id),
            situation: isObject(message.situation) ? message.situation : null, offered: message.offered.filter((o) => typeof o?.id === 'string'),
            chosen: chosen.length === 1 ? chosen[0] : chosen, default_choice: ids.has(message.default_choice) ? message.default_choice : null,
            explore: false, net_version: learner.version(), prompt_version: text(message.prompt_version, 40), ts: clock.now(),
        }).then(() => { stats.decisions++; }, (err) => failed('a decision could not be written', err));
    }

    const freeze = () => { learner.freeze(); update(); return true; };
    const unfreeze = () => { learner.unfreeze(); update(); return true; };
    const rollback = (v) => { const to = Number.isInteger(v) ? learner.rollback(v) : learner.rollback(); if (to !== null) { update(); keep(); } return to; };

    // Everything the Learning screen shows (genesis/learning/views.js), from what is stored: the learner's own
    // numbers, the versions, the decisions (what changed in behaviour) and the last day's experience (the computed
    // statements). The exploration setting is the one the scorer really uses.
    async function view() {
        const now = clock.now();
        const status = learner.status();
        for (const agent of Object.values(status.agents)) for (const option of agent.options) option.title = titles.get(option.key) ?? option.title ?? option.key;
        let decisions = [];
        let experiences = [];
        try { decisions = await store.listDecisions({ limit: 3000 }); } catch (err) { failed('the decisions could not be read', err); }
        try { experiences = await store.listExperience({ since: now - 24 * 60 * 60 * 1000, limit: 5000 }); } catch (err) { failed('the experience could not be read', err); }
        const made = learningView({ status, versions: learner.versions(), decisions, experiences, lessons: [], plays: [], roles: options.roles ?? {}, now, explore_rate: scorer.rules.explore_rate });
        return { ...made, header: { ...made.header, scored: status.scored, at: now }, stats: { ...stats } };
    }

    return {
        learner, scorer, store, versions, onVersion, view,
        // Called for every connection to the MindServer, like the planner host's attach().
        attach(socket, { isAgentSocket = () => true } = {}) {
            const own = (agent) => typeof agent === 'string' && agent.length > 0 && isAgentSocket(agent);
            const answer = (ack, value) => { if (typeof ack === 'function') { try { ack(value); } catch { /* the socket is gone */ } } };
            socket.on('genesis-learn-begin', (message, ack) => { if (own(message?.agent)) begin(message).then((value) => answer(ack, value), () => answer(ack, { ok: false })); });
            socket.on('genesis-learn-end', (message, ack) => { if (own(message?.agent)) end(message).then((value) => answer(ack, value), () => answer(ack, { ok: false })); });
            socket.on('genesis-learn-rank', (message, ack) => { if (!own(message?.agent)) return; try { answer(ack, rank(message)); } catch (err) { answer(ack, { ok: false, error: String(err?.message ?? err) }); } });
            socket.on('genesis-learn-choose', (message, ack) => { if (!own(message?.agent)) return; try { answer(ack, choose(message)); } catch (err) { answer(ack, { ok: false, error: String(err?.message ?? err) }); } });
            socket.on('genesis-learn-decision', (message) => { if (own(message?.agent)) { try { decision(message); } catch { stats.refused++; } } });
            // ---- the operator's side (the dashboard's Learning screen, over the socket it already has) ----
            //   genesis-learning-view     ({}, ack)                 -> ack({ ok, view })
            //   genesis-learning-control  ({ action, v? }, ack)     freeze | unfreeze | rollback (to v, or to the last good version)
            socket.on('genesis-learning-view', (message, ack) => {
                const reply = typeof message === 'function' ? message : ack;
                view().then((made) => answer(reply, { ok: true, view: made }), (err) => answer(reply, { ok: false, reason: String(err?.message ?? err) }));
            });
            socket.on('genesis-learning-control', (message, ack) => {
                try {
                    if (message?.action === 'freeze') answer(ack, { ok: freeze(), frozen: true });
                    else if (message?.action === 'unfreeze') answer(ack, { ok: unfreeze(), frozen: false });
                    else if (message?.action === 'rollback') { const to = rollback(Number.isInteger(message.v) ? message.v : undefined); answer(ack, to === null ? { ok: false, reason: 'no version to roll back to' } : { ok: true, version: to }); }
                    else answer(ack, { ok: false, reason: 'unknown action' });
                } catch (err) { answer(ack, { ok: false, reason: String(err?.message ?? err) }); }
            });
        },
        begin, end, rank, choose, decision, summary, update, keep,
        // The state kept from before: the count table and the examples, the place memory (unless the world was
        // reset since: its row is gone then), and the network version the pointer names.
        async restore() {
            const restored = { table: false, places: false, version: null };
            try {
                const saved = await store.getState(STATE_LEARNER);
                const places = await store.getState(STATE_PLACES);
                if (saved?.v === 1) {
                    restored.table = learner.importState({ v: 1, table: saved.table, place: places?.v === 1 ? places.place : { cells: [] }, examples: saved.examples });
                    restored.places = places?.v === 1;
                    for (const [key, title] of Object.entries(saved.titles ?? {})) titles.set(key, title);
                }
            } catch (err) { failed('the kept state could not be read', err); }
            try {
                const record = versions ? await versions.current() : null;
                if (record && record.feature_version === FEATURE_VERSION && record.v > 0) { learner.loadVersion(record); restored.version = record.v; }
                // nothing kept yet: version 0 (the network that says exactly what the count table says) becomes the first file
                if (versions && record === null) {
                    const first = learner.versions().find((row) => row.v === 0) ?? null;
                    const weights = learner.weights(0);
                    if (first && weights) onVersion({ ...first, arch: weights.arch ?? null, weights });
                    await writes;
                }
            } catch (err) { failed('the kept network version could not be loaded', err); }
            return restored;
        },
        // The operator's controls.
        freeze, unfreeze, rollback,
        // A full world reset: remembered places go, everything learned stays.
        worldReset() { learner.worldReset(); return keep(); },
        titleOf: (key) => titles.get(key) ?? null,
        flush: () => writes,
        stats: () => ({ ...stats, open: opening.size }),
    };
}
