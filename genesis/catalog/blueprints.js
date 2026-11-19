// Genesis: the blueprints, in upstream's construction format
// (src/agent/npc/construction/<name>.json: { name, blocks[y][z][x] }).
// Read from the folder upstream ships them in; nothing here changes them.
// Depends only on Node built-ins.

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { filePrefabs, PREFAB_DIR, OPERATOR_PREFAB_DIR } from '../build/prefab.js';

// WHAT THE AGENTS BUILD FROM (decided): the prefab files, genesis/prefabs/*.json (the generated ladder)
// and bots/genesis_prefabs/operator/*.json (what the operator uploaded on the Town screen). A prefab is
// a blueprint with more in it (stages, parts, below), in exact Minecraft block names. Upstream's
// construction files (fileBlueprints below) use family names ("planks") and are no longer what a plot
// names; they stay readable for the tests that hold the family rule.
//   root: the repository root when the process does not run from it
export function buildBlueprints({ root = null, dirs = null } = {}) {
    const folders = dirs ?? [PREFAB_DIR, OPERATOR_PREFAB_DIR].map((dir) => (root ? path.resolve(root, dir) : dir));
    return filePrefabs(folders);
}

export const BLUEPRINT_DIR = './src/agent/npc/construction';

export function fileBlueprints(dir = BLUEPRINT_DIR) {
    const cache = new Map();
    return {
        get(name) {
            if (!/^[A-Za-z0-9_-]+$/.test(String(name))) return null;
            if (!cache.has(name)) {
                let blueprint = null;
                try {
                    const parsed = JSON.parse(readFileSync(path.join(dir, `${name}.json`), 'utf8'));
                    if (Array.isArray(parsed?.blocks)) blueprint = { name: parsed.name ?? name, blocks: parsed.blocks };
                } catch { /* no such blueprint */ }
                cache.set(name, blueprint);
            }
            return cache.get(name);
        },
        // The names of the blueprints in the folder.
        names() {
            try {
                return readdirSync(dir).filter((file) => file.endsWith('.json')).map((file) => file.slice(0, -5)).sort();
            } catch {
                return [];
            }
        },
    };
}

// How many blocks a blueprint takes on each axis: { x, y, z }. Rows of unequal length count
// by their longest.
export function blueprintSize(blueprint) {
    const layers = Array.isArray(blueprint?.blocks) ? blueprint.blocks : [];
    let x = 0;
    let z = 0;
    for (const layer of layers) {
        if (!Array.isArray(layer)) continue;
        z = Math.max(z, layer.length);
        for (const row of layer) if (Array.isArray(row)) x = Math.max(x, row.length);
    }
    return { x, y: layers.length, z };
}
