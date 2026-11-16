import type { Goal } from '../shared/types.js';

// Goals as the planner's agent_goals table holds them: [{ id, title, option_id }].
export function goalList(value: unknown): Goal[] {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 3).filter((goal) => goal && typeof goal.title === 'string')
        .map((goal) => ({ id: typeof goal.id === 'string' ? goal.id : undefined, title: goal.title, option_id: typeof goal.option_id === 'string' ? goal.option_id : undefined }));
}
