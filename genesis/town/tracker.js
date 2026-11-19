// Genesis: what an agent's process does for the town (the town itself is in the MindServer
// process: genesis/town/town.js). All of it is code; the model is never asked.
//
//   builds     the first build goal on a plot tells the town the build has STARTED; every build goal that ends
//              tells it where the build stands; and when every cell is in place the build is VERIFIED:
//              surveyed cell by cell by block name, with no tracked scaffold left, twice, at least 60
//              seconds apart (genesis/build/verify.js). Only then does the town open the tier above.
//              The world is the truth: nothing about a build's cells is kept, every look is a new survey.
//   plots      when the town wants a plot for this agent (a home that outgrew its plot, Arthur's next
//              shared project), the agent looks at the land with its own world view and proposes where
//              it goes (genesis/town/proposer.js). Decided: the builder levels it by hand.
//   gaps       a walk that found no way is reported; where the agent can see a stretch of at most 15
//              blocks it cannot cross, it says where a footbridge would go.
//
// tick() is called every `tick_ms` by the runtime, and after every build goal.
//
// Injected: agent, town (genesis/town/client.js), catalog, zones (with the town layered over), state()
// (the world for the catalog), view, scaffold (the tracker of placed blocks), clock, emit.
// Depends only on other Genesis files.

import { createVerifier } from '../build/verify.js';
import { proposePlot, proposeSpan } from './proposer.js';
import { isEmptyBlock } from '../catalog/ops.js';

export const TRACKER_RULES = Object.freeze({
    tick_ms: 30 * 1000,
    propose_again_ms: 10 * 60 * 1000,   // a wanted plot nobody could place is looked for again after this long
    survey_reach: 12,                   // layers above and below the home point's height that are looked at for the ground
});

const WET = new Set(['water', 'lava', 'bubble_column']);
const TREE = /(_log|_leaves|_wood|_stem|mushroom_block)$/;

// The top of the ground in one column, as the view knows it: { y, wet, tree } or null (not loaded).
// A tree is looked through for the height (the land under it), and said: a trunk is not the builder's to clear.
export function columnOf(view, x, z, around_y, reach = TRACKER_RULES.survey_reach) {
    let tree = false;
    for (let y = Math.round(around_y) + reach; y >= Math.round(around_y) - reach; y--) {
        const block = view.blockAt({ x, y, z });
        if (!block) return null;
        if (WET.has(block.name)) return { y, wet: true, tree };
        if (isEmptyBlock(block.name)) continue;
        if (TREE.test(block.name)) { tree = tree || block.name.endsWith('_log'); continue; }
        return { y, wet: false, tree };
    }
    return { y: Math.round(around_y) - reach, wet: false, tree };
}

