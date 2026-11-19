// Genesis: what the dashboard's Town screen shows (mock-up Town.dc.html), put together from the
// town file, the prefab files and the shared chest's ledger. Every number is computed; every
// plot and prefab says whose it is (Operator, Code, Generated).
//
//   townView({ town, prefabs, stock, roles, zones_config, goals })
//     -> { limit, camp, field, plots, wanted, gaps, homes, project, ladder, builds, counts, goals, prefabs }
//   importPrefab({ name, title, kind, file_base64, substitute, save, prefabs, files, dir })
//     an operator's schematic, converted. Decided: operator prefabs arrive by upload on the Town screen.
//
// WHAT THE HOST CANNOT SEE: the blocks. A build's cells are counted by its builder's process
// (genesis/town/tracker.js) and arrive as numbers; the stage rows here are worked out from those.
//
// Depends only on other Genesis files.

import { stageBills, billOf, prefabSize, prefabText, catalogObtainable, unobtainable, checkPrefab, PREFAB_NAME } from '../build/prefab.js';
import { ladderView, homesView, unlockState, SHARED_BUILDER } from '../build/unlock.js';
import { schemToPrefab } from '../build/schematic.js';
import { GATHER_TYPES, CRAFT_ITEMS, CROPS } from '../catalog/defaults.js';
import { longTermCandidates, nextRung } from './goals.js';

export const OBTAINABLE = catalogObtainable({ gather_types: GATHER_TYPES, craft_items: CRAFT_ITEMS, crops: CROPS });
export const UPLOAD_LIMIT_BYTES = 2 * 1024 * 1024;

const allPrefabs = (prefabs) => prefabs.names().map((name) => prefabs.get(name)).filter(Boolean);

// One build under way, as the project panel shows it. build: the town's row (with what its builder last reported).
export function projectOf({ build, prefab, stock = {} }) {
    const stages = stageBills(prefab);
    const now = stages.findIndex((stage) => stage.name === build.stage);
    let left = build.cells_matching;
    const rows = stages.map((stage, index) => {
        // the stages before the one the build is at are done; the one it is at has what is left of the count
        const done = build.verified_at || (now >= 0 && index < now) ? stage.cells : (now >= 0 && index > now ? 0 : Math.max(0, Math.min(stage.cells, left)));
        left -= done;
        return { name: stage.name, done, total: stage.cells, label: 'Computed' };
    });
    // what is still to place, by item: the stages from the current one on (the builder's own count when it sent one)
    const need = {};
    if (build.bill) Object.assign(need, build.bill);
    else for (const stage of stages.slice(Math.max(0, now))) for (const [item, count] of Object.entries(stage.materials)) need[item] = (need[item] ?? 0) + count;
    const held = build.held ?? {};
    const materials = Object.keys(billOf(prefab).materials).sort((a, b) => (need[b] ?? 0) - (need[a] ?? 0) || a.localeCompare(b)).map((item) => {
        const have = (stock[item] ?? 0) + (held[item] ?? 0);
        const wanted = build.verified_at ? 0 : need[item] ?? 0;
        return { item, need: wanted, have, short: Math.max(0, wanted - have), state: wanted - have <= 0 ? 'Ready' : 'Short' };
    });
    return {
        build_id: build.build_id, prefab: prefab.name, title: prefab.title ?? prefab.name, kind: prefab.kind, tier: prefab.tier, by: prefab.by, plot: build.plot, builder: build.builder,
        size: prefabSize(prefab), state: build.verified_at ? 'Verified' : build.cells_matching > 0 ? 'Building' : 'Not started',
        cells: { done: build.cells_matching, total: build.cells_total }, stage: build.stage, stages: rows, materials,
        verified: build.verified_at ? { at: build.verified_at, day: build.verified_day ?? null } : null, check: 'By name', started_at: build.started_at,
    };
}

