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
//   - only the operator is listened to (genesisHears): a message from the panel always counts
//     as the operator's; in the game only the Minecraft usernames listed under
//     "genesis_planning.operators" do. Whatever any other player says is ignored and counted.
//     Another agent's message is never the operator's.
//   - the operator's !stop HOLDS the executor (genesisOperatorCommand) until the operator
//     types !resume, a command that only exists for an agent with planning on (resumeCommand)
//   - recovery (genesis/recovery; on with planning unless "genesis_recovery": { "enabled": false }):
//     upstream's own stuck detection no longer kills the process, it is handed to the
//     watchdog's ladder (genesisStuck); the process ends with an exit code that says why
//     (genesisDisconnectCode, genesisExitCode), so the supervisor in the MindServer process
//     can wait for a server that is down, send a refused login to the operator, and not count
//     a restart that was asked for (genesisIntendedRestart) as a crash
//   - no restart after smelting (src/agent/commands/actions.js asks genesisPlanningOn)
//   - agent-to-agent talk goes ONLY through the structured relay (genesis/relay; on with planning
//     unless "genesis_relay": { "enabled": false }): upstream's free-text conversation commands
//     stay blocked, and what another agent says in chat is never listened to (genesisHears)
// Depends only on Node built-ins and other Genesis files.

import { EXIT_CODES, exitCodeForDisconnect } from '../recovery/exit_codes.js';

export const DEFAULT_CHECKPOINT_DIR = './bots/genesis_checkpoints';
export const DEFAULT_WORLD_FILE = './genesis/genesis.world.json';
export const DEFAULT_LEDGER_FILE = './bots/genesis_ledger/chest_ledger.json';

export const STOP_COMMAND = '!stop';     // upstream's (src/agent/commands/actions.js): with planning on it also holds the executor
export const RESUME_COMMAND = '!resume'; // Genesis's: lets a held executor go on

const runtimes = new WeakMap(); // upstream Agent -> its Genesis runtime
const from_panel = new WeakSet(); // agents a message from the panel is being handed to right now
const chat_stats = new WeakMap(); // upstream Agent -> { panel, operator, ignored, ignored_by: Map(name -> count) }
const resumed_by = new WeakMap(); // upstream Agent -> who typed the !resume that is being carried out

function chatStatsOf(agent) {
    if (!chat_stats.has(agent)) chat_stats.set(agent, { panel: 0, operator: 0, ignored: 0, ignored_by: new Map() });
    return chat_stats.get(agent);
}

// Who was listened to and who was not, for one agent: { panel, operator, ignored, ignored_by: { name: count } }.
export function genesisChatStats(agent) {
    const stats = chatStatsOf(agent);
    return { panel: stats.panel, operator: stats.operator, ignored: stats.ignored, ignored_by: Object.fromEntries(stats.ignored_by) };
}

// Hands a message from the panel to the agent (src/agent/mindserver_proxy.js, 'send-message').
// The panel is the operator's, whatever name the message carries. The mark only lasts for
// the call itself: a whisper that arrives a moment later is judged by its sender again.
export function asPanelMessage(agent, deliver) {
    if (!agent) return deliver();
    from_panel.add(agent);
    try {
        return deliver();
    } finally {
        from_panel.delete(agent);
    }
}

// Asked first thing when a message reaches the agent (src/agent/agent.js, respondFunc):
// is this sender listened to? With planning off: always (upstream's behaviour).
// With planning on: the panel, and in the game only a listed operator. Another agent's
// whisper is let through to upstream, which drops it there; it is never the operator's.
export function genesisHears(agent, settings, username, is_other_agent = false) {
    if (!genesisPlanningOn(settings)) return true;
    const stats = chatStatsOf(agent);
    if (from_panel.has(agent)) { stats.panel++; return true; }
    if (is_other_agent) return true;
    const operators = Array.isArray(settings.genesis_planning.operators) ? settings.genesis_planning.operators : [];
    if (typeof username === 'string' && operators.includes(username)) { stats.operator++; return true; }
    stats.ignored++;
    const name = String(username).slice(0, 40);
    stats.ignored_by.set(name, (stats.ignored_by.get(name) ?? 0) + 1);
    if (stats.ignored_by.size > 50) stats.ignored_by.delete(stats.ignored_by.keys().next().value);
    try { runtimes.get(agent)?.ignoredChat?.(name); } catch { /* counting must never break the chat handler */ }
    return false;
}

// Called right BEFORE a command the operator typed is carried out (src/agent/agent.js,
// handleMessage). !stop: the executor is put on hold first, so the step the stop interrupts
// is not retried and nothing new starts until !resume. Does nothing with planning off.
export function genesisOperatorCommand(agent, source, command_name) {
    const runtime = runtimes.get(agent);
    if (!runtime) return;
    if (command_name === STOP_COMMAND) {
        Promise.resolve(runtime.hold?.({ by: String(source), reason: 'operator_stop' })).catch((err) => console.error('Genesis hold failed:', err));
    } else if (command_name === RESUME_COMMAND) {
        resumed_by.set(agent, String(source));
    }
}

