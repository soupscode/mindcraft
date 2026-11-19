// Genesis learning: A SIMULATION, NOT MINECRAFT. A generator of situations and outcomes
// with a hidden rule the tests know and the network does not (the plan's section 1.7).
// It exists to show that the learning machinery can find a rule from outcomes alone, and to
// test the gate, the bench and the exploration rule. It says nothing about how well any of
// this works on a real server: the rule is invented, the situations are drawn at random and
// independent of each other, and real play is neither.
//
// THE HIDDEN RULE
//   gather_blocks    succeeds 90% by day and 25% at night; halved when the target is more than
//                    24 blocks away and the pickaxe is below stone
//   travel           succeeds 95% when the height difference is 6 or less, 15% otherwise,
//                    except Felix: 45% on a big climb
//   build_blueprint  succeeds 85% up to 12 cells and 50% above
//   craft_item 97%, smelt_item 93%, harvest_replant 90%
//   danger           30% at night more than 20 blocks from home without a sword, 10% with one,
//                    1% otherwise
//   duration         20 + 3 x count + 1.5 x distance seconds, with log-normal noise;
//                    Felix travels a third faster
//   pure noise       food, free slots, rain, agents near, hostiles near: drawn at random, no effect
// createSim({ flipped }) or sim.flip() turns the gather rule and the travel rule round (night
// and big climbs become the good cases): the drift test.
//
// Depends only on other files of genesis/learning.

import { createRng } from './rng.js';
import { openExperience, closeExperience } from './experience.js';

export const SIM_AGENTS = Object.freeze(['Arthur', 'Mira', 'Felix', 'Nova']);
export const SIM_SKILLS = Object.freeze(['travel', 'gather_blocks', 'craft_item', 'build_blueprint', 'harvest_replant', 'smelt_item']);
const GATHER = ['oak_log', 'stone', 'coal_ore', 'sand'];
const CRAFT = ['oak_planks', 'stick', 'torch'];
const FAIL_REASON = { travel: 'no_safe_path', gather_blocks: 'nothing_found', build_blueprint: 'missing_materials', craft_item: 'no_recipe', smelt_item: 'no_fuel', harvest_replant: 'nothing_mature' };

