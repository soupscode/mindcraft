// Genesis: the event envelope, the event types and their validators.
// Shared by the agent processes (which create events), the MindServer (which publishes
// them) and anything that reads them back from the Redis streams.
// Plain JavaScript with no imports at all, so it can be copied or imported anywhere.
//
// Envelope:
//   {"v":1,"id":"<ulid>","ts":"<ISO-8601>","agent":"Arthur","seq":1042,"type":"skill.result",
//    "corr":"<decision id or null>","severity":"info|warn|error","data":{}}
//
// `data` per type (fields marked ? are optional; unknown extra fields are allowed, so a
// newer writer does not break an older reader):
//   agent.decision  { decision_id, summary, trigger?, command?, args? }
//   skill.started   { skill, args? }
//   skill.progress  { skill, done, total }            total may be null (not known)
//   skill.result    { skill, ok, interrupted, timedout, output, duration_ms }
//   goal.changed    { scope, before, after, reason, source, call_id }
//   agent.failure   { kind, error, message, ... }     kind "model" carries the model_failure log fields
//   agent.recovery  { kind, message? }
//   agent.message   { to, text }                      the envelope's agent is the sender
//   agent.state     { state, detail? }

export const EVENT_VERSION = 1;

export const EVENT_TYPES = Object.freeze([
    'agent.decision', 'skill.started', 'skill.progress', 'skill.result', 'goal.changed',
    'agent.failure', 'agent.recovery', 'agent.message', 'agent.state',
]);

export const SEVERITIES = Object.freeze(['info', 'warn', 'error']);

export const GOAL_SCOPES = Object.freeze(['long_term', 'short_term']);
export const GOAL_SOURCES = Object.freeze(['planner', 'executor', 'routine', 'operator']);

// An event larger than this (as JSON text) is refused: one event must never fill the buffer.
export const MAX_EVENT_BYTES = 16 * 1024;

const ENVELOPE_KEYS = ['v', 'id', 'ts', 'agent', 'seq', 'type', 'corr', 'severity', 'data'];
const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
// The form Date.prototype.toISOString() writes: UTC, milliseconds, "Z".
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const isText = (value) => typeof value === 'string';
const isFilledText = (value) => typeof value === 'string' && value.trim().length > 0;
const isCount = (value) => Number.isInteger(value) && value >= 0;
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Each check returns a list of problems with `data` (empty = fine).
const DATA_CHECKS = {
    'agent.decision': (d) => [
        !isFilledText(d.decision_id) && 'data.decision_id must be a non-empty string',
        !isText(d.summary) && 'data.summary must be a string',
        d.trigger !== undefined && !isText(d.trigger) && 'data.trigger must be a string',
        d.command !== undefined && d.command !== null && !isText(d.command) && 'data.command must be a string or null',
        d.args !== undefined && !Array.isArray(d.args) && 'data.args must be an array',
    ],
    'skill.started': (d) => [
        !isFilledText(d.skill) && 'data.skill must be a non-empty string',
        d.args !== undefined && !Array.isArray(d.args) && 'data.args must be an array',
    ],
    'skill.progress': (d) => [
        !isFilledText(d.skill) && 'data.skill must be a non-empty string',
        !isCount(d.done) && 'data.done must be a whole number, 0 or more',
        d.total !== null && !isCount(d.total) && 'data.total must be a whole number, 0 or more, or null',
    ],
    'skill.result': (d) => [
        !isFilledText(d.skill) && 'data.skill must be a non-empty string',
        typeof d.ok !== 'boolean' && 'data.ok must be true or false',
        typeof d.interrupted !== 'boolean' && 'data.interrupted must be true or false',
        typeof d.timedout !== 'boolean' && 'data.timedout must be true or false',
        !isText(d.output) && 'data.output must be a string',
        !isCount(d.duration_ms) && 'data.duration_ms must be a whole number, 0 or more',
    ],
    'goal.changed': (d) => [
        !GOAL_SCOPES.includes(d.scope) && `data.scope must be one of ${GOAL_SCOPES.join(', ')}`,
        !Array.isArray(d.before) && 'data.before must be an array',
        !Array.isArray(d.after) && 'data.after must be an array',
        !isFilledText(d.reason) && 'data.reason must be a non-empty string',
        !GOAL_SOURCES.includes(d.source) && `data.source must be one of ${GOAL_SOURCES.join(', ')}`,
        d.call_id !== null && !isFilledText(d.call_id) && 'data.call_id must be a non-empty string or null',
    ],
    'agent.failure': (d) => [
        !isFilledText(d.kind) && 'data.kind must be a non-empty string',
        !isFilledText(d.error) && 'data.error must be a non-empty string',
        !isText(d.message) && 'data.message must be a string',
    ],
    'agent.recovery': (d) => [
        !isFilledText(d.kind) && 'data.kind must be a non-empty string',
        d.message !== undefined && !isText(d.message) && 'data.message must be a string',
    ],
    'agent.message': (d) => [
        !isFilledText(d.to) && 'data.to must be a non-empty string',
        !isText(d.text) && 'data.text must be a string',
    ],
    'agent.state': (d) => [
        !isFilledText(d.state) && 'data.state must be a non-empty string',
        d.detail !== undefined && !isPlainObject(d.detail) && 'data.detail must be an object',
    ],
};

