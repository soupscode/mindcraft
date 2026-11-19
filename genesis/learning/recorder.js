// Genesis learning, the agent's side: what an agent tells the learner about its goals.
//
//   situate(option)   the RAW situation for one option, read from the world view at that moment:
//                     position, home distance, health, food, free slots, what it carries (items the
//                     catalog knows), tool tiers, time of day, rain, agents and hostile mobs near,
//                     and what the option is aimed at (catalog.target()). Place memory and recent
//                     history are filled in by the learner, which has them for all agents.
//   started(start, choice)   a goal is about to be carried out: the situation is taken NOW and sent
//                     with the option; the learner stores what it predicts for it before anything of
//                     the goal has happened
//   step()            a step ended: the health is looked at
//   died()            the agent died: every goal that is open carries it
//   ended(end)        the goal ended: outcome, reason, measure, steps, health lost and its lowest
//                     point, died, stuck, and what the inventory gained
//
// A goal that was dropped before it started (its preconditions were gone when its turn came)
// is recorded too: opened and closed in that order, so its prediction is still stored first.
//
// Nothing here waits for the learner and nothing here can stop a goal: every call is fire and
// forget, and a learner that is not there costs the agent nothing.
//
// Injected: client (genesis/learning/client.js), view, zones, catalog, state() (the world for
// the catalog), clock, queueLength(), modelAvailable(), ids().
// Depends only on other files of genesis/learning.

import { OUTCOMES } from './experience.js';

const TIERS = Object.freeze({ wooden: 1, golden: 1, stone: 2, iron: 3, diamond: 4, netherite: 5 });

// The best tier held of a tool: 0 (none), 1 wood, 2 stone, 3 iron, 4 diamond, 5 netherite.
export function toolTier(inventory, tool) {
    let best = 0;
    for (const [item, count] of Object.entries(inventory ?? {})) {
        if (!(count > 0) || !item.endsWith(`_${tool}`)) continue;
        best = Math.max(best, TIERS[item.slice(0, -tool.length - 1)] ?? 1);
    }
    return best;
}

const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const round1 = (n) => Math.round(n * 10) / 10;
const safe = (fn, fallback) => { try { const value = fn(); return value === undefined ? fallback : value; } catch { return fallback; } };

// What does not depend on the option.
export function selfSituation({ agent, view, zones, known = () => true, queue_length = 0, model_available = false }) {
    const position = view.position();
    const all = safe(() => view.inventory(), {});
    const inventory = Object.fromEntries(Object.entries(all).filter(([item, count]) => count > 0 && known(item)));
    const daylight = safe(() => view.dayTicksLeft(), 0);
    return {
        position: { x: round1(position.x), y: round1(position.y), z: round1(position.z) },
        dimension: safe(() => view.dimension?.(), 'overworld') ?? 'overworld',
        home_distance: round1(safe(() => zones.distanceFromHome(agent, position), 0)),
        range: zones.range(agent) ?? 32,
        health: safe(() => view.health(), 20), food: safe(() => view.food(), 20), free_slots: safe(() => view.freeSlots(), 36),
        inventory,
        tools: { pickaxe: toolTier(all, 'pickaxe'), axe: toolTier(all, 'axe'), sword: toolTier(all, 'sword'), hoe: toolTier(all, 'hoe') },
        day_tick: safe(() => view.timeOfDay?.(), null) ?? (daylight > 0 ? 12000 - daylight : 18000),
        daylight_left: daylight,
        rain: safe(() => view.raining?.(), false) === true,
        agents_near: safe(() => view.agentsNear?.(zones.agents(), 16), []) ?? [],
        hostiles_near: safe(() => view.hostilesNear?.(16), 0) ?? 0,
        queue_length, model_available,
    };
}

// What the option is aimed at: situation.target and situation.recipient.
export function targetSituation({ agent, option, view, zones, catalog, state }) {
    const aimed = safe(() => catalog.target?.(option.id, state), null);
    if (!aimed) return { target: null, recipient: null };
    const here = view.position();
    const pos = aimed.pos ?? null;
    const target = {
        pos: pos ? { x: round1(pos.x), y: round1(pos.y), z: round1(pos.z) } : null,
        dist: pos ? round1(dist(here, pos)) : 0,
        dy: pos ? round1(pos.y - here.y) : 0,
        home_distance: pos ? round1(safe(() => zones.distanceFromHome(agent, pos), 0)) : 0,
        in_site: pos ? safe(() => zones.isProtected(pos), false) === true : false,
        // only where the catalog itself asked for the way (the answer is cached in the view): a walk, a chest, a furnace
        path: pos && aimed.path ? safe(() => (flat(here, pos) <= 3.5 ? 'ok' : view.pathTo(pos, 2)?.status), 'unknown') ?? 'unknown' : 'unknown',
        kind: aimed.kind ?? null,
        cells: Number.isFinite(aimed.cells) ? aimed.cells : null,
        materials_share: Number.isFinite(aimed.materials_share) ? Math.round(aimed.materials_share * 100) / 100 : null,
    };
    return { target, recipient: aimed.recipient ? { kept_share: null, near: aimed.recipient.near === true } : null };
}

