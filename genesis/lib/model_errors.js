// Genesis: typed errors for model (LLM) failures, and the one place that logs them.
// Model clients throw these instead of returning placeholder text such as
// "No response data.", so a failure can never be mistaken for a model reply.
// Depends only on Node built-ins and other Genesis files, so it can be imported from
// upstream files and from tests.

import { emitEvent } from '../events/agent_emit.js';

export class ModelError extends Error {
    constructor(message, details = {}) {
        super(message, details.cause ? { cause: details.cause } : undefined);
        this.name = this.constructor.name;
        this.provider = details.provider ?? null;
        this.model = details.model ?? null;
        this.url = details.url ?? null;
        this.status = details.status ?? null;         // HTTP status, when there was one
        this.timeout_ms = details.timeout_ms ?? null; // the limit that applied
        this.elapsed_ms = details.elapsed_ms ?? null;
    }
}

// The model server could not be reached, or answered with an HTTP error.
export class ModelUnavailableError extends ModelError {}

// No complete answer arrived within the request timeout.
export class ModelTimeoutError extends ModelError {}

// The server answered, but not with something usable as a reply.
export class ModelInvalidResponseError extends ModelError {}

export function isModelError(err) {
    return err instanceof ModelError;
}

// Writes exactly one JSON line describing a model failure and returns the record.
// With the genesis_events setting on, the same record also goes out as one agent.failure
// event (kind "model"). Nothing else happens with a model failure: it is not chatted,
// not added to history, not saved to memory.
export function logModelFailure(err, context = {}) {
    const record = {
        ts: new Date().toISOString(),
        level: 'error',
        event: 'model_failure',
        agent: context.agent ?? null,
        call: context.call ?? null,
        error: err?.name ?? 'Error',
        message: String(err?.message ?? err),
        provider: err?.provider ?? null,
        model: err?.model ?? null,
        url: err?.url ?? null,
        status: err?.status ?? null,
        timeout_ms: err?.timeout_ms ?? null,
        elapsed_ms: err?.elapsed_ms ?? null,
    };
    console.error(JSON.stringify(record));
    const { ts, level, event, agent, ...details } = record; // the envelope carries time and agent
    emitEvent('agent.failure', { kind: 'model', ...details }, { severity: 'error' });
    return record;
}
