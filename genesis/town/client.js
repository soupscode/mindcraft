// Genesis: an agent process's copy of the town (genesis/town/town.js holds the one town in the
// MindServer process), and the three things the agent reads from it:
//
//   townZones(zones, client)        the zones of the world file with the town layered over them: the plots
//                                   and spans of the town file are plots like any other (protected, owned,
//                                   buildable), and every plot holds the prefab the town assigned to it and
//                                   knows which verified build stands on it (the upgrade in place). The world
//                                   file itself is never changed: its zones come first, then the town's.
//                                   Decided: an agent lives in its finished home. home(agent) is then the
//                                   home's shelter point; the RANGE stays centred on the camp.
//   townBlueprints(prefabs)         the prefab files, plus what the town names that is not a file: a span's
//                                   footbridge of its length ("span_9", five wide), and a prefab turned by
//                                   quarter turns ("span_9@90")
//   building(client, prefabs)       what the build template asks the ladder (genesis/catalog/templates.js,
//                                   buildLock): the verified builds, the generated ladder, which builds were started
//
// The copy starts empty (no town: the world file's zones as they are) and is replaced whole by every
// genesis-town-update. op() sends one operation and resolves to the town's answer, or to
// { ok: false, reason: 'no_answer' } when the MindServer does not answer in time.
//
// Depends only on other files of genesis/town, genesis/build and genesis/catalog/zones.js.

import { emptyTown } from './town_file.js';
import { rotatePrefab, prefabSize, billOf } from '../build/prefab.js';
import { footbridge } from '../build/ladder.js';
import { boxContains, PLOT_FLOOR_DEPTH } from '../catalog/zones.js';

export function createTownClient({ agent, send, clock = { setTimeout, clearTimeout }, timeout_ms = 3000 } = {}) {
    let town = emptyTown();
    let synced = false;
    let version = 0;
    const stats = { updates: 0, ops: 0, unanswered: 0 };
    const ask = (event, payload) => new Promise((resolve) => {
        let settled = false;
        const finish = (value) => { if (settled) return; settled = true; clock.clearTimeout(timer); resolve(value); };
        const timer = clock.setTimeout(() => { stats.unanswered++; finish(null); }, timeout_ms);
        timer?.unref?.();
        try { send(event, payload, (answer) => finish(answer ?? null)); } catch { finish(null); }
    });
    return {
        agent,
        state: () => town,
        version: () => version,
        isSynced: () => synced,
        async sync() {
            const answer = await ask('genesis-town-sync', agent);
            if (answer?.ok && answer.town) { town = answer.town; synced = true; version++; }
            return synced;
        },
        onUpdate(message) { if (message?.town && typeof message.town === 'object') { town = message.town; synced = true; version++; stats.updates++; } },
        async op(op) {
            stats.ops++;
            return (await ask('genesis-town-op', { agent, op })) ?? { ok: false, reason: 'no_answer' };
        },
        stats: () => ({ ...stats, synced }),
    };
}

const point = ([x, y, z]) => ({ x, y, z });
const boxOf = (entry) => ({ min: point(entry.min), max: point(entry.max) });
const flatOverlap = (a, b) => a.min.x <= b.max.x && b.min.x <= a.max.x && a.min.z <= b.max.z && b.min.z <= a.max.z;
const yOverlap = (a, b) => a.min.y <= b.max.y && b.min.y <= a.max.y;

// The name of the blueprint a town entry is built from: the prefab, turned when the entry is.
export const blueprintName = (prefab, rotation = 0) => (prefab ? (rotation ? `${prefab}@${rotation}` : prefab) : null);

