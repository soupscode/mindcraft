// Genesis: lets the action wrapper learn whether the skills an action ran succeeded.
// Skills return true/false, but the upstream command definitions call them as
// `await skills.x(...)` and drop the value. Instead of editing every command, the
// skills module is wrapped once, and each boolean a skill returns is recorded for
// the action that is running at that moment (tracked per async call chain, so
// modes or overlapping actions cannot mix their results).
// Depends only on Node built-ins.

import { AsyncLocalStorage } from 'node:async_hooks';

const current_action = new AsyncLocalStorage();

function record(skill, value) {
    const returns = current_action.getStore();
    if (returns && typeof value === 'boolean') {
        returns.push({ skill: String(skill), ok: value });
    }
}

// Returns a stand-in for the skills module that behaves the same, and also
// records every boolean a skill returns (or resolves to).
export function trackSkillReturns(skills) {
    return new Proxy(skills, {
        get(target, prop) {
            const value = target[prop];
            if (typeof value !== 'function') return value;
            return (...args) => {
                const result = value(...args);
                if (result && typeof result.then === 'function') {
                    return result.then((resolved) => {
                        record(prop, resolved);
                        return resolved;
                    });
                }
                record(prop, result);
                return result;
            };
        }
    });
}

// Runs one action function. Resolves to false if the function itself returned
// false or any tracked skill it ran returned false, otherwise to true.
// An exception passes through untouched (the action manager reports it).
export async function runWithSkillTracking(actionFn) {
    const returns = [];
    const returned = await current_action.run(returns, actionFn);
    return returned !== false && !returns.some((r) => r.ok === false);
}