// Who chose a goal, in the words of the experience table.
export const chooserOf = (source) => (['planner', 'routine', 'network', 'operator', 'recovery'].includes(source) ? source : 'planner');

export function createRecorder({
    agent, client, view, zones, catalog, state, clock = { now: Date.now }, queueLength = () => 0, modelAvailable = () => false, ids = null,
} = {}) {
    if (!client) throw new Error('the recorder needs the learning client');
    const open = new Map();     // plan id -> { health, health_min, health_lost, inventory, died, started_at }
    const stats = { started: 0, ended: 0, dropped: 0, unknown: 0, errors: 0 };
    let counter = 0;
    const nextId = ids ?? (() => `${agent}-x-${clock.now()}-${++counter}`);
    const known = (item) => safe(() => catalog.knows?.(item), true) !== false;

    function situate(option) {
        const world = state();
        return {
            ...selfSituation({ agent, view, zones, known, queue_length: queueLength(), model_available: modelAvailable() }),
            ...targetSituation({ agent, option, view, zones, catalog, state: world }),
        };
    }

    function sample(record) {
        const health = safe(() => view.health(), record.health);
        if (health < record.health) record.health_lost += record.health - health;
        record.health = health;
        record.health_min = Math.min(record.health_min, health);
    }

    function begin(id, start, choice) {
        const option = { id: start.option_id, skill: start.skill, args: start.args ?? {}, title: start.title ?? start.option_id };
        const now = clock.now();
        client.begin({
            id, agent, goal_id: start.goal_id ?? null, call_id: start.call_id ?? choice?.call_id ?? null, decision_id: choice?.decision_id ?? null,
            option, chooser: chooserOf(choice?.chooser ?? start.source), explore: choice?.explore === true,
            situation: situate(option), started_at: now,
        });
    }

    return {
        situate,
        // executor.onGoalStart. choice: { chooser, explore, decision_id, call_id } when the runtime knows how the goal was chosen.
        started(start, choice = null) {
            try {
                const health = safe(() => view.health(), 20);
                open.set(start.plan_id, { health, health_min: health, health_lost: 0, inventory: safe(() => view.inventory(), {}), died: false, started_at: clock.now() });
                if (open.size > 8) open.delete(open.keys().next().value);
                begin(start.plan_id, start, choice);
                stats.started++;
            } catch { stats.errors++; }
        },
        step() { for (const record of open.values()) sample(record); },
        died() { for (const record of open.values()) { record.died = true; record.health_min = 0; } },
        // executor.onGoalEnd (every way a goal can end; "yielded" is the routine giving way: censored like a replaced goal)
        ended(end, choice = null) {
            try {
                const outcome = OUTCOMES.includes(end.outcome) ? end.outcome : 'abandoned';
                const now = clock.now();
                if (!end.plan_id) {
                    // dropped before it started: no plan was ever made. Opened and closed, in that order.
                    const resolved = safe(() => catalog.resolve(end.option_id), null);
                    if (!resolved) { stats.unknown++; return; }
                    const id = nextId();
                    begin(id, { option_id: end.option_id, skill: resolved.skill, args: resolved.args, title: end.title, goal_id: end.goal_id, call_id: end.call_id ?? null, source: end.origin ?? end.source }, choice);
                    client.end({ agent, id, end: { outcome, reason: end.reason ?? null, done: 0, total: null, duration_ms: 0, steps: [], died: false, health_min: null, health_lost: 0, stuck: false, gained: {}, ended_at: now } });
                    stats.dropped++;
                    return;
                }
                const record = open.get(end.plan_id) ?? null;
                open.delete(end.plan_id);
                if (record) sample(record);
                const gained = {};
                if (record) {
                    const after = safe(() => view.inventory(), {});
                    for (const item of new Set([...Object.keys(after), ...Object.keys(record.inventory)])) {
                        const change = (after[item] ?? 0) - (record.inventory[item] ?? 0);
                        if (change !== 0) gained[item] = change;
                    }
                }
                const died = record?.died === true || end.reason === 'died';
                client.end({
                    agent, id: end.plan_id,
                    end: {
                        outcome, reason: end.reason ?? null, done: end.done ?? null, total: end.total ?? null,
                        duration_ms: Number.isFinite(end.started_at) ? Math.max(0, now - end.started_at) : (record ? Math.max(0, now - record.started_at) : null),
                        steps: end.steps ?? [], died, health_min: record ? record.health_min : null, health_lost: record ? Math.round(record.health_lost * 10) / 10 : 0,
                        stuck: end.reason === 'stuck', gained, ended_at: now,
                    },
                });
                stats.ended++;
            } catch { stats.errors++; }
        },
        open: () => open.size,
        stats: () => ({ ...stats }),
    };
}
