// Genesis: the planner broker. One service that owns the model gate, the request queue
// and the planning budget, and sends one planning call at a time to the model.
//
//   - one pending planning request per agent; a newer one replaces the older one
//   - the context is built when the request is dispatched, never when it is queued
//   - one model call at a time
//   - budget per agent: 40 calls per real hour (the 41st is refused and recorded), at
//     least 90 seconds between calls (a call that comes sooner is delayed, not dropped)
//   - a call may take 90 seconds; an invalid reply gets one repair retry
//   - when the desktop leaves, the call in flight is cancelled and its request goes back
//     into the queue; nothing is sent until the gate is AVAILABLE again
//   - every call is recorded
//   - small(): one small call of another kind than planning. Two kinds exist (genesis/relay):
//       chat_line          the spoken line of an agent message. It never waits and never delays
//                          a message: with the gate shut, a call in flight or its budget spent it
//                          answers at once with the reason, and the caller uses its template
//       message_decision   accept or decline, for a request or offer another agent sent. With
//                          the gate shut or its budget spent it answers at once and the caller's
//                          code rule decides; with the model busy on another call it waits a
//                          short, bounded time for its turn (it goes before the next planning call)
//       (addSmallKind adds further kinds: "long_term", the choice of an agent's long-term goals, genesis/town/goals.js)
//     Each kind has its own budget per agent, its own token limit and its own time-out.
//
// Everything outside is injected:
//   model         { name, chat({ messages, format, signal, timeout_ms }) -> Promise<{ content, prompt_tokens, completion_tokens, model }>,
//                   probe() -> Promise<boolean> }          (genesis/broker/ollama_planner.js is the real one)
//   clock         { now() -> ms, setTimeout(fn, ms) -> handle, clearTimeout(handle) }
//   calls         { record(call_record) }                  the call store (genesis/broker/call_record.js)
//   buildContext  async (request) -> { context: string, options: [{ id, description }] }
//   deliver       (result) -> void                         where a request's outcome goes:
//                   { ok: true,  request, call_id, reply: { thought, goals }, chosen_ids }
//                   { ok: false, request, call_id, reason, ... }
//                   reason: replaced | budget_exhausted | invalid_reply | timeout | model_error | context_error
//   emit          (type, data, options)                    events of the broker itself (the gate's state changes)
//   signals       { on(name, handler) }                    source of 'desktop_available' and 'desktop_leaving' (optional;
//                                                          broker.signal(name) does the same by hand)
//   ids           () -> string                             ids for requests and calls (ULIDs by default)

import { createModelGate } from './gate.js';
import { createRequestQueue } from './queue.js';
import { createBudget } from './budget.js';
import { buildPlannerMessages, plannerReplySchema, validatePlannerReply, checkOptions } from './planner_reply.js';
import { makeCallRecord } from './call_record.js';
import { createUlidFactory } from '../shared/events.js';

export const BROKER_DEFAULTS = Object.freeze({
    call_timeout_ms: 90 * 1000,
    repair_retries: 1,
    probe_interval_ms: 15 * 1000,
});

// The small calls (chat lines). Proposed starting values.
export const SMALL_CALL_DEFAULTS = Object.freeze({
    max_calls: 30,                  // lines the model writes per agent per real hour; after that the template is used
    window_ms: 60 * 60 * 1000,
    min_gap_ms: 0,                  // no pause between an agent's lines
    timeout_ms: 15 * 1000,          // a line that takes longer is given up
    max_tokens: 60,                 // the reply's own token limit
});

// The small call that decides an incoming request or offer (accept or decline; genesis/relay/decisions.js).
// Proposed starting values; the relay sets them from the genesis_relay.decision setting (setSmallLimits).
export const DECISION_CALL_DEFAULTS = Object.freeze({
    max_calls: 20,                  // decisions the model makes per agent per real hour; after that the code rule decides
    window_ms: 60 * 60 * 1000,
    min_gap_ms: 0,
    timeout_ms: 15 * 1000,          // a decision that takes longer is given up (the code rule decides)
    max_tokens: 80,                 // the reply's own token limit
    wait_ms: 120 * 1000,            // decided: a decision waits for a model that is busy with another call up to the message's expiry
});

export const SMALL_KINDS = Object.freeze(['chat_line', 'message_decision']);

const ABORTED = Symbol('aborted');

