// Genesis: the town, in the MindServer process. ONE town for all agents, kept in the town file
// (genesis/town/town_file.js) and handed to every agent process, which layers it over the
// zones of the world file (genesis/town/client.js). The world file is never written.
//
// What it does:
//   assignments   which prefab each plot is to hold next. Everyone builds and upgrades their OWN home
//                 (decided): an agent's home plot is given the next home tier above its verified one.
//                 Arthur also builds the shared projects and the bridges: his next project is the
//                 smallest shared prefab he has not built whose tier he has earned.
//   wanted        when what comes next fits no plot (a home that outgrows its plot, a shared project, a
//                 bridge), the town WANTS a plot. The agent it is for surveys the land and proposes
//                 where it goes (genesis/town/proposer.js); the town checks the proposal against both
//                 files and takes it. Decided: code places it; the operator can move or remove it.
//   builds        one row per build: started, where it stands, verified. A verified build opens the
//                 tier above (genesis/build/unlock.js) and moves the assignment on.
//   gaps          walks that found no way: three to the same place and the town wants a bridge there.
//
// Socket events (the agent's side is genesis/town/client.js):
//   genesis-town-sync    (agent, ack)           -> ack({ ok, town })
//   genesis-town-op      ({ agent, op }, ack)   -> ack({ ok } | { ok: false, reason })      op.kind: see apply()
//   genesis-town-update  -> every agent  { town }                                           after every change
// The operator's side (the dashboard, through genesis/town/server.js): operator(op).
//
// Events (agent.state, named states that carry a view): town_plan, plot_proposed, build_progress,
// build_verified, home_changed.
//
// Injected: file (createTownFile), zones_config (the world file's content), prefabs ({ get, names }),
// clock, emit, store (genesis/learning/store.js: the builds table), agents, shared_builder.
// Depends only on other Genesis files.

import { emptyTown, checkTown, PLOT_SIZES, SPAN_WIDTH, LANE, plotSizeFor, sizeFits } from './town_file.js';
import { prefabHash, prefabSize, billOf } from '../build/prefab.js';
import { SHARED_BUILDER, highestVerified, OPEN_FROM_START } from '../build/unlock.js';
import { footbridge } from '../build/ladder.js';

export const TOWN_RULES = Object.freeze({
    gap_reports: 3,         // walks to one place that found no way before a bridge is wanted there
    max_plots: 24,
    max_spans: 8,
    max_builds: 200,
});

const copy = (value) => JSON.parse(JSON.stringify(value));
const flat = (box) => ({ min: { x: box.min[0], z: box.min[box.min.length - 1] }, max: { x: box.max[0], z: box.max[box.max.length - 1] } });
const overlaps = (a, b, margin = 0) => a.min.x - margin <= b.max.x && b.min.x - margin <= a.max.x && a.min.z - margin <= b.max.z && b.min.z - margin <= a.max.z;
const isBlock = (value, size) => Array.isArray(value) && value.length === size && value.every((n) => Number.isInteger(n));

// The name a span's prefab has: the footbridge of that length, a column wider on each side (a span is 5 wide).
export const spanPrefabName = (length) => `span_${length}`;

