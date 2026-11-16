// Genesis: the planner's prompt and its structured reply.
//
// Reply:  {"thought": string up to 160 chars,
//          "goals": [1 to 3 items of {"option_id": one of the ids offered in this call,
//                                     "title": up to 60 chars, "reason": up to 140 chars}]}
//
// The reply is asked for with Ollama's structured outputs: the JSON schema built here goes
// into the `format` field of the /api/chat request (Ollama docs/api.md, "Generate a chat
// completion": "format: the format to return a response in. Format can be `json` or a
// JSON schema", and the section "Structured outputs"). The docs do not say which schema
// keywords the server enforces (length and item limits, enum), so nothing here relies on
// it: validatePlannerReply() checks every rule itself, and a reply that breaks one is
// rejected.
// No imports.

export const REPLY_LIMITS = Object.freeze({ thought: 160, title: 60, reason: 140, min_goals: 1, max_goals: 3 });

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Checks the options a planning call offers: [{ id, description }], unique non-empty ids.
// Returns a list of problems (empty = fine).
export function checkOptions(options) {
    if (!Array.isArray(options) || options.length === 0) return ['options must be a non-empty list'];
    const problems = [];
    const seen = new Set();
    options.forEach((option, index) => {
        if (!isPlainObject(option) || typeof option.id !== 'string' || option.id.trim().length === 0) {
            problems.push(`options[${index}].id must be a non-empty string`);
        } else if (seen.has(option.id)) {
            problems.push(`options[${index}].id "${option.id}" is offered twice`);
        } else {
            seen.add(option.id);
        }
        if (isPlainObject(option) && typeof option.description !== 'string') {
            problems.push(`options[${index}].description must be a string`);
        }
    });
    return problems;
}

// The JSON schema for the `format` field of the request. Only the offered ids are allowed.
export function plannerReplySchema(option_ids) {
    return {
        type: 'object',
        properties: {
            thought: { type: 'string', maxLength: REPLY_LIMITS.thought },
            goals: {
                type: 'array',
                minItems: REPLY_LIMITS.min_goals,
                maxItems: Math.min(REPLY_LIMITS.max_goals, Math.max(1, option_ids.length)),
                items: {
                    type: 'object',
                    properties: {
                        option_id: { type: 'string', enum: [...option_ids] },
                        title: { type: 'string', maxLength: REPLY_LIMITS.title },
                        reason: { type: 'string', maxLength: REPLY_LIMITS.reason },
                    },
                    required: ['option_id', 'title', 'reason'],
                    additionalProperties: false,
                },
            },
        },
        required: ['thought', 'goals'],
        additionalProperties: false,
    };
}

// Checks the raw text the model returned against the options offered in this call.
// Never throws. Returns
//   { ok: true,  reply: { thought, goals: [{ option_id, title, reason }] }, chosen_ids: [...], errors: [] }
//   { ok: false, reply: null, chosen_ids: [...ids that were named and offered], errors: [...] }
export function validatePlannerReply(raw, offered_ids) {
    const offered = new Set(offered_ids);
    const errors = [];
    const fail = (...messages) => ({ ok: false, reply: null, chosen_ids: [], errors: messages });
    if (typeof raw !== 'string' || raw.trim().length === 0) return fail('the reply is empty');
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        return fail(`the reply is not JSON (${err.message})`);
    }
    if (!isPlainObject(parsed)) return fail('the reply must be one JSON object');

    for (const key of Object.keys(parsed)) {
        if (key !== 'thought' && key !== 'goals') errors.push(`"${key}" is not a field of the reply`);
    }
    if (typeof parsed.thought !== 'string') errors.push('"thought" must be a string');
    else if (parsed.thought.length > REPLY_LIMITS.thought) errors.push(`"thought" is longer than ${REPLY_LIMITS.thought} characters`);

    const chosen_ids = [];
    if (!Array.isArray(parsed.goals)) {
        errors.push('"goals" must be a list');
    } else {
        if (parsed.goals.length < REPLY_LIMITS.min_goals || parsed.goals.length > REPLY_LIMITS.max_goals) {
            errors.push(`"goals" must hold ${REPLY_LIMITS.min_goals} to ${REPLY_LIMITS.max_goals} items, it holds ${parsed.goals.length}`);
        }
        parsed.goals.forEach((goal, index) => {
            const where = `goals[${index}]`;
            if (!isPlainObject(goal)) { errors.push(`${where} must be an object`); return; }
            for (const key of Object.keys(goal)) {
                if (!['option_id', 'title', 'reason'].includes(key)) errors.push(`${where}: "${key}" is not a field of a goal`);
            }
            if (typeof goal.option_id !== 'string') {
                errors.push(`${where}.option_id must be a string`);
            } else if (!offered.has(goal.option_id)) {
                errors.push(`${where}.option_id "${goal.option_id}" was not offered`);
            } else if (chosen_ids.includes(goal.option_id)) {
                errors.push(`${where}.option_id "${goal.option_id}" is chosen twice`);
            } else {
                chosen_ids.push(goal.option_id);
            }
            for (const field of ['title', 'reason']) {
                if (typeof goal[field] !== 'string' || goal[field].trim().length === 0) {
                    errors.push(`${where}.${field} must be a non-empty string`);
                } else if (goal[field].length > REPLY_LIMITS[field]) {
                    errors.push(`${where}.${field} is longer than ${REPLY_LIMITS[field]} characters`);
                }
            }
        });
    }
    if (errors.length > 0) return { ok: false, reply: null, chosen_ids, errors };
    const reply = {
        thought: parsed.thought,
        goals: parsed.goals.map((goal) => ({ option_id: goal.option_id, title: goal.title, reason: goal.reason })),
    };
    return { ok: true, reply, chosen_ids, errors: [] };
}

// The messages of one planning call.
//   agent:   the agent's name
//   context: the text describing the agent's situation, built when the call is dispatched
//   options: [{ id, description }]
//   repair:  { raw, errors } of the reply that was rejected, for the one repair retry
export function buildPlannerMessages({ agent, context, options, repair = null }) {
    const ids = options.map((option) => option.id);
    const system = [
        `You plan the next goals for ${agent}, a character in a Minecraft world.`,
        `Choose ${REPLY_LIMITS.min_goals} to ${Math.min(REPLY_LIMITS.max_goals, options.length)} of the options below, most important first.`,
        'Reply with one JSON object and nothing else, in this form:',
        '{"thought": "<one short sentence>", "goals": [{"option_id": "<id of an option>", "title": "<short title>", "reason": "<why>"}]}',
        `Limits: thought up to ${REPLY_LIMITS.thought} characters, title up to ${REPLY_LIMITS.title}, reason up to ${REPLY_LIMITS.reason}.`,
        `option_id must be exactly one of: ${ids.join(', ')}. Do not invent options and do not use an option twice.`,
    ].join('\n');
    const user = [
        String(context ?? '').trim(),
        '',
        'Options:',
        ...options.map((option) => `- ${option.id}: ${option.description}`),
    ].join('\n');
    const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
    if (repair) {
        messages.push({ role: 'assistant', content: String(repair.raw ?? '') });
        messages.push({
            role: 'user',
            content: [
                'That reply was rejected:',
                ...repair.errors.map((error) => `- ${error}`),
                `Reply again with only the JSON object. option_id must be exactly one of: ${ids.join(', ')}.`,
            ].join('\n'),
        });
    }
    return messages;
}
