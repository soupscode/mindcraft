// A world file with its bootstrap manifest on the real disk, for the tests that start the
// launcher: the shipped example world, bootstrapped by the real bootstrap against the
// in-memory server stand-in (helpers/fake-rcon.mjs).

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './stubs.mjs';
import { fakeMinecraft } from './fake-rcon.mjs';
import { runBootstrap } from '../../world/bootstrap.js';
import { seedText } from '../../world/world_config.js';
import { nodeFiles } from '../../store/node_files.js';

export const EXAMPLE_WORLD = JSON.parse(readFileSync(path.join(REPO_ROOT, 'genesis', 'genesis.world.example.json'), 'utf8'));
export const exampleWorld = () => JSON.parse(JSON.stringify(EXAMPLE_WORLD));

// Writes <dir>/genesis.world.json and bootstraps it. Resolves to { world_file, manifest_file, server, result }.
export async function bootstrappedWorld(dir, config = exampleWorld()) {
    const world_file = path.join(dir, 'genesis.world.json');
    const manifest_file = path.join(dir, 'genesis_world', 'bootstrap.manifest.json');
    writeFileSync(world_file, JSON.stringify(config, null, 2));
    const server = fakeMinecraft({ seed: seedText(config.seed) });
    const result = await runBootstrap({ config, rcon: server, files: nodeFiles(), manifest_file, world_file });
    if (!result.ok) throw new Error(`the test world could not be bootstrapped: ${result.problems.join('; ')}`);
    return { world_file, manifest_file, server, result };
}
