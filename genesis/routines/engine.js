// Genesis: the role routine. Scripted work near home for the time the model is away (or
// has nothing for the agent). A routine is a round of phases; each phase picks, by code,
// one goal from the action catalog at a time, and never anything else: a routine only does
// what the catalog offers, and it never builds.
//
// Shared rules (decided):
//   bounds   daylight left, health of 10 or more, food of 8 or more, 3 or more free slots,
//            and at most 2 deaths per model-away period. A breached bound sends the agent
//            straight to the Shelter phase.
//   yield    when the model returns, the routine finishes its current step (the executor
//            sees to that), keeps its phase, and the agent goes back to planning.
//   deaths   respawn, walk home, fetch a kit, restart at the first phase, and avoid a
//            24-block area around the death point. A second death in one away period parks
//            the agent at home and opens one incident.
//
// next(state) -> { goal: { title, option_id }, reason, routine: { name, phase } }   queue this, with source "routine"
//             -> { idle_ms, routine: { name, phase }, why }                         nothing to do right now
//
// Injected: catalog, zones, emit(type, data, opts), clock, the definition (genesis/routines/routines.js).
// Depends only on other Genesis files.

import { incidentData } from '../recovery/incidents.js';

export const ROUTINE_RULES = Object.freeze({
    min_health: 10,
    min_food: 8,
    min_free_slots: 3,
    max_deaths: 2,              // the second death parks the agent
    avoid_radius: 24,
    dusk_margin_ticks: 400,     // head home this long before dark, plus the walk
    walk_ticks_per_block: 5,    // 20 ticks a second at about 4 blocks a second
    idle_ms: 15 * 1000,         // wait this long when a whole round found nothing to do
    parked_idle_ms: 60 * 1000,
});

export const SHELTER = 'Shelter';

