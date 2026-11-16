// The live view: the folded state, a bounded ring of the newest entries (for SSE replay)
// and the subscribers of the one SSE stream. Lives in memory only, so it keeps serving
// when Postgres is down.

import { applyEntry, compareSid, emptyState } from '../shared/fold.js';
import type { Entry, Health, LiveState, ProcessStatus } from '../shared/types.js';

export type Frame =
    | { kind: 'snapshot'; id: string | null; data: { state: LiveState; health: Health; processes: ProcessStatus[] | null } }
    | { kind: 'event'; id: string; data: Entry['event'] }
    | { kind: 'health'; data: Health }
    | { kind: 'processes'; data: ProcessStatus[] | null }
    | { kind: 'control'; data: Record<string, any> };

export interface Live {
    state: LiveState;
    health: Health;
    processes: ProcessStatus[] | null;
    apply(entry: Entry): boolean;
    warm(entries: Entry[]): number;
    since(sid: string): Entry[] | null;
    ring(): Entry[];
    snapshot(): Frame;
    subscribe(listener: (frame: Frame) => void): () => void;
    setHealth(patch: Partial<Health>): void;
    setProcesses(list: ProcessStatus[] | null): void;
    publish(frame: Frame): void;
    subscribers(): number;
}

export function createLive({ roster = [], ring_size = 2000 }: { roster?: readonly string[]; ring_size?: number } = {}): Live {
    const state = emptyState(roster);
    const ring: Entry[] = [];
    const listeners = new Set<(frame: Frame) => void>();
    const health: Health = {
        redis_ok: null, postgres_ok: null, redis_down_since: null, postgres_down_since: null,
        mindserver_ok: null, ingested: 0, rejected: 0, unstored: 0,
    };

    function publish(frame: Frame) {
        for (const listener of [...listeners]) {
            try { listener(frame); } catch { /* one broken connection must not stop the others */ }
        }
    }

    const held_ids = new Set<string>(); // the event ids of the ring

    function take(entry: Entry): boolean {
        // the hub may write one event twice (same event id, two stream ids): it counts once
        if (held_ids.has(entry.event.id)) {
            if (state.cursor === null || compareSid(entry.sid, state.cursor) > 0) state.cursor = entry.sid;
            return false;
        }
        if (!applyEntry(state, entry)) return false;
        ring.push(entry);
        held_ids.add(entry.event.id);
        while (ring.length > ring_size) held_ids.delete(ring.shift()!.event.id);
        return true;
    }

    const live: Live = {
        state, health, processes: null,
        // One entry from the stream. False when it was already applied.
        apply(entry) {
            if (!take(entry)) return false;
            publish({ kind: 'event', id: entry.sid, data: entry.event });
            return true;
        },
        // History loaded at start: folded and kept for replay, told to nobody.
        warm(entries) {
            let taken = 0;
            for (const entry of entries) if (take(entry)) taken++;
            return taken;
        },
        // The entries after `sid`, or null when the ring does not reach back that far.
        since(sid) {
            if (state.cursor !== null && compareSid(sid, state.cursor) >= 0) return [];
            if (ring.length === 0 || compareSid(sid, ring[0].sid) < 0) return null;
            return ring.filter((entry) => compareSid(entry.sid, sid) > 0);
        },
        ring: () => [...ring],
        snapshot() {
            return { kind: 'snapshot', id: state.cursor, data: JSON.parse(JSON.stringify({ state, health, processes: live.processes })) };
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        setHealth(patch) {
            let changed = false;
            for (const [key, value] of Object.entries(patch) as [keyof Health, any][]) {
                if (health[key] !== value) { (health as any)[key] = value; changed = true; }
            }
            if (changed) publish({ kind: 'health', data: { ...health } });
        },
        setProcesses(list) {
            if (JSON.stringify(list) === JSON.stringify(live.processes)) return;
            live.processes = list;
            publish({ kind: 'processes', data: list });
        },
        publish,
        subscribers: () => listeners.size,
    };
    return live;
}