export function createBuildTracker({
    agent, town, catalog, zones, state, view, scaffold = null, clock = { now: Date.now }, emit = () => null, rules: overrides = {},
} = {}) {
    const R = { ...TRACKER_RULES, ...overrides };
    const verifier = createVerifier({ clock });
    const told = new Map();         // plot id -> "stage|matching" last sent
    const proposed_at = new Map();  // wanted id -> when a place was last looked for
    const stats = { started: 0, progress: 0, verified: 0, proposed: 0, no_place: 0, gaps: 0, errors: 0 };
    let ticking = false;

    const say = (name, detail) => { try { emit('agent.state', { state: name, detail }, { corr: null }); } catch { /* an event never disturbs the work */ } };
    const builds = () => town.state().builds ?? [];
    const openBuild = (plot) => builds().find((b) => b.plot === plot && !b.verified_at) ?? null;
    const plain = (name) => String(name ?? '').split('@')[0];
    const day = () => { try { const d = view.day?.(); return Number.isInteger(d) ? d : null; } catch { return null; } };

    async function lookAt(plot) {
        const world = state();
        const survey = catalog.buildSurvey(plot.id, world);
        if (!survey) return;
        const name = plain(plot.blueprint);
        const complete = survey.work === 0 && survey.foreign === 0 && survey.unloaded === 0;
        let build = openBuild(plot.id);
        // a build whose cells stand but that the town does not know (it was built before the town was kept): it is entered now
        if (!build && complete && plain(plot.built) !== name && survey.placed > 0) {
            const begun = await town.op({ kind: 'build_started', plot: plot.id, prefab: name });
            if (begun.ok) { stats.started++; build = openBuild(plot.id) ?? { build_id: begun.build_id, plot: plot.id }; }
        }
        if (!build) return;
        const key = `${survey.stage}|${survey.placed}|${complete}`;
        if (told.get(plot.id) !== key) {
            told.set(plot.id, key);
            stats.progress++;
            // what the stage still wants and the agent does not hold (the Town screen's "Short")
            const inventory = view.inventory();
            const short = Object.fromEntries(Object.entries(survey.stage_bill).map(([item, count]) => [item, Math.max(0, count - (inventory[item] ?? 0))]).filter(([, count]) => count > 0));
            // (counted in the prefab's own cells: what stands of what is to be placed; the cells kept clear are not counted)
            const held = Object.fromEntries(Object.keys(survey.bill).map((item) => [item, inventory[item] ?? 0]).filter(([, count]) => count > 0));
            await town.op({ kind: 'build_progress', plot: plot.id, stage: survey.stage, cells_matching: survey.placed, complete, short, bill: survey.bill, held });
        }
        if (!complete) { verifier.forget(build.build_id); return; }
        const strict = catalog.verifySurvey(plot.id, world);
        if (!strict) return;
        const verdict = verifier.check(build.build_id, strict, { scaffold: scaffold?.count?.() ?? 0 });
        if (verdict.state === 'verified') {
            const done = await town.op({ kind: 'build_verified', plot: plot.id, day: day() });
            if (done.ok) { stats.verified++; told.delete(plot.id); say('build_verified', { plot: plot.id, prefab: name, build_id: build.build_id, check: 'by name', reason: verdict.reason }); }
        } else if (verdict.state === 'not_finished') {
            say('build_not_verified', { plot: plot.id, prefab: name, reason: verdict.reason });
        }
    }

    // Looks for a place for a plot the town wants for this agent.
    async function propose(wanted) {
        const now = clock.now();
        const last = proposed_at.get(wanted.id);
        if (last !== undefined && now - last < R.propose_again_ms) return;
        proposed_at.set(wanted.id, now);
        const t = town.state();
        const home = (zones.campHome ?? zones.home)(agent);
        const flat = (box) => ({ min: { x: box.min.x, z: box.min.z }, max: { x: box.max.x, z: box.max.z } });
        const taken = [{ name: 'camp', ...flat(zones.camp()) }, { name: 'field', ...flat(zones.field()) }, ...zones.plots().map((plot) => ({ name: `plot ${plot.id}`, ...flat(plot) }))];
        const column = (x, z) => columnOf(view, x, z, home.y, R.survey_reach);
        const found = proposePlot({
            size: wanted.size, home, limit: t.limit, taken, ranges: [{ agent, home, range: zones.range(agent) }],
            heightAt: column, blockedAt: (x, z) => { const c = column(x, z); return c === null || c.wet || c.tree; },
        });
        if (!found.ok) { stats.no_place++; say('plot_not_placed', { wanted: wanted.id, prefab: wanted.prefab, size: wanted.size, reason: found.reason, looked: found.looked }); return; }
        const answer = await town.op({ kind: 'propose_plot', wanted: wanted.id, min: found.plot.min, max: found.plot.max, score: found.score });
        if (answer.ok) stats.proposed++;
        else say('plot_not_placed', { wanted: wanted.id, prefab: wanted.prefab, size: wanted.size, reason: answer.reason, looked: found.looked });
    }

    return {
        rules: R,
        // executor.onGoalStart: the first build goal on a plot starts the build
        goalStarted(start) {
            if (start.skill !== 'build_blueprint') return;
            const plot = zones.plot(start.args?.plot);
            if (!plot || !plot.blueprint || openBuild(plot.id)) return;
            stats.started++;
            town.op({ kind: 'build_started', plot: plot.id, prefab: plain(plot.blueprint) }).catch(() => { stats.errors++; });
        },
        // executor.onGoalEnd
        goalEnded(end) {
            const resolved = catalog.resolve(end.option_id);
            if (!resolved) return;
            if (resolved.skill === 'build_blueprint') {
                const plot = zones.plot(resolved.args.plot);
                if (plot) lookAt(plot).catch(() => { stats.errors++; });
                return;
            }
            // a walk that found no way: where to, and where a footbridge would go if the agent can see that
            if (resolved.skill === 'travel' && (end.outcome === 'failed' || end.outcome === 'dropped') && end.reason === 'no_safe_path') {
                try {
                    const place = zones.places(agent).find((entry) => entry.id === resolved.args.place) ?? null;
                    if (!place) return;
                    const here = view.position();
                    const found = proposeSpan({ from: { x: Math.round(here.x), y: Math.round(here.y), z: Math.round(here.z) }, to: place.pos, columnAt: (x, z) => columnOf(view, x, z, here.y, R.survey_reach) });
                    stats.gaps++;
                    town.op({ kind: 'gap', place: place.id, span: found.ok ? found.span : null, reason: found.ok ? null : found.reason }).catch(() => { stats.errors++; });
                } catch { stats.errors++; }
            }
        },
        // Every `tick_ms`: the agent's own builds (progress, verification), and plots the town wants for it.
        async tick() {
            if (ticking || !town.isSynced()) return;
            ticking = true;
            try {
                for (const plot of zones.plots()) {
                    if (!plot.blueprint || plot.owner !== agent) continue;
                    if (openBuild(plot.id) || plain(plot.built) !== plain(plot.blueprint)) await lookAt(plot);
                }
                for (const wanted of town.state().wanted ?? []) if (wanted.for === agent && wanted.size !== 'span') await propose(wanted);
            } catch { stats.errors++; } finally { ticking = false; }
        },
        stats: () => ({ ...stats }),
    };
}
