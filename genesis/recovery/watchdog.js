// Genesis: the watchdog. Every 10 seconds it compares a progress signature (position cell,
// inventory hash, step index). With no progress it climbs a ladder of recovery steps, one
// rung at a time, and stops climbing as soon as progress resumes (decided):
//
//   1 repath            find a new path: the running step is stopped and tried afresh
//   2 move_away         move away a few blocks, then the step is tried again
//   3 surface_or_home   go to the surface or walk home
//   4 park_step         park the step and move to the next goal
//   5 restart_process   restart the agent process (the incident is in the checkpoint and goes on after it)
//   6 needs_operator    mark the incident as needing the operator
//
// The ladder is capped per hour so it cannot loop: once the rungs taken within the hour
// reach the cap, the next stall goes to rung 6 exactly once, and nothing more is done until
// the hour has rolled on.
//
// One incident runs from the first stall until progress has held for a few checks. Progress
// in between only stops the climbing; when the agent stalls again before the incident is
// over, the climb goes on at the next rung instead of starting at the first one again.
// What a rung itself moved (the walk home, the parked step) is never taken for progress.
//
// NOT stuck, never climbing (decided): a held agent (operator !stop), an agent waiting on
// the model, and an agent in its routine's Shelter phase at night. `status()` says so.
//
// Everything outside is injected:
//   signature()       -> string     the progress signature now (progressSignature below)
//   status()          -> null | 'held' | 'waiting_model' | 'sheltering' | 'idle' | 'stationary_step' | 'down'
//                     null: the agent is trying to work, so no progress means stuck
//   actions           { repath, move_away, surface_or_home, park_step, restart_process } each
//                     async ({ incident, rung }) -> { ok, skipped?, detail? }
//   reporter          genesis/recovery/incidents.js
//   clock             { now(), setTimeout(fn, ms), clearTimeout(handle) }
// Depends only on genesis/recovery/incidents.js.

import { INCIDENT_KINDS } from './incidents.js';

export const LADDER = Object.freeze(['repath', 'move_away', 'surface_or_home', 'park_step', 'restart_process', 'needs_operator']);
const RESTART_RUNG = LADDER.indexOf('restart_process') + 1;
const OPERATOR_RUNG = LADDER.length;

export const WATCHDOG_DEFAULTS = Object.freeze({
    interval_ms: 10 * 1000,          // decided: the signature is compared every 10 seconds
    cap_window_ms: 60 * 60 * 1000,   // decided: the ladder is capped per hour
    max_climbs_per_hour: 12,         // proposed: rungs taken within the hour before the cap closes the ladder
    stall_checks: 3,                 // proposed: checks without progress before the first rung (30 seconds)
    rung_checks: 2,                  // proposed: checks without progress after a rung before the next one (20 seconds)
    resolve_checks: 3,               // proposed: checks with progress in a row before the incident is over
});

// Proposed: how the progress signature is cut, and which steps stand still on purpose.
export const SIGNATURE_DEFAULTS = Object.freeze({
    cell_size: 2,                              // blocks per position cell (upstream's unstuck mode also uses 2 blocks)
    stationary_commands: Object.freeze(['smeltItem']),  // a step that waits at a furnace is not stuck
    move_away_blocks: 5,                       // "a few blocks" (upstream's unstuck mode moves 5)
});

// Reasons a goal ended with that mean "the agent could not get there": with nothing else in
// hand, such an agent is not resting, it is shut in.
// ("stuck" is not one of them: a step the ladder parked is dealt with; an agent that has nothing else to do after it rests)
export const BLOCKED_REASONS = Object.freeze(['no_safe_path', 'not_reached', 'path_unknown', 'chest_unreachable', 'furnace_unreachable', 'timed_out']);

// The progress signature: position cell, inventory hash, step index.
//   position { x, y, z }; inventory { item: count }; step: a counter or key that changes when a step is done
export function progressSignature({ position, inventory, step }, cell_size = SIGNATURE_DEFAULTS.cell_size) {
    const cell = ['x', 'y', 'z'].map((axis) => Math.floor(Number(position?.[axis] ?? 0) / cell_size)).join(',');
    return `${cell}|${inventoryHash(inventory)}|${step ?? ''}`;
}

