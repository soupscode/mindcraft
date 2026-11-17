// Genesis: the action catalog. It knows the nine skill templates and answers three
// questions about them, always from the world as it is at that moment:
//   offer(agent_state)        which goals can start right now (arguments already filled in)
//   check(option_id, state)   does this one still hold (asked again before a queued goal starts)
//   plan(option, state)       the ordered steps for it
// An option the model may choose is { id, skill, args, title, description }. The id is
// stable: the same skill with the same arguments always has the same id, and the id alone
// is enough to find the skill and the arguments again ("gather_blocks:oak_log:8").
//
// agent_state: { agent, view, ledger, avoid?, now?, duties?, talk? }   (described in templates.js)
//
// Beside the skills, the catalog offers the planner two messages to other agents as goals
// (decided): ask_agent and offer_agent. They are only offered to an agent that has a message
// desk (agent_state.talk), and only while their preconditions hold.
//
// Contested claims: when an agent wants items that another agent has reserved in the chest
// ledger, the option is refused with the reason "contested_claim" AND the catalog reports the
// claim, { chest, item, count, holder, held, asker, in_chest }, to whoever listens:
//   createCatalog({ onContested })   or   catalog.setContestedHook(fn)
// The agent runtime turns it into an event and hands it to the hook the agent-to-agent
// request will be sent from (a later step; nothing is sent to another agent from here).
// Fixed for the catalog's life: zones (genesis/catalog/zones.js), blueprints
// ({ get(name) -> { name, blocks[y][z][x] } | null }) and the config tables (defaults.js).
//
// Depends only on other files of genesis/catalog.

import { TEMPLATES, HANDOFF_TEMPLATES, MESSAGE_TEMPLATES } from './templates.js';
import { STEP_NAMES, COMMON_FAILURES } from './ops.js';
import {
    CATALOG_DEFAULTS, GATHER_TYPES, CROPS, CRAFT_ITEMS, NATURAL_BLOCKS, NATURAL_SUFFIXES, CLEARABLE_BLOCKS, KEEP_ITEMS, KEEP_SUFFIXES,
} from './defaults.js';

const NO_BLUEPRINTS = Object.freeze({ get: () => null });

