// Genesis: the chest ledger. What an agent knows is in each registered chest, from the
// last time it looked into it, put something in or took something out. fetch_items is
// offered from the ledger, so nobody walks to a chest on the off chance.
//
// The ledger is kept per agent, in memory, and saved with the checkpoint. It can be wrong
// (another agent or a player used the chest): a fetch that finds less than the ledger said
// corrects it.
//
// Interface (the tests use this same implementation):
//   count(chest, item) -> number          stock(chest) -> { item: count }
//   known(chest) -> boolean                seen_at(chest) -> ms | null
//   set(chest, contents, now)              replaces what is known about a chest (after looking into it)
//   add(chest, item, n)   remove(chest, item, n)   zero(chest, item)
//   snapshot() -> plain object             restore(snapshot)
// No imports.

export function createLedger() {
    const chests = new Map(); // name -> { items: Map(item -> count), seen_at }

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
