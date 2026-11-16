// Genesis: the planner's request queue. One pending planning request per agent; a newer
// request from the same agent replaces the older one and keeps its place in the line.
// A request holds no context: the context is built when the request is dispatched.
//
// Request: { id, agent, kind, trigger, queued_at }   (id, kind and queued_at are what the
// checkpoint stores as pending_request)
// No imports.

export function createRequestQueue() {
    const pending = new Map(); // agent -> { request, since, order }
    let counter = 0;

    return {
        // Adds a request. Returns the request it replaced, or null.
        put(request) {
            const slot = pending.get(request.agent);
            const replaced = slot ? slot.request : null;
            // the agent keeps its place in the line: asking again must not push it to the back
            pending.set(request.agent, { request, since: slot ? slot.since : request.queued_at, order: slot ? slot.order : counter++ });
            return replaced;
        },
        // Puts a request that was being worked on back at its old place in the line.
        // Returns false when the agent has asked again meanwhile: the newer request wins.
        requeue(request) {
            if (pending.has(request.agent)) return false;
            pending.set(request.agent, { request, since: request.queued_at, order: -1 - counter++ }); // ahead of same-time requests
            return true;
        },
        get: (agent) => pending.get(agent)?.request ?? null,
        remove(request) {
            if (pending.get(request.agent)?.request !== request) return false;
            pending.delete(request.agent);
            return true;
        },
        // The waiting requests, the one that has waited longest first.
        list() {
            return [...pending.values()].sort((a, b) => a.since - b.since || a.order - b.order).map((slot) => slot.request);
        },
        size: () => pending.size,
    };
}
