// Genesis: builds the decision loop of one real agent (genesis/agent/runtime.js) on top of
// upstream's Agent: its mineflayer bot, its action manager and its socket to the MindServer.
// Loaded only when the genesis_planning setting is on (genesis/agent/hooks.js).
//
// NOT RUN AGAINST A REAL MINECRAFT SERVER, MINDSERVER OR MODEL. This file is the wiring; the
// parts it joins are tested with stand-ins (see genesis/tests).

import pf from 'mineflayer-pathfinder';
import Vec3 from 'vec3';
import * as skills from '../../src/agent/library/skills.js';
import * as world from '../../src/agent/library/world.js';
import * as mc from '../../src/utils/mcdata.js';
import { serverProxy } from '../../src/agent/mindserver_proxy.js';
import { emitEvent, agentEventStats } from '../events/agent_emit.js';
import { loadZones } from '../catalog/zones.js';
import { createCatalog } from '../catalog/catalog.js';
import { createLedgerClient } from '../catalog/ledger_client.js';
import { fileBlueprints } from '../catalog/blueprints.js';
import { createScaffoldTracker } from '../executor/scaffold.js';
import { createCheckpointStore } from '../store/checkpoint.js';
import { nodeFiles } from '../store/node_files.js';
import { socketGoalStorage } from '../planning/host.js';
import { createAgentRuntime } from '../agent/runtime.js';
import { DEFAULT_CHECKPOINT_DIR, DEFAULT_WORLD_FILE } from '../agent/hooks.js';
import { installBotGuards } from '../lib/bot_guards.js';
import { isNoDigPathing } from '../lib/no_dig_pathing.js';
import { createBotView } from './bot_world.js';
import { createBotOps } from './bot_ops.js';

// Blueprints in upstream's construction format (src/agent/npc/construction/<name>.json).
export { fileBlueprints };

const logLine = (record) => console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'warn', ...record }));

export async function buildBotRuntime(agent, settings) {
    const planning = settings.genesis_planning;
    const bot = agent.bot;
    if (!isNoDigPathing(bot)) throw new Error('pathfinding_no_dig is not on for this bot: the Genesis executor does not run without it');
    const loaded = await loadZones({ file: planning.world_file || DEFAULT_WORLD_FILE, read: nodeFiles().read });
    if (!loaded.ok) throw new Error(loaded.problems.join('; '));
    const zones = loaded.zones;
    if (!zones.home(agent.name)) throw new Error(`${agent.name} has no entry under "agents" in the world config`);

    const scaffold = createScaffoldTracker({ zones });
    const guards = installBotGuards(bot, { zones, onPlace: (pos) => scaffold.placed(pos) });
    const socket = serverProxy.getSocket();
    const send = (event, ...args) => {
        if (!socket.connected) throw new Error('not connected to MindServer');
        socket.emit(event, ...args);
    };
    // this agent's copy of the ONE chest ledger, which the MindServer holds
    const ledger = createLedgerClient({ agent: agent.name, send });
    socket.on('genesis-ledger-update', (message) => ledger.onUpdate(message));
    const runtime = createAgentRuntime({
        agent: agent.name,
        zones,
        catalog: createCatalog({ zones, blueprints: fileBlueprints() }),
        view: createBotView(bot, { world, mc, pf, Vec3 }),
        ops: createBotOps(agent, { skills, guards }),
        scaffold,
        goal_storage: socketGoalStorage({ socket }),
        checkpoints: createCheckpointStore({
            files: nodeFiles(), dir: planning.checkpoint_dir || DEFAULT_CHECKPOINT_DIR,
            report: (problem) => logLine({ event: 'genesis_checkpoint_problem', ...problem }),
        }),
        send,
        ledger,
        emit: emitEvent,
        getSeq: () => agentEventStats()?.seq ?? 0,
    });

    socket.on('genesis-plan-context', (request, ack) => runtime.onPlanContext(request, ack));
    socket.on('genesis-plan-queued', (message) => runtime.onPlanQueued(message));
    socket.on('genesis-plan-result', (result) => { runtime.onPlanResult(result).catch((err) => logLine({ event: 'genesis_plan_result_error', message: String(err?.message ?? err) })); });
    socket.on('genesis-gate', (message) => runtime.onGate(message));

    // a death: upstream stops the action (src/agent/agent.js, the 'death' handler); once the bot
    // stands again the runtime gives up the goal in hand and the routine applies its death rule
    bot.on('death', () => {
        const at = bot.entity?.position;
        const point = at ? { x: at.x, y: at.y, z: at.z } : null;
        const failed = (err) => logLine({ event: 'genesis_death_error', message: String(err?.message ?? err) });
        runtime.executor.abandon('died').catch(failed); // at once: no step of the old goal is tried again while the bot is down
        bot.once('spawn', () => { runtime.died(point).catch(failed); });
    });
    return runtime;
}
