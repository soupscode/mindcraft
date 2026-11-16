// The real Redis client behind the ingest (node-redis 4).
//
// The unit tests use the in-memory stream of test/fakes.ts instead; this file was checked
// by hand against a local redis-server (see README.md).
//
// A Redis that is down never holds anything up: commands fail at once instead of queueing
// (disableOfflineQueue) and connection errors are swallowed here; the ingest reports Redis
// going down and coming back.

import type { StreamClient, StreamEntry } from './ports.js';

export async function createRedisStream({ url, connect_timeout_ms = 5000, max_reconnect_ms = 5000 }: {
    url: string; connect_timeout_ms?: number; max_reconnect_ms?: number;
}): Promise<StreamClient> {
    const redis: any = await import('redis');
    const client = redis.createClient({
        url,
        disableOfflineQueue: true,
        socket: { connectTimeout: connect_timeout_ms, reconnectStrategy: (retries: number) => Math.min(250 * (retries + 1), max_reconnect_ms) },
    });
    client.on('error', () => { /* reported by the ingest */ });
    // waits for the first connection, but never longer than the connect timeout: a Redis that is
    // down must not hold the start up (the client keeps retrying through reconnectStrategy)
    await Promise.race([
        client.connect().catch(() => {}),
        new Promise<void>((resolve) => { setTimeout(resolve, connect_timeout_ms).unref(); }),
    ]);

    const toEntry = (message: any): StreamEntry => ({ id: String(message.id), fields: message.message ? { ...message.message } : null });

    return {
        async ping() { await client.ping(); },
        async ensureGroup(stream, group) {
            try {
                await client.xGroupCreate(stream, group, '0', { MKSTREAM: true });
            } catch (err: any) {
                if (!String(err?.message ?? err).includes('BUSYGROUP')) throw err;
            }
        },
        async readGroup(stream, group, consumer, { from, count, block_ms }) {
            const options: Record<string, number> = { COUNT: count };
            if (from === '>' && block_ms !== undefined && block_ms > 0) options.BLOCK = block_ms;
            const answer = await client.xReadGroup(group, consumer, { key: stream, id: from }, options);
            if (!answer || answer.length === 0) return [];
            return (answer[0].messages ?? []).map(toEntry);
        },
        async ack(stream, group, ids) {
            if (ids.length > 0) await client.xAck(stream, group, ids);
        },
        async tail(stream, count) {
            const messages = await client.xRevRange(stream, '+', '-', { COUNT: count });
            return (messages ?? []).map(toEntry).reverse();
        },
        async close() {
            try { await client.disconnect(); } catch { /* was not connected */ }
        },
    };
}