// The !resume command, in the shape of upstream's commands (src/agent/commands/actions.js).
// It is only added for an agent with planning on, so upstream's command list is unchanged otherwise.
export function resumeCommand() {
    return {
        name: RESUME_COMMAND,
        description: 'Resume the Genesis executor after !stop held it. The agent carries on with the step it was held at.',
        perform: async function (agent) {
            const runtime = runtimes.get(agent);
            const by = resumed_by.get(agent) ?? 'operator';
            resumed_by.delete(agent);
            if (!runtime?.resume) return 'There is nothing to resume.';
            return (await runtime.resume({ by })) ? 'Agent resumed.' : 'The agent was not held.';
        },
    };
}

export function genesisPlanningOn(settings) {
    return settings?.genesis_planning?.enabled === true;
}

export const genesisRuntimeOf = (agent) => runtimes.get(agent) ?? null;

// ---- recovery ----

// Recovery goes with planning: it is on whenever planning is, unless the genesis_recovery
// setting says "enabled": false (then upstream's own stuck detection and exit codes are back).
export function genesisRecoveryOn(settings) {
    return genesisPlanningOn(settings) && settings.genesis_recovery?.enabled !== false;
}

// Upstream's stuck detection fired (src/agent/modes.js, the "unstuck" mode, which would run
// moveAway and kill the process after 10 seconds). Returns false with recovery off: upstream
// then does what it always did. With it on the watchdog is told, and nothing is killed.
export function genesisStuck(agent, settings) {
    if (!genesisRecoveryOn(settings)) return false;
    try { runtimes.get(agent)?.stuck?.('upstream_unstuck'); } catch { /* telling the watchdog must never break the mode loop */ }
    return true;
}

// The exit code of a process whose connection to the Minecraft server ended
// (src/agent/agent.js). `type` is what upstream's parseKickReason made of the reason
// (src/agent/connection_handler.js). With recovery off: `code`, as upstream has it.
export function genesisDisconnectCode(settings, type, code = 1) {
    if (!genesisRecoveryOn(settings)) return code;
    const mapped = exitCodeForDisconnect(type);
    return mapped === EXIT_CODES.CRASH ? code : mapped;
}

// Agent messages go with planning too: on whenever planning is, unless the genesis_relay
// setting says "enabled": false (then agents do not message each other at all).
export function genesisRelayOn(settings) {
    return genesisPlanningOn(settings) && settings.genesis_relay?.enabled !== false;
}

const intended_restart = new WeakSet(); // agents whose process is about to end because somebody asked for a restart

// Called right before a restart somebody asked for (the operator's !restart, the panel's
// restart button). `settings` may be null: then the agent's own settings decide in genesisExitCode.
export function genesisIntendedRestart(agent) {
    if (agent) intended_restart.add(agent);
}

// The exit code of cleanKill (src/agent/agent.js). With recovery on, a restart that was asked
// for ends with its own code, so it is never counted as a crash. Otherwise: `code`, unchanged.
export function genesisExitCode(agent, settings, code = 1) {
    if (!genesisRecoveryOn(settings) || !agent || !intended_restart.has(agent)) return code;
    return EXIT_CODES.INTENDED_RESTART;
}

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
// `addCommand` is upstream's (src/agent/commands/index.js): the !resume command is added through it.
export async function startGenesisAgent(agent, settings, { build = null, exit = (code) => process.exit(code), addCommand = null } = {}) {
    if (!genesisPlanningOn(settings)) return false;
    try {
        if (!addCommand) ({ addCommand } = await import('../../src/agent/commands/index.js'));
        addCommand(resumeCommand());
        // the self-prompter is the loop that prompts the model without end: it stays off
        agent.self_prompter.start = () => 'Self-prompting is off: this agent plans through the Genesis planner.';
        agent.self_prompter.handleLoad = async () => {};
        if (!build) ({ buildBotRuntime: build } = await import('../adapters/bot_agent.js'));
        const runtime = await build(agent, settings);
        runtimes.set(agent, runtime);
        const begun = await runtime.start();
        console.log(JSON.stringify({
            ts: new Date().toISOString(), level: 'info', event: 'genesis_agent_started', agent: agent.name,
            resumed: begun?.resumed === true, checkpoint: begun?.load?.status ?? null, held: begun?.held === true,
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
//   from the operator (the panel, or a listed operator's chat in the game: genesisHears
//   has already turned everybody else away): a planning trigger carrying the text
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
