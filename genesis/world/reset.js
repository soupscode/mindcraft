// Genesis: the full reset. One script that wipes what the agents have learned and done, so
// that the same seed can be played again from the start.
//
//   node genesis/world/reset.js                          dry run: lists exactly what would be removed, removes nothing
//   node genesis/world/reset.js --yes-wipe-everything    removes it, and writes the marker for the operator
//   options:  --settings <file>   the Genesis settings (default genesis/settings.json; GENESIS_SETTINGS_FILE)
//
// Stop the agents (the launcher) first: their goals also live in the launcher's memory.
//
// WIPED, and nothing else:
//   agent memory   <bots>/<Agent>/memory.json and the files in <bots>/<Agent>/histories/
//   checkpoints    <checkpoint_dir>/<Agent>.checkpoint.json (and a leftover .tmp)
//   chest ledger   the ledger file (and a leftover .tmp)
//   goals          the tables agent_goals and goal_changes, and the checkpoint mirror
//                  agent_checkpoints, when a Postgres address is configured. Without one the
//                  goals only live in the launcher's memory and are gone when it stops.
// KEPT: identity (the profiles, and <bots>/<Agent>/last_profile.json), the settings, the
// world file with its seed, the blueprints, incidents, logs, the planner call records, and
// the bootstrap manifest of the old world (the next bootstrap files it away).
//
// THE MINECRAFT WORLD FOLDER IS NEVER TOUCHED. The script writes WORLD_RESET_REQUIRED.txt
// next to the bootstrap manifest: it tells the operator to delete the world folder and let
// the server generate it again from the same seed. While that marker is there the launcher
// refuses to start planning; the bootstrap removes it once the new world passes its checks.
//
// Safety: only files are removed, never folders; only the files named above; a path that
// does not lie inside one of the Genesis data folders the script was given is refused, and
// so is a link. A data folder that holds (or lies inside) the profiles, the settings, the
// world file or the blueprints stops the whole reset.
//
// NOT RUN AGAINST A REAL POSTGRES. The tests use in-memory files and a recording pool.
//
// Injected: files { kind(path) -> 'file' | 'dir' | 'link' | 'missing' | 'other', list(dir) -> [name],
// remove(path), write(path, text) } (resetFiles() below is the real one), pool { query(text) },
// clock.
// Depends only on Node built-ins and other Genesis files.

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_MANIFEST_FILE, manifestPaths } from './manifest.js';

export const RESET_FLAG = '--yes-wipe-everything';
export const DEFAULT_MEMORY_DIR = './bots';
export const RESET_TABLES = Object.freeze(['agent_goals', 'goal_changes', 'agent_checkpoints']);
const AGENT_NAME = /^[A-Za-z0-9_]{1,64}$/;

const inside = (root, target) => target === root || target.startsWith(root + path.sep);

// The real files, through node:fs.
export async function resetFiles() {
    const { lstat, readdir, unlink, mkdir, writeFile } = await import('node:fs/promises');
    return {
        async kind(file) {
            try {
                const stat = await lstat(file);
                if (stat.isSymbolicLink()) return 'link';
                if (stat.isFile()) return 'file';
                if (stat.isDirectory()) return 'dir';
                return 'other';
            } catch (err) {
                if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return 'missing';
                throw err;
            }
        },
        list: async (dir) => (await readdir(dir)).sort(),
        remove: (file) => unlink(file),
        async write(file, text) {
            await mkdir(path.dirname(file), { recursive: true });
            await writeFile(file, text, 'utf8');
        },
    };
}

