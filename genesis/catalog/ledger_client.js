// Genesis: an agent process's copy of the shared chest ledger. The ledger itself is held in
// the MindServer process (genesis/catalog/shared_ledger.js); the skill templates read their
// agent's copy, with the same interface as genesis/catalog/ledger.js, so nothing ever waits
// for the socket.
//
//   - what the agent sees and does is applied to the copy at once and sent to the MindServer
//       genesis-ledger-op       { agent, op }                 op: observe | add | remove | zero (shared_ledger.js)
//       genesis-ledger-reserve  ({ agent, chest, item, count }, ack)   ack({ ok, count | code, claim, reservations })
//       genesis-ledger-release  { agent, chest, item }
//       genesis-ledger-sync     (agent, ack)                  ack({ ok, ledger: snapshot })
//   - whatever the MindServer decides comes back to every agent and replaces the copy
//       genesis-ledger-update   { chests: { name: { items, seen_at, seen_by } }, reservations }   onUpdate
//
// A reservation is granted by the copy first (so a step never waits) and confirmed by the
// MindServer; when the MindServer says another agent was first, the copy drops it, takes the
// MindServer's list, and `onLost(claim)` is told. The next guard of the step then fails
// with a contested claim.
//
// Not connected: the copy keeps working on what it knows, and takes the MindServer's state
// again with the next sync().
//
// Injected: send(event, ...args) (the agent's socket), clock.
// Depends only on genesis/catalog/ledger.js.

import { createLedger } from './ledger.js';

export function createLedgerClient({ agent, send, clock = { now: Date.now }, onLost = () => {}, sync_timeout_ms = 5000 } = {}) {
    const local = createLedger();
    const stats = { ops_sent: 0, send_failed: 0, updates: 0, syncs: 0, reservations_lost: 0 };

    const tell = (event, ...args) => {
        try { send(event, ...args); stats.ops_sent++; return true; } catch { stats.send_failed++; return false; }
    };
    const now = () => clock.now();

    function takeChests(chests) {
        for (const [name, view] of Object.entries(chests ?? {})) {
            if (view === null || typeof view !== 'object') continue;
            local.set(name, view.items ?? {}, Number.isFinite(view.seen_at) ? view.seen_at : null);
        }
    }

    return {
        count: local.count,
        stock: local.stock,
        known: local.known,
        seen_at: local.seen_at,
        available: (chest, item, who = agent) => local.available(chest, item, who, now()),
        reservations: () => local.reservations(now()),
        // The agent looked into a chest: this is what is in it.
        set(chest, contents, seen = now()) {
            const at = Number.isFinite(seen) ? seen : now();
            local.set(chest, contents, at);
            tell('genesis-ledger-op', { agent, op: { kind: 'observe', chest, contents: local.stock(chest), at } });
        },
        add(chest, item, n) {
            if (!(n > 0)) return;
            local.add(chest, item, n);
            tell('genesis-ledger-op', { agent, op: { kind: 'add', chest, item, n: Math.floor(n), at: now() } });
        },
        remove(chest, item, n) {
            if (!(n > 0)) return;
            local.remove(chest, item, n);
            tell('genesis-ledger-op', { agent, op: { kind: 'remove', chest, item, n: Math.floor(n), at: now() } });
        },
        zero(chest, item) {
            local.zero(chest, item);
            tell('genesis-ledger-op', { agent, op: { kind: 'zero', chest, item, at: now() } });
        },
        reserve(chest, item, count, who = agent) {
            const mine = local.reserve(chest, item, count, who, now());
            if (!mine.ok) return mine;
            tell('genesis-ledger-reserve', { agent, chest, item, count: mine.count }, (answer) => {
                if (Array.isArray(answer?.reservations)) local.setReservations(answer.reservations);
                if (answer?.ok === false) {
                    // another agent was first: the MindServer's word counts
                    local.release(chest, item, who);
                    if (answer.code === 'contested') {
                        stats.reservations_lost++;
                        try { onLost(answer.claim); } catch { /* the listener's problem */ }
                    }
                }
            });
            return mine;
        },
        release(chest, item, who = agent) {
            if (local.release(chest, item, who)) tell('genesis-ledger-release', { agent, chest, item });
        },
        // ---- what arrives over the socket ----
        onUpdate(message) {
            stats.updates++;
            takeChests(message?.chests);
            if (Array.isArray(message?.reservations)) local.setReservations(message.reservations);
        },
        // Takes the whole ledger from the MindServer. Resolves to true when it came. Never rejects.
        sync() {
            return new Promise((resolve) => {
                let settled = false;
                const finish = (value) => { if (!settled) { settled = true; clock.clearTimeout?.(timer); resolve(value); } };
                const timer = clock.setTimeout ? clock.setTimeout(() => finish(false), sync_timeout_ms) : null;
                const asked = tell('genesis-ledger-sync', agent, (answer) => {
                    if (answer?.ok && answer.ledger) {
                        stats.syncs++;
                        local.restore({});
                        takeChests(answer.ledger.chests);
                        local.setReservations(answer.ledger.reservations);
                        finish(true);
                    } else finish(false);
                });
                if (!asked) finish(false);
            });
        },
        // The checkpoint no longer carries the ledger: these are here for the interface only.
        snapshot: () => local.snapshot(),
        restore() {},
        stats: () => ({ ...stats }),
    };
}
