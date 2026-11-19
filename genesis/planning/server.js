// Genesis: switches planning on in the MindServer process. Called by the launcher
// (genesis/start.js) only when the genesis_planning setting has "enabled": true; otherwise
// this file is never loaded and the MindServer knows nothing about planning.
//
// It builds the planner host (the broker with its model gate, queue and budget) around the
// thin Ollama client, gives it the stores, and adds its socket handlers to the MindServer.
//
// The database is optional (decided: its address comes from the launcher's environment, never
// from the settings file). With one, the tables are made at start (idempotent), and the planner
// call records, the goals and the checkpoint mirror are kept there; without one, or while it
// cannot be reached, everything works from memory and files.
//
// NOT RUN AGAINST A REAL OLLAMA. The tests start it with stand-ins.

import { createPlanningHost, createHostGoalStorage } from './host.js';
import { createOllamaPlanner } from '../broker/ollama_planner.js';
import { createEmitter } from '../events/agent_emit.js';
import { createSharedLedger, createLedgerFile } from '../catalog/shared_ledger.js';
import { DEFAULT_LEDGER_FILE } from '../agent/hooks.js';

// The name the broker's own events (the model gate opening and closing) are published under.
export const BROKER_EVENT_AGENT = 'planner';
// The name the learner's events are published under (experience, learning_update, learning_version).
export const LEARNING_EVENT_AGENT = 'learner';

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
// extensions: more services of the MindServer process that add their handlers to every
//   connection, [(socket, helpers) -> void] (genesis/recovery/server.js, genesis/relay/server.js);
//   upstream has one place for such a function, so they are joined here
// onGate, host: handed to the planning host (genesis/planning/host.js)
// Injectable for the tests: setSocketExtension, createModel, createPool, clock, files.
export async function startPlanning(planning, {
    event_sink = null, setSocketExtension, createModel = createOllamaPlanner, createPool, clock, files = null, warn = console.warn,
    extensions = [], onGate = null, host: host_options = {}, postgres_url = null, migrate = null, migrate_retry_ms = 30 * 1000,
    learning = null,
} = {}) {
    if (!setSocketExtension) ({ setSocketExtension } = await import('../../src/mindcraft/mindserver.js'));
    const log = (event, message) => warn(JSON.stringify({ ts: new Date().toISOString(), level: 'warn', event, message }));

    // the ONE chest ledger of all agents lives in this process, and in one file
    if (!files) files = (await import('../store/node_files.js')).nodeFiles();
    let ledger_file = null;
    const ledger = createSharedLedger({ ...(clock ? { clock } : {}), onChange: () => ledger_file?.schedule() });
    ledger_file = createLedgerFile({ ledger, files, file: planning.ledger_file || DEFAULT_LEDGER_FILE, ...(clock ? { clock } : {}), warn: (message) => log('genesis_chest_ledger', message) });
    await ledger_file.load();

    let calls = memoryCallStore();
    let learning_store = null;
    let durable = null;
    let checkpoint_mirror = null;
    let migrate_timer = null;
    const database = { configured: typeof postgres_url === 'string' && postgres_url.length > 0, connected: false, migrated: false, migrations: [] };
    if (database.configured) {
        try {
            const pg = await import('../adapters/pg_stores.js');
            const pool = await (createPool ?? pg.createPgPool)({ url: postgres_url });
            calls = pg.pgCallStore(pool);
            durable = pg.pgGoalStorage(pool);
            checkpoint_mirror = pg.pgCheckpointMirror(pool);
            if (learning) learning_store = (await import('../learning/store.js')).pgLearningStore(pool);
            database.connected = true;
            // the tables, made at start. A database that is not up yet is tried again: the stores above
            // keep what they can meanwhile (the goal storage waits, a call record that fails is counted)
            const timers = clock ?? { setTimeout, clearTimeout };
            const tables = async () => {
                migrate_timer = null;
                try {
                    database.migrations = await (migrate ?? pg.runStoreMigrations)(pool);
                    database.migrated = true;
                    warn(JSON.stringify({ ts: new Date().toISOString(), level: 'info', event: 'genesis_planning_database_ready', migrations: database.migrations }));
                } catch (err) {
                    log('genesis_planning_migrations_failed', `${String(err?.message ?? err)}; trying again in ${Math.round(migrate_retry_ms / 1000)} s`);
                    migrate_timer = timers.setTimeout(tables, migrate_retry_ms);
                    migrate_timer?.unref?.();
                }
            };
            await tables();
        } catch (err) {
            // no database: calls and goals are kept in memory, and lost when this process ends
            warn(JSON.stringify({ ts: new Date().toISOString(), level: 'warn', event: 'genesis_planning_no_database', message: String(err?.message ?? err) }));
        }
    }
    const emitter = event_sink ? createEmitter({ agent: BROKER_EVENT_AGENT, send: event_sink }) : null;
    // the learner: its rows in the database when there is one; without one in memory, with the count table and the
    // place memory kept in files. The network's weights are files either way.
    let learning_settings = null;
    if (learning) {
        const { memoryLearningStore, withFileState, LEARNING_DIR } = await import('../learning/store.js');
        const dir = learning.dir || LEARNING_DIR;
        const learning_emitter = event_sink ? createEmitter({ agent: LEARNING_EVENT_AGENT, send: event_sink }) : null;
        learning_settings = {
            agents: learning.agents, files, weights_dir: `${dir}/weights`,
            store: learning_store ?? withFileState(memoryLearningStore(), { files, dir }),
            emit: learning_emitter ? learning_emitter.emit : () => {},
            warn: (message) => log('genesis_learning', message),
            ...(Number.isFinite(learning.seed) ? { seed: learning.seed } : {}),
            ...(learning.scorer ? { scorer: learning.scorer } : {}), ...(learning.rules ? { rules: learning.rules } : {}), ...(learning.service ? { service: learning.service } : {}),
            world_sha256: learning.world_sha256 ?? null, roles: learning.roles ?? {},
        };
    }
    const host = createPlanningHost({
        model: createModel({ url: planning.model.url, model: planning.model.model, options: planning.model.options ?? null }),
        calls,
        goal_storage: createHostGoalStorage({ durable, warn: (message) => log('genesis_goal_storage', message) }),
        ledger,
        checkpoint_mirror,
        emit: emitter ? emitter.emit : () => {},
        onGate,
        learning: learning_settings,
        ...(clock ? { clock } : {}),
        ...host_options,
    });
    // what was learned before this process started: the count table, the places, the network version in use
    if (host.learning) {
        host.learning_restored = await host.learning.restore();
        host.learning.update();
    }
    setSocketExtension((socket, helpers) => {
        host.attach(socket, helpers);
        for (const extend of extensions) {
            try { extend(socket, helpers); } catch (err) { log('genesis_socket_extension', String(err?.message ?? err)); }
        }
    });
    // the broker does not know whether the desktop is there: it asks once now, and keeps asking
    host.start().catch(() => {});
    host.ledger_file = ledger_file;
    host.database = database;
    const stop_host = host.stop;
    host.stop = () => { if (migrate_timer !== null) (clock ?? { clearTimeout }).clearTimeout(migrate_timer); stop_host(); };
    return host;
}
