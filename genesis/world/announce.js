// Genesis: the world as events (decided: the dashboard's World view shows real data). Two
// agent.state events under the name "world", built from the two files only the agents' side
// has: the world file (the site, the zones, the plots) and the bootstrap manifest (what the
// operator's bootstrap put there, how the site was chosen, what favours the agents).
//
//   world_zones      { world_sha256, seed, home, floor_y, border, camp, field, plots, chests, agents, land }
//   world_bootstrap  { verified, verified_at, attributed_to, world_matches, runs, last_run, site,
//                      levelling: { boxes, blocks_changed, blocks_listed, zones: [{ zone, cleared, floored }] },
//                      blocks_placed, items_placed, rules: [{ id, value, favours_agents, status }],
//                      favours_agents: [sentences], operator_must_set: [lines] }
// The manifest's long lists (every block, every levelled cell) stay in the file: the events
// carry the counts. Emitted at start and again every half hour, so that a reader that joins
// late, or after the stream was trimmed, still has them.
//
// Depends on genesis/world (world_config.js, manifest.js), genesis/events/agent_emit.js and Node built-ins.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { worldHash } from './world_config.js';
import { DEFAULT_MANIFEST_FILE, parseManifest } from './manifest.js';
import { createEmitter } from '../events/agent_emit.js';

export const WORLD_EVENT_AGENT = 'world';
export const WORLD_REPEAT_MS = 30 * 60 * 1000;

const flatBox = (box) => ({ min: [box.min[0], box.min.at(-1)], max: [box.max[0], box.max.at(-1)] });

// The site as the world file has it. Pure.
export function worldZonesDetail(config) {
    const boxes = [flatBox(config.camp), flatBox(config.field), ...(config.plots ?? []).map(flatBox)];
    return {
        world_sha256: worldHash(config),
        seed: String(config.seed ?? ''),
        home: config.home ?? null,
        floor_y: Array.isArray(config.home) ? config.home[1] - 1 : null,
        border: config.border ?? null,
        camp: flatBox(config.camp),
        field: { ...flatBox(config.field), y: config.field.y ?? null, owner: config.field.owner ?? null, water: (config.field.water ?? []).length },
        plots: (config.plots ?? []).map((plot) => ({ id: plot.id, owner: plot.owner ?? null, blueprint: plot.blueprint ?? null, min: plot.min, max: plot.max })),
        chests: config.chests ?? {},
        agents: Object.fromEntries(Object.entries(config.agents ?? {}).map(([name, entry]) => [name, { home: entry.home, range: entry.range }])),
        land: { min: [Math.min(...boxes.map((box) => box.min[0])), Math.min(...boxes.map((box) => box.min[1]))], max: [Math.max(...boxes.map((box) => box.max[0])), Math.max(...boxes.map((box) => box.max[1]))] },
    };
}

// The summary of the bootstrap manifest. Pure. `config` (optional) says whether the manifest is for this world file.
export function bootstrapSummary(manifest, config = null) {
    const areas = manifest.areas ?? [];
    const zones = new Map();
    for (const record of areas) {
        const zone = record.zone ?? String(record.id ?? '').replace(/\.(clear|floor)(\.\d+)?$/, '');
        const entry = zones.get(zone) ?? { zone, cleared: 0, floored: 0, status: record.status ?? null };
        entry[record.kind === 'floor' ? 'floored' : 'cleared'] += Number(record.changed) || 0;
        zones.set(zone, entry);
    }
    const site = manifest.site ?? null;
    return {
        verified: manifest.verified === true,
        verified_at: manifest.verified_at ?? null,
        attributed_to: manifest.attributed_to ?? null,
        world_matches: config ? manifest.world_sha256 === worldHash(config) : null,
        seed: manifest.seed ?? null,
        runs: (manifest.runs ?? []).length,
        last_run: (manifest.runs ?? []).at(-1) ?? null,
        site: site ? {
            method: site.method ?? null, at: site.at ?? null, how: site.how ?? null, home: site.chosen?.home ?? site.home ?? null,
            ...(site.chosen ? {
                floor_y: site.chosen.floor_y, distance_from_spawn: site.chosen.distance, score: site.chosen.score, relief: site.chosen.relief,
                exact: site.chosen.exact ?? null, trees_nearby: site.chosen.trees_nearby,
                candidates: site.candidates ?? null, commands: site.commands ?? null, search: site.search ? { radius: site.search.radius, step: site.search.step, columns: site.search.columns } : null,
                runners_up: (site.runners_up ?? []).map((other) => ({ home: other.home, changes: other.exact?.changes ?? null, score: other.score })),
            } : {}),
        } : null,
        levelling: {
            boxes: areas.length,
            blocks_changed: areas.reduce((n, record) => n + (Number(record.changed) || 0), 0),
            blocks_listed: areas.reduce((n, record) => n + (Array.isArray(record.changes) ? record.changes.length : 0), 0),
            zones: [...zones.values()],
        },
        blocks_placed: (manifest.blocks ?? []).filter((record) => record.placed).length,
        blocks_recorded: (manifest.blocks ?? []).length,
        items_placed: (manifest.items ?? []).filter((record) => record.placed).length,
        rules: (manifest.rules ?? []).map((rule) => ({ id: rule.id, value: rule.value, favours_agents: rule.favours_agents === true, status: rule.status ?? null })),
        favours_agents: manifest.favours_agents ?? [],
        operator_must_set: manifest.operator_must_set ?? [],
    };
}

// Reads the two files and emits what they say. Never throws: a file that cannot be read is
// simply not announced (the launcher's own checks say why planning cannot start).
// Returns { emitted: [states], stop() }.
export function announceWorld({
    planning, repo_root, event_sink, read = (file) => readFileSync(file, 'utf8'), clock = { setInterval, clearInterval }, repeat_ms = WORLD_REPEAT_MS, emitter = null,
} = {}) {
    const out = emitter ?? createEmitter({ agent: WORLD_EVENT_AGENT, send: event_sink });
    const emitted = [];
    const once = () => {
        let config = null;
        try { config = JSON.parse(read(path.resolve(repo_root, planning.world_file))); } catch { return; }
        try {
            out.emit('agent.state', { state: 'world_zones', detail: worldZonesDetail(config) }, { severity: 'info', corr: null });
            emitted.push('world_zones');
        } catch { /* a world file the checks refuse is not announced */ }
        try {
            const manifest = parseManifest(read(path.resolve(repo_root, planning.manifest_file || DEFAULT_MANIFEST_FILE)));
            if (!manifest) return;
            out.emit('agent.state', { state: 'world_bootstrap', detail: bootstrapSummary(manifest, config) }, { severity: 'info', corr: null });
            emitted.push('world_bootstrap');
        } catch { /* no manifest yet */ }
    };
    once();
    const timer = repeat_ms > 0 ? clock.setInterval(once, repeat_ms) : null;
    timer?.unref?.();
    return { emitted, again: once, stop() { if (timer !== null) clock.clearInterval(timer); } };
}
