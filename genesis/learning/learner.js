// Genesis learning: the learner. It owns the count table, the place memory, the recent
// history, the network (an ensemble) and its versions, and it decides who is in charge.
//
// THE ORDER OF THINGS FOR ONE GOAL
//   1. stamp(agent, option, raw_situation, now)   the situation snapshot, with place memory and recent history filled in
//   2. estimate(agent, option, situation)         what the table and the PUBLISHED network version say
//   3. the caller stores toPredicted(estimate) in the experience it opens (experience.js)
//   4. the goal runs and ends; the caller closes the experience
//   5. observe(experience)                        scores the stored prediction, THEN learns from the outcome
// The prediction that is scored is the one that was stored in step 3, never a later one.
//
// TWO SETS OF WEIGHTS
//   live        trained after every goal (one step per ensemble member on that example plus 31
//               from the replay buffer: half from the newest 2,000, half from everything kept)
//   published   a numbered version; the only weights predictions are made with. So every stored
//               prediction names the version that made it.
//
// A NEW VERSION IS HELD OUT BEFORE IT IS USED (versions and automatic rollback)
//   online   every `snapshot_every` goals the live weights are a candidate. Before each training
//            step the live and the published weights both predict the new example, which neither
//            has seen: that window is the held-out test. The candidate is published only when it
//            passes the gate (see gate() below): it predicts no worse there than the published
//            version and all its weights are finite. Otherwise it is recorded as refused.
//   refit    refit() trains a fresh ensemble on the older 85% of the replay buffer and scores it on
//            the newest 15% (held out by time). The same rule decides. A refused candidate changes nothing.
//   bench    while the network is in charge for at least one agent: over the rolling window of the
//            last 300 stored predictions, when the network's success log-loss is more than 5% worse
//            than the count table's, every agent goes back to the table, the weights roll back to
//            the last version that was good while it was in use, and one low-priority incident is
//            reported. The network then has to earn the takeover again, agent by agent.
//   operator freeze() stops training and publishing; rollback(v) goes back by hand.
//
// WHEN THE NETWORK TAKES OVER FROM THE COUNT TABLE (per agent)
//   The table is in charge at the start. An agent's network takes over when at least
//   `takeover_min_scored` (200) of that agent's stored predictions have been scored since the
//   last rollback and, over that agent's rolling window, the network's success log-loss is at
//   least `takeover_margin` (2%) below the table's. It hands back when it is more than
//   `bench_margin` (5%) worse. In between it stays as it is, so it does not flicker.
//   estimate().source says who is in charge for that agent: "network" or "table".
//
// A FULL WORLD RESET (decided): worldReset() wipes the place memory and the recent history;
// the network, the count table and the scores are kept.
//
// The learner is synchronous and deterministic (seeded). Persistence is the caller's:
// onVersion(record) is told about every version, exportState() / importState() carry the rest.
//
// NOT BUILT HERE (integration): running in the MindServer process, the nightly refit in a
// worker thread, telling agents about a new version over their socket.
//
// Depends only on other files of genesis/learning.

import { createCountTable, optionKey } from './count_table.js';
import { createPlaceMemory, createHistory } from './memory.js';
import { featurize, FEATURE_VERSION } from './features.js';
import { labelsOf, makeSituation } from './experience.js';
import { createEnsemble, predict, trainStep, offsetsOf, nonZero, cloneEnsemble, exportWeights, importWeights, allFinite, weightsHash, HYPER, ENSEMBLE_SIZE } from './net.js';
import { createRng } from './rng.js';

export const LEARNING_RULES = Object.freeze({
    replay_max: 40000,          // examples kept in memory for training
    replay_recent: 2000,        // half of every batch comes from this many newest
    batch: 32,
    online_steps: 1,            // training steps per ensemble member after each goal
    window: 300,                // the rolling window of scored predictions
    called_right_window: 200,
    takeover_min_scored: 200,
    takeover_margin: 0.02,
    bench_margin: 0.05,
    snapshot_every: 250,        // goals between candidates from the live weights
    gate_holdout: 0.15,         // a refit is scored on this newest share, held out by time
    gate_slack: 0.10,           // how much worse success or danger may be on its own when the two together are no worse
    refit_epochs: 30,
    keep_versions: 30,
    curve_every: 25,            // goals of one agent between points of its learning curve
    curve_max: 400,
});

