// Genesis: the text an agent sends with a planning call, and the size rule for the prompt.
//
// The whole prompt (the broker's instructions, this context and the list of options) stays
// within about 1,200 tokens. 240 of those are reserved for the agent's memory, which is a
// later build step: the slot is here, named, and empty.
//
// There is no tokenizer in this repository, so sizes are estimated from the length of the
// text (CHARS_PER_TOKEN). The estimate is on the careful side for English and identifiers
// like "oak_log"; the real count of the model in use has not been measured.
//
// The context is built when the broker dispatches the request, never when the request is
// queued, and the options are exactly what catalog.offer() returns at that moment.
//
// Depends only on genesis/broker/planner_reply.js (to measure the broker's own part).

import { buildPlannerMessages } from '../broker/planner_reply.js';

export const PROMPT_LIMITS = Object.freeze({
    total_tokens: 1200,       // proposed, untested
    memory_tokens: 240,       // reserved for memory, used or not
    option_description: 80,   // characters of an option's description that reach the model
    operator_message: 240,    // characters of what the operator said
});

export const CHARS_PER_TOKEN = 3.5;
export const estimateTokens = (text) => Math.ceil(String(text ?? '').length / CHARS_PER_TOKEN);

export const MEMORY_SLOT_EMPTY = '(nothing yet)';

const clip = (text, max) => {
    const value = String(text ?? '').replace(/\s+/g, ' ').trim();
    return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
};

// What the model is shown of the options. The ids are untouched: the reply may only name these.
export function planOptions(options) {
    return options.map((option) => ({ id: option.id, description: clip(option.description, PROMPT_LIMITS.option_description) }));
}

// The estimated size of the whole prompt the broker will send.
export function estimatePromptTokens({ agent, context, options }) {
    return buildPlannerMessages({ agent, context, options }).reduce((sum, message) => sum + estimateTokens(message.content), 0);
}

// Builds the context for one planning call.
//   agent, role        who the agent is ("builder")
//   trigger            { kind, detail }: why the planner is asked now
//   view               the world view (genesis/catalog/templates.js)
//   home_distance      blocks from home
//   long_term          [{ title }]   the agent's long-term goals
//   last_outcome       { title, outcome, reason } of the goal that ended last, or null
//   routine            { name, phase } the routine the agent was on, or null
//   memory             the agent's memory text ('' until the memory step is built)
//   options            what catalog.offer() returned (measured here, listed by the broker)
// Returns { context, options: [{ id, description }], tokens: { total, memory_reserved, limit } }.
// Lines are dropped, least important first, until the prompt fits; the options never are.
export function buildPlanContext({
    agent, role = null, trigger = null, view, home_distance = null, long_term = [], last_outcome = null,
    routine = null, memory = '', options = [],
} = {}) {
    const listed = planOptions(options);
    const position = view.position();
    const inventory = Object.entries(view.inventory()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const light = view.dayTicksLeft();
    const memory_text = clip(memory, Math.floor(PROMPT_LIMITS.memory_tokens * CHARS_PER_TOKEN) - 10) || MEMORY_SLOT_EMPTY;

    // [importance, line]: 0 always stays
    const lines = [
        [0, `You are ${agent}${role ? `, the ${role}` : ''}.`],
        [0, `Asked because: ${describeTrigger(trigger)}`],
        [0, `At ${Math.round(position.x)}, ${Math.round(position.y)}, ${Math.round(position.z)}`
            + `${Number.isFinite(home_distance) ? `, ${Math.round(home_distance)} blocks from home` : ''}. `
            + `Health ${Math.round(view.health())}/20, food ${Math.round(view.food())}/20, ${view.freeSlots()} free slots. `
            + `${light > 0 ? `Day, ${Math.round(light / 1200)} min of light left` : 'Night'}.`],
    ];
    if (last_outcome) {
        lines.push([1, `Last goal: ${clip(last_outcome.title, 60)}: ${last_outcome.outcome}${last_outcome.reason ? ` (${clip(last_outcome.reason, 60)})` : ''}.`]);
    }
    if (long_term.length > 0) {
        lines.push([2, `Long-term goals: ${long_term.slice(0, 3).map((goal, i) => `${i + 1}) ${clip(goal.title, 60)}`).join('; ')}.`]);
    }
    if (inventory.length > 0) {
        lines.push([3, `Carrying: ${inventory.slice(0, 4).map(([item, count]) => `${count} ${item}`).join(', ')}${inventory.length > 4 ? ', ...' : ''}.`]);
        if (inventory.length > 4) {
            lines.push([5, `Also carrying: ${inventory.slice(4, 12).map(([item, count]) => `${count} ${item}`).join(', ')}.`]);
        }
    }
    if (routine) lines.push([4, `Was on the routine "${routine.name}", phase ${routine.phase}.`]);

    // the memory slot: always there, always counted as its full reserved share
    const memory_line = `Memory: ${memory_text}`;
    const limit = PROMPT_LIMITS.total_tokens - PROMPT_LIMITS.memory_tokens;
    const render = (kept) => [...kept.map(([, line]) => line), memory_line].join('\n');
    const sizeWithoutMemory = (kept) => estimatePromptTokens({ agent, context: kept.map(([, line]) => line).join('\n'), options: listed })
        + estimateTokens('Memory: ');

    let kept = lines;
    for (let drop = 5; drop >= 1 && sizeWithoutMemory(kept) > limit; drop--) kept = kept.filter(([importance]) => importance < drop);
    const used = sizeWithoutMemory(kept);
    return {
        context: render(kept),
        options: listed,
        tokens: { total: used + PROMPT_LIMITS.memory_tokens, memory_reserved: PROMPT_LIMITS.memory_tokens, limit: PROMPT_LIMITS.total_tokens },
    };
}

export function describeTrigger(trigger) {
    const detail = trigger?.detail ?? {};
    switch (trigger?.kind) {
        // every goal that ends asks (also while others still wait): the planner is told which one it was
        case 'goal_complete': return detail.option_id
            ? `a goal ended (${clip(detail.option_id, 40)}, ${clip(detail.outcome ?? 'completed', 12)}).`
            : 'the goals you had are finished.';
        case 'step_failed': return `a goal failed (${clip(detail.reason ?? 'unknown', 40)}).`;
        // (a death only asks when a goal the planner or the operator chose was given up over it: genesis/agent/runtime.js)
        case 'reflex_interrupt': return detail.cause === 'death'
            ? `you died${detail.gave_up ? `, and the goal you were on was given up (${clip(detail.gave_up, 40)})` : ''}.`
            : 'a reflex interrupted what you were doing.';
        case 'agent_request': return `${clip(detail.from ?? 'another agent', 20)} asks: "${clip(detail.text ?? '', PROMPT_LIMITS.operator_message)}"`;
        case 'operator_message': return `the operator${detail.from ? ` (${clip(detail.from, 20)})` : ''} says: "${clip(detail.text ?? '', PROMPT_LIMITS.operator_message)}"`;
        case 'model_returned': return 'the planner is back; you were working from your routine.';
        case 'request_declined': return `${clip(detail.to ?? 'the other agent', 20)} declined your request${detail.item ? ` for ${detail.count ?? ''} ${clip(detail.item, 30)}`.replace('  ', ' ') : ''}.`;
        case 'request_expired': return `${clip(detail.to ?? 'the other agent', 20)} did not answer your request${detail.item ? ` for ${detail.count ?? ''} ${clip(detail.item, 30)}`.replace('  ', ' ') : ''} in time.`;
        default: return 'it is time to choose what to do next.';
    }
}
