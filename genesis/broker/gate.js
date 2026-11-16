// Genesis: the model gate. It knows whether the desktop that runs the model is there.
//
//   AVAILABLE  planning calls may be sent
//   LEAVING    the desktop said it is going: no new calls, the call in flight is cancelled
//   AWAY       no calls
//
//   desktop_available, then one passing health probe   -> AVAILABLE
//   desktop_leaving                                    -> LEAVING -> AWAY
//   two failed health probes in a row, with no warning -> AWAY, with exactly one event
//   one passing health probe after such a silent loss  -> AVAILABLE (no signal needed)
//
// How the gate comes back depends on how it went away. After desktop_leaving the desktop
// said it is gone: it is not probed at all, and only desktop_available (plus a passing
// probe) reopens the gate. After an unannounced loss (two failed probes) the probes go on,
// and the first one that passes reopens the gate by itself.
//
// A missing model is never a failure and never an alert: every event the gate emits has
// severity "info", and a probe that fails while the gate is AWAY is not reported at all.
//
// Everything outside is injected:
//   probe()                 -> Promise<boolean>  true when the model server answers (a throw counts as false)
//   clock                   { setTimeout(fn, ms), clearTimeout(handle) }  used only to give up on a probe that hangs
//   emit(type, data, opts)  the event emitter (genesis/events/agent_emit.js shape)
// No imports.

export const GATE_STATES = Object.freeze({ AVAILABLE: 'AVAILABLE', LEAVING: 'LEAVING', AWAY: 'AWAY' });

export const GATE_DEFAULTS = Object.freeze({
    failed_probes_to_away: 2,
    probe_timeout_ms: 5000,
    // true (decided): after the gate went AWAY on failed probes, a passing probe brings it
    // back by itself. false: only desktop_available does.
    // Either way, after desktop_leaving only desktop_available brings it back.
    probe_recovery: true,
});

export function createModelGate({ probe, clock = { setTimeout, clearTimeout }, emit = () => {}, ...options } = {}) {
    const config = { ...GATE_DEFAULTS };
    for (const key of Object.keys(GATE_DEFAULTS)) {
        if (options[key] !== undefined) config[key] = options[key];
    }

    let state = GATE_STATES.AWAY;
    let away_reason = 'start';   // why the gate is AWAY: start | desktop_leaving | probe_failed
    let wanted = false;          // desktop_available came, and no probe has passed since
    let failed_in_a_row = 0;     // failed probes while AVAILABLE
    let epoch = 0;               // goes up with every desktop signal: a probe started before it does not count
    let probing = null;
    const leave_handlers = new Set();     // run when calls must stop; the gate waits for them
    const available_handlers = new Set();

    function announce(new_state, detail) {
        try {
            emit('agent.state', { state: `model_${new_state.toLowerCase()}`, detail }, { severity: 'info' });
        } catch { /* an event must never disturb the gate */ }
    }

    async function runHandlers(handlers, ...args) {
        await Promise.allSettled([...handlers].map(async (handler) => handler(...args)));
    }

    // One probe, never longer than probe_timeout_ms. Resolves to true or false.
    function probeOnce() {
        return new Promise((resolve) => {
            const timer = clock.setTimeout(() => resolve(false), config.probe_timeout_ms);
            Promise.resolve()
                .then(() => probe())
                .then((answer) => resolve(answer === true), () => resolve(false))
                .finally(() => clock.clearTimeout(timer));
        });
    }

    // The health probe. Called on a timer by the broker, and right after desktop_available.
    // At most one probe runs at a time.
    function tick() {
        if (probing) return probing;
        const wants_probe = state === GATE_STATES.AVAILABLE
            || (state === GATE_STATES.AWAY && (wanted || (config.probe_recovery && away_reason === 'probe_failed')));
        if (!wants_probe) return Promise.resolve(state);
        const started_epoch = epoch;
        probing = (async () => {
            const passed = await probeOnce();
            probing = null;
            if (started_epoch !== epoch) return state; // a desktop signal came meanwhile: it decides
            if (state === GATE_STATES.AVAILABLE) {
                if (passed) {
                    failed_in_a_row = 0;
                } else if (++failed_in_a_row >= config.failed_probes_to_away) {
                    failed_in_a_row = 0;
                    state = GATE_STATES.AWAY;
                    away_reason = 'probe_failed';
                    announce(state, { reason: 'probe_failed', failed_probes: config.failed_probes_to_away });
                    await runHandlers(leave_handlers, 'probe_failed');
                }
            } else if (state === GATE_STATES.AWAY && passed) {
                wanted = false;
                state = GATE_STATES.AVAILABLE;
                announce(state, { reason: away_reason === 'probe_failed' ? 'probe_passed' : 'desktop_available' });
                await runHandlers(available_handlers);
            }
            return state;
        })();
        return probing;
    }

    // The desktop says it is there. The gate opens only after one probe has passed;
    // if this one fails, the next tick tries again.
    async function desktopAvailable() {
        epoch++;
        if (state === GATE_STATES.AVAILABLE) return state;
        wanted = true;
        if (state === GATE_STATES.LEAVING) return state; // desktopLeaving probes when it is done
        if (probing) await probing;                      // a probe from before the signal: let it end, it does not count
        return tick();
    }

    // The desktop says it is going. Resolves once the call in flight has been cancelled
    // and the gate is AWAY.
    async function desktopLeaving() {
        epoch++;
        wanted = false;
        failed_in_a_row = 0;
        if (state === GATE_STATES.LEAVING) return state;
        if (state === GATE_STATES.AWAY) {
            away_reason = 'desktop_leaving';
            return state;
        }
        state = GATE_STATES.LEAVING;
        announce(state, { reason: 'desktop_leaving' });
        await runHandlers(leave_handlers, 'desktop_leaving');
        state = GATE_STATES.AWAY;
        away_reason = 'desktop_leaving';
        announce(state, { reason: 'desktop_leaving' });
        if (wanted) return tick(); // desktop_available came while the gate was closing
        return state;
    }

    return {
        state: () => state,
        isAvailable: () => state === GATE_STATES.AVAILABLE,
        awayReason: () => (state === GATE_STATES.AWAY ? away_reason : null),
        desktopAvailable,
        desktopLeaving,
        tick,
        onLeave(handler) { leave_handlers.add(handler); return () => leave_handlers.delete(handler); },
        onAvailable(handler) { available_handlers.add(handler); return () => available_handlers.delete(handler); },
    };
}