const EPS = 1e-6;
const logLoss = (p, y) => -(y ? Math.log(Math.max(p, EPS)) : Math.log(Math.max(1 - p, EPS)));

// A rolling list of scored predictions: { ok, danger, net: { p_ok, p_danger }, table: { p_ok, p_danger } }.
function createBoard(size) {
    let entries = [];
    return {
        push(entry) { entries.push(entry); if (entries.length > size) entries.shift(); },
        clear() { entries = []; },
        size: () => entries.length,
        // Mean log-loss of both over the last `n` entries: { n, net, table, danger_net, danger_table, right_net, right_table }.
        score(n = size) {
            const last = entries.slice(-n);
            let count = 0; let net = 0; let table = 0; let right_net = 0; let right_table = 0; let dn = 0; let dt = 0;
            for (const e of last) {
                dn += logLoss(e.net.p_danger, e.danger);
                dt += logLoss(e.table.p_danger, e.danger);
                if (e.ok === null) continue;
                count++;
                net += logLoss(e.net.p_ok, e.ok);
                table += logLoss(e.table.p_ok, e.ok);
                if ((e.net.p_ok >= 0.5) === (e.ok === 1)) right_net++;
                if ((e.table.p_ok >= 0.5) === (e.ok === 1)) right_table++;
            }
            const div = (sum, by) => (by > 0 ? sum / by : null);
            return {
                n: count, net: div(net, count), table: div(table, count),
                danger_net: div(dn, last.length), danger_table: div(dt, last.length),
                right_net: div(right_net, count), right_table: div(right_table, count),
            };
        },
        entries: () => entries,
    };
}

