// Genesis: the ONE chest ledger, held in the MindServer process. Every agent process works
// on a copy (genesis/catalog/ledger_client.js) and sends what it saw and did here; this
// ledger decides what is true and tells every agent.
//
// The rule that decides: A CHEST THAT WAS LOOKED INTO ALWAYS BEATS ARITHMETIC. For each
// chest the ledger keeps the last observation (what an agent saw when it looked into the
// chest, and when) and, on top of it, only the puts and takes that happened AFTER that
// look. A put or take that is older than the newest observation is dropped: the observation
// already shows its result. An observation older than the one the ledger has is dropped too.
//
//   apply(agent, op) -> { chest } | null        op, as an agent sends it:
//       { kind: 'observe', chest, contents: { item: count }, at }
//       { kind: 'add' | 'remove', chest, item, n, at }      { kind: 'zero', chest, item, at }
//   reserve(agent, { chest, item, count }) -> as genesis/catalog/ledger.js reserve()
//   release(agent, { chest, item })   releaseAll(agent)
//   view(chest) -> { items, seen_at, seen_by }     reservations() -> [...]
//   snapshot() -> { v, chests: { name: view }, reservations }      what a copy is filled from
//   save() / restore(saved)                          what the ledger file holds (no reservations:
//                                                    they do not outlive the process)
//
// createLedgerFile() keeps the ledger in one file, written atomically a moment after a change.
// Depends only on genesis/catalog/ledger.js.

import { RESERVATION_MS, contestedClaim } from './ledger.js';

export const SHARED_LEDGER_VERSION = 1;
export const LEDGER_DEFAULTS = Object.freeze({
    reservation_ms: RESERVATION_MS,
    max_deltas: 200,        // puts and takes kept on top of an observation; older ones are folded into it
    save_delay_ms: 2000,    // how long after a change the file is written
});

const NAME = /^[A-Za-z0-9_-]{1,40}$/;
const ITEM = /^[a-z0-9_]{1,60}$/;

const cleanContents = (contents) => {
    const items = {};
    for (const [item, count] of Object.entries(contents ?? {})) {
        if (ITEM.test(item) && Number.isFinite(count) && count > 0) items[item] = Math.floor(count);
    }
    return items;
};

