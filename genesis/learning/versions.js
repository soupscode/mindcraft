// Genesis learning: the network's weights as versioned files, written the way checkpoints
// are (genesis/store/checkpoint.js): the text goes to <file>.tmp, is read back, and only then
// renamed over <file>. Whatever dies on the way, the previous version stays loadable.
//
//   <dir>/net-v000041.json   { v, feature_version, arch, created_at, examples, parent, metrics, sha256, weights }
//                            sha256 is the hash of the weights' JSON text: a damaged file is
//                            told from a good one even when the damage leaves valid JSON behind
//   <dir>/current.json       { v, versions: [{ v, created_at, examples, state }] }   the pointer and the list
//
// Kept: the newest `keep` versions (30) and the last one of every day.
//
// Injected: files { write(path, text), rename(from, to), read(path) -> text | null, remove(path) }
//           (genesis/store/node_files.js is the real one; memoryFiles() below is for tests).
// Depends only on Node built-ins.

import { createHash } from 'node:crypto';

export const WEIGHTS_DIR = './bots/genesis_learning/weights';
export const KEEP_VERSIONS = 30;

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
export const versionFile = (dir, v) => `${dir}/net-v${String(v).padStart(6, '0')}.json`;
const pointerFile = (dir) => `${dir}/current.json`;
const dayOf = (time) => new Date(time).toISOString().slice(0, 10);

// Files in memory, with the same interface as nodeFiles(). fail(fn) makes the next matching
// call throw: fail((op, path) => op === 'rename') is "killed before the rename".
export function memoryFiles() {
    const files = new Map();
    let failing = null;
    const guard = (op, file) => { if (failing?.(op, file)) throw new Error(`${op} failed: ${file}`); };
    return {
        async write(file, text) { guard('write', file); files.set(file, String(text)); },
        async rename(from, to) {
            guard('rename', to);
            if (!files.has(from)) throw new Error(`no such file: ${from}`);
            files.set(to, files.get(from));
            files.delete(from);
        },
        async read(file) { guard('read', file); return files.has(file) ? files.get(file) : null; },
        async remove(file) { files.delete(file); },
        fail(fn) { failing = fn; },
        names: () => [...files.keys()].sort(),
        corrupt(file, text) { files.set(file, text); },
    };
}

export function createVersionStore({ files, dir = WEIGHTS_DIR, keep = KEEP_VERSIONS, report = () => {} } = {}) {
    if (!files) throw new Error('the version store needs files');

    async function writeAtomic(file, text) {
        const tmp = `${file}.tmp`;
        await files.write(tmp, text);
        if (await files.read(tmp) !== text) throw new Error(`${tmp} did not read back as written`);
        await files.rename(tmp, file);
    }

    async function pointer() {
        try {
            const parsed = JSON.parse(await files.read(pointerFile(dir)) ?? 'null');
            if (Number.isInteger(parsed?.v) && Array.isArray(parsed.versions)) return parsed;
        } catch { /* a damaged pointer: fall through */ }
        return null;
    }

    // The version, or null when the file is missing or damaged (reported, never thrown).
    async function load(v) {
        let text;
        try { text = await files.read(versionFile(dir, v)); } catch (err) { report({ kind: 'version_unreadable', v, error: String(err?.message ?? err) }); return null; }
        if (text === null) return null;
        try {
            const record = JSON.parse(text);
            if (record?.v !== v || sha256(JSON.stringify(record.weights)) !== record.sha256) throw new Error('hash mismatch');
            return record;
        } catch (err) {
            report({ kind: 'version_corrupt', v, error: String(err?.message ?? err) });
            return null;
        }
    }

    return {
        load,
        // Writes the version file, then moves the pointer. A failure in between leaves the
        // pointer on the previous version, which is still there.
        async save({ v, feature_version, arch, created_at, examples, parent = null, metrics = {}, weights, state = 'in_use' }) {
            const record = { v, feature_version, arch, created_at, examples, parent, metrics, sha256: sha256(JSON.stringify(weights)), weights };
            await writeAtomic(versionFile(dir, v), JSON.stringify(record));
            const before = await pointer();
            const versions = [...(before?.versions ?? []).filter((entry) => entry.v !== v), { v, created_at, examples, state }].sort((a, b) => a.v - b.v);
            // the newest `keep`, and the last version of each day
            const last_of_day = new Map();
            for (const entry of versions) last_of_day.set(dayOf(entry.created_at), entry.v);
            const kept = versions.filter((entry, i) => i >= versions.length - keep || last_of_day.get(dayOf(entry.created_at)) === entry.v);
            await writeAtomic(pointerFile(dir), JSON.stringify({ v, versions: kept }));
            for (const entry of versions) if (!kept.includes(entry)) await files.remove(versionFile(dir, entry.v));
            return record;
        },
        // Moves the pointer to a version that exists (a rollback). False when it cannot be loaded.
        async point(v) {
            if (await load(v) === null) return false;
            const before = await pointer();
            await writeAtomic(pointerFile(dir), JSON.stringify({ v, versions: before?.versions ?? [] }));
            return true;
        },
        // The version to use: the one the pointer names, else the newest that loads.
        async current() {
            const at = await pointer();
            if (at) {
                const record = await load(at.v);
                if (record) return record;
                for (const entry of [...at.versions].sort((a, b) => b.v - a.v)) {
                    const older = entry.v === at.v ? null : await load(entry.v);
                    if (older) return older;
                }
            }
            return null;
        },
        async list() { return (await pointer())?.versions ?? []; },
    };
}
