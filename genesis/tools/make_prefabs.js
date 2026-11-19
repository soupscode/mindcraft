// Genesis: writes the generated prefab ladder to genesis/prefabs/ (one JSON file per prefab).
// The files are in the repository; this makes them again from genesis/build/ladder.js.
//
//   node genesis/tools/make_prefabs.js            write the eight files
//   node genesis/tools/make_prefabs.js --check    write nothing; exit 1 when a file differs from what the generator gives
//
// A prefab that does not hold (genesis/build/prefab.js, checkPrefab) is not written.
// Depends only on Node built-ins and genesis/build.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateLadder } from '../build/ladder.js';
import { checkPrefab, prefabText, billOf } from '../build/prefab.js';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'prefabs');
const check_only = process.argv.includes('--check');
let failed = false;
if (!check_only) mkdirSync(dir, { recursive: true });
for (const prefab of generateLadder()) {
    const problems = checkPrefab(prefab);
    const file = path.join(dir, `${prefab.name}.json`);
    if (problems.length > 0) { console.log(`FAIL  ${prefab.name}: ${problems.join('; ')}`); failed = true; continue; }
    const text = prefabText(prefab);
    if (check_only) {
        let on_disk = null;
        try { on_disk = readFileSync(file, 'utf8'); } catch { /* missing */ }
        if (on_disk !== text) { console.log(`FAIL  ${prefab.name}: the file differs from the generator`); failed = true; continue; }
    } else {
        writeFileSync(file, text);
    }
    console.log(`ok    ${prefab.name.padEnd(11)} tier ${prefab.tier}  ${prefab.kind.padEnd(6)}  ${prefab.size.x} x ${prefab.size.z} x ${prefab.size.y}  ${String(billOf(prefab).cells).padStart(3)} cells  ${JSON.stringify(prefab.materials)}`);
}
process.exit(failed ? 1 : 0);
