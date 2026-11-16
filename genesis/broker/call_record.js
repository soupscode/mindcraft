// Genesis: the record kept of every planning call, and the store interface it goes to.
//
// Record (one per model call; the repair retry is a call of its own, with attempt 2):
//   call_id, request_id, agent, trigger, context, options_offered, raw_output, chosen_ids,
//   valid, attempt, queue_wait_ms, latency_ms, prompt_tokens, completion_tokens, model,
//   outcome, errors, started_at
//
// outcome: ok              a valid reply
//          invalid         a reply that broke the schema or named an option that was not offered
//          refused_budget  not sent: the agent's hourly budget is used up (attempt says which call it would have been)
//          cancelled       stopped because the desktop left; the request went back into the queue
//          timeout         no reply within the call timeout
//          error           the model call failed
//
// Store interface (injected): { record(call_record) -> Promise | void }
// genesis/adapters/pg_stores.js holds the Postgres one; the tests use an in-memory one.
// No imports.

export const CALL_OUTCOMES = Object.freeze(['ok', 'invalid', 'refused_budget', 'cancelled', 'timeout', 'error']);

export const CALL_RECORD_FIELDS = Object.freeze([
    'call_id', 'request_id', 'agent', 'trigger', 'context', 'options_offered', 'raw_output', 'chosen_ids',
    'valid', 'attempt', 'queue_wait_ms', 'latency_ms', 'prompt_tokens', 'completion_tokens', 'model',
    'outcome', 'errors', 'started_at',
]);

const count_or_null = (value) => (Number.isFinite(value) && value >= 0 ? Math.round(value) : null);

// Builds a complete record: every field is present, whatever was passed in.
export function makeCallRecord(fields) {
    return {
        call_id: String(fields.call_id),
        request_id: fields.request_id ?? null,
        agent: String(fields.agent),
        trigger: fields.trigger ?? null,
        context: typeof fields.context === 'string' ? fields.context : null,
        options_offered: Array.isArray(fields.options_offered) ? fields.options_offered : [],
        raw_output: typeof fields.raw_output === 'string' ? fields.raw_output : null,
        chosen_ids: Array.isArray(fields.chosen_ids) ? fields.chosen_ids : [],
        valid: fields.valid === true,
        attempt: Number.isInteger(fields.attempt) ? fields.attempt : 1,
        queue_wait_ms: count_or_null(fields.queue_wait_ms),
        latency_ms: count_or_null(fields.latency_ms),
        prompt_tokens: count_or_null(fields.prompt_tokens),
        completion_tokens: count_or_null(fields.completion_tokens),
        model: fields.model ?? null,
        outcome: CALL_OUTCOMES.includes(fields.outcome) ? fields.outcome : 'error',
        errors: Array.isArray(fields.errors) ? fields.errors.map(String) : [],
        started_at: fields.started_at ?? null, // ISO-8601
    };
}