// Works out what a reset would remove. Removes nothing. Never throws.
//   agents            the agents' names (from the profiles)
//   memory_dir        the folder upstream keeps each agent's memory in (./bots)
//   checkpoint_dir, ledger_file, manifest_file   the Genesis data files
//   protect           paths that must never lie inside a data folder (profiles, settings, world file, blueprints)
//   database          true when a Postgres address is configured
// Resolves to { ok, refused: [reasons], remove: [{ path, what }], skipped: [{ path, why }],
//               database: [statements], marker, roots, kept: [notes] }.
export async function planReset({
    agents = [], memory_dir = DEFAULT_MEMORY_DIR, checkpoint_dir, ledger_file, manifest_file = DEFAULT_MANIFEST_FILE,
    protect = [], database = false, files, cwd = process.cwd(),
} = {}) {
    const abs = (file) => path.resolve(cwd, file);
    const plan = { ok: true, refused: [], remove: [], skipped: [], database: [], marker: abs(manifestPaths(manifest_file).reset_marker), roots: [], kept: [] };
    const refuse = (reason) => { plan.ok = false; plan.refused.push(reason); };

    const names = [];
    for (const agent of agents) {
        if (typeof agent === 'string' && AGENT_NAME.test(agent)) names.push(agent);
        else refuse(`"${agent}" is not an agent name: nothing is removed for it`);
    }
    if (names.length === 0) refuse('no agents are listed');
    for (const [key, value] of Object.entries({ memory_dir, checkpoint_dir, ledger_file, manifest_file })) {
        if (typeof value !== 'string' || value.length === 0) refuse(`${key} is not given`);
    }
    if (!plan.ok) return plan;

    // the Genesis data folders: nothing outside them is ever removed
    const roots = {
        memory: names.map((agent) => abs(path.join(memory_dir, agent))),
        checkpoints: [abs(checkpoint_dir)],
        ledger: [abs(path.dirname(ledger_file))],
    };
    plan.roots = [...roots.memory, ...roots.checkpoints, ...roots.ledger];
    const filesystem_root = path.parse(abs('.')).root;
    for (const root of plan.roots) {
        if (root === filesystem_root || root === abs('.') || inside(root, abs('.'))) refuse(`the data folder ${root} is the working folder or lies above it`);
        for (const precious of protect.map(abs)) {
            if (inside(root, precious) || inside(precious, root)) refuse(`the data folder ${root} holds, or lies inside, ${precious}, which a reset must keep`);
        }
    }
    if (!plan.ok) return plan;

    async function want(file, what, root_list) {
        const target = abs(file);
        if (!root_list.some((root) => inside(root, target))) { plan.skipped.push({ path: target, why: 'outside the Genesis data folders' }); return; }
        let kind;
        try { kind = await files.kind(target); } catch (err) { plan.skipped.push({ path: target, why: `cannot be looked at (${err?.message ?? err})` }); return; }
        if (kind === 'missing') return;
        if (kind !== 'file') { plan.skipped.push({ path: target, why: kind === 'link' ? 'a link: links are never followed or removed' : `not a file (${kind})` }); return; }
        plan.remove.push({ path: target, what });
    }
    // true when every folder from the root down to `dir` is a real folder (no link on the way)
    async function realFolder(dir, root) {
        let at = abs(dir);
        const chain = [];
        while (inside(root, at)) { chain.push(at); if (at === root) break; at = path.dirname(at); }
        for (const folder of chain) {
            let kind;
            try { kind = await files.kind(folder); } catch { return false; }
            if (kind === 'missing') return false;
            if (kind !== 'dir') { plan.skipped.push({ path: folder, why: kind === 'link' ? 'a link: links are never followed' : `not a folder (${kind})` }); return false; }
        }
        return true;
    }

    for (const agent of names) {
        const root = abs(path.join(memory_dir, agent));
        if (!(await realFolder(root, root))) continue;
        await want(path.join(root, 'memory.json'), `${agent}: memory`, [root]);
        const histories = path.join(root, 'histories');
        if (await realFolder(histories, root)) {
            let listed = [];
            try { listed = await files.list(histories); } catch (err) { plan.skipped.push({ path: histories, why: `cannot be listed (${err?.message ?? err})` }); }
            for (const name of listed) await want(path.join(histories, name), `${agent}: conversation history`, [root]);
        }
    }
    const checkpoints = abs(checkpoint_dir);
    if (await realFolder(checkpoints, checkpoints)) {
        for (const agent of names) {
            await want(path.join(checkpoints, `${agent}.checkpoint.json`), `${agent}: checkpoint`, roots.checkpoints);
            await want(path.join(checkpoints, `${agent}.checkpoint.json.tmp`), `${agent}: checkpoint (unfinished write)`, roots.checkpoints);
        }
    }
    const ledger_dir = abs(path.dirname(ledger_file));
    if (await realFolder(ledger_dir, ledger_dir)) {
        await want(ledger_file, 'the chest ledger', roots.ledger);
        await want(`${ledger_file}.tmp`, 'the chest ledger (unfinished write)', roots.ledger);
    }
    if (database) plan.database = RESET_TABLES.map((table) => `DELETE FROM ${table}`);
    plan.kept = [
        'the profiles and each agent\'s last_profile.json (identity)',
        'the settings and the world file with its seed',
        'the blueprints',
        'incidents, logs and the planner call records',
        'the bootstrap manifest of the old world (the next bootstrap files it away)',
        'THE MINECRAFT WORLD FOLDER: this script never touches it',
    ];
    return plan;
}