// agent: whose process this is. Its own personal chest (decided: an agent that lives in its home keeps one there) is
// then a registered chest of ITS zones, named "home-<agent>"; nobody else's zones hold it.
export function townZones(zones, client, agent = client?.agent ?? null) {
    const town = () => client?.state?.() ?? null;
    const ownChest = () => {
        const home = agent ? town()?.homes?.[agent] ?? null : null;
        return home && Array.isArray(home.chest) && home.chest.length === 3 ? { name: home.chest_name ?? `home-${agent}`, pos: point(home.chest) } : null;
    };
    // the town's own plots and spans, in the zones' shape
    const extra = () => {
        const t = town();
        if (!t) return [];
        return [...(t.plots ?? []).map((p) => ({ ...p, kind: p.kind })), ...(t.spans ?? []).map((s) => ({ ...s, kind: 'bridge' }))].map((entry) => ({
            id: entry.id, owner: entry.owner ?? null, blueprint: blueprintName(t.assign?.[entry.id]?.prefab ?? entry.prefab ?? null, entry.rotation ?? 0), built: blueprintName(t.assign?.[entry.id]?.built ?? null, entry.rotation ?? 0),
            ...boxOf(entry), town: true, level: true, kind: entry.kind, size: entry.size ?? 'span',
        }));
    };
    // a plot of the world file, with what the town assigned to it
    const dress = (plot) => {
        const assigned = town()?.assign?.[plot.id] ?? null;
        return { ...plot, blueprint: assigned?.prefab ?? plot.blueprint ?? null, built: assigned?.built ?? null, town: false, level: false, kind: plot.owner ? 'home' : 'spare', size: 'S' };
    };
    const plots = () => [...zones.plots().map(dress), ...extra()];
    const inPlot = (plot, pos) => boxContains(plot, pos) || boxContains(plot, { x: pos.x, y: pos.y + PLOT_FLOOR_DEPTH, z: pos.z });
    const protectedAt = (pos) => {
        const base = zones.protectedAt(pos);
        if (base !== null) return base;
        for (const plot of extra()) if (inPlot(plot, pos)) return `plot:${plot.id}`;
        return null;
    };
    // decided: once its home is verified an agent shelters and sleeps there
    const shelter = (who) => { const at = town()?.homes?.[who]?.shelter; return Array.isArray(at) && at.length === 3 ? point(at) : null; };
    return {
        ...zones,
        base: zones,
        plots,
        plot: (id) => plots().find((plot) => plot.id === id) ?? null,
        // across both files: the camp, the field, every plot of the world file and of the town
        plotOverlaps(id) {
            const mine = plots().find((plot) => plot.id === id);
            if (!mine) return [];
            if (!mine.town) return [...zones.plotOverlaps(id), ...extra().filter((other) => flatOverlap(mine, other) && yOverlap(mine, other)).map((other) => `plot:${other.id}`)];
            const hits = [];
            const flat3 = (box) => ({ min: { ...box.min, y: -Infinity }, max: { ...box.max, y: Infinity } });
            if (flatOverlap(mine, flat3(zones.camp()))) hits.push('camp');
            if (flatOverlap(mine, flat3(zones.field()))) hits.push('field');
            for (const other of plots()) if (other.id !== id && flatOverlap(mine, other) && yOverlap(mine, other)) hits.push(`plot:${other.id}`);
            return hits;
        },
        protectedAt,
        isProtected: (pos) => protectedAt(pos) !== null,
        chests: () => { const own = ownChest(); return own ? [...zones.chests(), own] : zones.chests(); },
        chest: (name) => { const own = ownChest(); return own && own.name === name ? { ...own.pos } : zones.chest(name); },
        // the name of the agent's own chest at home, or null while it has none
        homeChest: (who) => (who === agent ? ownChest()?.name ?? null : null),
        home: (who) => shelter(who) ?? zones.home(who),
        // where the agent's range is measured from: always the camp's home point, wherever the agent lives
        campHome: (who) => zones.home(who),
        livesAt: (who) => (shelter(who) ? town().homes[who] : null),
        places(who) {
            const list = zones.places(who).map((place) => (place.id === 'home' && shelter(who) ? { ...place, pos: shelter(who) } : place));
            const own = who === agent ? ownChest() : null;
            if (own) {
                const after_chests = list.reduce((last, place, index) => (place.kind === 'chest' ? index : last), 0);
                list.splice(after_chests + 1, 0, { id: `chest-${own.name}`, kind: 'chest', chest: own.name, pos: { ...own.pos } });
            }
            const at = list.findIndex((place) => place.kind === 'patrol');
            const mine = extra().filter((plot) => plot.owner === null || plot.owner === who).map((plot) => ({
                id: `plot-${plot.id}`, kind: 'plot', pos: { x: Math.floor((plot.min.x + plot.max.x) / 2), y: plot.min.y, z: Math.floor((plot.min.z + plot.max.z) / 2) },
            }));
            list.splice(at < 0 ? list.length : at, 0, ...mine);
            return list;
        },
    };
}

// base: { get(name), names() } of the prefab files.
export function townBlueprints(base) {
    const made = new Map();
    const one = (name) => {
        const span = /^span_(\d+)$/.exec(name);
        if (!span) return base.get(name);
        if (made.has(name)) return made.get(name);
        let prefab = null;
        try {
            // a span is five wide: the three of the deck with one column left alone on each side
            const bridge = footbridge(Number(span[1]));
            const blocks = bridge.blocks.map((layer) => layer.map((row) => ['', ...row, '']));
            prefab = { ...bridge, name, blocks, size: prefabSize({ blocks }), cells: billOf(bridge).cells };
        } catch { prefab = null; }
        made.set(name, prefab);
        return prefab;
    };
    return {
        get(name) {
            const [plain, turn] = String(name ?? '').split('@');
            const prefab = one(plain);
            if (!prefab || turn === undefined) return prefab;
            const degrees = Number(turn);
            if (![90, 180, 270].includes(degrees)) return null;
            if (!made.has(name)) made.set(name, { ...rotatePrefab(prefab, degrees), name: prefab.name });
            return made.get(name);
        },
        names: () => base.names(),
        problems: (name) => base.problems?.(name) ?? [],
    };
}

// What the build template asks about the ladder. ladder: the generated prefabs (for the "Needs Cabin" sentence).
export function building(client, prefabs) {
    let ladder = null;
    const plain = (name) => String(name ?? '').split('@')[0];
    return {
        get builds() { return (client.state().builds ?? []).filter((b) => b.verified_at); },
        get ladder() { ladder ??= prefabs.names().map((name) => prefabs.get(name)).filter((p) => p && p.by === 'Generated'); return ladder; },
        started: (plot, prefab) => (client.state().builds ?? []).some((b) => b.plot === plot && b.prefab === plain(prefab) && !b.verified_at),
        // the plots with a build under way (the learner may continue those while the model is away, and start none)
        startedPlots: () => [...new Set((client.state().builds ?? []).filter((b) => !b.verified_at).map((b) => b.plot))],
    };
}