export function createTown({
    file = null, zones_config, prefabs, clock = { now: Date.now }, emit = () => {}, warn = () => {}, store = null,
    agents = Object.keys(zones_config?.agents ?? {}), shared_builder = SHARED_BUILDER, world_sha256 = null, rules: rule_overrides = {},
} = {}) {
    if (!zones_config || !prefabs) throw new Error('the town needs the world file and the prefabs');
    const R = { ...TOWN_RULES, ...rule_overrides };
    const home_point = zones_config.home ?? zones_config.agents?.[shared_builder]?.home ?? Object.values(zones_config.agents)[0].home;
    let town = emptyTown({ world_sha256, home: home_point });
    const sockets = new Map();      // agent -> socket
    const listeners = new Set();    // told after every change (the long-term goals follow the builds)
    const stats = { ops: 0, refused: 0, saved: 0, save_failures: 0 };
    let build_store = store;        // where the builds are also kept as rows (the learner's store), when there is one
    let counter = 0;

    const say = (state, detail, about = null) => { try { emit('agent.state', { state, detail, ...(about ? { about } : {}) }, { corr: null }); } catch { /* an event must never disturb the town */ } };
    const iso = () => new Date(clock.now()).toISOString();
    const nextId = (prefix, list, others = []) => { let n = 1; while ([...list, ...others].some((it) => it.id === `${prefix}-${n}`)) n++; return `${prefix}-${n}`; };

    // ---- what is where ----
    const worldPlots = () => (zones_config.plots ?? []).map((plot) => ({ ...plot, world: true, size: 'S', kind: plot.owner ? 'home' : 'spare' }));
    const everyPlot = () => [...worldPlots(), ...town.plots, ...town.spans.map((span) => ({ ...span, kind: 'bridge', size: 'span' }))];
    const taken = (except = null) => [
        { name: 'camp', ...flat(zones_config.camp) }, { name: 'field', ...flat(zones_config.field) },
        ...everyPlot().filter((plot) => plot.id !== except).map((plot) => ({ name: `plot ${plot.id}`, ...flat(plot) })),
    ];
    const generated = () => prefabs.names().map((name) => prefabs.get(name)).filter(Boolean);
    const homeTiers = () => generated().filter((p) => p.kind === 'home' && p.by === 'Generated').sort((a, b) => a.tier - b.tier);
    const verified = (builder = null) => town.builds.filter((b) => b.verified_at && (builder === null || b.builder === builder));
    const started = (plot, prefab) => town.builds.some((b) => b.plot === plot && b.prefab === prefab && !b.verified_at);
    const prefabOf = (name) => {
        const span = /^span_(\d+)$/.exec(String(name ?? ''));
        if (span) { try { return { ...footbridge(Number(span[1])), name }; } catch { return null; } }
        return prefabs.get(name);
    };

    // The plot an agent's home is on: the plot of the world file it owns, or a home plot of the town (the newest wins).
    function homePlot(agent) {
        const lived = town.homes[agent]?.plot ?? null;
        const mine = everyPlot().filter((plot) => plot.owner === agent && (plot.kind === 'home'));
        return mine.find((plot) => plot.id === lived) ?? mine[0] ?? null;
    }

    // ---- what comes next (assignments and wanted plots), worked out again after every change ----
    function plan() {
        const wanted = [];
        const want = (entry) => { if (!wanted.some((w) => w.for === entry.for && w.prefab === entry.prefab)) wanted.push({ id: `want-${entry.for}-${entry.prefab}`, ...entry }); };
        const tiers = homeTiers();
        for (const agent of agents) {
            const mine = verified(agent).filter((b) => tiers.some((p) => p.name === b.prefab));
            const top = mine.reduce((best, b) => (best === null || b.tier > best.tier ? b : best), null);
            const next = tiers.find((p) => p.tier > (top?.tier ?? -1)) ?? null;
            if (!next) continue;
            const needed = plotSizeFor(next);
            // the plot the home stands on, when the next tier fits it; else the agent's biggest home plot that takes it
            const plots = everyPlot().filter((plot) => plot.owner === agent && plot.kind === 'home');
            const current = plots.find((plot) => plot.id === top?.plot) ?? null;
            const target = (current && sizeFits(current.size, needed) ? current : null) ?? plots.find((plot) => sizeFits(plot.size, needed) && !verified().some((b) => b.plot === plot.id)) ?? null;
            if (target) {
                // what stands there: the highest tier verified on that plot (the newest among equals)
                const built = verified().filter((b) => b.plot === target.id).reduce((best, b) => (best === null || b.tier >= best.tier ? b : best), null)?.prefab ?? null;
                const now = town.assign[target.id] ?? {};
                // a build that is under way is finished first: the assignment does not move under it
                if (!town.builds.some((b) => b.plot === target.id && !b.verified_at && b.prefab !== next.name)) town.assign[target.id] = { ...now, prefab: next.name, built };
            } else if (top && highestVerified(town.builds, agent) >= next.tier - 1) {
                // the home has outgrown its plot, and the tier is earned: a bigger plot is wanted
                want({ for: agent, kind: 'home', size: needed, prefab: next.name, why: `${next.title} needs a plot of size ${needed}` });
            }
        }
        // Arthur's projects: shared prefabs he has earned and not built, smallest first, one at a time
        const earned = highestVerified(town.builds, shared_builder);
        const shared = generated().filter((p) => p.kind === 'shared').sort((a, b) => a.tier - b.tier || billOf(a).cells - billOf(b).cells);
        const project = shared.find((p) => !verified(shared_builder).some((b) => b.prefab === p.name) && (p.tier <= OPEN_FROM_START || earned >= p.tier - 1)) ?? null;
        if (project) {
            const needed = plotSizeFor(project);
            const held = town.plots.find((plot) => plot.kind === 'shared' && (plot.prefab === project.name || (town.assign[plot.id]?.prefab ?? null) === project.name));
            const free = held ?? town.plots.find((plot) => plot.kind === 'shared' && sizeFits(plot.size, needed) && !town.builds.some((b) => b.plot === plot.id));
            if (free) town.assign[free.id] = { ...(town.assign[free.id] ?? {}), prefab: project.name, built: town.assign[free.id]?.built ?? null };
            else want({ for: shared_builder, kind: 'shared', size: needed, prefab: project.name, why: `${project.title ?? project.name} is the next shared project` });
        }
        // bridges: a span that stands in the file is assigned its footbridge
        for (const span of town.spans) if (!town.assign[span.id]) town.assign[span.id] = { prefab: span.prefab, built: null };
        town.wanted = wanted;
    }

    async function changed(what, detail = {}, about = null) {
        plan();
        const message = { town: copy(town) };
        for (const [agent, socket] of sockets) { try { if (socket.connected !== false) socket.emit('genesis-town-update', message); } catch { sockets.delete(agent); } }
        say('town_plan', view());
        if (what) say(what, detail, about);
        for (const fn of listeners) { try { fn(what, detail); } catch { /* the listener's problem */ } }
        if (file) {
            try { await file.save(copy(town)); stats.saved++; } catch (err) { stats.save_failures++; try { warn(`town: not written (${err?.message ?? err})`); } catch { /* nothing more to do */ } }
        }
    }

    // Why a plot may not stand there, or null. `ranges`: who has to reach every corner.
    function plotRefusal(box, { except = null, owner = null, span = false } = {}) {
        if (!isBlock(box.min, 3) || !isBlock(box.max, 3)) return 'bad_box';
        const f = flat(box);
        const hit = taken(except).find((other) => overlaps(f, other, span ? 0 : LANE));
        if (hit) return `too_close_to_${hit.name.replace(/\s+/g, '_')}`;
        if (f.min.x < town.limit.min[0] || f.min.z < town.limit.min[1] || f.max.x > town.limit.max[0] || f.max.z > town.limit.max[1]) return span ? null : 'outside_town_limit';
        return rangeRefusal(f, [owner, shared_builder === owner || span ? shared_builder : null]);
    }
    function rangeRefusal(f, who) {
        for (const agent of new Set(who.filter(Boolean))) {
            const entry = zones_config.agents?.[agent];
            if (!entry) return 'unknown_owner';
            for (const [x, z] of [[f.min.x, f.min.z], [f.min.x, f.max.z], [f.max.x, f.min.z], [f.max.x, f.max.z]]) {
                if (Math.hypot(x - entry.home[0], z - entry.home[2]) > entry.range) return `outside_${agent}_range`;
            }
        }
        return null;
    }

    // ---- what an agent's process may ask ----
    function apply(agent, op) {
        stats.ops++;
        const refuse = (reason) => { stats.refused++; return { ok: false, reason }; };
        if (!agents.includes(agent) || op === null || typeof op !== 'object') return refuse('not_an_agent');
        const plot = typeof op.plot === 'string' ? everyPlot().find((p) => p.id === op.plot) ?? null : null;
        const mine = plot !== null && (plot.owner === agent || plot.owner === null);
        switch (op.kind) {
            // a build was started: the first goal on a plot that holds a prefab
            case 'build_started': {
                if (!mine) return refuse('not_your_plot');
                const name = town.assign[plot.id]?.prefab ?? plot.blueprint ?? plot.prefab ?? null;
                const prefab = prefabOf(name);
                if (!prefab || (op.prefab && op.prefab !== name)) return refuse('no_such_build');
                if (started(plot.id, name)) return { ok: true, build_id: town.builds.find((b) => b.plot === plot.id && b.prefab === name && !b.verified_at).build_id };
                const build = {
                    build_id: `b-${clock.now()}-${++counter}`, plot: plot.id, prefab: name, prefab_sha256: prefabHash(prefab), builder: agent, tier: prefab.tier ?? 0, kind: prefab.kind ?? 'home',
                    stage: null, cells_total: billOf(prefab).cells, cells_matching: 0, started_at: iso(), finished_at: null, verified_at: null, verified_day: null,
                };
                town.builds.push(build);
                if (town.builds.length > R.max_builds) town.builds.splice(0, town.builds.length - R.max_builds);
                saveBuild(build);
                changed('build_progress', { ...build }, agent);
                return { ok: true, build_id: build.build_id };
            }
            case 'build_progress': {
                const build = plot ? town.builds.find((b) => b.plot === plot.id && b.builder === agent && !b.verified_at) : null;
                if (!build) return refuse('no_such_build');
                const next = { stage: typeof op.stage === 'string' ? op.stage.slice(0, 40) : null, cells_matching: Number.isInteger(op.cells_matching) ? Math.max(0, op.cells_matching) : build.cells_matching };
                if (Number.isInteger(op.cells_total) && op.cells_total > 0) next.cells_total = op.cells_total;
                if (next.stage === build.stage && next.cells_matching === build.cells_matching) return { ok: true };
                Object.assign(build, next);
                // what the builder counted is still to place, and what it holds of that (the Town screen's materials)
                const items = (value) => (value !== null && typeof value === 'object' && !Array.isArray(value)
                    ? Object.fromEntries(Object.entries(value).filter(([item, count]) => /^[a-z0-9_]{1,60}$/.test(item) && Number.isInteger(count) && count >= 0).slice(0, 24)) : null);
                build.bill = items(op.bill);
                build.held = items(op.held);
                if (op.complete === true && !build.finished_at) build.finished_at = iso();
                saveBuild(build);
                changed('build_progress', { ...build, short: op.short ?? null }, agent);
                return { ok: true };
            }
            // verified: every cell matched by name twice, 60 seconds apart (genesis/build/verify.js, in the builder's process)
            case 'build_verified': {
                const build = plot ? town.builds.find((b) => b.plot === plot.id && b.builder === agent && !b.verified_at) : null;
                if (!build) return refuse('no_such_build');
                build.verified_at = iso();
                build.finished_at ??= build.verified_at;
                build.cells_matching = build.cells_total;
                build.stage = null;
                build.verified_day = Number.isInteger(op.day) ? op.day : null;
                build.bill = null;
                build.held = null;
                town.assign[plot.id] = { prefab: build.prefab, built: build.prefab };
                saveBuild(build);
                changed('build_verified', { ...build }, agent);
                return { ok: true, build_id: build.build_id };
            }
            // where a wanted plot goes: surveyed by the agent it is for, checked here against both files
            case 'propose_plot': {
                const wanted = town.wanted.find((w) => w.id === op.wanted && w.for === agent) ?? null;
                if (!wanted || wanted.size === 'span') return refuse('not_wanted');
                if (town.plots.length >= R.max_plots) return refuse('town_full');
                const n = PLOT_SIZES[wanted.size];
                if (!isBlock(op.min, 3) || !isBlock(op.max, 3) || op.max[0] - op.min[0] + 1 !== n || op.max[2] - op.min[2] + 1 !== n) return refuse('wrong_size');
                const refusal = plotRefusal({ min: op.min, max: op.max }, { owner: agent });
                if (refusal) return refuse(refusal);
                const entry = {
                    id: nextId('town', town.plots, worldPlots()), size: wanted.size, kind: wanted.kind, owner: agent, min: op.min, max: op.max, prefab: wanted.prefab, rotation: 0,
                    by: 'Code', levelled_by: 'Builder', score: { relief: Number(op.score?.relief ?? 0), distance: Number(op.score?.distance ?? 0) }, at: iso(),
                };
                town.plots.push(entry);
                town.assign[entry.id] = { prefab: wanted.prefab, built: null };
                changed('plot_proposed', { ...entry, why: wanted.why }, agent);
                return { ok: true, id: entry.id };
            }
            // a walk found no way: counted per place; with a span the agent could see, a bridge is proposed
            case 'gap': {
                const place = typeof op.place === 'string' ? op.place.slice(0, 60) : null;
                if (!place) return refuse('bad_gap');
                const gap = town.gaps[place] ?? { count: 0, agents: [], last_at: null, span: null };
                gap.count++;
                if (!gap.agents.includes(agent)) gap.agents.push(agent);
                gap.last_at = iso();
                town.gaps[place] = gap;
                if (Object.keys(town.gaps).length > 60) delete town.gaps[Object.keys(town.gaps)[0]];
                let proposed = null;
                const span = op.span;
                if (gap.count >= R.gap_reports && gap.span === null && span && town.spans.length < R.max_spans && isBlock(span.min, 3) && isBlock(span.max, 3)
                    && Number.isInteger(span.length) && span.length >= 5 && span.length <= 15 && [0, 90].includes(span.rotation)) {
                    const [dx, dz] = [span.max[0] - span.min[0] + 1, span.max[2] - span.min[2] + 1];
                    const fits = (span.rotation === 0 ? dx === SPAN_WIDTH && dz === span.length : dz === SPAN_WIDTH && dx === span.length);
                    const refusal = fits ? plotRefusal({ min: span.min, max: span.max }, { owner: shared_builder, span: true }) ?? rangeRefusal(flat(span), [shared_builder]) : 'wrong_size';
                    if (!refusal) {
                        proposed = {
                            id: nextId('span', town.spans), owner: shared_builder, min: span.min, max: span.max, prefab: spanPrefabName(span.length), rotation: span.rotation,
                            from: span.from, to: span.to, length: span.length, why: `${gap.agents.join(', ')}: ${gap.count} walks to ${place} found no way`, by: 'Code', levelled_by: 'Builder', at: iso(),
                        };
                        town.spans.push(proposed);
                        gap.span = proposed.id;
                    } else gap.refused = refusal;
                }
                changed(proposed ? 'plot_proposed' : null, proposed ? { ...proposed, kind: 'bridge' } : {}, agent);
                return { ok: true, count: gap.count, span: proposed?.id ?? null };
            }
            // the home: its bed stands, its chest is there (genesis/town/homes.js writes these through here)
            case 'home': {
                const home = town.homes[agent];
                if (!home) return refuse('no_home');
                if (op.bed_placed === true && home.bed) home.bed.placed = true;
                if (op.bed_placed === false && home.bed) home.bed.placed = false;
                changed('home_changed', { agent, ...home }, agent);
                return { ok: true };
            }
            default: return refuse('unknown_op');
        }
    }

    function saveBuild(build) {
        if (!build_store?.saveBuild) return;
        const { bill, held, tier, kind, ...row } = build;
        void bill; void held; void tier; void kind;
        Promise.resolve().then(() => build_store.saveBuild({ ...row, started_at: Date.parse(build.started_at), finished_at: build.finished_at ? Date.parse(build.finished_at) : null, verified_at: build.verified_at ? Date.parse(build.verified_at) : null }))
            .catch((err) => { try { warn(`town: build row not written (${err?.message ?? err})`); } catch { /* nothing more to do */ } });
    }

    // ---- what the operator may do (the dashboard's Town screen) ----
    function operator(op) {
        const refuse = (reason) => ({ ok: false, reason });
        if (op === null || typeof op !== 'object') return refuse('bad_request');
        const list = town.plots.some((p) => p.id === op.id) ? town.plots : town.spans.some((p) => p.id === op.id) ? town.spans : null;
        const entry = list?.find((p) => p.id === op.id) ?? null;
        switch (op.kind) {
            // decided: the operator can move or remove what code proposed. Not once a build stands on it.
            case 'move': {
                if (!entry) return refuse('no_such_proposal');
                if (town.builds.some((b) => b.plot === entry.id)) return refuse('a_build_was_started_there');
                if (!isBlock(op.min, 3)) return refuse('bad_position');
                const size = [entry.max[0] - entry.min[0], entry.max[1] - entry.min[1], entry.max[2] - entry.min[2]];
                const moved = { min: op.min, max: [op.min[0] + size[0], op.min[1] + size[1], op.min[2] + size[2]] };
                const refusal = plotRefusal(moved, { except: entry.id, owner: entry.owner, span: list === town.spans });
                if (refusal) return refuse(refusal);
                Object.assign(entry, moved, { by: 'Operator', moved_at: iso() });
                changed('plot_proposed', { ...entry, moved: true });
                return { ok: true, id: entry.id };
            }
            case 'remove': {
                if (!entry) return refuse('no_such_proposal');
                if (town.builds.some((b) => b.plot === entry.id)) return refuse('a_build_was_started_there');
                list.splice(list.indexOf(entry), 1);
                delete town.assign[entry.id];
                // (the town will want the plot again and code will propose another place: the removed spot is remembered)
                for (const gap of Object.values(town.gaps)) if (gap.span === entry.id) { gap.span = 'removed'; }
                changed('plot_proposed', { id: entry.id, removed: true, by: 'Operator' });
                return { ok: true, id: entry.id };
            }
            case 'limit': {
                if (!isBlock(op.min, 2) || !isBlock(op.max, 2) || op.min[0] >= op.max[0] || op.min[1] >= op.max[1]) return refuse('bad_limit');
                town.limit = { min: op.min, max: op.max };
                changed(null);
                return { ok: true };
            }
            default: return refuse('unknown_op');
        }
    }

    // The town as the dashboard's Town screen and the agents' copies see it.
    function view() {
        return {
            limit: town.limit, wanted: town.wanted,
            plots: everyPlot().map((plot) => ({
                id: plot.id, size: plot.size, kind: plot.kind, owner: plot.owner ?? null, min: plot.min, max: plot.max, by: plot.world ? 'Operator' : plot.by, levelled_by: plot.world ? 'Operator' : plot.levelled_by,
                prefab: town.assign[plot.id]?.prefab ?? plot.blueprint ?? plot.prefab ?? null, built: town.assign[plot.id]?.built ?? null, world: plot.world === true,
                ...(plot.length ? { length: plot.length, why: plot.why } : {}),
            })),
            builds: town.builds.slice(-40), homes: town.homes, gaps: town.gaps, goals: town.goals,
        };
    }

    return {
        rules: R,
        // Reads the file. A file for another world (its hash differs) is not this town: it starts empty.
        async load() {
            const loaded = file ? await file.load() : { ok: false, missing: true };
            const used = loaded.ok && (world_sha256 === null || loaded.town.world_sha256 === null || loaded.town.world_sha256 === world_sha256);
            if (used) town = { ...emptyTown({ world_sha256, home: home_point }), ...loaded.town };
            else if (loaded.ok || (!loaded.missing && loaded.problems?.length > 0)) { try { warn(`town: the town file is not used (${loaded.ok ? 'it belongs to another world file' : loaded.problems.join('; ')})`); } catch { /* nothing more to do */ } }
            plan();
            return { loaded: used === true, plots: town.plots.length, builds: town.builds.length };
        },
        attach(socket, { isAgentSocket = () => true } = {}) {
            const own = (agent) => typeof agent === 'string' && agent.length > 0 && isAgentSocket(agent);
            socket.on('genesis-town-sync', (agent, ack) => { if (!own(agent)) return; sockets.set(agent, socket); if (typeof ack === 'function') ack({ ok: true, town: copy(town) }); });
            socket.on('genesis-town-op', (message, ack) => {
                if (!own(message?.agent)) return;
                sockets.set(message.agent, socket);
                let answer;
                try { answer = apply(message.agent, message.op); } catch (err) { answer = { ok: false, reason: `error: ${err?.message ?? err}` }; }
                if (typeof ack === 'function') ack(answer);
            });
            socket.on('disconnect', () => { for (const [agent, known] of sockets) if (known === socket) sockets.delete(agent); });
        },
        apply, operator, view, plan,
        state: () => copy(town),
        // Changes the town from inside this process (homes and goals are kept in the same file).
        update(fn, what = null, detail = {}, about = null) { fn(town); return changed(what, detail, about); },
        onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
        setStore(next) { build_store = next ?? null; },
        prefabOf, homePlot,
        check: () => checkTown(town),
        flush: () => file?.flush() ?? Promise.resolve(),
        stats: () => ({ ...stats, plots: town.plots.length, spans: town.spans.length, builds: town.builds.length, agents: sockets.size }),
    };
}
