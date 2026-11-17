// Genesis: switches recovery on in the MindServer process. Called by the launcher
// (genesis/start.js) only when the genesis_planning setting is on and the genesis_recovery
// setting does not say "enabled": false; otherwise this file is never loaded, and upstream
// restarts agent processes by its own rule (src/process/agent_process.js).
//
// It puts the supervisor (genesis/recovery/supervisor.js) in charge of what happens when an
// agent process ends, tells it when an agent is in the game again, and turns the model
// gate's changes into the model.away and model.available incident events.
//
// NOT RUN AGAINST REAL AGENT PROCESSES. The tests drive the supervisor with stand-ins.

import { createRestartSupervisor } from './supervisor.js';
import { modelAwayData, modelAvailableData } from './incidents.js';
import { createEmitter } from '../events/agent_emit.js';
import { createUlidFactory } from '../shared/events.js';

// The name the supervisor's events are published under. Which agent an incident is about
// is in the event's data: source { type: "agent", name }.
export const RECOVERY_EVENT_AGENT = 'supervisor';

// recovery: the genesis_recovery setting (may be undefined: every value then has its default)
// event_sink: where events go when the genesis_events setting is on (the hub's accept), or null
// Injectable for the tests: setRestartSupervisor, clock.
export async function startRecovery(recovery = {}, { event_sink = null, setRestartSupervisor, clock = null, say = (line) => console.log(line) } = {}) {
    if (!setRestartSupervisor) ({ setRestartSupervisor } = await import('../../src/process/agent_process.js'));
    const emitter = event_sink ? createEmitter({ agent: RECOVERY_EVENT_AGENT, send: event_sink, ...(clock ? { now: clock.now } : {}) }) : null;
    const emit = emitter ? emitter.emit : () => null;
    // (the wait for a Minecraft server that is down is said on the console in plain words, and as an event)
    const supervisor = createRestartSupervisor({ emit, say, ...(clock ? { clock } : {}), ...(recovery?.supervisor ?? {}) });
    setRestartSupervisor(supervisor);

    const nextId = createUlidFactory(clock ? { now: clock.now } : {});
    let away_id = null; // one incident id per model-away period

    return {
        supervisor,
        // Added to every connection to the MindServer (genesis/planning/server.js, `extensions`).
        attach(socket, { isAgentSocket = () => true } = {}) {
            // upstream's own handler ran first (src/mindcraft/mindserver.js, 'login-agent'), so the socket is known as the agent's
            socket.on('login-agent', (name) => { if (typeof name === 'string' && isAgentSocket(name)) supervisor.loggedIn(name); });
        },
        // The model gate changed (genesis/planning/host.js, `onGate`). Away is a normal state:
        // the events have is_failure false, outcome "expected" and severity "info".
        onGate(state, detail = {}) {
            if (state === 'AWAY') {
                away_id = nextId();
                emit('agent.failure', modelAwayData({ incident_id: away_id, reason: detail.reason ?? null }), { severity: 'info', corr: null });
            } else if (state === 'AVAILABLE') {
                emit('agent.recovery', modelAvailableData({ incident_id: away_id ?? nextId(), reason: detail.reason ?? null }), { severity: 'info', corr: null });
                away_id = null;
            }
        },
        stop() { supervisor.close(); },
    };
}
