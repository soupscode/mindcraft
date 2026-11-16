// Genesis: the real files behind the checkpoint store (genesis/store/checkpoint.js).
// Node built-ins only.
//
//   write(path, text)  writes the whole file and flushes it to the disk before returning
//   rename(from, to)   replaces `to` with `from` in one step (rename(2)), then flushes the folder
//   read(path)         the file's text, or null when there is no such file
//   remove(path)       removes the file; no error when it is not there

import { open, rename, readFile, unlink, mkdir } from 'node:fs/promises';
import path from 'node:path';

export function nodeFiles() {
    return {
        async write(file, text) {
            await mkdir(path.dirname(file), { recursive: true });
            const handle = await open(file, 'w');
            try {
                await handle.writeFile(text, 'utf8');
                await handle.sync();
            } finally {
                await handle.close();
            }
        },
        async rename(from, to) {
            await rename(from, to);
            try { // make the new name itself survive a power cut; not every file system allows this
                const dir = await open(path.dirname(to), 'r');
                try { await dir.sync(); } finally { await dir.close(); }
            } catch { /* the rename has happened either way */ }
        },
        async read(file) {
            try {
                return await readFile(file, 'utf8');
            } catch (err) {
                if (err?.code === 'ENOENT') return null;
                throw err;
            }
        },
        async remove(file) {
            try {
                await unlink(file);
            } catch (err) {
                if (err?.code !== 'ENOENT') throw err;
            }
        },
    };
}
