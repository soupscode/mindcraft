// Genesis: the one publisher of events. Runs inside the MindServer process.
// Agent processes hand their events to the MindServer over their socket; the hub checks
// each one, keeps it in a bounded buffer and writes it to a capped Redis stream.
//
// Redis is reached only through the injected `client`:
//   client.xadd(stream, fields, { maxlen }) -> Promise
//     appends one entry (`fields` is a flat object of strings) and trims the stream to
//     about `maxlen` entries. Rejects when Redis cannot take it.
// genesis/adapters/redis_stream.js is the real one; the tests use an in-memory fake.
//
// When Redis is down nothing waits for it: accept() only puts the event in the buffer and
// returns. The buffer is retried with a growing pause; once it is full the oldest waiting
// event is thrown away and counted in `dropped`. Delivery is at-least-once: after a
// publish that timed out the same event can be written twice (same id, readers can tell).
//
// Depends only on genesis/shared/events.js.

import { validateEvent } from '../shared/events.js';

export const HUB_DEFAULTS = Object.freeze({
    stream: 'genesis:events',
    stream_per_agent: false, // true: one stream per agent, "<stream>:<agent>"
    stream_maxlen: 20000,
    buffer_size: 2000,
    retry_ms: 1000,
    max_retry_ms: 30000,
    publish_timeout_ms: 5000,
});

export function createEventHub({ client, timers = { setTimeout, clearTimeout }, warn = console.warn, now = Date.now, ...options } = {}) {
    const config = { ...HUB_DEFAULTS };
    for (const key of Object.keys(HUB_DEFAULTS)) {
        if (options[key] !== undefined && options[key] !== null) config[key] = options[key];
    }
    config.buffer_size = Math.max(2, Math.floor(Number(config.buffer_size)) || HUB_DEFAULTS.buffer_size);

    const counters = { accepted: 0, published: 0, dropped: 0, rejected: 0, publish_failures: 0, seq_gaps: 0 };
    const last_seq = new Map(); // agent -> seq of its last accepted event
    const buffer = [];
    let in_flight = null;     // the event being written right now (always buffer[0])
    let pumping = null;       // the promise of the running pump, or null
    let retry_timer = null;
    let retry_delay = config.retry_ms;
    let redis_ok = null;      // null until the first publish attempt has ended
    let last_error = null;
    let closed = false;

    function logLine(record) {
        try { warn(JSON.stringify({ ts: new Date(now()).toISOString(), level: 'warn', ...record })); } catch { /* logging must not break the hub */ }
    }

    function streamFor(event) {
        return config.stream_per_agent ? `${config.stream}:${event.agent}` : config.stream;
    }

    function publish(event) {
        return new Promise((resolve, reject) => {
            const timer = timers.setTimeout(
                () => reject(new Error(`publish timed out after ${config.publish_timeout_ms} ms`)), config.publish_timeout_ms);
            timer?.unref?.();
            Promise.resolve()
                .then(() => client.xadd(streamFor(event),
                    { event: JSON.stringify(event), agent: event.agent, type: event.type }, { maxlen: config.stream_maxlen }))
                .then(resolve, reject)
                .finally(() => timers.clearTimeout(timer));
        });
    }

    function scheduleRetry() {
        if (closed || retry_timer !== null) return;
        retry_timer = timers.setTimeout(() => { retry_timer = null; pump(); }, retry_delay);
        retry_timer?.unref?.(); // a waiting retry must not keep the process alive
        retry_delay = Math.min(retry_delay * 2, config.max_retry_ms);
    }

    // Writes the buffer to Redis, oldest first, until it is empty or a write fails.
    function pump() {
        if (pumping) return pumping;
        if (closed || buffer.length === 0) return Promise.resolve();
        pumping = (async () => {
            while (buffer.length > 0 && !closed) {
                const event = buffer[0];
                in_flight = event;
                try {
                    await publish(event);
                } catch (err) {
                    in_flight = null;
                    counters.publish_failures++;
                    last_error = String(err?.message ?? err);
                    if (redis_ok !== false) {
                        logLine({ event: 'genesis_events_redis_down', message: last_error, buffered: buffer.length, dropped: counters.dropped });
                    }
                    redis_ok = false;
                    scheduleRetry();
                    return;
                }
                in_flight = null;
                buffer.shift();
                counters.published++;
                if (redis_ok === false) {
                    logLine({ event: 'genesis_events_redis_back', buffered: buffer.length, dropped: counters.dropped });
                }
                redis_ok = true;
                retry_delay = config.retry_ms;
            }
        })().catch((err) => { last_error = String(err?.message ?? err); }).finally(() => { pumping = null; });
        return pumping;
    }

    // Takes one event from an agent process. Never throws and never waits for Redis.
    // Returns true when the event was put in the buffer.
    function accept(event) {
        try {
            if (closed) return false;
            if (!validateEvent(event).ok) {
                counters.rejected++;
                return false;
            }
            const previous = last_seq.get(event.agent);
            if (previous !== undefined && event.seq > previous + 1) counters.seq_gaps += event.seq - previous - 1;
            last_seq.set(event.agent, event.seq);

            if (buffer.length >= config.buffer_size) {
                // full: the oldest event that is not being written right now goes
                buffer.splice(in_flight !== null ? 1 : 0, 1);
                counters.dropped++;
            }
            buffer.push(event);
            counters.accepted++;
            if (retry_timer === null) pump(); // while Redis is down, the retry timer decides when to try again
            return true;
        } catch (err) {
            counters.rejected++;
            last_error = String(err?.message ?? err);
            return false;
        }
    }

    return {
        accept,
        // Tries now to write everything that waits (also when a retry was scheduled for later).
        // Resolves when the buffer is empty or a write failed. Never rejects.
        async drain() {
            if (retry_timer !== null) { timers.clearTimeout(retry_timer); retry_timer = null; }
            await pump();
        },
        stats: () => ({ ...counters, buffered: buffer.length, redis_ok, last_error }),
        close() {
            closed = true;
            if (retry_timer !== null) { timers.clearTimeout(retry_timer); retry_timer = null; }
        },
    };
}