export function createRoutine({ agent, definition, catalog, zones, clock, emit = () => null, rules: rule_overrides = {} } = {}) {
    const rules = { ...ROUTINE_RULES, ...rule_overrides };
    const phases = definition.phases.map((phase) => phase.name);
    const first = phases[0];
    const stats = { goals: 0, idles: 0, rounds: 0, shelters: 0, deaths: 0, incidents: 0, yields: 0 };

    let phase = first;
    let picked_in_phase = 0;    // goals this visit to the phase
    let skip = new Set();       // option ids that failed this round: not tried again until the next round
    let memo = {};              // what the phases remember within a round (the patrol's next waypoint, ...)
    let away = false;           // a model-away period is running
    let deaths = 0;             // in this away period
    let avoid = [];             // [{ x, y, z, radius }]
    let parked = false;
    let walk_home = false;      // after a death: home first
    let waiting = null;         // the option id of the goal the routine asked for and has not seen end
    let patrol_index = 0;

    const tag = () => ({ name: definition.name, phase });
    const home = () => zones.home(agent);
    const atHome = (state) => {
        const here = state.view.position();
        const h = home();
        return Boolean(h) && Math.hypot(here.x - h.x, here.z - h.z) <= 4 && Math.abs(here.y - h.y) <= 4;
    };

    // The bounds that do not hold right now.
    function breached(state) {
        const out = [];
        const view = state.view;
        const walk_home_ticks = Math.ceil(zones.distanceFromHome(agent, view.position()) * rules.walk_ticks_per_block);
        if (view.dayTicksLeft() <= rules.dusk_margin_ticks + walk_home_ticks) out.push('daylight');
        if (view.health() < rules.min_health) out.push('health');
        if (view.food() < rules.min_food) out.push('food');
        if (view.freeSlots() < rules.min_free_slots) out.push('free_slots');
        return out;
    }

    function enter(name) {
        if (phase !== name) { phase = name; picked_in_phase = 0; }
    }

    function nextPhase() {
        const index = phases.indexOf(phase);
        const next = phases[(index + 1) % phases.length];
        if (index === phases.length - 1) { stats.rounds++; skip = new Set(); memo = {}; }
        phase = next;
        picked_in_phase = 0;
    }

    // What a phase works with. option() is the only way to a goal: the catalog checks the
    // preconditions, and a skill that can place a block is refused outright.
    function context(state) {
        const world = { ...state, avoid: [...(state.avoid ?? []), ...avoid] };
        const inventory = state.view.inventory();
        const ctx = {
            agent, zones, state: world, inventory, ledger: state.ledger, memo, now: clock.now(),
            held: (item) => inventory[item] ?? 0,
            holdsSuffix: (suffix) => Object.keys(inventory).some((item) => item.endsWith(suffix) && inventory[item] > 0),
            atHome: () => atHome(state),
            option(skill, args) {
                if (skill === 'build_blueprint') return null; // routines never build
                const found = catalog.option(skill, args, world);
                if (!found.ok || skip.has(found.option.id)) return null;
                return found.option;
            },
            // why the catalog does not offer this right now (a named reason), or null when it does
            refusal(skill, args) {
                const found = catalog.option(skill, args, world);
                return found.ok ? null : found.reason;
            },
            // the first of the catalog's own candidates for a skill that holds and passes `filter`
            firstCandidate(skill, filter = () => true) {
                for (const args of catalog.candidates(skill, world)) {
                    if (!filter(args)) continue;
                    const option = ctx.option(skill, args);
                    if (option) return option;
                }
                return null;
            },
            patrol: {
                points: () => zones.patrol(agent),
                index: () => patrol_index,
                advance: () => { patrol_index = (patrol_index + 1) % Math.max(1, zones.patrol(agent).length); },
            },
        };
        return ctx;
    }

    const goal = (option, why) => {
        stats.goals++;
        picked_in_phase++;
        waiting = option.id;
        return { goal: { title: option.title, option_id: option.id }, reason: `routine ${definition.name}, ${phase}: ${why}`, routine: tag() };
    };
    const idle = (ms, why) => { stats.idles++; return { idle_ms: ms, routine: tag(), why }; };

    // Shelter: free the inventory if that is what is wrong, then go home and stay there.
    function shelter(ctx, state, reasons) {
        if (reasons.includes('free_slots')) {
            const chest = zones.chest('shared') ? 'shared' : zones.chests()[0]?.name;
            const option = chest ? ctx.firstCandidate('store_items', (args) => args.chest === chest) : null;
            if (option) return goal(option, 'the inventory is full');
        }
        if (!atHome(state)) {
            const option = ctx.option('travel', { place: 'home' });
            if (option) return goal(option, reasons.length > 0 ? `going home (${reasons.join(', ')})` : 'going home');
        }
        if (reasons.includes('food') && definition.food && ctx.held(definition.food) === 0 && zones.chest('kits')) {
            // hungry with nothing to eat: the kit chest may have food (eating itself is upstream's auto-eat)
            const count = Math.min(4, state.ledger.count('kits', definition.food));
            const option = count > 0 ? ctx.option('fetch_items', { chest: 'kits', item: definition.food, count }) : null;
            if (option) return goal(option, 'fetching food');
        }
        return null;
    }

    return {
        name: definition.name,
        phases: () => [...phases],
        next(state) {
            const ctx = context(state);
            if (parked) {
                if (!atHome(state)) {
                    const option = ctx.option('travel', { place: 'home' });
                    if (option) return goal(option, 'parked after a second death');
                }
                return idle(rules.parked_idle_ms, 'parked at home after a second death');
            }
            if (walk_home) {
                // after a death: home first, then the round starts again at its first phase (the kit)
                if (!atHome(state)) {
                    const option = ctx.option('travel', { place: 'home' });
                    if (option) return goal(option, 'walking home after a death');
                }
                walk_home = false;
                enter(first);
            }
            const reasons = breached(state);
            if (reasons.length > 0) {
                if (phase !== SHELTER) stats.shelters++;
                enter(SHELTER);
                return shelter(ctx, state, reasons) ?? idle(rules.idle_ms, `sheltering (${reasons.join(', ')})`);
            }
            // one look at every phase of the round, starting (and ending) with the one the routine is in
            for (let looked = 0; looked <= phases.length; looked++) {
                const spec = definition.phases[phases.indexOf(phase)];
                if (phase === SHELTER) {
                    const home_goal = shelter(ctx, state, []);
                    if (home_goal) return home_goal;
                } else if (picked_in_phase < (spec.max_goals ?? 1)) {
                    const picked = spec.pick(ctx);
                    if (picked) return goal(picked.option, picked.why);
                }
                nextPhase();
            }
            return idle(rules.idle_ms, 'nothing to do this round');
        },
        // A goal the routine asked for has ended (completed, failed, dropped, abandoned, yielded).
        goalEnded({ option_id, outcome }) {
            if (waiting === option_id) waiting = null;
            if (outcome === 'failed' || outcome === 'dropped') skip.add(option_id);
        },
        // The agent died at `point`. Returns 'restart' or 'parked'.
        died(point) {
            stats.deaths++;
            waiting = null;
            if (!away) { walk_home = true; enter(first); return 'restart'; } // with the model there, the planner decides what comes next
            deaths++;
            if (point) avoid.push({ x: point.x, y: point.y, z: point.z, radius: rules.avoid_radius });
            if (deaths >= rules.max_deaths) {
                if (!parked) {
                    parked = true;
                    stats.incidents++;
                    // one incident, for the operator: the agent stays at home until the model is back
                    // (it also carries the incident shape of genesis/recovery/incidents.js, so the Incidents view lists it)
                    emit('agent.failure', {
                        ...incidentData({
                            incident_id: `${agent}-deaths-${clock.now()}`, source: { type: 'agent', name: agent }, kind: 'incident', phase: 'escalated',
                            is_failure: true, recovery: { step: 'park_home', attempt: deaths, max: rules.max_deaths, result: 'ok' },
                            outcome: 'needs_operator', needs_operator: true,
                        }),
                        kind: 'incident', error: 'parked_after_second_death',
                        message: `${agent} died ${deaths} times while the model was away and is parked at home until it returns.`,
                        deaths, death_point: point ? [Math.round(point.x), Math.round(point.y), Math.round(point.z)] : null,
                        routine: definition.name, routine_phase: phase, // `phase` is the incident's own: "escalated"
                    }, { severity: 'error', corr: null });
                }
                return 'parked';
            }
            walk_home = true;
            enter(first);
            return 'restart';
        },
        // A model-away period begins or ends. Ending it forgives the deaths and keeps the phase.
        awayStarted() { if (!away) { away = true; deaths = 0; avoid = []; parked = false; } },
        modelReturned() {
            if (away) stats.yields++;
            away = false; deaths = 0; avoid = []; parked = false;
        },
        isAway: () => away,
        isParked: () => parked,
        deaths: () => deaths,
        avoid: () => avoid.map((area) => ({ ...area })),
        // The checkpoint's "routine": { name, phase }.
        snapshot: () => tag(),
        restore(saved) {
            if (saved?.name === definition.name && phases.includes(saved.phase)) { phase = saved.phase; picked_in_phase = 0; }
        },
        phase: () => phase,
        stats: () => ({ ...stats, phase, deaths_this_period: deaths, parked, away }),
    };
}
