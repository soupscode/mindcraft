// Genesis: the step runner of a real bot. It runs one template step as one upstream skill,
// through upstream's own action manager, so interrupts, time-outs and the action log work
// exactly as they do for a command the model used to send.
//
// NOT RUN AGAINST A REAL MINECRAFT SERVER. The tests drive it with a stand-in agent.
//
//   run(command, args, { permit, cleanup }) -> { ok, interrupted, timedout, output }
//     command  a name of genesis/catalog/ops.js: called as skills[command](bot, ...args)
//     permit   { dig: (pos) -> true where digging stays forbidden, no_place } or null
//              (genesis/lib/no_dig_pathing.js; only a gather step is ever given `dig`)
//
// A step never cuts into something else the bot is doing: it waits until the agent is idle
// (a reflex, or a command the operator typed), because starting an action stops the one
// that runs (src/agent/action_manager.js, _executeAction).
//
// Injected: skills (src/agent/library/skills.js), guards (genesis/lib/bot_guards.js), sleep.
// Depends only on other Genesis files.

import { UPSTREAM_OPS } from '../catalog/ops.js';
import { withPathingPermit } from '../lib/no_dig_pathing.js';

export const OPS_DEFAULTS = Object.freeze({
    idle_wait_ms: 300,
    idle_patience_ms: 2 * 60 * 1000,
    // upstream's action manager counts actions that start within 20 ms of each other as a runaway
    // loop and ends the process after a few (src/agent/action_manager.js, _executeAction)
    min_start_gap_ms: 60,
});

export function createBotOps(agent, { skills, guards = null, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), ...options } = {}) {
    const config = { ...OPS_DEFAULTS, ...options };
    const NOT_RUN = (output) => ({ ok: false, interrupted: false, timedout: false, output });
    let last_start = 0;

    return {
        async run(command, args, { permit = null } = {}) {
            const op = UPSTREAM_OPS[command];
            if (!op || typeof skills[command] !== 'function') return NOT_RUN(`!!Code threw exception!!\nError: ${command} is not a skill a Genesis step may call`);
            for (let waited = 0; !agent.isIdle(); waited += config.idle_wait_ms) {
                // something else has the bot: come back to this step later, it is not a failure
                if (waited >= config.idle_patience_ms) return { ok: false, interrupted: true, timedout: false, output: '' };
                await sleep(config.idle_wait_ms);
            }
            const since = Date.now() - last_start;
            if (since < config.min_start_gap_ms) await sleep(config.min_start_gap_ms - since);
            last_start = Date.now();
            const bot = agent.bot;
            const step = async () => {
                // inside a zone only the cell this step names may be broken (a crop, ground on a plot, own scaffold)
                guards?.allowBreak(command === 'breakBlockAt' ? { x: args[0], y: args[1], z: args[2] } : null);
                try {
                    const call = () => skills[command](bot, ...args);
                    const returned = permit ? await withPathingPermit(bot, permit, call) : await call();
                    return returned !== false; // upstream skills answer true or false
                } finally {
                    guards?.allowBreak(null);
                }
            };
            step.own_events = true; // the executor emits skill.started and skill.result for its steps itself
            step.args = args;
            const result = await agent.actions.runAction(`action:genesis_${command}`, step, { timeout: op.timeout_min });
            return {
                ok: result?.ok === true && result?.interrupted !== true,
                interrupted: result?.interrupted === true,
                timedout: result?.timedout === true,
                output: String(result?.output ?? ''),
            };
        },
    };
}
