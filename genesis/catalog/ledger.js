// Genesis: the chest ledger. What is known to be in each registered chest, from the last
// time an agent looked into it, put something in or took something out. fetch_items is
// offered from the ledger, so nobody walks to a chest on the off chance.
//
// There is ONE ledger for all agents. It is held in the MindServer process
// (genesis/catalog/shared_ledger.js); each agent process works on a copy of it that is kept
// in step over its socket (genesis/catalog/ledger_client.js). This file is the plain,
// in-memory form both are built on, and what the tests of the catalog use directly.
//
// It can be wrong (a player used the chest, an agent died on the way): a fetch that finds
// less than the ledger said corrects it, and a chest that was looked into always beats
// what was worked out by adding and subtracting.
//
// Reservations: an agent that sets out to fetch something reserves it, so that a second
// agent is not sent after the same items. What another agent has reserved is not available:
// asking for it gives a contested claim, never a silent failure.
//
// Interface (the copy in an agent process has the same one):
//   count(chest, item) -> number          stock(chest) -> { item: count }
//   known(chest) -> boolean                seen_at(chest) -> ms | null
//   set(chest, contents, now)              replaces what is known about a chest (after looking into it)
//   add(chest, item, n)   remove(chest, item, n)   zero(chest, item)
//   available(chest, item, agent) -> number           what `agent` may still take: the count less what others reserved
//   reserve(chest, item, count, agent, now) -> { ok: true, count } | { ok: false, code: 'empty' }
//                                           | { ok: false, code: 'contested', claim: { chest, item, count, holder, held, asker, in_chest } }
//   release(chest, item, agent)            reservations() -> [{ chest, item, count, holder, at, expires_at }]
//   snapshot() -> plain object             restore(snapshot)
// No imports.

export const RESERVATION_MS = 10 * 60 * 1000; // a reservation nobody released (a crash) lapses after this long

// The claim an agent is refused with: who holds what the asker wanted.
export function contestedClaim({ chest, item, count, asker, in_chest, held_by }) {
    const [holder, held] = [...held_by].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))[0];
    return { chest, item, count, holder, held, asker, in_chest };
}

export function createLedger({ reservation_ms = RESERVATION_MS } = {}) {
    const chests = new Map(); // name -> { items: Map(item -> count), seen_at }
    let reserved = [];        // { chest, item, count, holder, at, expires_at }

    const live = (now) => {
        if (Number.isFinite(now)) reserved = reserved.filter((entry) => !(entry.expires_at <= now));
        return reserved;
    };
    const countOf = (chest, item) => chests.get(chest)?.items.get(item) ?? 0;
    const heldByOthers = (chest, item, agent, now) => {
        const held_by = new Map();
        for (const entry of live(now)) {
            if (entry.chest !== chest || entry.item !== item || entry.holder === agent) continue;
            held_by.set(entry.holder, (held_by.get(entry.holder) ?? 0) + entry.count);
        }
        return held_by;
    };
    const sum = (held_by) => [...held_by.values()].reduce((total, n) => total + n, 0);

    function entry(chest) {
        if (!chests.has(chest)) chests.set(chest, { items: new Map(), seen_at: null });
        return chests.get(chest);
    }

    return {
        count: (chest, item) => chests.get(chest)?.items.get(item) ?? 0,
        stock: (chest) => Object.fromEntries(chests.get(chest)?.items ?? []),
        known: (chest) => chests.get(chest)?.seen_at != null, // looked into at least once
        seen_at: (chest) => chests.get(chest)?.seen_at ?? null,
        set(chest, contents, now = null) {
            const items = new Map();
            for (const [item, count] of Object.entries(contents ?? {})) {
                if (Number.isFinite(count) && count > 0) items.set(item, Math.floor(count));
            }
            chests.set(chest, { items, seen_at: now });
        },
        add(chest, item, n) {
            if (!(n > 0)) return;
            const slot = entry(chest);
            slot.items.set(item, (slot.items.get(item) ?? 0) + Math.floor(n));
        },
        remove(chest, item, n) {
            const slot = entry(chest);
            const left = (slot.items.get(item) ?? 0) - Math.floor(n);
            if (left > 0) slot.items.set(item, left); else slot.items.delete(item);
        },
        zero(chest, item) { chests.get(chest)?.items.delete(item); },
        available(chest, item, agent, now = null) {
            return Math.max(0, countOf(chest, item) - sum(heldByOthers(chest, item, agent, now)));
        },
        // Reserves up to `count` for `agent`. Asking again replaces the agent's earlier reservation of that item.
        reserve(chest, item, count, agent, now = null) {
            const in_chest = countOf(chest, item);
            const held_by = heldByOthers(chest, item, agent, now);
            const free = Math.max(0, in_chest - sum(held_by));
            if (free <= 0) {
                if (held_by.size === 0) return { ok: false, code: 'empty' };
                return { ok: false, code: 'contested', claim: contestedClaim({ chest, item, count, asker: agent, in_chest, held_by }) };
            }
            const granted = Math.min(Math.max(1, Math.floor(count)), free);
            reserved = reserved.filter((entry) => !(entry.chest === chest && entry.item === item && entry.holder === agent));
            reserved.push({ chest, item, count: granted, holder: agent, at: now, expires_at: Number.isFinite(now) ? now + reservation_ms : null });
            return { ok: true, count: granted };
        },
        release(chest, item, agent) {
            const before = reserved.length;
            reserved = reserved.filter((entry) => !(entry.chest === chest && entry.item === item && entry.holder === agent));
            return reserved.length < before;
        },
        releaseAll(agent) { reserved = reserved.filter((entry) => entry.holder !== agent); },
        reservations: (now = null) => live(now).map((entry) => ({ ...entry })),
        // Replaces every reservation (the copy in an agent process takes the MindServer's list).
        setReservations(list) {
            reserved = (Array.isArray(list) ? list : []).filter((entry) => entry && typeof entry === 'object' && Number.isFinite(entry.count) && entry.count > 0)
                .map((entry) => ({ chest: entry.chest, item: entry.item, count: Math.floor(entry.count), holder: entry.holder, at: entry.at ?? null, expires_at: entry.expires_at ?? null }));
        },
        snapshot() {
            const out = {};
            for (const [name, slot] of chests) out[name] = { items: Object.fromEntries(slot.items), seen_at: slot.seen_at };
            return out;
        },
        restore(snapshot) {
            chests.clear();
            for (const [name, slot] of Object.entries(snapshot ?? {})) {
                if (slot === null || typeof slot !== 'object') continue;
                const items = new Map();
                for (const [item, count] of Object.entries(slot.items ?? {})) {
                    if (Number.isFinite(count) && count > 0) items.set(item, Math.floor(count));
                }
                chests.set(name, { items, seen_at: Number.isFinite(slot.seen_at) ? slot.seen_at : null });
            }
        },
    };
}

// Reads what upstream's viewChest logged (src/agent/library/skills.js, viewChest, lines
// 946-973: "The chest is empty." or "The chest contains:" followed by "<count> <name>" lines).
// Returns { item: count }, or null when the text holds neither.
export function parseChestView(output) {
    const text = String(output ?? '');
    if (text.includes('The chest is empty.')) return {};
    const start = text.indexOf('The chest contains:');
    if (start < 0) return null;
    const contents = {};
    for (const line of text.slice(start).split('\n').slice(1)) {
        const match = /^\s*(\d+) ([a-z0-9_]+)\s*$/.exec(line);
        if (!match) continue;
        contents[match[2]] = (contents[match[2]] ?? 0) + Number(match[1]);
    }
    return contents;
}