function whenAborted(signal) {
    return new Promise((_, reject) => {
        if (signal.aborted) reject(ABORTED);
        else signal.addEventListener('abort', () => reject(ABORTED), { once: true });
    });
}

export function createPlannerBroker({
    model, clock, calls, buildContext, deliver = () => {}, emit = () => {}, signals = null, ids = null,
    gate: gate_options = {}, budget: budget_options = {}, small: small_options = {}, decision: decision_options = {}, ...options
} = {}) {
    const config = { ...BROKER_DEFAULTS };
    for (const key of Object.keys(BROKER_DEFAULTS)) {
        if (options[key] !== undefined) config[key] = options[key];
    }
    const nextId = ids ?? createUlidFactory({ now: clock.now });
    const queue = createRequestQueue();
    const budget = createBudget(budget_options);
    const small_config = { ...SMALL_CALL_DEFAULTS, ...small_options };
    const small_budget = createBudget({ max_calls: small_config.max_calls, window_ms: small_config.window_ms, min_gap_ms: small_config.min_gap_ms });
    const decision_config = { ...DECISION_CALL_DEFAULTS, ...decision_options };
    const decision_budget = createBudget({ max_calls: decision_config.max_calls, window_ms: decision_config.window_ms, min_gap_ms: decision_config.min_gap_ms });
    // each kind of small call: its own limits, its own budget per agent
    const small_kinds = {
        chat_line: { config: small_config, budget: small_budget },
        message_decision: { config: decision_config, budget: decision_budget },
    };
    const small_waiting = [];   // small calls that wait for the model to be free: { input, resolve, timer }
    const gate = createModelGate({ probe: () => model.probe(), clock, emit, ...gate_options });
    const stats = {
        submitted: 0, replaced: 0, calls: 0, valid: 0, invalid: 0, refused: 0, cancelled: 0, requeued: 0,
        timeouts: 0, errors: 0, record_failures: 0,
        small_calls: 0, small_valid: 0, small_invalid: 0, small_refused: 0, small_busy: 0, small_failed: 0, small_waited: 0,
        decision_calls: 0, decision_refused: 0,
    };

    let in_flight = null;   // { request, controller, cancelled, done } of the one call being made
    let small_in_flight = null; // { controller, cancelled, done } of the one small call being made (never at the same time as a planning call)
    let wake_timer = null;  // set while every waiting request is inside its 90 seconds
    let probe_timer = null;
    let running = false;

    const iso = (ms) => new Date(ms).toISOString();

    function tell(result) {
        try { deliver(result); } catch { /* the receiver's problem must not stop the broker */ }
    }

    // Hands a record to the call store without waiting for it: a slow store delays nothing.
    function save(fields) {
        const record = makeCallRecord(fields);
        try {
            const pending = calls?.record(record);
            if (pending && typeof pending.then === 'function') pending.then(null, () => { stats.record_failures++; });
        } catch {
            stats.record_failures++;
        }
        return record;
    }

    function clearWake() {
        if (wake_timer !== null) { clock.clearTimeout(wake_timer); wake_timer = null; }
    }

    function refuse(request, attempt, verdict, built = null) {
        stats.refused++;
        const now = clock.now();
        const record = save({
            call_id: nextId(), request_id: request.id, agent: request.agent, trigger: request.trigger,
            context: built?.context ?? null, options_offered: built?.options ?? [], attempt,
            queue_wait_ms: now - request.queued_at, model: model.name ?? null, outcome: 'refused_budget',
            errors: [`hourly budget used up (${budget.config.max_calls} calls per hour), free again at ${iso(verdict.retry_at)}`],
            started_at: iso(now),
        });
        return record.call_id;
    }

    // Starts the next call if one may start now.
    function pump() {
        if (!running || in_flight || small_in_flight || !gate.isAvailable()) return;
        clearWake();
        const now = clock.now();
        let wake_at = null;
        for (const request of queue.list()) {
            const verdict = budget.check(request.agent, now);
            if (verdict.ok) {
                queue.remove(request);
                dispatch(request);
                return;
            }
            if (verdict.reason === 'hourly_limit') {
                queue.remove(request);
                const call_id = refuse(request, 1, verdict);
                tell({ ok: false, request, call_id, reason: 'budget_exhausted', retry_at: iso(verdict.retry_at) });
                continue;
            }
            // min_gap: the request stays where it is and goes out when its 90 seconds are over
            wake_at = wake_at === null ? verdict.retry_at : Math.min(wake_at, verdict.retry_at);
        }
        if (wake_at !== null) {
            wake_timer = clock.setTimeout(() => { wake_timer = null; pump(); }, Math.max(0, wake_at - now));
            wake_timer?.unref?.(); // a waiting timer must not keep the process alive (the MindServer does that)
        }
    }

    function dispatch(request) {
        const job = { request, controller: null, cancelled: null, done: null };
        in_flight = job;
        job.done = run(job)
            .catch((err) => {
                stats.errors++;
                tell({ ok: false, request, call_id: null, reason: 'model_error', error: String(err?.message ?? err) });
            })
            .finally(() => {
                in_flight = null;
                nextUp();
            });
    }

    // The model is free: a small call that waited for it goes first (it is short, and the message it
    // decides about expires), then the next planning request.
    function nextUp() {
        while (small_waiting.length > 0 && !in_flight && !small_in_flight && gate.isAvailable()) {
            const waiter = small_waiting.shift();
            clock.clearTimeout(waiter.timer);
            waiter.resolve(startSmall(waiter.input)); // sets small_in_flight at once, or answers at once with why not
        }
        pump();
    }

    // Small calls that still wait are answered with a reason (the gate shut, the broker stopped).
    function dismissWaiting(reason) {
        for (const waiter of small_waiting.splice(0)) {
            clock.clearTimeout(waiter.timer);
            waiter.resolve({ ok: false, reason });
        }
    }

    function putBack(job) {
        if (queue.requeue(job.request)) {
            stats.requeued++;
        } else {
            // the agent asked again while this call was out: the newer request wins
            stats.replaced++;
            tell({ ok: false, request: job.request, call_id: null, reason: 'replaced', replaced_by: queue.get(job.request.agent)?.id ?? null });
        }
    }

    // One model call. Returns { kind: valid | invalid | cancelled | timeout | error, call_id, ... }.
    async function callOnce(job, built, format, messages, attempt) {
        const { request } = job;
        const started = clock.now();
        const call_id = nextId();
        const spent = budget.spend(request.agent, started);
        const controller = new AbortController();
        job.controller = controller;
        let timed_out = false;
        const timer = clock.setTimeout(() => { timed_out = true; controller.abort(); }, config.call_timeout_ms);
        const base = {
            call_id, request_id: request.id, agent: request.agent, trigger: request.trigger,
            context: built.context, options_offered: built.options, attempt,
            queue_wait_ms: started - request.queued_at, model: model.name ?? null, started_at: iso(started),
        };
        stats.calls++;
        let response;
        try {
            // the race makes the broker independent of whether the model client honours the signal
            response = await Promise.race([
                Promise.resolve().then(() => model.chat({ messages, format, signal: controller.signal, timeout_ms: config.call_timeout_ms })),
                whenAborted(controller.signal),
            ]);
        } catch (err) {
            const latency_ms = clock.now() - started;
            if (job.cancelled) {
                budget.refund(spent); // the desktop left: this call does not count
                stats.cancelled++;
                save({ ...base, latency_ms, outcome: 'cancelled', errors: [`cancelled: ${job.cancelled}`] });
                return { kind: 'cancelled', call_id };
            }
            budget.finish(spent, clock.now());
            if (timed_out) {
                stats.timeouts++;
                const errors = [`no reply within ${config.call_timeout_ms} ms`];
                save({ ...base, latency_ms, outcome: 'timeout', errors });
                return { kind: 'timeout', call_id, errors };
            }
            stats.errors++;
            const errors = [err === ABORTED ? 'aborted' : `${err?.name ?? 'Error'}: ${err?.message ?? err}`];
            save({ ...base, latency_ms, outcome: 'error', errors });
            return { kind: 'error', call_id, errors };
        } finally {
            clock.clearTimeout(timer);
            job.controller = null;
        }

        const ended = clock.now();
        budget.finish(spent, ended);
        const raw = typeof response?.content === 'string' ? response.content : null;
        const checked = validatePlannerReply(raw, built.options.map((option) => option.id));
        save({
            ...base, latency_ms: ended - started, raw_output: raw, chosen_ids: checked.chosen_ids, valid: checked.ok,
            outcome: checked.ok ? 'ok' : 'invalid', errors: checked.errors,
            prompt_tokens: response?.prompt_tokens, completion_tokens: response?.completion_tokens,
            model: response?.model ?? model.name ?? null,
        });
        if (checked.ok) {
            stats.valid++;
            return { kind: 'valid', call_id, reply: checked.reply, chosen_ids: checked.chosen_ids };
        }
        stats.invalid++;
        return { kind: 'invalid', call_id, raw, errors: checked.errors };
    }

    // Works on one request: builds its context now, calls the model, and retries once
    // when the reply is invalid.
    async function run(job) {
        const { request } = job;
        let built;
        try {
            built = await buildContext(request);
            const problems = checkOptions(built?.options);
            if (typeof built?.context !== 'string') problems.push('context must be a string');
            if (problems.length > 0) throw new Error(problems.join('; '));
        } catch (err) {
            tell({ ok: false, request, call_id: null, reason: 'context_error', error: String(err?.message ?? err) });
            return;
        }
        const format = plannerReplySchema(built.options.map((option) => option.id));
        let repair = null;
        let last = null;
        for (let attempt = 1; attempt <= 1 + config.repair_retries; attempt++) {
            if (job.cancelled) { putBack(job); return; } // the desktop left before this call went out
            if (attempt > 1) {
                const verdict = budget.check(request.agent, clock.now(), { repair: true });
                if (!verdict.ok) { refuse(request, attempt, verdict, built); break; }
            }
            const messages = buildPlannerMessages({ agent: request.agent, context: built.context, options: built.options, repair });
            last = await callOnce(job, built, format, messages, attempt);
            if (last.kind === 'valid') {
                tell({ ok: true, request, call_id: last.call_id, reply: last.reply, chosen_ids: last.chosen_ids });
                return;
            }
            if (last.kind === 'cancelled') { putBack(job); return; }
            if (last.kind !== 'invalid') break;
            repair = { raw: last.raw, errors: last.errors };
        }
        const reason = { invalid: 'invalid_reply', timeout: 'timeout', error: 'model_error' }[last.kind];
        tell({ ok: false, request, call_id: last.call_id, reason, errors: last.errors });
        // a call that failed or hung: ask now whether the model is still there, instead of waiting for the next probe
        if (last.kind !== 'invalid') gate.tick().catch(() => {});
    }

    // The gate closes (the desktop is leaving, or two probes failed): stop the call in
    // flight and wait until its request is back in the queue.
    gate.onLeave(async (reason) => {
        clearWake();
        dismissWaiting('model_away');
        const line = small_in_flight;
        if (line) {
            line.cancelled = reason;
            line.controller.abort();
            await line.done;
        }
        const job = in_flight;
        if (!job) return;
        job.cancelled = reason;
        job.controller?.abort();
        await job.done;
    });

    // One small call. Resolves (never rejects) to
    //   { ok: true, content, call_id }                    the model's raw reply, which `validate` accepted
    //   { ok: false, reason, call_id? }                   reason: model_away | model_busy | budget_exhausted |
    //                                                     invalid_reply | timeout | model_error | cancelled
    //   agent      whose budget the call counts against
    //   kind       chat_line (the default) | message_decision: which limits and which budget apply
    //   trigger    what the call record says the call was for, e.g. { kind: 'chat_line', detail: { msg_id } }
    //   validate   (raw text) -> true when the reply may be used
    //   wait_ms    how long the call may wait for a model that is busy with another call (0: not at all)
    function small(input = {}) {
        const kind = small_kinds[input.kind ?? 'chat_line'];
        if (!kind || typeof input.agent !== 'string' || input.agent.length === 0 || !Array.isArray(input.messages)) return Promise.resolve({ ok: false, reason: 'bad_request' });
        if (!gate.isAvailable()) return Promise.resolve({ ok: false, reason: 'model_away' });
        if (in_flight || small_in_flight) {
            const wait_ms = Number(input.wait_ms ?? kind.config.wait_ms ?? 0);
            if (!(wait_ms > 0) || !running) { stats.small_busy++; return Promise.resolve({ ok: false, reason: 'model_busy' }); }
            // the model is busy: the call waits its turn, for a bounded time
            stats.small_waited++;
            return new Promise((resolve) => {
                const waiter = { input, resolve, timer: null };
                waiter.timer = clock.setTimeout(() => {
                    const index = small_waiting.indexOf(waiter);
                    if (index >= 0) small_waiting.splice(index, 1);
                    stats.small_busy++;
                    resolve({ ok: false, reason: 'model_busy' });
                }, wait_ms);
                waiter.timer?.unref?.();
                small_waiting.push(waiter);
            });
        }
        return startSmall(input);
    }

    // Starts a small call now (the model is free and the gate is open). Sets small_in_flight before it returns.
    function startSmall({ agent, kind: kind_name = 'chat_line', trigger = null, messages, format, validate = () => true, max_tokens = null, timeout_ms = null } = {}) {
        const kind = small_kinds[kind_name];
        const of_kind = kind.budget;
        max_tokens ??= kind.config.max_tokens;
        timeout_ms ??= kind.config.timeout_ms;
        trigger ??= { kind: kind_name };
        const is_decision = kind_name === 'message_decision';
        const started = clock.now();
        const verdict = of_kind.check(agent, started);
        if (!verdict.ok) {
            stats.small_refused++;
            if (is_decision) stats.decision_refused++;
            return Promise.resolve({ ok: false, reason: 'budget_exhausted', retry_at: iso(verdict.retry_at) });
        }
        const spent = of_kind.spend(agent, started);
        const call_id = nextId();
        const job = { controller: new AbortController(), cancelled: null, done: null };
        small_in_flight = job;
        stats.small_calls++;
        if (is_decision) stats.decision_calls++;
        let timed_out = false;
        const timer = clock.setTimeout(() => { timed_out = true; job.controller.abort(); }, timeout_ms);
        const base = {
            call_id, request_id: null, agent, trigger, context: messages.map((message) => String(message.content ?? '')).join('\n'),
            options_offered: [], attempt: 1, queue_wait_ms: 0, model: model.name ?? null, started_at: iso(started),
        };
        job.done = (async () => {
            let response;
            try {
                response = await Promise.race([
                    Promise.resolve().then(() => model.chat({ messages, format, signal: job.controller.signal, timeout_ms, max_tokens })),
                    whenAborted(job.controller.signal),
                ]);
            } catch (err) {
                const latency_ms = clock.now() - started;
                if (job.cancelled) {
                    of_kind.refund(spent); // the desktop left: this call does not count
                    save({ ...base, latency_ms, outcome: 'cancelled', errors: [`cancelled: ${job.cancelled}`] });
                    return { ok: false, reason: 'cancelled', call_id };
                }
                stats.small_failed++;
                of_kind.finish(spent, clock.now());
                const errors = [timed_out ? `no reply within ${timeout_ms} ms` : (err === ABORTED ? 'aborted' : `${err?.name ?? 'Error'}: ${err?.message ?? err}`)];
                save({ ...base, latency_ms, outcome: timed_out ? 'timeout' : 'error', errors });
                return { ok: false, reason: timed_out ? 'timeout' : 'model_error', call_id };
            } finally {
                clock.clearTimeout(timer);
            }
            const ended = clock.now();
            of_kind.finish(spent, ended);
            const raw = typeof response?.content === 'string' ? response.content : null;
            let valid = false;
            try { valid = raw !== null && validate(raw) === true; } catch { valid = false; }
            save({
                ...base, latency_ms: ended - started, raw_output: raw, valid, outcome: valid ? 'ok' : 'invalid',
                errors: valid ? [] : ['the reply was not used'], prompt_tokens: response?.prompt_tokens, completion_tokens: response?.completion_tokens,
                model: response?.model ?? model.name ?? null,
            });
            if (valid) { stats.small_valid++; return { ok: true, content: raw, call_id }; }
            stats.small_invalid++;
            return { ok: false, reason: 'invalid_reply', call_id, content: raw };
        })().finally(() => {
            if (small_in_flight === job) small_in_flight = null;
            nextUp();
        });
        return job.done;
    }
    gate.onAvailable(() => pump());

    function scheduleProbe() {
        if (!running || probe_timer !== null) return;
        probe_timer = clock.setTimeout(async () => {
            probe_timer = null;
            try { await gate.tick(); } catch { /* the gate reports nothing for a failed probe */ }
            scheduleProbe();
            pump();
        }, config.probe_interval_ms);
        probe_timer?.unref?.();
    }

    // 'desktop_available' or 'desktop_leaving'. Resolves when the gate has dealt with it.
    async function signal(name) {
        if (name === 'desktop_available') await gate.desktopAvailable();
        else if (name === 'desktop_leaving') await gate.desktopLeaving();
        pump();
        return gate.state();
    }

    if (signals && typeof signals.on === 'function') {
        signals.on('desktop_available', () => { signal('desktop_available').catch(() => {}); });
        signals.on('desktop_leaving', () => { signal('desktop_leaving').catch(() => {}); });
    }

    return {
        gate,
        // Queues a planning request for an agent. Returns { ok: true, request, replaced } or { ok: false, error }.
        // ref: the sender's own name for the request (optional). It comes back on the request of
        // every result, so a result that is delivered before submit() has returned can be matched.
        submit({ agent, trigger = null, kind = 'plan', ref = null } = {}) {
            if (typeof agent !== 'string' || agent.trim().length === 0) return { ok: false, error: 'agent must be a non-empty string' };
            const request = { id: nextId(), agent, kind, trigger, queued_at: clock.now(), ...(ref !== null ? { ref } : {}) };
            stats.submitted++;
            const replaced = queue.put(request);
            if (replaced) {
                stats.replaced++;
                tell({ ok: false, request: replaced, call_id: null, reason: 'replaced', replaced_by: request.id });
            }
            pump();
            return { ok: true, request, replaced };
        },
        signal,
        small,
        smallBudget: small_budget,
        decisionBudget: decision_budget,
        // One more kind of small call, with its own limits and its own budget per agent (the long-term goal choice:
        // genesis/town/goals.js). A kind that exists is left as it is. Returns true when it was added.
        addSmallKind(kind_name, limits = {}) {
            if (typeof kind_name !== 'string' || kind_name.length === 0 || small_kinds[kind_name]) return false;
            const kind_config = { ...SMALL_CALL_DEFAULTS, ...limits };
            small_kinds[kind_name] = { config: kind_config, budget: createBudget({ max_calls: kind_config.max_calls, window_ms: kind_config.window_ms, min_gap_ms: kind_config.min_gap_ms }) };
            return true;
        },
        // The limits of one kind of small call, e.g. from a setting: { max_calls, max_tokens, timeout_ms, wait_ms }.
        // Returns the limits in force, or null for a kind that does not exist.
        setSmallLimits(kind_name, limits = {}) {
            const kind = small_kinds[kind_name];
            if (!kind) return null;
            for (const key of ['max_calls', 'max_tokens', 'timeout_ms', 'wait_ms']) {
                if (Number.isFinite(limits[key]) && limits[key] >= 0) kind.config[key] = limits[key];
            }
            kind.budget.config.max_calls = kind.config.max_calls;
            return { ...kind.config };
        },
        smallLimits: (kind_name) => (small_kinds[kind_name] ? { ...small_kinds[kind_name].config } : null),
        // Starts the health probes. probe_first: the broker does not know whether the desktop
        // is there when it starts, so by default it asks once, as if desktop_available had come.
        start({ probe_first = true } = {}) {
            running = true;
            scheduleProbe();
            // decided: the gate says its state at start. A probe that passes announces "available" itself;
            // one that fails changes nothing, so the state it leaves (away) is said here, once.
            if (probe_first) {
                return signal('desktop_available').then((state) => {
                    if (!gate.isAvailable()) gate.report({ reason: 'not_reachable_at_start', at_start: true });
                    return state;
                });
            }
            pump();
            gate.report({ at_start: true });
            return Promise.resolve(gate.state());
        },
        // Stops the timers. Requests stay in the queue; a call in flight is left to end.
        stop() {
            running = false;
            clearWake();
            dismissWaiting('cancelled');
            if (probe_timer !== null) { clock.clearTimeout(probe_timer); probe_timer = null; }
        },
        pump,
        // The request an agent is waiting on, in the checkpoint's pending_request shape, or null.
        pendingFor(agent) {
            const request = queue.get(agent) ?? (in_flight?.request.agent === agent ? in_flight.request : null);
            return request ? { id: request.id, kind: request.kind, queued_at: iso(request.queued_at) } : null;
        },
        pending: () => queue.list(),
        inFlight: () => in_flight?.request ?? null,
        budget,
        stats: () => ({ ...stats, state: gate.state(), pending: queue.size(), in_flight: in_flight !== null }),
    };
}
