// Genesis: how an agent process says WHY it ended, so that whoever restarts it (the
// supervisor in the MindServer process, genesis/recovery/supervisor.js) can tell a crash
// from a server that is down, a refused login and a restart that was asked for.
//
// Upstream's own codes (src/process/agent_process.js lines 32-52): 0 and SIGINT are a
// deliberate stop (not restarted), 1 is everything else, and a code above 1 ends the WHOLE
// program ("Ending task", used by the benchmark tasks). The codes below are above 1, so
// they are only ever used by an agent that has the genesis_planning setting on, and
// genesis/start.js puts the supervisor in charge of exits whenever that setting is on.
// No imports.

export const EXIT_CODES = Object.freeze({
    STOP: 0,
    CRASH: 1,
    INTENDED_RESTART: 64,   // a restart somebody asked for (the operator's !restart, the panel): never counted as a crash
    SERVER_DOWN: 65,        // the Minecraft server cannot be reached or closed the connection: wait and reconnect
    LOGIN_REFUSED: 66,      // the server answered and refused the login (whitelist, ban, name in use, version)
});

// What upstream's parseKickReason calls the reason for a disconnect (src/agent/connection_handler.js
// lines 4-40), sorted into what the supervisor does about it.
export const SERVER_DOWN_TYPES = Object.freeze(['network_error', 'maintenance', 'server_full']);
export const LOGIN_REFUSED_TYPES = Object.freeze(['access_denied', 'name_conflict', 'version_mismatch']);

// The exit code for a disconnect of the given type. Anything not listed is a crash (1).
export function exitCodeForDisconnect(type) {
    if (SERVER_DOWN_TYPES.includes(type)) return EXIT_CODES.SERVER_DOWN;
    if (LOGIN_REFUSED_TYPES.includes(type)) return EXIT_CODES.LOGIN_REFUSED;
    return EXIT_CODES.CRASH;
}

// What an exit means: 'stop' | 'intended' | 'server_down' | 'login_refused' | 'crash'.
export function classifyExit({ code = null, signal = null } = {}) {
    if (signal === 'SIGINT' || code === EXIT_CODES.STOP) return 'stop';
    if (code === EXIT_CODES.INTENDED_RESTART) return 'intended';
    if (code === EXIT_CODES.SERVER_DOWN) return 'server_down';
    if (code === EXIT_CODES.LOGIN_REFUSED) return 'login_refused';
    return 'crash';
}
