// The socket to the MindServer (socket.io, as its own panel uses).
//
// NOT RUN AGAINST THE REAL MINDSERVER in the tests: they use a recording stand-in for the
// MindLink interface of controls.ts.
//
// It listens to two things the MindServer already sends to any panel: "agents-status"
// (which processes exist, which are in the game) and, after "listen-to-agents", the
// "state-update" it sends every second (position, health, food, the action in hand).

import type { ProcessStatus } from '../shared/types.js';
import type { MindLink } from './controls.js';
import type { Live } from './live.js';

export async function createMindLink({ url, live }: { url: string; live: Live }): Promise<MindLink & { close(): void }> {
    const { io }: any = await import('socket.io-client');
    const socket = io(url, { reconnection: true, reconnectionDelayMax: 10000, timeout: 5000 });
    const status = new Map<string, ProcessStatus>();

    const publish = () => live.setProcesses([...status.values()].map((agent) => ({ ...agent })));
    const whole = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null);

    socket.on('connect', () => { live.setHealth({ mindserver_ok: true }); socket.emit('listen-to-agents'); });
    socket.on('disconnect', () => { live.setHealth({ mindserver_ok: false }); live.setProcesses(null); status.clear(); });
    socket.on('connect_error', () => { live.setHealth({ mindserver_ok: false }); });

    socket.on('agents-status', (agents: any[]) => {
        if (!Array.isArray(agents)) return;
        const seen = new Set<string>();
        for (const agent of agents) {
            if (typeof agent?.name !== 'string') continue;
            seen.add(agent.name);
            const before = status.get(agent.name);
            const in_game = agent.in_game === true;
            status.set(agent.name, {
                name: agent.name, in_game, socket_connected: agent.socket_connected === true,
                pos: in_game ? before?.pos ?? null : null, health: in_game ? before?.health ?? null : null,
                food: in_game ? before?.food ?? null : null, action: in_game ? before?.action ?? null : null,
            });
        }
        for (const name of [...status.keys()]) if (!seen.has(name)) status.delete(name);
        publish();
    });

    socket.on('state-update', (states: Record<string, any>) => {
        if (!states || typeof states !== 'object') return;
        for (const [name, state] of Object.entries(states)) {
            const known = status.get(name);
            if (!known || !state || state.error) continue;
            const p = state.gameplay?.position;
            const x = whole(p?.x), y = whole(p?.y), z = whole(p?.z);
            known.pos = x !== null && y !== null && z !== null ? [x, y, z] : null;
            known.health = whole(state.gameplay?.health);
            known.food = whole(state.gameplay?.hunger);
            known.action = typeof state.action?.current === 'string' ? state.action.current.slice(0, 80) : null;
        }
        publish();
    });

    return {
        connected: () => socket.connected === true,
        emit: (event, ...args) => { socket.emit(event, ...args); },
        ask: (event, arg, timeout_ms = 5000) => new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('the MindServer did not answer')), timeout_ms);
            socket.emit(event, arg, (answer: any) => { clearTimeout(timer); resolve(answer); });
        }),
        close: () => { socket.close(); },
    };
}
