// Genesis: what the watchdog's ladder moves a real bot with (genesis/recovery/watchdog.js,
// through genesis/agent/runtime.js). Every move goes through upstream's own action manager,
// so starting it stops the step that is running (src/agent/action_manager.js,
// _executeAction, which awaits stop() first), and the executor's next try of the step
// waits until the move is over (genesis/adapters/bot_ops.js waits for agent.isIdle()).
//
// NOT RUN AGAINST A REAL MINECRAFT SERVER. The tests drive it with a stand-in agent.
//
//   interrupt()               stops the running action: the executor tries the step afresh, with a new path search
//   moveAway(blocks)          upstream's moveAway (src/agent/library/skills.js line 1411)
//   surfaceOrHome(home)       walks home (goToPosition, line 1194); when that fails, goes to the
//                             surface (goToSurface, line 1977)
//   restartProcess(reason)    ends the process through upstream's agent.cleanKill (src/agent/agent.js line 543)
//                             with the exit code of a restart the watchdog ordered: the supervisor starts
//                             it again and does NOT count it toward the crash cap (decided: only crashes
//                             count; the ladder's own hourly cap bounds these restarts)
//
// With the pathfinding_no_dig setting on (always, for Genesis) none of these breaks a block.
// Injected: skills (src/agent/library/skills.js).
// Depends only on genesis/recovery/exit_codes.js.

import { EXIT_CODES } from '../recovery/exit_codes.js';

export const RECOVERY_OPS_DEFAULTS = Object.freeze({
    move_timeout_min: 1,
    home_timeout_min: 5,
    arrive_distance: 2,
});

export function createBotRecovery(agent, { skills, ...options } = {}) {
    const config = { ...RECOVERY_OPS_DEFAULTS, ...options };

    async function act(label, fn, timeout) {
        const step = async () => (await fn()) !== false;
        step.args = [];
        const result = await agent.actions.runAction(`recovery:${label}`, step, { timeout });
        return result?.ok === true && result?.interrupted !== true;
    }

    return {
        async interrupt() {
            if (agent.isIdle()) return false; // nothing was running
            await agent.actions.stop();
            return true;
        },
        moveAway: (blocks) => act('move_away', () => skills.moveAway(agent.bot, blocks), config.move_timeout_min),
        surfaceOrHome: (home) => act('surface_or_home', async () => {
            if (home && await skills.goToPosition(agent.bot, home.x, home.y, home.z, config.arrive_distance)) return true;
            return skills.goToSurface(agent.bot);
        }, config.home_timeout_min),
        async restartProcess(reason) {
            agent.cleanKill(`Genesis watchdog: ${reason}. Restarting the agent process.`, EXIT_CODES.WATCHDOG_RESTART);
        },
    };
}
