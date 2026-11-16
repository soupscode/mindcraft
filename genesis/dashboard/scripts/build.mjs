// Builds the server (one ES module, packages stay in node_modules) and the front end
// (Preact, bundled; the fonts are copied next to it, so nothing is fetched from a font CDN).
//   node scripts/build.mjs
import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist');
await rm(out, { recursive: true, force: true });
await mkdir(path.join(out, 'public'), { recursive: true });

await build({
    entryPoints: [path.join(root, 'src/server/main.ts')],
    outfile: path.join(out, 'server.mjs'),
    bundle: true, platform: 'node', format: 'esm', target: 'node20', packages: 'external', sourcemap: true, logLevel: 'warning',
});

await build({
    entryPoints: { app: path.join(root, 'src/web/main.tsx') },
    outdir: path.join(out, 'public'),
    bundle: true, platform: 'browser', format: 'esm', target: 'es2020', minify: true, sourcemap: true, logLevel: 'warning',
    jsx: 'automatic', jsxImportSource: 'preact',
    loader: { '.woff2': 'file', '.woff': 'file' },
    assetNames: 'fonts/[name]',
});
await cp(path.join(root, 'src/web/index.html'), path.join(out, 'public/index.html'));
console.log('built dist/server.mjs and dist/public');
