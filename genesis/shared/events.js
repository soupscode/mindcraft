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
//   goal.changed    { scope, before, after, reason, source, call_id, thought? }
//     thought: the model's own sentence, on the change that carries the planner's decision (source
//     "planner"). A field of its own (decided): readers take it from here, never out of `reason`.
//   agent.failure   { kind, error, message, ... }     kind "model" carries the model_failure log fields
//   agent.recovery  { kind, message? }
//     Both also come in the incident shape (decided, genesis/recovery/incidents.js): a `data`
//     with an incident_id is checked as
//       { incident_id, source: { type, name }, kind, phase, is_failure,
//         recovery: { step, attempt, max, result } | null, outcome, needs_operator }
//     model.away and model.available use it with is_failure false and outcome "expected".
//   agent.message   { to, text }                      the envelope's agent is the sender
//     The structured message of the relay (decided, genesis/relay/relay.js): a `data` with a
//     msg_id is checked as
//       { msg_id, conv, from, to, type, body, chat_line, expires_at, state, reason? }
//     state "rejected" carries the named reason and never has a chat line.
//   agent.state     { state, detail? }
//     States that carry a view of their own (the dashboard reads them; `detail` is checked by nobody else):
//       goals             { long_term: [goal], short_term: [goal] }   an agent's goals as it starts: long-term
//                         goals are emitted as events (decided), also when none has changed
//       routine           { name, phase, phases, away, parked, deaths, bounds: { daylight_ticks_left, health, food,
//                         free_slots, breached: [names], limits: { min_health, min_food, min_free_slots, max_deaths } } }
//                         the role routine's phase and bounds, when the phase or a breached bound changes
//       world_zones       the site as the world file has it (agent "world"; genesis/world/announce.js)
//       world_bootstrap   the summary of the bootstrap manifest (agent "world")
//       model_available | model_leaving | model_away   the model gate (agent "planner"), also once at start
//       server_down_wait  { agent, attempt, delay_ms, waited_ms, message }   an agent process waits for the Minecraft
//       server_back       { agent, waited_ms, message }                      server (agent "supervisor")

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

// ---- the incident shape of agent.failure and agent.recovery ----
export const INCIDENT_PHASES = Object.freeze(['detected', 'recovery_step', 'resolved', 'escalated']);
export const INCIDENT_OUTCOMES = Object.freeze(['pending', 'auto_recovered', 'needs_operator', 'expected', 'gave_up']);
export const RECOVERY_RESULTS = Object.freeze(['ok', 'failed', 'pending', 'skipped']);

// ---- the structured message of agent.message ----
export const MESSAGE_TYPES = Object.freeze(['request', 'offer', 'accept', 'decline', 'inform', 'warn']);
// only these expect a reply (decided)
export const REPLY_EXPECTED = Object.freeze(['request', 'offer']);
// pending: a request or offer that waits for its reply. delivered: a message that expects none.
// accepted, declined, expired: how a request or offer ended. rejected: the relay refused it.
export const MESSAGE_STATES = Object.freeze(['pending', 'delivered', 'accepted', 'declined', 'expired', 'rejected']);

const ENVELOPE_KEYS = ['v', 'id', 'ts', 'agent', 'seq', 'type', 'corr', 'severity', 'data'];
const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
// The form Date.prototype.toISOString() writes: UTC, milliseconds, "Z".
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const isText = (value) => typeof value === 'string';
const isFilledText = (value) => typeof value === 'string' && value.trim().length > 0;
const isCount = (value) => Number.isInteger(value) && value >= 0;
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function incidentProblems(d) {
    const recovery = d.recovery;
    return [
        !isFilledText(d.incident_id) && 'data.incident_id must be a non-empty string',
        (!isPlainObject(d.source) || !isFilledText(d.source.type) || !isFilledText(d.source.name)) && 'data.source must be { type, name }',
        !isFilledText(d.kind) && 'data.kind must be a non-empty string',
        !INCIDENT_PHASES.includes(d.phase) && `data.phase must be one of ${INCIDENT_PHASES.join(', ')}`,
        typeof d.is_failure !== 'boolean' && 'data.is_failure must be true or false',
        recovery !== null && (!isPlainObject(recovery) || !isFilledText(recovery.step) || !isCount(recovery.attempt) || !isCount(recovery.max)
            || !RECOVERY_RESULTS.includes(recovery.result)) && `data.recovery must be null or { step, attempt, max, result: ${RECOVERY_RESULTS.join(' | ')} }`,
        !INCIDENT_OUTCOMES.includes(d.outcome) && `data.outcome must be one of ${INCIDENT_OUTCOMES.join(', ')}`,
        typeof d.needs_operator !== 'boolean' && 'data.needs_operator must be true or false',
    ];
}

function messageProblems(d) {
    return [
        !isFilledText(d.msg_id) && 'data.msg_id must be a non-empty string',
        !isFilledText(d.conv) && 'data.conv must be a non-empty string',
        !isFilledText(d.from) && 'data.from must be a non-empty string',
        !isFilledText(d.to) && 'data.to must be a non-empty string',
        // (a rejected message is shown as it was handed in, so its type may be one that does not exist)
        (d.state === 'rejected' ? !isFilledText(d.type) : !MESSAGE_TYPES.includes(d.type)) && `data.type must be one of ${MESSAGE_TYPES.join(', ')}`,
        !isPlainObject(d.body) && 'data.body must be an object',
        d.chat_line !== null && !isText(d.chat_line) && 'data.chat_line must be a string or null',
        d.expires_at !== null && (!isText(d.expires_at) || !ISO_PATTERN.test(d.expires_at)) && 'data.expires_at must be an ISO-8601 UTC time or null',
        !MESSAGE_STATES.includes(d.state) && `data.state must be one of ${MESSAGE_STATES.join(', ')}`,
        d.state === 'rejected' && !isFilledText(d.reason) && 'data.reason must name why the message was rejected',
        d.state === 'rejected' && d.chat_line !== null && 'a rejected message has no chat line',
    ];
}

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
        d.thought !== undefined && d.thought !== null && !isText(d.thought) && 'data.thought must be a string',
    ],
    'agent.failure': (d) => (d.incident_id !== undefined ? incidentProblems(d) : [
        !isFilledText(d.kind) && 'data.kind must be a non-empty string',
        !isFilledText(d.error) && 'data.error must be a non-empty string',
        !isText(d.message) && 'data.message must be a string',
    ]),
    'agent.recovery': (d) => (d.incident_id !== undefined ? incidentProblems(d) : [
        !isFilledText(d.kind) && 'data.kind must be a non-empty string',
        d.message !== undefined && !isText(d.message) && 'data.message must be a string',
    ]),
    'agent.message': (d) => (d.msg_id !== undefined ? messageProblems(d) : [
        !isFilledText(d.to) && 'data.to must be a non-empty string',
        !isText(d.text) && 'data.text must be a string',
    ]),
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