// The text of WORLD_RESET_REQUIRED.txt.
export function markerText({ at, seed = null, world_file = 'genesis.world.json' } = {}) {
    return [
        'GENESIS: THE WORLD MUST BE REGENERATED',
        '',
        `A full reset was run at ${at}. The agents' memory, goals, checkpoints and the chest ledger were wiped.`,
        'The Minecraft world itself was NOT touched: the reset script never deletes it.',
        '',
        'Operator, do this now:',
        '  1. Stop the Minecraft server.',
        '  2. Delete the world folder of the server (and its Nether and End folders, if the server keeps them apart).',
        `  3. Make sure server.properties still has  level-seed=${seed ?? `<the "seed" of ${world_file}>`}  and start the server: it generates the world again from the same seed.`,
        '  4. Run  node genesis/world/bootstrap.js  to build the starter camp and check it. It removes this file when the new world passes.',
        '',
        'While this file exists the launcher refuses to start planning.',
        '',
    ].join('\n');
}

// Carries a reset out, or (without `confirmed`) only says what it would do. Never throws.
// Resolves to { dry_run, ok, plan, removed: [paths], failed: [{ path | statement, error }],
//               database_done: [statements], marker_written }.
export async function runReset(inputs, { confirmed = false, files, pool = null, clock = { now: Date.now }, seed = null, world_file } = {}) {
    const plan = await planReset({ ...inputs, files });
    const outcome = { dry_run: !confirmed, ok: plan.ok, plan, removed: [], failed: [], database_done: [], marker_written: false };
    if (!confirmed || !plan.ok) return outcome;
    for (const entry of plan.remove) {
        // looked at once more right before it goes: it must still be a plain file inside a data folder
        try {
            if (!plan.roots.some((root) => inside(root, entry.path)) || (await files.kind(entry.path)) !== 'file') {
                outcome.failed.push({ path: entry.path, error: 'no longer a plain file inside a data folder: left alone' });
                continue;
            }
            await files.remove(entry.path);
            outcome.removed.push(entry.path);
        } catch (err) {
            outcome.failed.push({ path: entry.path, error: String(err?.message ?? err) });
        }
    }
    for (const statement of plan.database) {
        try {
            if (!pool) throw new Error('no database connection (is the "pg" package installed, and the database up?)');
            await pool.query(statement);
            outcome.database_done.push(statement);
        } catch (err) {
            outcome.failed.push({ statement, error: String(err?.message ?? err) });
        }
    }
    try {
        await files.write(plan.marker, markerText({ at: new Date(clock.now()).toISOString(), seed, world_file }));
        outcome.marker_written = true;
    } catch (err) {
        outcome.failed.push({ path: plan.marker, error: String(err?.message ?? err) });
    }
    outcome.ok = outcome.failed.length === 0 && outcome.marker_written;
    return outcome;
}