// A short stable hash of what is carried (FNV-1a over the sorted "item:count" list).
export function inventoryHash(inventory) {
    const text = Object.entries(inventory ?? {}).filter(([, count]) => count > 0).sort((a, b) => a[0].localeCompare(b[0]))
        .map(([item, count]) => `${item}:${count}`).join(',');
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
}

export function createWatchdog({
    signature, status = () => null, actions = {}, reporter, clock = { now: Date.now, setTimeout, clearTimeout }, ...options
} = {}) {
    const config = { ...WATCHDOG_DEFAULTS };
    for (const key of Object.keys(WATCHDOG_DEFAULTS)) {
        if (options[key] !== undefined) config[key] = options[key];
    }
    const stats = { checks: 0, exempt: 0, stalls: 0, climbs: 0, resolved: 0, operator: 0, capped: 0, suppressed: 0, nudges: 0 };

    let last = null;          // the signature at the last check
    let still = 0;            // checks without progress in a row
    let moving = 0;           // checks with progress in a row while an incident is open
    let incident = null;      // { incident_id, kind, rung, opened_at, last_step }: rung is the last one taken (0: none yet)
    let climbs = [];          // when rungs were taken, within the cap window
    let cap_reported = false; // the cap sent one incident to the operator and stays shut until the window rolls on
    let acting = false;
    let nudged = null;        // upstream's own stuck detection said "stuck" since the last check
    let timer = null;
    let running = false;

    const read = () => { try { return String(signature()); } catch { return last ?? ''; } };
    const why = () => { try { return status() ?? null; } catch { return null; } };
    const recent = (now) => { climbs = climbs.filter((at) => at > now - config.cap_window_ms); return climbs.length; };
    const stepInfo = (name, result) => ({ step: name, attempt: 1, max: 1, result });

    function resolve(reason) {
        const over = incident;
        incident = null;
        moving = 0;
        still = 0;
        stats.resolved++;
        const done = over.rung > 0 ? LADDER[over.rung - 1] : null;
        reporter.resolved(over, {
            recovery: done ? stepInfo(done, 'ok') : null, outcome: 'auto_recovered', rung: over.rung, rungs: LADDER.length, reason,
            stalled_ms: Math.max(0, clock.now() - over.opened_at),
        });
        return { kind: 'resolved', incident_id: over.incident_id, rung: over.rung };
    }

    async function climb() {
        const now = clock.now();
        const rung = incident.rung + 1;
        if (rung > OPERATOR_RUNG) return { kind: 'waiting_for_operator', incident_id: incident.incident_id };
        if (rung < OPERATOR_RUNG && recent(now) >= config.max_climbs_per_hour) {
            // the cap: straight to the operator, once
            stats.capped++;
            cap_reported = true;
            return toOperator('hourly_cap');
        }
        if (rung === OPERATOR_RUNG) return toOperator('ladder_exhausted');

        const name = LADDER[rung - 1];
        incident.rung = rung;
        climbs.push(now);
        stats.climbs++;
        still = 0;
        moving = 0;
        const more = { rung, rungs: LADDER.length };
        if (rung === RESTART_RUNG) {
            // told (and so in the checkpoint) before the process ends: the incident goes on in the next process
            reporter.step(incident, stepInfo(name, 'pending'), more);
        }
        acting = true;
        let result;
        try {
            result = await (actions[name] ?? (async () => ({ ok: false, skipped: true })))({ incident: { ...incident }, rung });
        } catch (err) {
            result = { ok: false, detail: String(err?.message ?? err) };
        } finally {
            acting = false;
        }
        if (rung !== RESTART_RUNG && incident) {
            reporter.step(incident, stepInfo(name, result?.ok ? 'ok' : (result?.skipped ? 'skipped' : 'failed')),
                { ...more, ...(result?.detail ? { message: String(result.detail) } : {}) });
        }
        last = read(); // what the rung itself moved is not progress
        return { kind: 'climbed', rung, step: name, ok: result?.ok === true };
    }

    function toOperator(reason) {
        incident.rung = OPERATOR_RUNG;
        still = 0;
        stats.operator++;
        reporter.escalated(incident, { recovery: stepInfo('needs_operator', 'ok'), rung: OPERATOR_RUNG, rungs: LADDER.length, reason });
        return { kind: 'needs_operator', incident_id: incident.incident_id, reason };
    }

    // One check. Resolves to what was found or done: { kind: 'exempt' | 'first' | 'progress' |
    // 'still' | 'climbed' | 'needs_operator' | 'resolved' | 'suppressed' | 'acting' | ... }.
    async function tick() {
        if (acting) return { kind: 'acting' };
        stats.checks++;
        const exempt = why();
        const now_sig = read();
        if (exempt !== null) {
            stats.exempt++;
            last = now_sig;
            still = 0;
            nudged = null;
            // an agent that rests (it is not held and not down) is no longer fighting what it was stuck on
            if (incident && exempt !== 'held' && exempt !== 'down' && ++moving >= config.resolve_checks) return resolve(exempt);
            return { kind: 'exempt', reason: exempt };
        }
        if (last === null) { last = now_sig; return { kind: 'first' }; }
        if (now_sig !== last) {
            last = now_sig;
            still = 0;
            nudged = null;
            if (incident && ++moving >= config.resolve_checks) return resolve('progress');
            return { kind: 'progress' };
        }
        still++;
        moving = 0;
        const needed = incident && incident.rung > 0 ? config.rung_checks : config.stall_checks;
        const forced = nudged !== null;
        nudged = null;
        if (still < needed && !forced) return { kind: 'still', checks: still };
        if (incident && incident.rung >= OPERATOR_RUNG) return { kind: 'waiting_for_operator', incident_id: incident.incident_id };
        if (!incident) {
            if (cap_reported) {
                if (recent(clock.now()) >= config.max_climbs_per_hour) { stats.suppressed++; still = 0; return { kind: 'suppressed' }; }
                cap_reported = false; // the hour has rolled on: the ladder is open again
            }
            stats.stalls++;
            incident = { ...reporter.detected({ kind: INCIDENT_KINDS.STUCK, checks: still, upstream: forced }), rung: 0, opened_at: clock.now() };
        }
        return climb();
    }

    function schedule() {
        if (!running) return;
        timer = clock.setTimeout(() => {
            timer = null;
            tick().catch(() => {}).finally(schedule);
        }, config.interval_ms);
        timer?.unref?.();
    }

    return {
        config,
        tick,
        start() { if (!running) { running = true; schedule(); } },
        stop() { running = false; if (timer !== null) { clock.clearTimeout(timer); timer = null; } },
        // Upstream's own stuck detection fired (src/agent/modes.js, the "unstuck" mode). It no longer
        // kills the process for a Genesis agent: the next check takes it as a stall, if the signature agrees.
        nudge(reason = 'upstream_unstuck') { stats.nudges++; nudged = String(reason); },
        incident: () => (incident ? { ...incident } : null),
        isActing: () => acting,
        // What the checkpoint keeps, and the way back after a restart of the process.
        snapshot() {
            const now = clock.now();
            recent(now);
            if (!incident && climbs.length === 0 && !cap_reported) return null;
            return { incident: incident ? { ...incident } : null, climbs: [...climbs], cap_reported };
        },
        restore(saved) {
            if (saved === null || typeof saved !== 'object') return false;
            climbs = (Array.isArray(saved.climbs) ? saved.climbs : []).filter(Number.isFinite);
            cap_reported = saved.cap_reported === true;
            const open = saved.incident;
            if (open && typeof open.incident_id === 'string' && Number.isInteger(open.rung) && open.rung >= 0 && open.rung <= OPERATOR_RUNG) {
                incident = { incident_id: open.incident_id, kind: String(open.kind ?? INCIDENT_KINDS.STUCK), source: open.source,
                    rung: open.rung, opened_at: Number.isFinite(open.opened_at) ? open.opened_at : clock.now() };
            }
            last = null;
            still = 0;
            moving = 0;
            // the process was restarted on the ladder's fifth rung, and here it is again
            if (incident?.rung === RESTART_RUNG) reporter.step(incident, stepInfo(LADDER[RESTART_RUNG - 1], 'ok'), { rung: RESTART_RUNG, rungs: LADDER.length });
            return true;
        },
        stats: () => ({ ...stats, still, rung: incident?.rung ?? 0, open: incident !== null, climbs_in_window: recent(clock.now()) }),
    };
}
