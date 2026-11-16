// Reads the event stream through the alerter's own consumer group and hands every valid
// event to the handlers, oldest first. An entry is acknowledged once it has been handled;
// one that was read before a crash is read again at the next start (the rules never ping
// twice for the same problem, so that is safe).

import type { GenesisEvent, StreamClient, StreamEntry } from './ports.js';

export interface ReaderConfig { stream: string; group: string; consumer: string; batch: number; block_ms: number }
export const READER_DEFAULTS: ReaderConfig = Object.freeze({ stream: 'genesis:events', group: 'alerter', consumer: 'alerter-1', batch: 200, block_ms: 2000 });

export function createReader({ stream, validate, onEvent, config: overrides = {} }: {
    stream: StreamClient; validate: (event: unknown) => { ok: boolean }; onEvent: (event: GenesisEvent) => Promise<void>; config?: Partial<ReaderConfig>;
}) {
    const config = { ...READER_DEFAULTS, ...overrides };
    const stats = { read: 0, handled: 0, rejected: 0, failed: 0 };
    let group_ready = false;
    let pending_checked = false;
    let stopped = false;

    async function take(batch: StreamEntry[]) {
        for (const raw of batch) {
            stats.read++;
            let event: unknown = null;
            try { event = typeof raw.fields?.event === 'string' ? JSON.parse(raw.fields.event) : null; } catch { event = null; }
            if (event === null || !validate(event).ok) { stats.rejected++; continue; }
            try { await onEvent(event as GenesisEvent); stats.handled++; } catch { stats.failed++; }
        }
        if (batch.length > 0) await stream.ack(config.stream, config.group, batch.map((raw) => raw.id));
    }

    // One round. Rejects when Redis cannot be reached.
    async function step({ block_ms = config.block_ms }: { block_ms?: number } = {}): Promise<number> {
        try {
            if (!group_ready) { await stream.ensureGroup(config.stream, config.group); group_ready = true; }
            let count = 0;
            if (!pending_checked) {
                let from = '0';
                for (;;) {
                    const old = await stream.readGroup(config.stream, config.group, config.consumer, { from, count: config.batch });
                    if (old.length === 0) break;
                    await take(old);
                    count += old.length;
                    from = old[old.length - 1].id;
                }
                pending_checked = true;
            }
            const fresh = await stream.readGroup(config.stream, config.group, config.consumer, { from: '>', count: config.batch, block_ms });
            await take(fresh);
            return count + fresh.length;
        } catch (err) {
            group_ready = false; // a Redis that came back empty has no group
            throw err;
        }
    }

    async function run({ retry_ms = 1000, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) } = {}) {
        while (!stopped) {
            try { await step(); } catch { if (!stopped) await sleep(retry_ms); }
        }
    }
    return { step, run, stats: () => ({ ...stats }), stop() { stopped = true; } };
}
