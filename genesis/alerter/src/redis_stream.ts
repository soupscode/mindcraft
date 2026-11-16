// The real Redis client of the alerter (node-redis 4): its own consumer group on the one
// event stream, and the "pinged" marks.
//
// The unit tests use the in-memory stream of test/fakes.ts instead.
// Commands fail at once while Redis is down (disableOfflineQueue); the alerter notices
// through its own ping and, after 60 seconds, says so on the phone.

import type { StreamClient, StreamEntry } from './ports.js';

export async function createRedisStream({ url, connect_timeout_ms = 5000, max_reconnect_ms = 5000 }: {
    url: string; connect_timeout_ms?: number; max_reconnect_ms?: number;
}): Promise<StreamClient> {
    const redis: any = await import('redis');
    const options = {
        url, disableOfflineQueue: true,
        socket: { connectTimeout: connect_timeout_ms, reconnectStrategy: (retries: number) => Math.min(250 * (retries + 1), max_reconnect_ms) },
    };
    // two connections: the blocking read must not hold up the ping and the marks
    const reader = redis.createClient(options);
    const client = redis.createClient(options);
    for (const each of [reader, client]) each.on('error', () => { /* seen through ping() */ });
    // waits for the first connection, but never longer than the connect timeout: a Redis that is
    // down must not hold the start up (the clients keep retrying through reconnectStrategy)
    await Promise.race([
        Promise.all([reader.connect().catch(() => {}), client.connect().catch(() => {})]),
        new Promise<void>((resolve) => { setTimeout(resolve, connect_timeout_ms).unref(); }),
    ]);
    const toEntry = (message: any): StreamEntry => ({ id: String(message.id), fields: message.message ? { ...message.message } : null });

    return {
        async ping() { await client.ping(); },
        async ensureGroup(stream, group) {
            try { await client.xGroupCreate(stream, group, '0', { MKSTREAM: true }); } catch (err: any) {
                if (!String(err?.message ?? err).includes('BUSYGROUP')) throw err;
            }
        },
        async readGroup(stream, group, consumer, { from, count, block_ms }) {
            const read_options: Record<string, number> = { COUNT: count };
            if (from === '>' && block_ms !== undefined && block_ms > 0) read_options.BLOCK = block_ms;
            const answer = await reader.xReadGroup(group, consumer, { key: stream, id: from }, read_options);
            if (!answer || answer.length === 0) return [];
            return (answer[0].messages ?? []).map(toEntry);
        },
        async ack(stream, group, ids) { if (ids.length > 0) await client.xAck(stream, group, ids); },
        async claim(key, ttl_s) { return (await client.set(key, '1', { NX: true, EX: ttl_s })) === 'OK'; },
        async close() {
            for (const each of [reader, client]) { try { await each.disconnect(); } catch { /* was not connected */ } }
        },
    };
}
