// Genesis: the town service in the MindServer process (the launcher starts it with planning).
// It holds the ONE town (genesis/town/town.js), joins it to the agent processes, and is what
// the dashboard's Town screen talks to over the socket it already has to this process.
//
//   agents       genesis-town-sync, genesis-town-op, genesis-town-update   (genesis/town/town.js)
//   operator     genesis-town-view      ({}, ack)                 -> ack({ ok, view })    everything the Town screen shows
//                genesis-town-operator  (op, ack)                 -> ack({ ok } | { ok: false, reason })
//                    { kind: 'move', id, min: [x, y, z] } | { kind: 'remove', id }        a plot or a span code proposed
//                    { kind: 'limit', min: [x, z], max: [x, z] }                          the town limit
//                    { kind: 'goal', agent, titles: [..] | null }                         long-term goals (genesis/town/goals.js)
//                genesis-prefab-import  ({ name, title?, kind?, file_base64, substitute?, save? }, ack)
//                    -> ack({ ok, report, prefab: { name, title, tier, size, cells, materials }, saved })
//                    an operator's schematic, converted (genesis/build/schematic.js). Nothing is guessed:
//                    what cannot be carried over is in the report. Saved to the operator's prefab folder
//                    only with save: true, and only when it holds as a prefab.
// Only the network decides who may reach these (LAN / Tailscale: decided for all controls).
//
// Depends only on other Genesis files.

import path from 'node:path';
import { createEmitter } from '../events/agent_emit.js';
import { createTown } from './town.js';
import { createTownFile, DEFAULT_TOWN_FILE } from './town_file.js';
import { townView, importPrefab } from './views.js';
import { createHomes } from './homes.js';
import { createTownGoals } from './goals.js';

export const TOWN_EVENT_AGENT = 'town';

// planning: the genesis_planning setting. zones_config: the world file's content (read by the launcher).
// ledger: the shared chest ledger (what the town holds). goal_storage: the host's goal storage (long-term goals).
export async function startTown(planning, {
    zones_config, prefabs, files, event_sink = null, emit = null, clock = null, agents = null, store = null, ledger = null, roles = {},
    world_sha256 = null, operator_dir = null, warn = console.warn, goal_storage = null, broker = null,
} = {}) {
    const emitter = event_sink ? createEmitter({ agent: TOWN_EVENT_AGENT, send: event_sink, ...(clock ? { now: clock.now } : {}) }) : null;
    const say = emit ?? (emitter ? emitter.emit : () => null);
    const log = (message) => { try { warn(JSON.stringify({ ts: new Date().toISOString(), level: 'warn', event: 'genesis_town', message })); } catch { /* nothing more to do */ } };
    const file = createTownFile({ files, file: planning?.town_file || DEFAULT_TOWN_FILE });
    const town = createTown({ file, zones_config, prefabs, emit: say, warn: log, store, world_sha256, ...(agents ? { agents } : {}), ...(clock ? { clock } : {}) });
    const loaded = await town.load();
    const homes = createHomes({ town, zones_config, prefabs, ...(clock ? { clock } : {}) });
    const goals = createTownGoals({ town, prefabs, roles, agents: agents ?? Object.keys(zones_config.agents ?? {}), emit: say, ...(clock ? { clock } : {}) });
    let chest_ledger = ledger;
    const stock = () => { try { return chest_ledger?.stock?.('shared') ?? chest_ledger?.view?.('shared')?.items ?? {}; } catch { return {}; } };
    const view = () => townView({ town, prefabs, stock: stock(), roles, zones_config, goals });
    const service = {
        town, homes, goals, loaded, view,
        attach(socket, helpers = {}) {
            town.attach(socket, helpers);
            goals.attach(socket, helpers);
            const answer = (ack, result) => { if (typeof ack === 'function') { try { ack(result); } catch { /* the socket is gone */ } } };
            socket.on('genesis-town-view', (message, ack) => {
                try { answer(typeof message === 'function' ? message : ack, { ok: true, view: view() }); } catch (err) { answer(typeof message === 'function' ? message : ack, { ok: false, reason: String(err?.message ?? err) }); }
            });
            socket.on('genesis-town-operator', async (op, ack) => {
                try {
                    if (op?.kind === 'goal') answer(ack, await goals.override(op.agent, op.titles ?? null));
                    else answer(ack, town.operator(op));
                } catch (err) { answer(ack, { ok: false, reason: String(err?.message ?? err) }); }
            });
            socket.on('genesis-prefab-import', async (message, ack) => {
                try {
                    answer(ack, await importPrefab({ ...message, prefabs, files, dir: operator_dir ?? path.resolve('./bots/genesis_prefabs/operator'), ...(clock ? { now: clock.now() } : {}) }));
                    if (message?.save === true) town.update(() => {}, null); // the ladder has one more prefab: everybody is told
                } catch (err) { answer(ack, { ok: false, reason: String(err?.message ?? err) }); }
            });
        },
        // what follows from this process's other parts: the broker (the model sets long-term goals), the goal storage
        bind(more = {}) {
            goals.bind(more);
            if (more.ledger) chest_ledger = more.ledger;
            if (more.store) town.setStore(more.store);
        },
        stop() { goals.stop(); },
    };
    if (broker || goal_storage) service.bind({ broker, goal_storage });
    return service;
}
