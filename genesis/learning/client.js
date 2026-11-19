// Genesis learning, the agent's end of the socket to the learner in the MindServer process
// (genesis/learning/service.js). The learner is one for all agents and lives there; an agent
// only tells it what it is about to do and what became of it, and asks it to order options.
//
//   agent -> learner   genesis-learn-begin     ({ agent, id, option, chooser, situation, ... }, ack)   a goal starts: the prediction is stored
//   agent -> learner   genesis-learn-end       ({ agent, id, end }, ack)                               the goal ended
//   agent -> learner   genesis-learn-rank      ({ agent, options, situations, chooser }, ack)          -> the same options, ordered and annotated
//   agent -> learner   genesis-learn-choose    ({ agent, options, situations, need, started_builds }, ack)   -> the learner's pick, with the decision row written
//   agent -> learner   genesis-learn-decision  ({ agent, ...decision })                                a choice somebody else made (the planner)
//
// begin() and end() never wait and never throw. rank() and choose() resolve to null when the
// learner does not answer in time (timeout_ms) or is not connected: the caller then goes on
// exactly as it did before there was a learner.
//
// Injected: send(event, ...args) (the socket's emit), clock { setTimeout, clearTimeout }.
// No imports.

export const LEARNING_CLIENT_DEFAULTS = Object.freeze({ timeout_ms: 1500 });

export function createLearningClient({ agent, send, clock = { setTimeout, clearTimeout }, timeout_ms = LEARNING_CLIENT_DEFAULTS.timeout_ms } = {}) {
    const stats = { begun: 0, ended: 0, ranked: 0, chosen: 0, decisions: 0, unanswered: 0, send_failed: 0 };

    const tell = (event, payload) => {
        try { send(event, payload, () => {}); return true; } catch { stats.send_failed++; return false; }
    };
    const ask = (event, payload) => new Promise((resolve) => {
        let settled = false;
        const finish = (value) => { if (settled) return; settled = true; clock.clearTimeout(timer); resolve(value); };
        const timer = clock.setTimeout(() => { stats.unanswered++; finish(null); }, timeout_ms);
        timer?.unref?.();
        try {
            send(event, payload, (answer) => finish(answer?.ok === true ? answer : null));
        } catch {
            stats.send_failed++;
            finish(null);
        }
    });

    return {
        agent,
        begin(fields) { if (tell('genesis-learn-begin', { ...fields, agent })) stats.begun++; },
        end(message) { if (tell('genesis-learn-end', { ...message, agent })) stats.ended++; },
        decision(fields) { if (tell('genesis-learn-decision', { ...fields, agent })) stats.decisions++; },
        // options: [{ id, skill, args, title? }]   situations: { option id: raw situation }
        // -> [{ id, label, estimate, score, need }] in the learner's order, or null
        async rank({ options, situations, need = {}, chooser = 'planner' }) {
            const answer = await ask('genesis-learn-rank', { agent, options, situations, need, chooser });
            if (answer) stats.ranked++;
            return answer?.ranked ?? null;
        },
        // -> { chosen (an option id or null), explore, decision_id, ranked, reason } or null
        async choose({ options, situations, need = {}, started_builds = [], held_back = [], default_choice = null }) {
            const answer = await ask('genesis-learn-choose', { agent, options, situations, need, started_builds, held_back, default_choice });
            if (answer) stats.chosen++;
            return answer ? { chosen: answer.chosen ?? null, explore: answer.explore === true, decision_id: answer.decision_id ?? null, ranked: answer.ranked ?? [], reason: answer.reason ?? null, need: answer.need ?? null } : null;
        },
        stats: () => ({ ...stats }),
    };
}
