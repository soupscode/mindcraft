// Genesis: the few places where upstream's agent hands over to the Genesis decision loop.
// Imported by src/agent/agent.js and src/agent/mindserver_proxy.js, so it stays light:
// nothing here loads mineflayer or the adapters until the genesis_planning setting is on.
//
// The setting (in the settings the MindServer gives each agent process):
//   "genesis_planning": { "enabled": true, "world_file": "...", "checkpoint_dir": "...", ... }
// No setting, or "enabled": false (upstream's default): every function here does nothing,
// and Mindcraft asks the model after every action as it always did.
//
// With it on, for that agent:
//   - no model prompt per message or per action: handleMessage hands the message to
//     genesisMessage() instead of prompting (commands the operator types still run)
//   - no self-prompter (its start is switched off, and a saved one is not loaded)
//   - no "Agent process restarted." prompt: the executor loads its checkpoint and resumes
// Depends only on Node built-ins and other Genesis files.

export const DEFAULT_CHECKPOINT_DIR = './bots/genesis_checkpoints';
export const DEFAULT_WORLD_FILE = './genesis/genesis.world.json';

const runtimes = new WeakMap(); // upstream Agent -> its Genesis runtime

export function genesisPlanningOn(settings) {
    return settings?.genesis_planning?.enabled === true;
}

export const genesisRuntimeOf = (agent) => runtimes.get(agent) ?? null;

// The seq of the last event the agent emitted before its process ended, from its checkpoint.
// The event emitter starts from it, so seq goes on instead of starting at 1 again.
// Never throws: 0 when planning is off, there is no checkpoint, or it cannot be read.
export async function genesisLastSeq(name, settings, { store = null } = {}) {
    if (!genesisPlanningOn(settings)) return 0;
    try {
        let checkpoints = store;
        if (!checkpoints) {
            const [{ createCheckpointStore }, { nodeFiles }] = await Promise.all([import('../store/checkpoint.js'), import('../store/node_files.js')]);
            checkpoints = createCheckpointStore({ files: nodeFiles(), dir: settings.genesis_planning.checkpoint_dir || DEFAULT_CHECKPOINT_DIR });
        }
        const loaded = await checkpoints.load(name);
        return loaded.status === 'ok' ? loaded.checkpoint.seq : 0;
    } catch {
        return 0;
    }
}

// Called once the bot has spawned (src/agent/agent.js, _setupEventHandlers). Returns false
// when planning is off: upstream then carries on with its own start-up. With planning on it
// builds the agent's runtime, starts it and returns true; upstream then skips the restart
// prompt, the self-prompter and the greeting.
// `build` is injectable for the tests; the real one is genesis/adapters/bot_agent.js.
export async function startGenesisAgent(agent, settings, { build = null, exit = (code) => process.exit(code) } = {}) {
    if (!genesisPlanningOn(settings)) return false;
    try {
        // the self-prompter is the loop that prompts the model without end: it stays off
        agent.self_prompter.start = () => 'Self-prompting is off: this agent plans through the Genesis planner.';
        agent.self_prompter.handleLoad = async () => {};
        if (!build) ({ buildBotRuntime: build } = await import('../adapters/bot_agent.js'));
        const runtime = await build(agent, settings);
        runtimes.set(agent, runtime);
        const begun = await runtime.start();
        console.log(JSON.stringify({
            ts: new Date().toISOString(), level: 'info', event: 'genesis_agent_started', agent: agent.name,
            resumed: begun?.resumed === true, checkpoint: begun?.load?.status ?? null,
        }));
        runtime.run().catch((err) => console.error('Genesis executor stopped:', err));
    } catch (err) {
        // an agent that is set to plan through Genesis must never fall back to prompting the model
        console.error(`Genesis agent ${agent?.name} could not start:`, err);
        exit(1);
    }
    return true;
}

// A message for the agent that is not a command the operator typed (src/agent/agent.js,
// handleMessage). It never prompts the model. Returns false (no command was used).
//   from the operator (the panel, or chat in the game): a planning trigger carrying the text
//   from another agent: a planning trigger too
//   from the system or the agent itself (restart notes, "you died", "your action was
//   interrupted by ..."): dropped; the executor and the bot's own events cover those
export function genesisMessage(agent, source, message, from_other_bot = false) {
    const runtime = runtimes.get(agent);
    if (!runtime) return false; // not started yet: nothing can be done with it
    if (source === 'system' || source === agent.name) {
        runtime.ignoredMessage();
    } else if (from_other_bot) {
        runtime.agentRequest(source, String(message));
    } else {
        runtime.operatorMessage(source, String(message));
    }
    return false;
}