export function createSharedLedger({ clock = { now: Date.now }, onChange = () => {}, ...options } = {}) {
    const config = { ...LEDGER_DEFAULTS };
    for (const key of Object.keys(LEDGER_DEFAULTS)) if (options[key] !== undefined) config[key] = options[key];
    const chests = new Map(); // name -> { base: { item: count }, seen_at, seen_by, deltas: [{ kind, item, n, at, by }] }
    let reserved = [];        // { chest, item, count, holder, at, expires_at }
    const stats = { observations: 0, stale_observations: 0, arithmetic: 0, arithmetic_overruled: 0, refused_ops: 0, reservations: 0, contested: 0 };

    const entry = (chest) => {
        if (!chests.has(chest)) chests.set(chest, { base: {}, seen_at: null, seen_by: null, deltas: [] });
        return chests.get(chest);
    };
    const step = (items, delta) => {
        if (delta.kind === 'zero') delete items[delta.item];
        else {
            const left = (items[delta.item] ?? 0) + (delta.kind === 'add' ? delta.n : -delta.n);
            if (left > 0) items[delta.item] = left; else delete items[delta.item];
        }
    };
    function itemsOf(chest) {
        const slot = chests.get(chest);
        if (!slot) return {};
        const items = { ...slot.base };
        for (const delta of slot.deltas) step(items, delta);
        return items;
    }
    const live = () => {
        const now = clock.now();
        reserved = reserved.filter((held) => !(held.expires_at <= now));
        return reserved;
    };
    const changed = (chest) => { try { onChange(chest); } catch { /* the listener's problem */ } };

    const ledger = {
        // Takes in what an agent saw or did. Returns { chest } when the ledger changed, else null.
        apply(agent, op) {
            if (op === null || typeof op !== 'object' || !NAME.test(String(op.chest ?? ''))) { stats.refused_ops++; return null; }
            const at = Number.isFinite(op.at) ? op.at : clock.now();
            if (op.kind === 'observe') {
                const slot = entry(op.chest);
                if (slot.seen_at !== null && at < slot.seen_at) { stats.stale_observations++; return null; }
                stats.observations++;
                slot.base = cleanContents(op.contents);
                slot.seen_at = at;
                slot.seen_by = agent;
                slot.deltas = slot.deltas.filter((delta) => delta.at >= at); // what happened after this look still counts
                changed(op.chest);
                return { chest: op.chest };
            }
            if (!['add', 'remove', 'zero'].includes(op.kind) || !ITEM.test(String(op.item ?? ''))) { stats.refused_ops++; return null; }
            const n = op.kind === 'zero' ? 0 : Math.floor(Number(op.n));
            if (op.kind !== 'zero' && !(n > 0)) { stats.refused_ops++; return null; }
            const slot = entry(op.chest);
            if (slot.seen_at !== null && at < slot.seen_at) { stats.arithmetic_overruled++; return null; } // the look already shows it
            stats.arithmetic++;
            slot.deltas.push({ kind: op.kind, item: op.item, n, at, by: agent });
            slot.deltas.sort((a, b) => a.at - b.at);
            while (slot.deltas.length > config.max_deltas) step(slot.base, slot.deltas.shift());
            changed(op.chest);
            return { chest: op.chest };
        },
        reserve(agent, { chest, item, count } = {}) {
            if (!NAME.test(String(chest ?? '')) || !ITEM.test(String(item ?? '')) || !(Number(count) > 0)) { stats.refused_ops++; return { ok: false, code: 'bad_request' }; }
            const in_chest = itemsOf(chest)[item] ?? 0;
            const held_by = new Map();
            for (const held of live()) {
                if (held.chest === chest && held.item === item && held.holder !== agent) held_by.set(held.holder, (held_by.get(held.holder) ?? 0) + held.count);
            }
            const free = Math.max(0, in_chest - [...held_by.values()].reduce((total, n) => total + n, 0));
            if (free <= 0) {
                if (held_by.size === 0) return { ok: false, code: 'empty' };
                stats.contested++;
                return { ok: false, code: 'contested', claim: contestedClaim({ chest, item, count: Math.floor(count), asker: agent, in_chest, held_by }) };
            }
            const now = clock.now();
            const granted = Math.min(Math.max(1, Math.floor(count)), free);
            reserved = reserved.filter((held) => !(held.chest === chest && held.item === item && held.holder === agent));
            reserved.push({ chest, item, count: granted, holder: agent, at: now, expires_at: now + config.reservation_ms });
            stats.reservations++;
            return { ok: true, count: granted };
        },
        release(agent, { chest, item } = {}) {
            const before = reserved.length;
            reserved = reserved.filter((held) => !(held.chest === chest && held.item === item && held.holder === agent));
            return reserved.length < before;
        },
        releaseAll(agent) {
            const before = reserved.length;
            reserved = reserved.filter((held) => held.holder !== agent);
            return reserved.length < before;
        },
        view(chest) {
            const slot = chests.get(chest);
            return { items: itemsOf(chest), seen_at: slot?.seen_at ?? null, seen_by: slot?.seen_by ?? null };
        },
        reservations: () => live().map((held) => ({ ...held })),
        snapshot() {
            const out = {};
            for (const name of chests.keys()) out[name] = ledger.view(name);
            return { v: SHARED_LEDGER_VERSION, chests: out, reservations: ledger.reservations() };
        },
        // What the ledger file holds: every chest with its last observation and what came after it.
        save() {
            const out = {};
            for (const [name, slot] of chests) out[name] = { base: { ...slot.base }, seen_at: slot.seen_at, seen_by: slot.seen_by, deltas: slot.deltas.map((delta) => ({ ...delta })) };
            return { v: SHARED_LEDGER_VERSION, chests: out };
        },
        // Takes back what save() gave. Anything that does not look like it is left out. Returns how many chests were taken.
        restore(saved) {
            chests.clear();
            reserved = [];
            if (saved?.v !== SHARED_LEDGER_VERSION || saved.chests === null || typeof saved.chests !== 'object') return 0;
            for (const [name, slot] of Object.entries(saved.chests)) {
                if (!NAME.test(name) || slot === null || typeof slot !== 'object') continue;
                const deltas = (Array.isArray(slot.deltas) ? slot.deltas : [])
                    .filter((delta) => delta && ['add', 'remove', 'zero'].includes(delta.kind) && ITEM.test(String(delta.item ?? '')) && Number.isFinite(delta.at))
                    .map((delta) => ({ kind: delta.kind, item: delta.item, n: Math.max(0, Math.floor(Number(delta.n) || 0)), at: delta.at, by: delta.by ?? null }));
                chests.set(name, {
                    base: cleanContents(slot.base), seen_at: Number.isFinite(slot.seen_at) ? slot.seen_at : null,
                    seen_by: typeof slot.seen_by === 'string' ? slot.seen_by : null, deltas,
                });
            }
            return chests.size;
        },
        stats: () => ({ ...stats, chests: chests.size, reserved: live().length }),
    };
    return ledger;
}

// Keeps the shared ledger in one file. The file is written atomically (to .tmp, then renamed)
// a moment after the ledger changed; a file that is missing or damaged starts an empty ledger,
// which fills again as the agents look into the chests.
//   files   { read, write, rename, remove }   (genesis/store/node_files.js)
export function createLedgerFile({ ledger, files, file, clock = { setTimeout, clearTimeout }, delay_ms = LEDGER_DEFAULTS.save_delay_ms, warn = () => {} } = {}) {
    const stats = { loaded: 0, saved: 0, save_failures: 0, damaged: 0 };
    let timer = null;
    let writing = null;

    async function writeNow() {
        try {
            const text = `${JSON.stringify(ledger.save())}\n`;
            await files.write(`${file}.tmp`, text);
            await files.rename(`${file}.tmp`, file);
            stats.saved++;
            return true;
        } catch (err) {
            stats.save_failures++;
            warn(`chest ledger: not written (${err?.message ?? err})`);
            return false;
        }
    }

    return {
        // Reads the file into the ledger. Never throws. Resolves to how many chests it held.
        async load() {
            let text = null;
            try { text = await files.read(file); } catch (err) { warn(`chest ledger: cannot be read (${err?.message ?? err}), starting empty`); }
            if (text === null) return 0;
            try {
                stats.loaded = ledger.restore(JSON.parse(text));
            } catch (err) {
                stats.damaged++;
                warn(`chest ledger: the file is damaged (${err?.message ?? err}), starting empty`);
                ledger.restore(null);
            }
            return stats.loaded;
        },
        // Call when the ledger changed.
        schedule() {
            if (timer !== null) return;
            timer = clock.setTimeout(() => {
                timer = null;
                writing = (writing ?? Promise.resolve()).then(writeNow);
            }, delay_ms);
            timer?.unref?.();
        },
        // Writes now what is still waiting (for shutdown and for tests).
        async flush() {
            if (timer !== null) { clock.clearTimeout(timer); timer = null; writing = (writing ?? Promise.resolve()).then(writeNow); }
            await writing;
        },
        stop() { if (timer !== null) { clock.clearTimeout(timer); timer = null; } },
        stats: () => ({ ...stats }),
    };
}