export function createCatalog({ zones, blueprints = NO_BLUEPRINTS, config = {}, onContested = null } = {}) {
    if (!zones) throw new Error('the catalog needs the zones');
    let contested_hook = typeof onContested === 'function' ? onContested : null;
    let quiet = 0; // > 0 while an offer is put together: looking at what could be offered is not wanting it
    const settings = {
        ...CATALOG_DEFAULTS, accept_partial_path: true, ...config,
        per_skill: { ...CATALOG_DEFAULTS.per_skill, ...(config.per_skill ?? {}) },
    };
    // what a plot may be cleared of: the ground, and a torch the idle torch reflex left there
    const natural_blocks = new Set([...(config.natural_blocks ?? NATURAL_BLOCKS), ...(config.clearable_blocks ?? CLEARABLE_BLOCKS)]);
    const keep_items = new Set(config.keep_items ?? KEEP_ITEMS);
    const ctx = {
        config: settings,
        gather_types: config.gather_types ?? GATHER_TYPES,
        crops: config.crops ?? CROPS,
        craft_items: config.craft_items ?? CRAFT_ITEMS,
        natural: (name) => natural_blocks.has(name) || NATURAL_SUFFIXES.some((suffix) => name.endsWith(suffix)),
        keep: (item) => keep_items.has(item) || KEEP_SUFFIXES.some((suffix) => item.endsWith(suffix)),
        // an item the catalog knows: something it gathers, crafts, sows or harvests
        known: (item) => known_items.has(item),
        // every item the catalog knows, in the order of its tables
        knownItems: () => [...known_items],
        // An agent wanted items another agent has reserved. Never throws.
        contested(claim) {
            if (quiet > 0 || !contested_hook) return;
            try { contested_hook({ ...claim }); } catch { /* the listener's problem */ }
        },
    };
    const known_items = new Set([
        ...Object.values(ctx.gather_types).flatMap((type) => type.drops),
        ...ctx.craft_items.map(([item]) => item),
        ...Object.values(ctx.crops).flatMap((crop) => [crop.seed, crop.produce].filter(Boolean)),
    ]);
    const work_templates = [...TEMPLATES, ...HANDOFF_TEMPLATES]; // the nine, and the hand-over that only a commitment brings up
    const offered_templates = [...work_templates, ...MESSAGE_TEMPLATES]; // and the two messages the planner may choose to send
    const by_name = new Map(offered_templates.map((template) => [template.name, template]));

    const full = (state) => ({ avoid: [], now: null, ...state, zones, blueprints });

    function makeOption(template, args, state) {
        return {
            id: template.id(args),
            skill: template.name,
            args,
            title: template.title(args),
            description: template.describe(args, state, ctx),
        };
    }

    // The skill and arguments an option id stands for, or null when it is not an id of this catalog.
    function resolve(option_id) {
        if (typeof option_id !== 'string') return null;
        const [name, ...parts] = option_id.split(':');
        const template = by_name.get(name);
        if (!template) return null;
        const args = template.parse(parts);
        if (!args || template.id(args) !== option_id) return null;
        return { template, args };
    }

    // Never throws: a view that fails makes the option unavailable, with the reason "world_error".
    function refusal(template, args, state) {
        try {
            return template.check(args, state, ctx);
        } catch (err) {
            return `world_error: ${err?.message ?? err}`;
        }
    }

    function collectFrom(templates, state, options, room) {
        for (const template of templates) {
            let taken = 0;
            let candidates;
            try { candidates = template.candidates(state, ctx); } catch { candidates = []; }
            const seen = new Set();
            for (const args of candidates) {
                if (taken >= (settings.per_skill[template.name] ?? 1) || options.length >= room) break;
                const id = template.id(args);
                if (seen.has(id)) continue;
                seen.add(id);
                if (refusal(template, args, state) !== null) continue;
                options.push(makeOption(template, args, state));
                taken++;
            }
        }
    }

    // The work first, then the messages the planner may send. The messages are few and their
    // places are kept free: a long list of work never pushes them off the offer.
    function collect(state, options) {
        const messages = [];
        collectFrom(MESSAGE_TEMPLATES, state, messages, settings.max_options);
        collectFrom(work_templates, state, options, settings.max_options - messages.length);
        options.push(...messages);
    }

    return {
        config: settings,
        skills: () => TEMPLATES.map((template) => ({
            name: template.name, progress_unit: template.progress_unit,
            failures: [...new Set([...template.failures, ...COMMON_FAILURES])],
        })),
        resolve(option_id) {
            const found = resolve(option_id);
            return found ? { skill: found.template.name, args: found.args } : null;
        },
        // Only what can run now. At most max_options, at most per_skill[name] of one skill,
        // in a fixed order, so the same world gives the same list.
        offer(agent_state) {
            const state = full(agent_state);
            const options = [];
            quiet++;
            try {
                collect(state, options);
            } finally {
                quiet--;
            }
            return options;
        },
        // true for what an agent keeps for itself (tools, armour, torches, food): never given away
        keeps: (item) => ctx.keep(item),
        // Who is told about contested claims (one listener; null for none).
        setContestedHook(fn) { contested_hook = typeof fn === 'function' ? fn : null; },
        // A goal ended, however it ended: the template gives back what it held (a reservation). Never throws.
        release(option_id, agent_state) {
            const found = resolve(option_id);
            if (!found || typeof found.template.release !== 'function') return false;
            try { found.template.release(found.args, full(agent_state), ctx); return true; } catch { return false; }
        },
        // { ok: true, option } when the preconditions hold now, else { ok: false, reason }.
        check(option_id, agent_state) {
            const found = resolve(option_id);
            if (!found) return { ok: false, reason: 'unknown_option' };
            const state = full(agent_state);
            const reason = refusal(found.template, found.args, state);
            if (reason !== null) return { ok: false, reason };
            return { ok: true, option: makeOption(found.template, found.args, state) };
        },
        // The same for a skill and arguments chosen by code (the routines).
        option(skill, args, agent_state) {
            const template = by_name.get(skill);
            if (!template) return { ok: false, reason: 'unknown_skill' };
            let id;
            try { id = template.id(args); } catch { return { ok: false, reason: 'bad_arguments' }; }
            if (!resolve(id)) return { ok: false, reason: 'bad_arguments' };
            const state = full(agent_state);
            const reason = refusal(template, args, state);
            if (reason !== null) return { ok: false, reason };
            return { ok: true, option: makeOption(template, args, state) };
        },
        // The candidates a skill has now, as code would fill them in (the routines choose among them).
        candidates(skill, agent_state) {
            const template = by_name.get(skill);
            if (!template) return [];
            try { return template.candidates(full(agent_state), ctx); } catch { return []; }
        },
        // The steps and the progress baseline for an option whose preconditions hold.
        plan(option, agent_state) {
            const found = resolve(option.id);
            const state = full(agent_state);
            const steps = found.template.steps(found.args, state, ctx);
            for (const step of steps) {
                if (!STEP_NAMES.includes(step.command)) throw new Error(`template ${found.template.name} names an unknown command: ${step.command}`);
            }
            return { steps, baseline: found.template.baseline(found.args, state, ctx) };
        },
        // The guard right before a step. Never throws.
        before(option_id, step, agent_state) {
            const found = resolve(option_id);
            if (!found) return { fail: 'unknown_option' };
            if (!STEP_NAMES.includes(step.command)) return { fail: 'unknown_command' };
            try {
                return found.template.before(step, found.args, full(agent_state), ctx) ?? null;
            } catch (err) {
                return { fail: `world_error: ${err?.message ?? err}` };
            }
        },
        after(option_id, step, result, agent_state, baseline) {
            const found = resolve(option_id);
            if (!found) return null;
            try {
                return found.template.after(step, result, found.args, full(agent_state), ctx, baseline ?? {}) ?? null;
            } catch {
                return null;
            }
        },
        // { done, total } for the whole goal (total may be null), or null when it cannot be measured now.
        progress(option_id, agent_state, baseline, plan) {
            const found = resolve(option_id);
            if (!found) return null;
            try {
                const measured = found.template.progress(found.args, full(agent_state), ctx, baseline ?? {}, plan);
                const done = Number.isFinite(measured?.done) ? Math.max(0, Math.floor(measured.done)) : 0;
                const total = Number.isFinite(measured?.total) ? Math.max(0, Math.floor(measured.total)) : null;
                return { done, total, unit: found.template.progress_unit };
            } catch {
                return null;
            }
        },
    };
}
