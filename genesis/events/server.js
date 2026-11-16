// Genesis: switches event publishing on in the MindServer process.
// Called by the launcher (genesis/start.js) only when the genesis_events setting has
// "enabled": true. Otherwise this file is never loaded and the MindServer ignores events.

import { createEventHub } from './hub.js';

// event_settings: the genesis_events setting
// `setEventSink` and `createClient` are injectable for the tests; by default they are the
// MindServer's and the node-redis adapter (loaded only here, so nothing else needs them).
export async function startEventPublishing(event_settings, { setEventSink, createClient, ...hub_options } = {}) {
    if (!setEventSink) ({ setEventSink } = await import('../../src/mindcraft/mindserver.js'));
    if (!createClient) ({ createRedisStreamClient: createClient } = await import('../adapters/redis_stream.js'));

    let client;
    try {
        client = await createClient({ url: event_settings.redis_url });
    } catch (err) {
        // no client at all: every write fails, the hub counts what it has to throw away
        const message = `Redis client could not be created: ${err?.message ?? err}`;
        client = { xadd: async () => { throw new Error(message); } };
    }
    const hub = createEventHub({
        client,
        stream: event_settings.stream,
        stream_per_agent: event_settings.stream_per_agent,
        stream_maxlen: event_settings.stream_maxlen,
        buffer_size: event_settings.buffer_size,
        ...hub_options,
    });
    setEventSink(hub.accept);
    return hub;
}
