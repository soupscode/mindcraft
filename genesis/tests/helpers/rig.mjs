// One agent with everything the executor needs, on the fake world: zones, catalog, ledger,
// goal store, checkpoint store, a real event emitter that keeps what it emits, the scaffold
// tracker and the executor itself. Used by the executor, planning and routine tests.

import { fakeFiles, fakeGoalStorage } from './fakes.mjs';
import { campWorld, WORLD_CONFIG, HUT } from './fake-world.mjs';
import { createZones } from '../../catalog/zones.js';
import { createCatalog } from '../../catalog/catalog.js';
import { createLedger } from '../../catalog/ledger.js';
import { createGoalStore, goalChangedEventData } from '../../store/goal_store.js';
import { createCheckpointStore } from '../../store/checkpoint.js';
import { createEmitter } from '../../events/agent_emit.js';
import { createScaffoldTracker } from '../../executor/scaffold.js';
import { createExecutor } from '../../executor/executor.js';

export const BLUEPRINTS = { get: (name) => (name === 'hut' ? HUT : null) };

// world, storage and files may be handed in: they are what survives when an agent
// process dies, so a second rig built on them is the agent after its restart.
export function makeRig({
    agent = 'Arthur', clock, world = null, storage = fakeGoalStorage(), files = fakeFiles(), config = WORLD_CONFIG,
    position = { x: 0, y: 64, z: 0 }, inventory = {}, last_seq = 0, catalog_config = {}, executor: executor_options = {},
    blueprints = BLUEPRINTS, zones = null, more_state = () => ({}),
} = {}) {
    const rig = { agent, clock, storage, files, events: [], triggers: [], ended: [] };
    rig.world = world ?? campWorld(clock);
    if (!rig.world.body(agent)) rig.world.addAgent(agent, { position, inventory });
    rig.zones = zones ?? createZones(config);
    rig.catalog = createCatalog({ zones: rig.zones, blueprints, config: catalog_config });
    rig.ledger = createLedger();
    rig.avoid = [];
    rig.emitter = createEmitter({ agent, send: (event) => rig.events.push(event), last_seq, now: clock.now, warn: () => {}, progress_interval_ms: 0 });
    rig.scaffold = createScaffoldTracker({ zones: rig.zones });
    rig.ops = rig.world.ops(agent, { on_place: (pos, how) => { if (how !== 'skill') rig.scaffold.placed(pos, { reflex_torch: how === 'reflex_torch' }); } });
    rig.state = () => ({ agent, view: rig.world.view(agent), ledger: rig.ledger, avoid: rig.avoid, ...more_state() });
    rig.checkpoints = createCheckpointStore({ files, dir: '/checkpoints', clock });
    rig.goals = createGoalStore({
        storage, clock,
        onChange: (change) => rig.emitter.emit('goal.changed', goalChangedEventData(change), { corr: rig.executor?.corr() ?? null }),
    });
    rig.executor = createExecutor({
        agent, catalog: rig.catalog, goals: rig.goals, checkpoints: rig.checkpoints, ops: rig.ops, state: rig.state,
        emit: rig.emitter.emit, getSeq: () => rig.emitter.stats().seq, clock, scaffold: rig.scaffold, zones: rig.zones,
        onTrigger: (trigger) => rig.triggers.push(trigger), onGoalEnd: (end) => rig.ended.push(end),
        ...executor_options,
    });
    // Puts a goal in the queue the way the operator (or a planner reply) would.
    rig.seed = async (option_id, { title = `Do ${option_id}`.slice(0, 60), source = 'operator', call_id = null } = {}) => {
        const pushed = await rig.goals.pushShortTerm(agent, { title, option_id }, { reason: `seeded by the test (${source})`, source, call_id });
        if (!pushed.ok) throw new Error(pushed.error);
        const goal = pushed.goals.short_term[pushed.goals.short_term.length - 1];
        rig.executor.noteGoals([goal], { source, call_id });
        return goal;
    };
    // Runs the executor until it has nothing to do (or `max` things were done). Returns what it did.
    rig.drain = async (max = 400) => {
        const done = [];
        for (let i = 0; i < max; i++) {
            const outcome = await rig.executor.runOnce();
            done.push(outcome);
            if (outcome.kind === 'idle' || outcome.kind === 'store_unavailable' || outcome.kind === 'scaffold_pending') break;
        }
        return done;
    };
    rig.queue = async () => (await rig.goals.get(agent)).goals.short_term;
    rig.eventsOf = (type) => rig.events.filter((event) => event.type === type);
    return rig;
}
