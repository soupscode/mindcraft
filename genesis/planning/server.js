// Genesis: switches planning on in the MindServer process. Called by the launcher
// (genesis/start.js) only when the genesis_planning setting has "enabled": true; otherwise
// this file is never loaded and the MindServer knows nothing about planning.
//
// It builds the planner host (the broker with its model gate, queue and budget) around the
// thin Ollama client, gives it the stores, and adds its socket handlers to the MindServer.
//
// NOT RUN AGAINST A REAL OLLAMA OR POSTGRES. The tests start it with stand-ins for both.

import { createPlanningHost, createHostGoalStorage } from './host.js';
import { createOllamaPlanner } from '../broker/ollama_planner.js';
import { createEmitter } from '../events/agent_emit.js';
import { createSharedLedger, createLedgerFile } from '../catalog/shared_ledger.js';
import { DEFAULT_LEDGER_FILE } from '../agent/hooks.js';

// The name the broker's own events (the model gate opening and closing) are published under.
export const BROKER_EVENT_AGENT = 'planner';

// Keeps the newest call records in memory when no database is configured.
export function memoryCallStore(max = 500) {
    const records = [];
    return {
        records,
        record(call) {
            records.push(call);
            if (records.length > max) records.shift();
        },
    };
}

// planning: the genesis_planning setting
// event_sink: where events go when the genesis_events setting is on (the hub's accept), or null
// Injectable for the tests: setSocketExtension, createModel, createPool, clock, files.
export async function startPlanning(planning, { event_sink = null, setSocketExtension, createModel = createOllamaPlanner, createPool, clock, files = null, warn = console.warn } = {}) {
    if (!setSocketExtension) ({ setSocketExtension } = await import('../../src/mindcraft/mindserver.js'));
    const log = (event, message) => warn(JSON.stringify({ ts: new Date().toISOString(), level: 'warn', event, message }));

    // the ONE chest ledger of all agents lives in this process, and in one file
    if (!files) files = (await import('../store/node_files.js')).nodeFiles();
    let ledger_file = null;
    const ledger = createSharedLedger({ ...(clock ? { clock } : {}), onChange: () => ledger_file?.schedule() });
    ledger_file = createLedgerFile({ ledger, files, file: planning.ledger_file || DEFAULT_LEDGER_FILE, ...(clock ? { clock } : {}), warn: (message) => log('genesis_chest_ledger', message) });
    await ledger_file.load();

    let calls = memoryCallStore();
    let durable = null;
    if (typeof planning.postgres_url === 'string' && planning.postgres_url.length > 0) {
        try {
            const pg = await import('../adapters/pg_stores.js');
            const pool = await (createPool ?? pg.createPgPool)({ url: planning.postgres_url });
            calls = pg.pgCallStore(pool);
            durable = pg.pgGoalStorage(pool);
        } catch (err) {
            // no database: calls and goals are kept in memory, and lost when this process ends
            warn(JSON.stringify({ ts: new Date().toISOString(), level: 'warn', event: 'genesis_planning_no_database', message: String(err?.message ?? err) }));
        }
    }
    const emitter = event_sink ? createEmitter({ agent: BROKER_EVENT_AGENT, send: event_sink }) : null;
    const host = createPlanningHost({
        model: createModel({ url: planning.model.url, model: planning.model.model, options: planning.model.options ?? null }),
        calls,
        goal_storage: createHostGoalStorage({ durable, warn: (message) => log('genesis_goal_storage', message) }),
        ledger,
        emit: emitter ? emitter.emit : () => {},
        ...(clock ? { clock } : {}),
    });
    setSocketExtension((socket, helpers) => host.attach(socket, helpers));
    // the broker does not know whether the desktop is there: it asks once now, and keeps asking
    host.start().catch(() => {});
    host.ledger_file = ledger_file;
    return host;
}
