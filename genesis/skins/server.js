// Genesis: the skin service in the MindServer process (the launcher starts it with planning).
// The dashboard hands it a skin over the socket it already has; the commands go to the
// Minecraft server over RCON (genesis/world/rcon.js, the bootstrap's path), and every outcome
// is an event under the name "skins" through the one central publisher.
//
//   genesis-skin-apply   ({ agent, png_base64, variant? }, ack)  -> ack({ ok, ... } | { ok: false, reason })
//   genesis-skin-clear   ({ agent }, ack)
//   genesis-skin-known   ({ agent, sha256 })     the dashboard says what it has stored (after a restart)
//   login-agent          (name)                  upstream's own: the agent is in the game again, its skin is applied again
//
// RCON: GENESIS_RCON_PASSWORD and GENESIS_RCON_HOST (GENESIS_RCON_PORT, default 25575) from the
// launcher's environment. Without the password the service answers "no_rcon".
// The signer (the way a PNG gets to an address the signing service can fetch) is NOT built:
// it is an injected interface, and without one a skin is stored by the dashboard and not applied.

import { createEmitter } from '../events/agent_emit.js';
import { createSkinService } from './skins.js';

export const SKINS_EVENT_AGENT = 'skins';

// A RCON connection made for each command and closed after it: skins change rarely.
export function rconOnDemand({ host, port, password, createClient }) {
    return {
        async send(command) {
            const { createRconClient } = createClient ? { createRconClient: createClient } : await import('../world/rcon.js');
            const client = createRconClient({ host, port, password });
            try { await client.connect(); return await client.send(command); } finally { client.end(); }
        },
    };
}

export function startSkins({ event_sink = null, agents = null, rcon = null, signer = null, clock = null, emit = null } = {}) {
    const emitter = event_sink ? createEmitter({ agent: SKINS_EVENT_AGENT, send: event_sink, ...(clock ? { now: clock.now } : {}) }) : null;
    const service = createSkinService({ rcon, signer, agents, emit: emit ?? (emitter ? emitter.emit : () => null), ...(clock ? { clock } : {}) });
    return {
        service,
        attach(socket, { isAgentSocket = () => false } = {}) {
            const answer = (ack, result) => { if (typeof ack === 'function') ack(result); };
            socket.on('genesis-skin-apply', async (message, ack) => {
                let png = null;
                try { png = Buffer.from(String(message?.png_base64 ?? ''), 'base64'); } catch { /* checked below */ }
                answer(ack, await service.apply({ agent: message?.agent, png, variant: message?.variant ?? 'classic' }));
            });
            socket.on('genesis-skin-clear', async (message, ack) => { answer(ack, await service.clear(message?.agent)); });
            socket.on('genesis-skin-known', (message) => { if (typeof message?.sha256 === 'string') service.remember(message.agent, message.sha256); });
            socket.on('login-agent', (name) => { if (typeof name === 'string' && isAgentSocket(name)) service.onLogin(name).catch(() => {}); });
        },
    };
}