// Problems with the `data` of an event of the given type (empty = fine).
export function checkEventData(type, data) {
    if (!EVENT_TYPES.includes(type)) return [`type must be one of ${EVENT_TYPES.join(', ')}`];
    if (!isPlainObject(data)) return ['data must be an object'];
    return DATA_CHECKS[type](data).filter(Boolean);
}

// Checks a whole event. Never throws, whatever it is given.
// Returns { ok: true, errors: [] } or { ok: false, errors: [...] }.
export function validateEvent(event) {
    const errors = [];
    if (!isPlainObject(event)) return { ok: false, errors: ['event must be an object'] };
    for (const key of ENVELOPE_KEYS) {
        if (!Object.hasOwn(event, key)) errors.push(`"${key}" is missing`);
    }
    for (const key of Object.keys(event)) {
        if (!ENVELOPE_KEYS.includes(key)) errors.push(`"${key}" is not an envelope field`);
    }
    if (errors.length > 0) return { ok: false, errors };

    if (event.v !== EVENT_VERSION) errors.push(`v must be ${EVENT_VERSION}`);
    if (!isText(event.id) || !ULID_PATTERN.test(event.id)) errors.push('id must be a ULID');
    if (!isText(event.ts) || !ISO_PATTERN.test(event.ts) || Number.isNaN(Date.parse(event.ts))) {
        errors.push('ts must be an ISO-8601 UTC time such as 2026-01-31T12:00:00.000Z');
    }
    if (!isFilledText(event.agent)) errors.push('agent must be a non-empty string');
    if (!Number.isInteger(event.seq) || event.seq < 1) errors.push('seq must be a whole number, 1 or more');
    if (event.corr !== null && !isFilledText(event.corr)) errors.push('corr must be a non-empty string or null');
    if (!SEVERITIES.includes(event.severity)) errors.push(`severity must be one of ${SEVERITIES.join(', ')}`);
    errors.push(...checkEventData(event.type, event.data));
    if (errors.length > 0) return { ok: false, errors };

    let size;
    try {
        size = byteLength(JSON.stringify(event));
    } catch (err) {
        return { ok: false, errors: [`event cannot be written as JSON (${err?.message ?? err})`] };
    }
    if (size > MAX_EVENT_BYTES) errors.push(`event is ${size} bytes as JSON, the limit is ${MAX_EVENT_BYTES}`);
    return { ok: errors.length === 0, errors };
}

function byteLength(text) {
    let bytes = 0;
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code < 0x80) bytes += 1;
        else if (code < 0x800) bytes += 2;
        else if (code >= 0xd800 && code <= 0xdbff) { bytes += 4; i++; } // a surrogate pair is one 4-byte character
        else bytes += 3;
    }
    return bytes;
}

// Cuts a text for use inside an event, keeping the start and the end (where errors usually are).
export function clipText(text, max = 2000) {
    const value = String(text ?? '');
    if (value.length <= max) return value;
    const head = Math.ceil((max - 5) / 2);
    const tail = max - 5 - head;
    return `${value.slice(0, head)} ... ${value.slice(value.length - tail)}`;
}

// ---- ULID: 48 bits of time and 80 random bits, as 26 characters that sort by time ----

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeTime(ms) {
    let rest = ms;
    let out = '';
    for (let i = 0; i < 10; i++) {
        out = CROCKFORD[rest % 32] + out;
        rest = Math.floor(rest / 32);
    }
    return out;
}

// Returns a function that makes ULIDs. Ids made within the same millisecond still sort in
// the order they were made (the random part is counted up by one).
// `now` returns milliseconds since 1970; `random` returns a number in [0, 1).
export function createUlidFactory({ now = Date.now, random = Math.random } = {}) {
    let last_ms = -1;
    let last_random = null; // 16 values of 5 bits each
    return function ulid() {
        let ms = Math.floor(now());
        if (!Number.isFinite(ms) || ms < 0) ms = 0;
        if (ms <= last_ms && last_random) {
            ms = last_ms; // a clock that stepped back must not make ids sort backwards
            let i = 15;
            while (i >= 0 && last_random[i] === 31) { last_random[i] = 0; i--; }
            if (i >= 0) last_random[i]++;
        } else {
            last_ms = ms;
            last_random = Array.from({ length: 16 }, () => Math.floor(random() * 32) % 32);
        }
        return encodeTime(ms) + last_random.map((value) => CROCKFORD[value]).join('');
    };
}

export const ulid = createUlidFactory();
