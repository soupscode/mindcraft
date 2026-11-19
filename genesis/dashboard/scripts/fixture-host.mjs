// A development aid, never part of the image: a stand-in for the MindServer process's learner
// and town, for scripts/fixture-server.ts. The code is the real one (genesis/learning,
// genesis/town, the eight prefab files, the example world file); what it is fed is made up
// here: a few hundred invented goals with invented outcomes, and a short invented history of
// builds. Nothing here touches a file, a server or a model.
//   const host = await makeFixtureHost(); host.link.ask('genesis-town-view', {})

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHostLearning } from '../../planning/host.js';
import { memoryLearningStore } from '../../learning/store.js';
import { startTown } from '../../town/server.js';
import { buildBlueprints } from '../../catalog/blueprints.js';
import { fakeFiles } from '../../tests/helpers/fakes.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const ROLES = { Arthur: 'builder', Mira: 'farmer', Felix: 'explorer', Nova: 'merchant' };

// what each agent "does" in the fixture: [option, chance it works by day, by night, minutes]
const WORK = {
    Arthur: [['gather_blocks:oak_log:16', 'gather_blocks', { type: 'oak_log', count: 16 }, 'Gather 16 oak logs', 0.9, 0.55, 4], ['craft_item:oak_planks:32', 'craft_item', { item: 'oak_planks', count: 32 }, 'Craft 32 oak planks', 0.97, 0.95, 1], ['build_blueprint:arthur-1', 'build_blueprint', { plot: 'arthur-1' }, 'Build on arthur-1', 0.8, 0.35, 6], ['gather_blocks:cobblestone:16', 'gather_blocks', { type: 'cobblestone', count: 16 }, 'Mine 16 cobblestone', 0.7, 0.6, 5]],
    Mira: [['harvest_replant:field', 'harvest_replant', {}, 'Harvest the field', 0.93, 0.7, 3], ['sow_field:wheat_seeds', 'sow_field', { seed: 'wheat_seeds' }, 'Sow wheat', 0.95, 0.75, 2], ['craft_item:bread:3', 'craft_item', { item: 'bread', count: 3 }, 'Bake 3 bread', 0.9, 0.9, 1], ['store_items:shared:wheat', 'store_items', { chest: 'shared', item: 'wheat' }, 'Store the wheat', 0.98, 0.9, 1]],
    Felix: [['travel:north_forest', 'travel', { place: 'north_forest' }, 'Walk to the north forest', 0.75, 0.3, 7], ['gather_blocks:oak_log:16', 'gather_blocks', { type: 'oak_log', count: 16 }, 'Gather 16 oak logs', 0.85, 0.5, 4], ['gather_blocks:coal_ore:8', 'gather_blocks', { type: 'coal_ore', count: 8 }, 'Mine 8 coal', 0.6, 0.45, 6], ['travel:camp', 'travel', { place: 'camp' }, 'Walk home', 0.97, 0.8, 2]],
    Nova: [['give_items:Arthur:oak_planks:32', 'give_items', { to: 'Arthur', item: 'oak_planks', count: 32 }, 'Bring Arthur 32 planks', 0.88, 0.6, 3], ['fetch_items:shared:bread:4', 'fetch_items', { chest: 'shared', item: 'bread', count: 4 }, 'Fetch 4 bread', 0.95, 0.85, 1], ['store_items:shared:oak_log', 'store_items', { chest: 'shared', item: 'oak_log' }, 'Store oak logs', 0.97, 0.9, 1], ['craft_item:torch:8', 'craft_item', { item: 'torch', count: 8 }, 'Craft 8 torches', 0.8, 0.8, 1]],
};

