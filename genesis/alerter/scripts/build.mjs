// Builds the alerter into one ES module (packages stay in node_modules).
import { build } from 'esbuild';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await rm(path.join(root, 'dist'), { recursive: true, force: true });
await build({
    entryPoints: [path.join(root, 'src/main.ts')],
    outfile: path.join(root, 'dist/alerter.mjs'),
    bundle: true, platform: 'node', format: 'esm', target: 'node20', packages: 'external', sourcemap: true, logLevel: 'warning',
});
console.log('built dist/alerter.mjs');
