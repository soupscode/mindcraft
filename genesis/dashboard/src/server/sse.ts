// The one server-sent-events stream.
//
// Every event frame carries the stream id of its entry as the SSE id, so a browser that
// reconnects sends it back as Last-Event-ID and gets exactly what it missed: from the ring
// in memory when that reaches back far enough, else from Postgres. When neither can fill
// the gap (Postgres down, or the browser was away too long) it gets one snapshot instead,
// which replaces its state.

import { compareSid } from '../shared/fold.js';
import type { Entry } from '../shared/types.js';
import type { Store } from './ports.js';
import type { Frame, Live } from './live.js';

export const SID_PATTERN = /^\d{1,15}-\d{1,10}$/;
export const MAX_REPLAY = 3000;

const eventFrame = (entry: Entry): Frame => ({ kind: 'event', id: entry.sid, data: entry.event });

// The frames a connection gets first. `last_id` is the Last-Event-ID header (or null).
export async function resumeFrames(live: Live, store: Store, last_id: string | null, max_replay = MAX_REPLAY): Promise<Frame[]> {
    if (!last_id || !SID_PATTERN.test(last_id)) return [live.snapshot()];
    const cursor = live.state.cursor;
    // the browser is ahead of this process (it restarted with nothing, or the stream began anew)
    if (cursor === null || compareSid(last_id, cursor) > 0) return [live.snapshot()];
    const held = live.since(last_id);
    if (held !== null) return held.length <= max_replay ? held.map(eventFrame) : [live.snapshot()];
    try {
        const stored = await store.entriesAfter(last_id, max_replay + 1);
        if (stored.length > max_replay) return [live.snapshot()];
        // Postgres can be behind the live view (it was down a moment ago): the ring adds the rest,
        // but only when the two meet without a hole
        const ring = live.ring();
        const last_stored = stored.length > 0 ? stored[stored.length - 1].sid : last_id;
        if (ring.length > 0 && compareSid(last_stored, ring[0].sid) < 0) return [live.snapshot()];
        const rest = ring.filter((entry) => compareSid(entry.sid, last_stored) > 0);
        if (stored.length + rest.length > max_replay) return [live.snapshot()];
        return [...stored, ...rest].map(eventFrame);
    } catch {
        return [live.snapshot()];
    }
}

// One frame as SSE text.
export function encodeFrame(frame: Frame): string {
    const id = 'id' in frame && frame.id ? `id: ${frame.id}\n` : '';
    return `event: ${frame.kind}\n${id}data: ${JSON.stringify(frame.data)}\n\n`;
}

// Connects one client: first what it missed, then everything as it happens. `write` gets
// SSE text. Returns the function that ends the subscription.
export async function openStream(live: Live, store: Store, last_id: string | null, write: (text: string) => void): Promise<() => void> {
    const waiting: Frame[] = [];
    let ready = false;
    const unsubscribe = live.subscribe((frame) => { if (ready) write(encodeFrame(frame)); else waiting.push(frame); });
    try {
        const first = await resumeFrames(live, store, last_id);
        let last_sent: string | null = null;
        for (const frame of first) {
            write(encodeFrame(frame));
            if ((frame.kind === 'event' || frame.kind === 'snapshot') && frame.id) last_sent = frame.id;
        }
        // what happened while the first frames were put together (never twice, never out of order)
        for (const frame of waiting) {
            if (frame.kind === 'event' && last_sent !== null && compareSid(frame.id, last_sent) <= 0) continue;
            write(encodeFrame(frame));
        }
        waiting.length = 0;
        ready = true;
    } catch (err) {
        unsubscribe();
        throw err;
    }
    return unsubscribe;
}