export async function makeFixtureHost({ goals = 420 } = {}) {
    const agents = Object.keys(ROLES);
    const end = Date.now();
    let now = end - 7 * 3600 * 1000;
    const clock = { now: () => now };
    let seed = 7;
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    // everything is kept in memory, except the operator's prefab folder: an uploaded prefab is read back from
    // disk by the same code that reads the ladder, so it is a temporary folder (removed by close())
    const operator_dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-fixture-prefabs-'));
    const memory = fakeFiles();
    const real = (file) => String(file).startsWith(operator_dir);
    const files = {
        store: memory.store,
        write: async (file, text) => (real(file) ? fs.writeFileSync(file, text) : memory.write(file, text)),
        read: async (file) => { if (!real(file)) return memory.read(file); try { return fs.readFileSync(file, 'utf8'); } catch { return null; } },
        rename: async (from, to) => (real(from) ? fs.renameSync(from, to) : memory.rename(from, to)),
        remove: async (file) => (real(file) ? fs.rmSync(file, { force: true }) : memory.remove(file)),
    };
    const said = [];

    // ---- the learner ----
    const learning = createHostLearning({ agents, store: memoryLearningStore(), files, weights_dir: '/learning/versions', clock, roles: ROLES, world_sha256: 'fixture-world', emit: (type, data) => said.push({ type, data }) });
    await learning.restore();
    const step_ms = (7 * 3600 * 1000 - 60000) / goals;
    for (let i = 0; i < goals; i++) {
        const agent = agents[i % agents.length];
        const [id, skill, args, title, by_day, by_night, minutes] = WORK[agent][Math.floor(rand() * WORK[agent].length)];
        const night = rand() < 0.3;
        const situation = { position: { x: 4, y: 64, z: 2 }, dimension: 'overworld', home_distance: 6 + Math.floor(rand() * 30), range: 48, health: 20 - Math.floor(rand() * 5), food: 14 + Math.floor(rand() * 6), free_slots: 20, inventory: {}, tools: { pickaxe: 2, axe: 2, sword: 1, hoe: 1 }, day_tick: night ? 18000 : 4000, daylight_left: night ? 0 : 8000, rain: false, agents_near: [], hostiles_near: night ? 1 : 0, queue_length: 1, model_available: rand() < 0.6 };
        const chooser = situation.model_available ? 'planner' : 'network';
        const key = `x-${i}`;
        await learning.begin({ id: key, agent, option: { id, skill, args, title }, chooser, explore: chooser === 'network' && rand() < 0.25, situation, started_at: now });
        const ok = rand() < (night ? by_night : by_day);
        const hurt = !ok && night && rand() < 0.4;
        now += Math.round(step_ms * (0.4 + rand() * 0.4));
        await learning.end({ agent, id: key, end: { outcome: ok ? 'completed' : 'failed', reason: ok ? null : hurt ? 'hurt' : 'no_progress', done: ok ? 1 : 0, total: 1, duration_ms: minutes * 60000, steps: [], died: false, health_min: hurt ? 8 : 18, health_lost: hurt ? 9 : 0, stuck: false, gained: {}, ended_at: now } });
        now = end - 7 * 3600 * 1000 + Math.round((i + 1) * step_ms);
        // a choice the network made differently from the routine's own pick, now and then
        if (chooser === 'network' && i % 9 === 0) {
            const [was, chosen] = agent === 'Arthur' ? ['gather_blocks:oak_log:8', 'gather_blocks:oak_log:16'] : agent === 'Mira' ? ['sow_field:wheat_seeds', 'harvest_replant:field'] : agent === 'Felix' ? ['travel:north_forest', 'travel:camp'] : ['store_items:shared:oak_log', 'give_items:Arthur:oak_planks:32'];
            learning.decision({ agent, chooser: 'network', offered: [{ id: was }, { id: chosen }], chosen, default_choice: was, situation });
        }
    }
    await learning.flush?.();

    // ---- the town ----
    const zones_config = JSON.parse(fs.readFileSync(path.join(REPO, 'genesis/genesis.world.example.json'), 'utf8'));
    const prefabs = buildBlueprints({ dirs: [path.join(REPO, 'genesis/prefabs'), operator_dir] });
    const stock = { oak_planks: 212, oak_log: 38, cobblestone: 96, oak_door: 1, torch: 14, glass_pane: 0, oak_slab: 24, oak_fence: 6, ladder: 0, bread: 9 };
    const town = await startTown({ town_file: '/town/genesis.town.json' }, {
        zones_config, prefabs, files, clock, agents, world_sha256: 'fixture-world', roles: ROLES, operator_dir,
        ledger: { stock: () => ({ ...stock }) }, emit: (type, data) => said.push({ type, data }), warn: () => {},
    });
    const t = town.town;
    const build = (agent, plot, day) => { const a = t.apply(agent, { kind: 'build_started', plot }); const b = a.ok ? t.apply(agent, { kind: 'build_verified', plot, day }) : a; return b; };
    now = end - 5 * 3600 * 1000;
    build('Arthur', 'arthur-1', 3);
    now += 40 * 60000; build('Mira', 'mira-1', 4);
    now += 40 * 60000; build('Felix', 'felix-1', 6);
    now += 40 * 60000; build('Arthur', 'arthur-1', 9);          // his next home tier, in place
    now += 40 * 60000; build('Arthur', 'arthur-1', 14);         // and the one after: the first shared project opens
    now += 20 * 60000; t.apply('Nova', { kind: 'build_started', plot: 'nova-1' });
    t.apply('Nova', { kind: 'build_progress', plot: 'nova-1', stage: 'Frame', cells_matching: 11 });
    // what the town wants next is proposed where the town accepts it. (In the example world no 24-block plot
    // fits between the camp, the five plots and Arthur's range: the Storehouse stays wanted.)
    for (const wanted of [...t.view().wanted]) {
        if (wanted.size === 'span') continue;
        const n = { S: 16, M: 24, L: 32 }[wanted.size];
        search: for (let x = -44; x <= 44; x += 2) for (let z = -44; z <= 44; z += 2) {
            if (t.apply(wanted.for, { kind: 'propose_plot', wanted: wanted.id, min: [x, 64, z], max: [x + n - 1, 77, z + n - 1], score: { relief: 1, distance: Math.hypot(x, z) } }).ok) break search;
        }
    }
    // three walks to one place found no way: a footbridge is proposed where the agents saw the gap. Twice.
    const gap = (place, span) => { for (const agent of ['Felix', 'Mira', 'Felix']) { now += 6 * 60000; t.apply(agent, { kind: 'gap', place, span }); } };
    gap('east-stream', { min: [27, 63, -12], max: [35, 66, -8], length: 9, rotation: 90, from: [26, 64, -10], to: [36, 64, -10] });
    // Arthur's project: the first bridge, under way
    const span = t.view().plots.find((plot) => plot.kind === 'bridge');
    if (span) {
        now += 30 * 60000;
        const started = t.apply('Arthur', { kind: 'build_started', plot: span.id });
        if (started.ok) { now += 20 * 60000; t.apply('Arthur', { kind: 'build_progress', plot: span.id, stage: 'Deck', cells_matching: 19, bill: { oak_planks: 8, oak_fence: 14, oak_log: 4 }, held: { oak_planks: 8, oak_fence: 2 } }); }
    }
    gap('west-ditch', { min: [-18, 63, 2], max: [-14, 66, 8], length: 7, rotation: 0, from: [-16, 64, 1], to: [-16, 64, 9] });
    now = end;

    // ---- the socket the dashboard would hold: asks reach the same handlers ----
    const handlers = new Map();
    const socket = { connected: true, on: (event, fn) => { handlers.set(event, fn); }, emit: () => {} };
    learning.attach(socket);
    town.attach(socket);
    const link = {
        connected: () => true,
        emit: () => {},
        ask: (event, arg) => new Promise((resolve, reject) => {
            const fn = handlers.get(event);
            if (!fn) { reject(new Error(`${event} did not answer`)); return; }
            const timer = setTimeout(() => reject(new Error(`${event} did not answer`)), 8000);
            Promise.resolve(fn(arg, (value) => { clearTimeout(timer); resolve(value); })).catch(reject);
        }),
    };
    return { link, learning, town, said, files, clock, operator_dir, close: () => fs.rmSync(operator_dir, { recursive: true, force: true }) };
}
