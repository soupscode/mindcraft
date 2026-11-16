// Genesis: the real Redis client behind the event hub (genesis/events/hub.js).
//
// NOT COVERED BY THE TESTS: the test suite runs without node_modules and without a Redis
// server, and uses an in-memory fake with the same one-method interface instead.
// Needs the "redis" package (node-redis 4 or newer), which is not in package.json.
//
// Interface handed to the hub:
//   xadd(stream, fields, { maxlen }) -> Promise   XADD <stream> MAXLEN ~ <maxlen> * field value ...
//   close() -> Promise
//
// Built so that a Redis that is down can never hold anything up:
//   - commands are not queued while disconnected (disableOfflineQueue), they fail at once
//     and the hub keeps the event in its own bounded buffer;
//   - connection errors are swallowed here (an unhandled "error" event would end the process);
//   - a missing "redis" package gives a client that fails every write, with one log line.

function logLine(record) {
    console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'error', ...record }));
}

export async function createRedisStreamClient({ url, connect_timeout_ms = 5000, max_reconnect_ms = 10000 } = {}) {
    let redis;
    try {
        redis = await import('redis');
    } catch (err) {
        const message = `the "redis" package is not installed (${err?.code ?? err?.message ?? err})`;
        logLine({ event: 'genesis_events_redis_unusable', message });
        return {
            xadd: async () => { throw new Error(message); },
            close: async () => {},
        };
    }

    const client = redis.createClient({
        url,
        disableOfflineQueue: true,
        socket: {
            connectTimeout: connect_timeout_ms,
            reconnectStrategy: (retries) => Math.min(500 * (retries + 1), max_reconnect_ms),
        },
    });
    client.on('error', () => { /* the hub reports Redis going down and coming back */ });
    client.connect().catch(() => { /* keeps retrying through reconnectStrategy */ });

    return {
        xadd(stream, fields, { maxlen } = {}) {
            const options = Number.isInteger(maxlen) && maxlen > 0
                ? { TRIM: { strategy: 'MAXLEN', strategyModifier: '~', threshold: maxlen } }
                : undefined;
            return client.xAdd(stream, '*', fields, options);
        },
        // Drops the connection without waiting: quit() never answers while Redis is unreachable.
        async close() {
            try {
                if (typeof client.destroy === 'function') client.destroy(); // node-redis 5 and newer
                else await client.disconnect();                             // node-redis 4
            } catch { /* was not connected */ }
        },
    };
}