export function townView({ town, prefabs, stock = {}, roles = {}, zones_config, goals = null }) {
    const state = town.state();
    const base = town.view();
    const all = allPrefabs(prefabs);
    const agents = Object.keys(zones_config.agents ?? {});
    const tiered = state.builds.map((b) => ({ ...b }));
    const active = state.builds.filter((b) => !b.verified_at).map((b) => ({ prefab: b.prefab, builder: b.builder, plot: b.plot, cells_matching: b.cells_matching, cells_total: b.cells_total }));
    const ladder = ladderView({ prefabs: all, builds: tiered, stock, active, obtainable: OBTAINABLE });
    const home_plots = Object.fromEntries(agents.map((agent) => [agent, town.homePlot(agent)?.id ?? null]));
    const homes = homesView({ agents, roles, plots: home_plots, builds: tiered, prefabs: all, stock, active, obtainable: OBTAINABLE }).map((home) => ({
        ...home,
        // decided: the agent lives in its finished home. Its bed (furniture it places itself) and its own chest:
        living: state.homes[home.agent] ? { plot: state.homes[home.agent].plot, bed: state.homes[home.agent].bed ? (state.homes[home.agent].bed.placed ? 'Placed' : 'Not placed') : null, chest: state.homes[home.agent].chest ? 'Personal' : null } : null,
    }));
    // Arthur's project: the shared or bridge build under way, else his next rung
    const under_way = state.builds.filter((b) => !b.verified_at && b.builder === SHARED_BUILDER).sort((a, b) => (a.kind === 'home' ? 1 : 0) - (b.kind === 'home' ? 1 : 0))[0] ?? null;
    const rung = nextRung({ town_state: state, prefabs });
    let project = null;
    const project_prefab = under_way ? town.prefabOf(under_way.prefab) : rung ? town.prefabOf(rung.prefab) : null;
    if (under_way && project_prefab) project = projectOf({ build: under_way, prefab: project_prefab, stock });
    else if (rung && project_prefab) {
        const unlock = unlockState({ prefab: project_prefab, builder: SHARED_BUILDER, builds: tiered, stock, ladder: all.filter((p) => p.by === 'Generated'), obtainable: OBTAINABLE });
        project = { ...projectOf({ build: { build_id: null, plot: rung.plot ?? base.plots.find((p) => p.prefab === rung.prefab)?.id ?? null, builder: SHARED_BUILDER, stage: null, cells_matching: 0, cells_total: billOf(project_prefab).cells, started_at: null }, prefab: project_prefab, stock }), state: unlock.state === 'open' ? 'Open' : 'Locked', lock: unlock.reason };
    }
    // the outline of each prefab, seen from above: how many layers stand in each column (the ladder's small pictures)
    const outline = (name) => {
        const prefab = prefabs.get(name);
        if (!prefab) return null;
        const size = prefabSize(prefab);
        return Array.from({ length: size.z }, (_, z) => Array.from({ length: size.x }, (_, x) => prefab.blocks.reduce((n, layer) => n + (layer[z]?.[x] && layer[z][x] !== 'air' ? 1 : 0), 0)));
    };
    for (const part of [ladder.generated, ladder.operator]) for (const entry of part.list) { entry.outline = outline(entry.name); entry.materials = billOf(prefabs.get(entry.name)).materials; }
    const count = (list, test) => list.filter(test).length;
    return {
        limit: base.limit, camp: zones_config.camp, field: zones_config.field, home: zones_config.home ?? null,
        plots: base.plots, wanted: base.wanted, gaps: base.gaps,
        homes, project, ladder,
        builds: state.builds.slice(-12).reverse(),
        counts: {
            plots: base.plots.length, by_code: count(base.plots, (p) => p.by === 'Code'), by_operator: count(base.plots, (p) => p.by === 'Operator'),
            verified: count(state.builds, (b) => Boolean(b.verified_at)), building: active.length,
        },
        long_term: Object.fromEntries(agents.map((agent) => [agent, {
            candidates: longTermCandidates({ agent, role: roles[agent] ?? null, town_state: state, prefabs }), chosen: state.goals[agent]?.chosen ?? null, chosen_by: state.goals[agent]?.chosen_by ?? null,
            override: state.goals[agent]?.override ?? null,
        }])),
        stock_of: 'the shared chest',
        goals_stats: goals?.stats?.() ?? null,
    };
}

// An operator's schematic to a prefab. Nothing is guessed: what cannot be carried over is in the report.
//   -> { ok: true, report, prefab: { name, title, kind, tier, size, cells, materials, by }, saved, file }
//      | { ok: false, reason, problems? }
export async function importPrefab({ name, title = null, kind = 'shared', file_base64, substitute = {}, save = false, prefabs, files = null, dir = null, now = Date.now() } = {}) {
    if (!PREFAB_NAME.test(String(name ?? '')) || String(name).length > 40) return { ok: false, reason: 'a prefab name is letters, digits, _ and -, at most 40' };
    if (!['shared', 'home'].includes(kind)) return { ok: false, reason: 'kind must be shared or home' };
    if (typeof file_base64 !== 'string' || file_base64.length === 0) return { ok: false, reason: 'no file' };
    if (file_base64.length > UPLOAD_LIMIT_BYTES * 1.4) return { ok: false, reason: `the file is larger than ${UPLOAD_LIMIT_BYTES / 1024 / 1024} MB` };
    const bytes = Buffer.from(file_base64, 'base64');
    if (bytes.length === 0 || bytes.length > UPLOAD_LIMIT_BYTES) return { ok: false, reason: 'the file is empty or too large' };
    const generated = allPrefabs(prefabs).filter((p) => p.by === 'Generated');
    if (generated.some((p) => p.name === name)) return { ok: false, reason: `${name} is a prefab of the generated ladder` };
    const swaps = {};
    for (const [from, to] of Object.entries(substitute ?? {})) if (/^[a-z0-9_]{1,60}$/.test(from) && /^[a-z0-9_]{1,60}$/.test(String(to))) swaps[from] = String(to);
    let made;
    try {
        // decided: air in an uploaded schematic leaves the cell alone
        made = schemToPrefab(bytes, { name, title: title ? String(title).slice(0, 40) : null, kind, source_file: `${name}.schem`, now, obtainable: OBTAINABLE, ladder: generated, substitute: swaps, air: 'leave' });
    } catch (err) {
        return { ok: false, reason: `not a schematic this can read: ${err?.message ?? err}` };
    }
    const { prefab, report } = made;
    // the file is kept in exact block names; the bill a prefab file carries is recomputed when it is read
    const stored = { ...prefab, materials: billOf(prefab).materials };
    const problems = checkPrefab(stored);
    const summary = { name: prefab.name, title: prefab.title, kind: prefab.kind, tier: prefab.tier, by: prefab.by, size: prefab.size, cells: billOf(prefab).cells, materials: prefab.materials, blocked: unobtainable(prefab, OBTAINABLE) };
    let saved = false;
    let file = null;
    if (save === true) {
        if (problems.length > 0) return { ok: false, reason: 'the prefab does not hold and was not saved', problems, report, prefab: summary };
        if (!files || !dir) return { ok: false, reason: 'no place to save it', report, prefab: summary };
        file = `${dir}/${prefab.name}.json`;
        const text = prefabText(stored);
        await files.write(`${file}.tmp`, text);
        if (await files.read(`${file}.tmp`) !== text) return { ok: false, reason: 'the file did not read back as written', report, prefab: summary };
        await files.rename(`${file}.tmp`, file);
        saved = true;
    }
    return { ok: true, report: { ...report, problems }, prefab: summary, saved, file };
}