export function resetLines(outcome) {
    const lines = [];
    const plan = outcome.plan;
    if (!plan.ok) {
        lines.push('RESET REFUSED. Nothing was removed.');
        for (const reason of plan.refused) lines.push(`  ${reason}`);
        return lines;
    }
    lines.push(outcome.dry_run ? 'DRY RUN. This is what a full reset would remove:' : 'FULL RESET. Removed:');
    const listed = outcome.dry_run ? plan.remove : plan.remove.filter((entry) => outcome.removed.includes(entry.path));
    for (const entry of listed) lines.push(`  ${entry.path}   (${entry.what})`);
    if (listed.length === 0) lines.push('  (no files)');
    for (const statement of (outcome.dry_run ? plan.database : outcome.database_done)) lines.push(`  database: ${statement}`);
    for (const skipped of plan.skipped) lines.push(`  left alone: ${skipped.path} (${skipped.why})`);
    for (const failed of outcome.failed) lines.push(`  FAILED: ${failed.path ?? failed.statement}: ${failed.error}`);
    lines.push('Kept:');
    for (const note of plan.kept) lines.push(`  ${note}`);
    if (outcome.dry_run) {
        lines.push(`It would also write ${plan.marker}, which tells you to delete the Minecraft world folder and regenerate it from the same seed.`);
        lines.push(`Nothing was removed. To do it, stop the agents and run again with ${RESET_FLAG}`);
    } else {
        lines.push(outcome.marker_written ? `Wrote ${plan.marker}. READ IT: the Minecraft world folder must now be deleted by you and regenerated from the same seed.` : 'The marker file could NOT be written.');
        if (!outcome.ok) lines.push('THE RESET IS NOT COMPLETE: see the FAILED lines above.');
    }
    return lines;
}

// ---- command line ---------------------------------------------------------------------------

async function main(argv) {
    const { readFileSync } = await import('node:fs');
    const repo_root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    process.chdir(repo_root);
    const at = argv.indexOf('--settings');
    const settings_file = (at >= 0 ? argv[at + 1] : null) ?? process.env.GENESIS_SETTINGS_FILE ?? path.join(repo_root, 'genesis', 'settings.json');
    let settings;
    try { settings = JSON.parse(readFileSync(settings_file, 'utf8')); } catch (err) {
        console.error(`The Genesis settings cannot be read (${settings_file}): ${err.message}`);
        return 1;
    }
    const planning = settings.genesis_planning ?? {};
    const { DEFAULT_CHECKPOINT_DIR, DEFAULT_WORLD_FILE, DEFAULT_LEDGER_FILE } = await import('../agent/hooks.js');
    const { BLUEPRINT_DIR } = await import('../catalog/blueprints.js');
    const profiles = Array.isArray(settings.profiles) ? settings.profiles : [];
    const agents = [];
    for (const profile of profiles) {
        try { agents.push(JSON.parse(readFileSync(profile, 'utf8')).name); } catch (err) {
            console.error(`The profile ${profile} cannot be read (${err.message}). Nothing was removed.`);
            return 1;
        }
    }
    const world_file = process.env.GENESIS_WORLD_FILE || planning.world_file || DEFAULT_WORLD_FILE;
    let seed = null;
    try { seed = String(JSON.parse(readFileSync(world_file, 'utf8')).seed ?? '') || null; } catch { /* the marker then names the file instead */ }
    const confirmed = argv.includes(RESET_FLAG);
    // the database address comes from the environment (decided), never from the settings file
    const database_url = process.env.GENESIS_DATABASE_URL || '';
    const database = database_url.length > 0;
    let pool = null;
    if (confirmed && database) {
        try {
            const pg = await import('../adapters/pg_stores.js');
            pool = await pg.createPgPool({ url: database_url });
        } catch { /* reported by runReset as a failed statement */ }
    }
    const outcome = await runReset({
        agents, memory_dir: DEFAULT_MEMORY_DIR, checkpoint_dir: planning.checkpoint_dir || DEFAULT_CHECKPOINT_DIR,
        ledger_file: planning.ledger_file || DEFAULT_LEDGER_FILE, manifest_file: planning.manifest_file || DEFAULT_MANIFEST_FILE,
        protect: [...profiles, settings_file, world_file, BLUEPRINT_DIR, './genesis', './src'], database,
    }, { confirmed, files: await resetFiles(), pool, seed, world_file });
    try { await pool?.end?.(); } catch { /* closing is best effort */ }
    for (const line of resetLines(outcome)) console.log(line);
    return outcome.plan.ok && (outcome.dry_run || outcome.ok) ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    main(process.argv.slice(2)).then((code) => process.exit(code), (err) => { console.error(err); process.exit(1); });
}