export function createLearner({
    agents, seed = 1, clock = { now: () => Date.now() }, rules = {}, hyper = HYPER, ensemble_size = ENSEMBLE_SIZE,
    onVersion = () => {}, report = () => {},
} = {}) {
    if (!Array.isArray(agents) || agents.length === 0) throw new Error('the learner needs the list of agents');
    const R = { ...LEARNING_RULES, ...rules };
    const member_rngs = Array.from({ length: ensemble_size }, (_, i) => createRng(seed * 31 + i + 1));
    const table = createCountTable();
    const place = createPlaceMemory();
    const history = createHistory();

    let live = createEnsemble({ agents, seed, size: ensemble_size });
    let published = cloneEnsemble(live);
    let version = 0;
    let frozen = false;
    let examples = 0;                       // goals observed
    let since_snapshot = 0;
    const replay = [];
    const weights_kept = new Map();         // v -> exported weights (the newest keep_versions)
    const versions = [];                    // newest last: { v, parent, examples, created_at, state, reason, metrics, sha256, good }
    const in_use = Object.fromEntries(agents.map((agent) => [agent, false]));
    const boards = Object.fromEntries(agents.map((agent) => [agent, createBoard(R.window)]));
    const overall = createBoard(R.window);
    const held_out = createBoard(R.window);         // live against published on examples neither has seen (entry.net = live, entry.table = published)
    const per_agent = Object.fromEntries(agents.map((agent) => [agent, { own: 0, curve: [], calibration: Array.from({ length: 10 }, () => ({ n: 0, said: 0, happened: 0 })), options: new Map() }]));

    function recordVersion(state, { parent = null, reason = null, metrics = {}, ensemble = published } = {}) {
        const row = { v: version, feature_version: FEATURE_VERSION, parent, examples, created_at: clock.now(), state, reason, metrics, sha256: weightsHash(ensemble), good: false };
        versions.push(row);
        if (state === 'in_use') {
            weights_kept.set(row.v, exportWeights(ensemble));
            const keep = new Set(versions.filter((r) => weights_kept.has(r.v)).slice(-R.keep_versions).map((r) => r.v));
            for (const v of weights_kept.keys()) if (!keep.has(v) && v !== 0) weights_kept.delete(v);
        }
        try {
            onVersion({ ...row, arch: published.arch, weights: state === 'in_use' ? weights_kept.get(row.v) : null });
        } catch { /* the listener's problem */ }
        return row;
    }
    // version 0: the heads are zero, so it says exactly what the count table says. Always good.
    recordVersion('in_use', { reason: 'start: no data, the network equals the count table' }).good = true;

    const row = (v) => versions.find((r) => r.v === v) ?? null;
    const currentRow = () => row(version);

    function stamp(agent, option, raw, now = clock.now()) {
        const base = makeSituation(raw);
        base.place = { here: place.at(base.position, now), target: place.at(base.target?.pos ?? null, now) };
        base.recent = history.snapshot(agent, optionKey(option), option.skill, now);
        return makeSituation(base);
    }

    function estimateWith(ensemble, agent, option, situation, chooser, table_estimate) {
        const x = featurize({ agent, option, situation, table: table_estimate, chooser });
        const off = offsetsOf(table_estimate);
        const nz = nonZero(x);
        return { x, nz, off, net: predict(ensemble, agent, x, off, nz) };
    }

    // What is known about one option for one agent, before the goal starts.
    function estimate(agent, option, situation, { chooser = 'routine' } = {}) {
        const t = table.predict(agent, option);
        const { net } = estimateWith(published, agent, option, situation, chooser, t);
        const source = in_use[agent] ? 'network' : 'table';
        return { agent, option_key: optionKey(option), table: t, net, net_version: version, source };
    }

    function publish(candidate, { reason, metrics = {}, parent = version } = {}) {
        const before = currentRow();
        if (before) {
            before.state = 'kept';
            // good: while it was in use, the network was not worse than the table over the rolling window
            const s = overall.score();
            if (s.n >= Math.min(100, R.window) && s.net <= s.table) before.good = true;
        }
        published = cloneEnsemble(candidate);
        version = versions.reduce((max, r) => Math.max(max, r.v), 0) + 1;
        since_snapshot = 0;
        held_out.clear();
        return recordVersion('in_use', { parent, reason, metrics });
    }

    function refuse(candidate, reason, metrics, parent) {
        const kept_version = version;
        version = versions.reduce((max, r) => Math.max(max, r.v), 0) + 1;
        const refused = recordVersion('refused', { parent, reason, metrics, ensemble: candidate });
        version = kept_version;
        return refused;
    }

    // The gate both kinds of candidate pass through: { ok, reason }. Scored on examples the
    // candidate has not been trained on:
    //   every weight is a finite number;
    //   success and danger log-loss TOGETHER are no worse than the current version's;
    //   neither of the two is worse on its own by more than `gate_slack` (10%).
    // (The plan asked for each of the two to be no worse. Danger is rare, so its log-loss on a
    // few hundred examples moves by a few percent from chance alone: the strict rule refused
    // candidates that were 8% better on success over a 0.3% difference in danger.)
    function gate(candidate, cand, cur) {
        if (!allFinite(candidate)) return { ok: false, reason: 'a weight is not a finite number' };
        if (cand.n === 0 || cand.net === null) return { ok: false, reason: 'nothing to score the candidate on' };
        const f = (n) => n.toFixed(4);
        if (cand.net > cur.net * (1 + R.gate_slack)) return { ok: false, reason: `success log-loss ${f(cand.net)} is more than ${Math.round(R.gate_slack * 100)}% worse than the current version's ${f(cur.net)} on held-out examples` };
        if (cand.danger > cur.danger * (1 + R.gate_slack)) return { ok: false, reason: `danger log-loss ${f(cand.danger)} is more than ${Math.round(R.gate_slack * 100)}% worse than the current version's ${f(cur.danger)} on held-out examples` };
        if (cand.net + cand.danger > cur.net + cur.danger + 1e-9) return { ok: false, reason: `predicts worse on held-out examples: success and danger log-loss ${f(cand.net + cand.danger)} against the current version's ${f(cur.net + cur.danger)}` };
        return { ok: true, reason: `predicts no worse on held-out examples: ${f(cand.net + cand.danger)} against ${f(cur.net + cur.danger)}` };
    }

    function rollbackTo(v, reason) {
        const weights = weights_kept.get(v);
        if (!weights) return false;
        const from = currentRow();
        if (from && from.v !== v) { from.state = 'rolled_back'; from.reason = reason; from.good = false; }
        published = importWeights(weights);
        live = cloneEnsemble(published);
        version = v;
        const to = row(v);
        to.state = 'in_use';
        since_snapshot = 0;
        held_out.clear();
        overall.clear();
        for (const agent of agents) { boards[agent].clear(); in_use[agent] = false; }
        try { onVersion({ ...to, arch: published.arch, weights, rolled_back_from: from?.v ?? null }); } catch { /* the listener's problem */ }
        return true;
    }

    function lastGood(before) {
        for (let i = versions.length - 1; i >= 0; i--) {
            const r = versions[i];
            if (r.v !== before && r.good && weights_kept.has(r.v)) return r.v;
        }
        return 0;   // version 0 equals the count table and is always kept
    }

    function checkBench() {
        // only a network that is in charge somewhere can be benched: once every agent is back on
        // the table the live weights go on learning, and must earn the takeover again
        if (version === 0 || !agents.some((agent) => in_use[agent])) return false;
        const s = overall.score();
        if (s.n >= R.window && s.net > s.table * (1 + R.bench_margin)) {
            const from = version;
            const to = lastGood(from);
            rollbackTo(to, `benched: success log-loss ${s.net.toFixed(4)} against the count table's ${s.table.toFixed(4)} over the last ${s.n} predictions`);
            // the restored version starts again from the table: every agent must earn the takeover anew
            try {
                report({ kind: 'learning_bench', severity: 'info', from, to, net: s.net, table: s.table, n: s.n,
                    message: `the network was more than ${Math.round(R.bench_margin * 100)}% worse than the count table: back to the table and to version ${to}` });
            } catch { /* the listener's problem */ }
            return true;
        }
        return false;
    }

    function checkTakeover(agent) {
        const s = boards[agent].score();
        if (s.n < Math.min(R.takeover_min_scored, R.window) || s.net === null) return;
        // version 0 is the count table by another name: there is nothing to take over with
        if (!in_use[agent] && version !== 0 && s.net <= s.table * (1 - R.takeover_margin)) in_use[agent] = true;
        else if (in_use[agent] && s.net > s.table * (1 + R.bench_margin)) in_use[agent] = false;
    }

    function trainOnline(example) {
        for (let m = 0; m < live.nets.length; m++) {
            const r = member_rngs[m];
            const batch = r.chance(0.8) ? [example] : [];      // each member sees its own resampling of the data
            const recent_from = Math.max(0, replay.length - R.replay_recent);
            while (batch.length < R.batch && replay.length > 0) {
                const i = batch.length % 2 === 0 ? recent_from + r.int(replay.length - recent_from) : r.int(replay.length);
                batch.push(replay[i]);
            }
            trainStep(live.nets[m], batch, hyper);
        }
    }
    function trainOnlineTimes(example) { for (let k = 0; k < R.online_steps; k++) trainOnline(example); }

    // A goal ended. `experience` is the closed record, with the prediction stored when it started.
    function observe(experience) {
        const labels = labelsOf(experience);
        if (!labels) throw new Error('observe needs an experience that has ended');
        const agent = experience.agent;
        const option = { id: experience.option_id, skill: experience.skill, args: experience.args };
        const key = optionKey(option);
        const now = experience.ended_at;
        const stored = experience.predicted;
        const stored_net = stored.net ?? stored.table;

        // 1. score what was predicted before the outcome was known
        const entry = { ok: labels.ok, danger: labels.danger, net: { p_ok: stored_net.p_ok, p_danger: stored_net.p_danger }, table: { p_ok: stored.table.p_ok, p_danger: stored.table.p_danger } };
        overall.push(entry);
        const mine = per_agent[agent];
        if (boards[agent]) {
            boards[agent].push(entry);
            mine.own++;
            if (labels.ok !== null) {
                const said = stored.source === 'network' ? stored_net.p_ok : stored.table.p_ok;
                const bin = mine.calibration[Math.min(9, Math.floor(said * 10))];
                bin.n++; bin.said += said; bin.happened += labels.ok;
            }
            mine.options.delete(key);
            mine.options.set(key, { key, title: experience.title ?? experience.option_id, p_ok: stored_net.p_ok, spread: stored.net?.spread ?? null, n: (stored.table.n ?? 0) + 1, at: now });
            if (mine.options.size > 200) mine.options.delete(mine.options.keys().next().value);
            if (mine.own % R.curve_every === 0) {
                const s = boards[agent].score();
                if (s.n > 0) mine.curve.push({ examples: mine.own, net: s.net, table: s.table });
                if (mine.curve.length > R.curve_max) mine.curve = mine.curve.filter((_, i) => i % 2 === 1);
            }
        }

        // 2. the example, built from the stored row alone
        const situation = makeSituation(experience.situation);
        const { x, nz, off, net: live_says } = estimateWith(live, agent, option, situation, experience.chooser, stored.table);
        const pub_says = predict(published, agent, x, off, nz);
        held_out.push({ ok: labels.ok, danger: labels.danger, net: { p_ok: live_says.p_ok, p_danger: live_says.p_danger }, table: { p_ok: pub_says.p_ok, p_danger: pub_says.p_danger } });
        const example = { x, nz, off, head: agents.indexOf(agent), y: { ok: labels.ok, danger: labels.danger, log_secs: labels.log_secs, yield: labels.yield }, at: now };

        // 3. learn: the table, the place memory, the history, then the network
        table.update(agent, option, labels);
        const where = situation.target?.pos ?? situation.position;
        if (labels.ok === 1) place.note(where, 'ok', now);
        else if (labels.ok === 0) place.note(where, 'fail', now);
        if (labels.died) place.note(where, 'death', now);
        if (labels.stuck) place.note(where, 'stuck', now);
        history.note(agent, key, option.skill, { outcome: experience.outcome, reason: experience.reason, died: labels.died, stuck: labels.stuck }, now);
        examples++;
        replay.push(example);
        if (replay.length > R.replay_max) replay.shift();
        let published_now = null;
        if (!frozen) {
            trainOnlineTimes(example);
            since_snapshot++;
            if (since_snapshot >= R.snapshot_every) {
                const s = held_out.score(R.snapshot_every);
                // in this board "net" is the live weights and "table" the published ones
                const verdict = gate(live, { n: s.n, net: s.net, danger: s.danger_net }, { net: s.table, danger: s.danger_table });
                const metrics = { held_out: s.n, candidate_error: s.net, current_error: s.table, candidate_danger: s.danger_net, current_danger: s.danger_table };
                if (verdict.ok) published_now = publish(live, { reason: `online: ${verdict.reason}`, metrics });
                else { refuse(live, `online: ${verdict.reason}`, metrics, version); since_snapshot = 0; }
            }
        }

        // 4. who is in charge
        const rolled_back = checkBench();
        if (!rolled_back && boards[agent]) checkTakeover(agent);
        return { labels, scored: entry, published: published_now?.v ?? null, rolled_back };
    }

    // A full re-fit: a fresh ensemble trained on the older part of the replay buffer, scored on
    // the newest `gate_holdout` share. `train`: examples to train on instead (a test hands in a
    // bad batch); the held-out part is always the learner's own newest examples.
    function refit({ train = null, epochs = R.refit_epochs, seed: refit_seed = seed + 7 + versions.length } = {}) {
        const cut = Math.floor(replay.length * (1 - R.gate_holdout));
        const holdout = replay.slice(cut);
        const train_set = train ?? replay.slice(0, cut);
        if (train_set.length === 0 || holdout.length === 0) return { promoted: false, reason: 'not enough examples to refit and hold some out' };
        const candidate = createEnsemble({ agents, seed: refit_seed, size: ensemble_size });
        const r = createRng(refit_seed);
        const steps = Math.ceil((epochs * train_set.length) / R.batch);
        for (const net of candidate.nets) {
            for (let step = 0; step < steps; step++) {
                const batch = [];
                while (batch.length < R.batch) batch.push(train_set[r.int(train_set.length)]);
                trainStep(net, batch, hyper);
            }
        }
        const scoreOn = (ensemble) => {
            let n = 0; let net = 0; let danger = 0;
            for (const e of holdout) {
                const says = predict(ensemble, agents[e.head], e.x, e.off, e.nz);
                danger += logLoss(says.p_danger, e.y.danger);
                if (e.y.ok === null) continue;
                n++;
                net += logLoss(says.p_ok, e.y.ok);
            }
            return { n, net: n > 0 ? net / n : null, danger: danger / holdout.length };
        };
        const cand = scoreOn(candidate);
        const cur = scoreOn(published);
        const verdict = gate(candidate, cand, cur);
        const metrics = { held_out: cand.n, candidate_error: cand.net, current_error: cur.net, candidate_danger: cand.danger, current_danger: cur.danger };
        if (!verdict.ok || frozen) {
            const reason = frozen && verdict.ok ? 'learning is frozen' : verdict.reason;
            const refused = refuse(candidate, `refit: ${reason}`, metrics, version);
            return { promoted: false, reason, v: refused.v, metrics };
        }
        const made = publish(candidate, { reason: `refit: ${verdict.reason}`, metrics });
        live = cloneEnsemble(candidate);
        return { promoted: true, reason: verdict.reason, v: made.v, metrics };
    }

    return {
        agents: [...agents], rules: R, table, place, history,
        stamp, estimate, observe, refit,
        // What goes into experience.predicted.
        toPredicted(est) {
            const { p_ok, p_danger, secs, spread, danger_max } = est.net;
            return {
                net_version: est.net_version, source: est.source,
                table: { p_ok: est.table.p_ok, p_danger: est.table.p_danger, secs: est.table.secs, yield: est.table.yield, n: est.table.n },
                net: { p_ok, p_danger, secs, yield: est.net.yield, spread, danger_max },
            };
        },
        // An example in the form refit({ train }) takes, from a closed experience (labels may be overridden).
        exampleOf(experience, labels = labelsOf(experience)) {
            const option = { id: experience.option_id, skill: experience.skill, args: experience.args };
            const { x, nz, off } = estimateWith(live, experience.agent, option, makeSituation(experience.situation), experience.chooser, experience.predicted.table);
            return { x, nz, off, head: agents.indexOf(experience.agent), y: { ok: labels.ok, danger: labels.danger, log_secs: labels.log_secs, yield: labels.yield }, at: experience.ended_at };
        },
        version: () => version,
        versions: () => versions.map((r) => ({ ...r })),
        weights: (v = version) => weights_kept.get(v) ?? null,
        weightsHash: () => weightsHash(published),
        liveHash: () => weightsHash(live),
        inUse: (agent) => in_use[agent] === true,
        freeze() { frozen = true; },
        unfreeze() { frozen = false; },
        isFrozen: () => frozen,
        // The operator's Roll back: to `v`, or to the last version that was good.
        rollback(v = lastGood(version), reason = 'operator: rolled back') { return rollbackTo(v, reason) ? v : null; },
        // For a test or an operator tool: make these weights the published version without the gate.
        forcePublish(ensemble, reason = 'forced') { live = cloneEnsemble(ensemble); return publish(ensemble, { reason }).v; },
        liveEnsemble: () => live,
        worldReset() { place.wipe(); history.wipe(); },
        // What the Learning view shows (genesis/learning/views.js shapes it).
        status() {
            const s = overall.score();
            return {
                version, examples, frozen, feature_version: FEATURE_VERSION,
                updated_at: currentRow()?.created_at ?? null,
                error: s.net, table_error: s.table, scored: s.n,
                in_use: { ...in_use },
                agents: Object.fromEntries(agents.map((agent) => {
                    const mine = per_agent[agent];
                    const b = boards[agent].score();
                    const right = boards[agent].score(R.called_right_window);
                    return [agent, {
                        state: in_use[agent] ? 'network' : 'table', own: mine.own, from_others: examples - mine.own,
                        error: b.net, table_error: b.table, called_right: { n: right.n, network: right.right_net, table: right.right_table },
                        curve: mine.curve.map((point) => ({ ...point })),
                        calibration: mine.calibration.map((bin, i) => ({ from: i / 10, to: (i + 1) / 10, n: bin.n, said: bin.n > 0 ? bin.said / bin.n : null, happened: bin.n > 0 ? bin.happened / bin.n : null })),
                        options: [...mine.options.values()],
                    }];
                })),
            };
        },
        exportState() { return { v: 1, table: table.toJSON(), place: place.toJSON(), examples, version, in_use: { ...in_use } }; },
        importState(saved) {
            if (saved?.v !== 1) return false;
            table.load(saved.table);
            place.load(saved.place);
            examples = Number.isFinite(saved.examples) ? saved.examples : examples;
            return true;
        },
        // Start from a stored version file (versions.js): { v, weights }.
        loadVersion(record) {
            published = importWeights(record.weights);
            live = cloneEnsemble(published);
            version = record.v;
            weights_kept.set(record.v, record.weights);
            if (!row(record.v)) versions.push({ v: record.v, feature_version: record.feature_version, parent: record.parent ?? null, examples: record.examples, created_at: record.created_at, state: 'in_use', reason: 'loaded from file', metrics: record.metrics ?? {}, sha256: weightsHash(published), good: false });
        },
    };
}
