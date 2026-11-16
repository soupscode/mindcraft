// Genesis: what an agent does after it died (decided): respawn, walk home, re-equip from the
// kits chest, resume from the checkpoint. No model call is needed for any of it.
//
// This file is the chooser of the detour the executor runs (executor.detour): it hands out
// one goal of the action catalog at a time, by code:
//
//   walk_home   travel:home, unless the agent stands at home already
//   look        travel:chest-kits: walking to the kit chest reads it into the chest ledger
//   re_equip    fetch_items:kits:<item>:<count> for every tool of the role that is not held,
//               then some food
//
// and then nothing: the executor carries on with the goal it kept, at the same step.
// A goal the catalog does not offer (no dig-free way home, an empty kit chest) is passed
// over: the re-equip takes what is there and never blocks the resume.
//
// How this agrees with the routines' two-deaths rule (genesis/routines/engine.js), which
// stays as it was:
//   - a goal the ROUTINE chose is given up at a death, and the routine starts again at its
//     Kit check (walk home, fetch a kit, avoid the place of death)
//   - a goal the planner or the operator chose is kept and resumed, at the step it was at
//   - the second death parks: in one model-away period the routine parks the agent at home
//     with one incident (whatever goal was in hand is given up); and a goal that the agent
//     dies on twice is given up too, wherever the model is
//
// Injected: catalog, zones, state() (the world now: { agent, view, ledger, avoid }), the kit.
// Depends only on other Genesis files.

import { KIT_FOOD, ROLE_KITS } from '../routines/routines.js';

export const DEATH_RULES = Object.freeze({
    max_deaths_per_goal: 2,   // decided (the two-deaths rule): the second death on one goal gives it up
    max_detour_goals: 8,      // proposed: goals one re-equip may take before the agent goes back to work regardless
    home_tries: 2,            // proposed: how often the walk home is tried
    kits_chest: 'kits',
    home_distance: 4,         // as the routines measure "at home"
});

export function createDeathRecovery({ agent, catalog, zones, state, kit = ROLE_KITS[agent] ?? [], food = KIT_FOOD, rules: overrides = {} } = {}) {
    const rules = { ...DEATH_RULES, ...overrides };
    let home_tries = 0;
    let looked = false;
    const tried = new Set(); // option ids already handed out

    const atHome = (view) => {
        const here = view.position();
        const home = zones.home(agent);
        return Boolean(home) && Math.hypot(here.x - home.x, here.z - home.z) <= rules.home_distance && Math.abs(here.y - home.y) <= rules.home_distance;
    };
    const offer = (skill, args, world) => {
        const found = catalog.option(skill, args, world);
        if (!found.ok || tried.has(found.option.id)) return null;
        tried.add(found.option.id);
        return found.option;
    };
    const goal = (option, step, why) => ({ goal: { title: option.title, option_id: option.id }, reason: `after a death: ${why}`, step });

    return {
        // Asked by the executor each time the detour has nothing in hand.
        next({ goals_run = 0 } = {}) {
            if (goals_run >= rules.max_detour_goals) return null;
            const world = state();
            const view = world.view;
            if (!atHome(view) && home_tries < rules.home_tries) {
                home_tries++;
                tried.delete('travel:home');
                const option = offer('travel', { place: 'home' }, world);
                if (option) return goal(option, 'walk_home', 'walking home');
            }
            if (!zones.chest(rules.kits_chest)) return null;
            if (!looked) {
                looked = true;
                const option = offer('travel', { place: `chest-${rules.kits_chest}` }, world);
                if (option) return goal(option, 're_equip', 'looking into the kit chest');
            }
            const held = view.inventory();
            const stock = world.ledger.stock(rules.kits_chest);
            for (const tool of kit) {
                if (Object.keys(held).some((item) => item.endsWith(tool.suffix) && held[item] > 0)) continue;
                const item = Object.keys(stock).sort().find((name) => name.endsWith(tool.suffix));
                const option = item ? offer('fetch_items', { chest: rules.kits_chest, item, count: 1 }, world) : null;
                if (option) return goal(option, 're_equip', `taking a ${tool.suffix.slice(1)} from the kit chest`);
            }
            if (food && (held[food.item] ?? 0) < food.keep) {
                const count = Math.min(food.take, world.ledger.count(rules.kits_chest, food.item));
                const option = count > 0 ? offer('fetch_items', { chest: rules.kits_chest, item: food.item, count }, world) : null;
                if (option) return goal(option, 're_equip', 'taking food from the kit chest');
            }
            return null;
        },
    };
}
