// Child process for the hard-kill test: writes checkpoint after checkpoint to real files,
// moving the plan forward each time, until it is killed. Prints the seq of every
// checkpoint whose write has completed.
//   node checkpoint-writer.mjs <dir>

import { createCheckpointStore } from '../../store/checkpoint.js';
import { nodeFiles } from '../../store/node_files.js';

const [dir] = process.argv.slice(2);
const store = createCheckpointStore({ files: nodeFiles(), dir });
const STEPS = 40;

function checkpointAt(seq) {
    const cursor = seq % STEPS;
    return {
        v: 1, agent: 'Arthur', seq, saved_at: new Date().toISOString(),
        plan: {
            id: 'plan-hard-kill', goal: 'Build the great hall', source: 'model', cursor,
            steps: Array.from({ length: STEPS }, (_, i) => ({
                i, command: '!collectBlocks', args: ['oak_log', i + 1],
                status: i < cursor ? 'done' : i === cursor ? 'active' : 'pending',
                attempts: i <= cursor ? 1 : 0,
                progress: { done: i < cursor ? i + 1 : 0, total: i + 1 },
            })),
        },
        routine: null,
        position: { x: cursor, y: 64, z: -cursor, dimension: 'overworld' },
        places: { home: [0, 64, 0] },
        pending_request: null,
        budgets: {},
    };
}

for (let seq = 1; ; seq++) {
    const result = await store.write(checkpointAt(seq));
    if (!result.ok) { console.error(JSON.stringify(result)); process.exit(3); }
    process.stdout.write(`${seq}\n`);
}
