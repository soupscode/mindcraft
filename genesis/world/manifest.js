// Genesis: the bootstrap manifest. The honest record of everything the operator's bootstrap
// (genesis/world/bootstrap.js) put into the world: every block, every item, every rule that
// favours the agents. All of it is attributed to "Operator" and none of it is ever agent work.
//
// The manifest file (JSON), next to which the bootstrap also writes
// server-settings.required.txt and the reset writes WORLD_RESET_REQUIRED.txt:
//   {
//     "v": 1, "kind": "genesis.bootstrap.manifest",
//     "world_file": "...", "world_sha256": "<hash of the world file's content>", "seed": "...",
//     "attributed_to": "Operator",
//     "verified": true, "verified_at": "<ISO time>",       every check of the last run passed
//     "runs": [ { "run": 1, "at", "blocks_placed", "items_placed", "rules_set", "blocks_cleared", "floor_blocks_placed", "result": "ok" | "<what failed>" } ],
//     "areas":  [ { "id", "kind": "clear" | "floor", "min": [x, y, z], "max": [x, y, z], "block", "purpose", "by": "Operator",
//                   "changed": <blocks the server reported as changed>, "placed": true, "status", "at", "run" } ],
//          the levelling of the camp, one record per layer: every block in the box that was not already
//          `block` was removed ("clear", block air) or placed ("floor"). `changed` is the count; a fill
//          command does not say which blocks they were.
//          status: "filled" | "nothing to change" | "not levelled: the camp was already standing"
//     "blocks": [ { "id", "pos": [x, y, z], "block", "purpose", "by": "Operator", "placed": true, "at", "run" } ],
//          placed false: the block was already there when the bootstrap first looked
//     "items":  [ { "id", "chest": "kits", "pos", "slot", "item", "count", "by": "Operator", "placed": true, "at", "run" } ],
//     "rules":  [ { "id", "kind", "value", "favours_agents", "why", "by": "Operator", "status", "at", "run" } ],
//          status: "set" | "already set" | "set, cannot be read back" | "operator must set"
//     "favours_agents": [ "<one sentence each: the levelled camp, the camp, the kit, the field (Operator-built and
//                           bare: every crop is agent-planted), the rules that favour the agents>" ],
//     "operator_must_set": [ "server.properties: allow-nether=false", ... ]
//   }
//
// The launcher (genesis/lib/config.js) lets planning start only with a manifest whose
// world_sha256 is the hash of the world file and whose "verified" is true.
// Depends only on Node built-ins and genesis/world/world_config.js.

import path from 'node:path';
import { worldHash } from './world_config.js';

export const MANIFEST_KIND = 'genesis.bootstrap.manifest';
export const MANIFEST_VERSION = 1;
export const OPERATOR = 'Operator';
export const DEFAULT_MANIFEST_FILE = './bots/genesis_world/bootstrap.manifest.json';
export const SERVER_SETTINGS_FILE = 'server-settings.required.txt';
export const RESET_MARKER_FILE = 'WORLD_RESET_REQUIRED.txt';

// The files that live next to the manifest.
export function manifestPaths(manifest_file = DEFAULT_MANIFEST_FILE) {
    const dir = path.dirname(manifest_file);
    return { dir, manifest: manifest_file, server_settings: path.join(dir, SERVER_SETTINGS_FILE), reset_marker: path.join(dir, RESET_MARKER_FILE) };
}

// Reads the text of a manifest file. Returns the manifest, or null when it is not one.
export function parseManifest(text) {
    if (typeof text !== 'string' || text.trim().length === 0) return null;
    try {
        const manifest = JSON.parse(text);
        if (manifest === null || typeof manifest !== 'object' || manifest.kind !== MANIFEST_KIND || manifest.v !== MANIFEST_VERSION) return null;
        return manifest;
    } catch {
        return null;
    }
}

// Why this manifest does not allow planning to start for this world file (empty = it does).
export function checkManifest(manifest, config) {
    if (!manifest) return ['there is no bootstrap manifest'];
    const problems = [];
    if (manifest.world_sha256 !== worldHash(config)) problems.push('the bootstrap manifest is for another version of the world file (its hash does not match)');
    if (manifest.verified !== true) problems.push('the last bootstrap run did not pass its checks');
    const records = [...(manifest.areas ?? []), ...(manifest.blocks ?? []), ...(manifest.items ?? []), ...(manifest.rules ?? [])];
    if (!(manifest.areas ?? []).some((record) => record?.kind === 'floor')) {
        problems.push('the bootstrap manifest has no record of the levelled camp (it was written before the bootstrap levelled the camp)');
    }
    // decided after the first run: the strip one block outside the fence is levelled too. A manifest from before
    // that has no record of it: the bootstrap is run again (it levels only the strip, once, and nothing built).
    if ((manifest.areas ?? []).length > 0 && !(manifest.areas ?? []).some((record) => String(record?.zone ?? '').startsWith('camp.strip.'))) {
        problems.push('the bootstrap manifest has no record of the strip outside the camp\'s fence (it was written before the bootstrap levelled it): run the bootstrap again');
    }
    if (manifest.attributed_to !== OPERATOR || records.some((record) => record?.by !== OPERATOR)) {
        problems.push(`the bootstrap manifest attributes something to someone other than "${OPERATOR}"`);
    }
    return problems;
}