export function createSim({ seed = 1, flipped = false } = {}) {
    const r = createRng(seed);
    let turned = flipped;

    function draw() {
        const agent = r.pick(SIM_AGENTS);
        const skill = r.pick(SIM_SKILLS);
        const night = r.chance(0.3);
        const daylight_left = night ? 0 : 1 + r.int(12000);
        const count = 1 + r.int(32);
        const dist = r() * 64;
        const dy = (r() - 0.5) * 24;
        const home_distance = r() * 64;
        let option;
        let target = { pos: { x: Math.round(dist), y: 64 + Math.round(dy), z: 0 }, dist, dy, home_distance: r() * 64, in_site: r.chance(0.3), path: 'ok' };
        if (skill === 'travel') { const place = `ring-${r.int(8)}`; option = { id: `travel:${place}`, skill, args: { place } }; }
        else if (skill === 'gather_blocks') { const type = r.pick(GATHER); option = { id: `gather_blocks:${type}:${count}`, skill, args: { type, count } }; }
        else if (skill === 'craft_item') { const item = r.pick(CRAFT); option = { id: `craft_item:${item}:${count}`, skill, args: { item, count } }; target = null; }
        else if (skill === 'build_blueprint') { const plot = `${agent.toLowerCase()}-1`; option = { id: `build_blueprint:${plot}`, skill, args: { plot } }; target.cells = count; target.materials_share = r(); }
        else if (skill === 'harvest_replant') { option = { id: 'harvest_replant:wheat', skill, args: { crop: 'wheat', count } }; }
        else { option = { id: `smelt_item:raw_iron:${count}`, skill, args: { item: 'raw_iron', count } }; target = null; }
        const raw = {
            position: { x: 0, y: 64, z: 0 }, home_distance, range: 48,
            health: 6 + r() * 14, food: 6 + r() * 14, free_slots: r.int(37),
            inventory: {}, tools: { pickaxe: r.int(4), axe: r.int(4), sword: r.chance(0.5) ? 2 : 0, hoe: r.chance(0.5) ? 1 : 0 },
            day_tick: night ? 13000 + r.int(10000) : 12000 - daylight_left, daylight_left, rain: r.chance(0.2),
            agents_near: r.chance(0.4) ? [{ name: r.pick(SIM_AGENTS), dist: r() * 30 }] : [], hostiles_near: r.int(3),
            target, queue_length: r.int(3), model_available: false,
        };
        return { agent, option, raw, count: skill === 'travel' ? 0 : count };
    }

    // The truth for one drawn case: { p, danger, secs }.
    function truth({ agent, option, raw, count }) {
        const night = raw.daylight_left <= 0;
        const dist = raw.target?.dist ?? 0;
        const climb = Math.abs(raw.target?.dy ?? 0) > 6;
        let p;
        if (option.skill === 'gather_blocks') {
            p = (night !== turned) ? 0.25 : 0.9;
            if (dist > 24 && raw.tools.pickaxe < 2) p *= 0.5;
        } else if (option.skill === 'travel') {
            const hard = climb !== turned;
            p = hard ? (agent === 'Felix' ? 0.45 : 0.15) : 0.95;
        } else if (option.skill === 'build_blueprint') p = count <= 12 ? 0.85 : 0.5;
        else if (option.skill === 'craft_item') p = 0.97;
        else if (option.skill === 'smelt_item') p = 0.93;
        else p = 0.9;
        const danger = night && raw.home_distance > 20 ? (raw.tools.sword > 0 ? 0.1 : 0.3) : 0.01;
        const secs = (20 + 3 * count + 1.5 * dist) * (agent === 'Felix' && option.skill === 'travel' ? 0.67 : 1);
        return { p, danger, secs };
    }

    return {
        flip() { turned = !turned; },
        // One case with what happened: { agent, option, raw, truth, end }. `end` has the fields
        // closeExperience takes, except ended_at.
        next() {
            const drawn = draw();
            const t = truth(drawn);
            const ok = r.chance(t.p);
            const danger = r.chance(t.danger);
            const kind = danger ? r.int(4) : -1;        // 0, 1: hurt   2: died   3: stuck
            const total = Math.max(1, drawn.count);
            const secs = t.secs * Math.exp(0.3 * r.normal());
            return {
                ...drawn, truth: t,
                end: {
                    outcome: ok ? 'completed' : 'failed', reason: ok ? null : FAIL_REASON[drawn.option.skill],
                    done: ok ? total : Math.floor(total * r() * 0.8), total, duration_ms: Math.round(secs * 1000),
                    died: kind === 2, health_lost: kind === 0 || kind === 1 ? 8 : kind === 2 ? 20 : 0, stuck: kind === 3, steps: [],
                },
            };
        },
        truth,
        draw,
    };
}

// Plays `n` simulated goals through the learner the way an agent would: stamp, estimate,
// open the experience with the prediction, close it with the outcome, observe.
//   mutate(experience_end, case) -> end    lets a test corrupt outcomes (inverted labels)
//   onGoal(experience, result)            called after each
// Returns the closed experiences when `keep` is set.
export function simulateGoals(learner, sim, n, { clock, mutate = null, onGoal = null, keep = false, chooser = 'routine', id_prefix = 'sim' } = {}) {
    const kept = [];
    for (let i = 0; i < n; i++) {
        const it = sim.next();
        const now = clock.now();
        const situation = learner.stamp(it.agent, it.option, it.raw, now);
        const est = learner.estimate(it.agent, it.option, situation, { chooser });
        const opened = openExperience({
            id: `${id_prefix}-${now}-${i}`, agent: it.agent, option_id: it.option.id, skill: it.option.skill, args: it.option.args,
            chooser, situation, predicted: learner.toPredicted(est), predicted_at: now, started_at: now, world_sha256: 'simulation',
        });
        if (!opened.ok) throw new Error(opened.problems.join('; '));
        clock.advance(it.end.duration_ms + 5000);
        const end = mutate ? mutate({ ...it.end }, it) : it.end;
        const closed = closeExperience(opened.experience, { ...end, ended_at: clock.now() });
        if (!closed.ok) throw new Error(closed.problems.join('; '));
        const result = learner.observe(closed.experience);
        if (onGoal) onGoal(closed.experience, result, it);
        if (keep) kept.push(closed.experience);
    }
    return kept;
}

// A clock the simulation moves by hand.
export function simClock(start = Date.parse('2026-01-01T00:00:00.000Z')) {
    let now = start;
    return { now: () => now, advance(ms) { now += ms; } };
}
