// The Agents view (mock-up: Main). One card per agent, and the goal changes underneath.
//
// Honesty rules: the thought is the model's own sentence and shows its age; the steps come
// from the skill template and are labelled so; a routine choice is labelled Routine; what
// the operator did is labelled Operator.

import { agentStatus, isRoutineWork } from '../../shared/fold';
import type { AgentView, GoalChange, LiveState, ProcessStatus } from '../../shared/types';
import { useClient, useNow } from '../store';
import { age, dayTime, sourceLabel } from '../format';
import { Monogram, roleOf } from '../ui';

const FRESH_MS = 90 * 1000;        // how long a goal change is marked "Changed"
const STALE_MS = 5 * 60 * 1000;    // from when a thought is marked as old

const STATUS_CLASS: Record<string, string> = {
    Executing: 'status on', Recovering: 'status fail', Parked: 'status fail', Held: 'status gold', Waiting: 'status', Offline: 'status',
};

function AgentCard({ live, agent, role, process, now }: { live: LiveState; agent: AgentView; role: string; process: ProcessStatus | null; now: number }) {
    const status = agentStatus(live, agent, process ? process.in_game : null);
    const routine = isRoutineWork(agent);
    const plan = agent.plan;
    const goal = plan?.title ?? agent.short_term[0]?.title ?? null;
    const fresh = (change: { at: string } | null) => change !== null && now - Date.parse(change.at) < FRESH_MS;
    const thought_old = agent.thought !== null && now - Date.parse(agent.thought.at) > STALE_MS;
    const progress = agent.progress;
    const pct = progress && progress.total ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 0;
    const queued = agent.short_term.filter((queued_goal) => queued_goal.title !== goal);
    return (
        <article class="panel agent" aria-label={agent.name}>
            <div class="who">
                <Monogram name={agent.name} />
                <div class="id">
                    <h2 class="title">{agent.name}</h2>
                    <div class="small muted">
                        {role}
                        {process?.pos && <> · <span class="mono" style="font-size:12px;white-space:nowrap">x {process.pos[0]}, z {process.pos[2]}</span></>}
                    </div>
                </div>
                <div class={STATUS_CLASS[status]}>{status === 'Held' ? 'Held · Operator' : status}</div>
            </div>

            <section class="stack" style="gap:6px">
                <div class="between label">
                    <span>Thought <span class="plain">model</span></span>
                    <span class="row" style="gap:6px">
                        {thought_old && <span class="tag">Old</span>}
                        <span class="plain">{agent.thought ? age(agent.thought.at, now) : ''}</span>
                    </span>
                </div>
                {agent.thought
                    ? <p class="thought">{agent.thought.text}</p>
                    : <p class="thought none">No thought from the model yet.</p>}
            </section>

            <section class="stack" style="gap:8px">
                <div class="between label">
                    <span>Short-term</span>
                    <span class="row" style="gap:6px">
                        {routine && <span class="tag">Routine</span>}
                        {plan?.source === 'operator' && <span class="tag">Operator</span>}
                        {plan?.source === 'planner' && <span class="tag line">Model</span>}
                        {fresh(agent.short_change) && <span class="tag">Changed</span>}
                    </span>
                </div>
                <div class="goal">{goal ?? <span class="muted" style="font-weight:400">No goal in hand</span>}</div>
                {fresh(agent.short_change) && <div class="reason">{agent.short_change!.reason}</div>}
                {plan && plan.steps.length > 0 && (
                    <>
                        <div class="between label">
                            <span>Steps <span class="plain">{plan.steps_from === 'template' ? 'skill template' : plan.steps_from ?? 'source unknown'}</span></span>
                            <span class="plain">{Math.min(plan.cursor + 1, plan.steps.length)} / {plan.steps.length}{plan.attempt > 1 ? ` · try ${plan.attempt}` : ''}</span>
                        </div>
                        <ol class="steps">
                            {plan.steps.map((step, i) => (
                                <li class={i <= plan.done_through ? 'done' : i === plan.cursor ? 'now' : ''} aria-current={i === plan.cursor ? 'step' : undefined}>{step}</li>
                            ))}
                        </ol>
                    </>
                )}
                {queued.length > 0 && (
                    <div class="small muted">Next: {queued.map((queued_goal) => queued_goal.title).join(' · ')}</div>
                )}
            </section>

            <section class="stack" style="gap:6px">
                <div class="between label">
                    <span>Skill</span>
                    <span class="plain">{progress ? `${progress.done}${progress.total !== null ? ` / ${progress.total}` : ''}${progress.unit ? ` ${progress.unit}` : ''}` : ''}</span>
                </div>
                <div class="mono small">{progress?.skill ?? plan?.skill ?? <span class="muted">none</span>}</div>
                <div class="bar" role="img" aria-label={progress ? `${progress.skill} ${pct} percent complete` : 'no skill running'}>
                    <div style={`width:${pct}%`} />
                </div>
            </section>

            <section class="long">
                <div class="between label">
                    <span>Long-term</span>
                    {fresh(agent.long_change) && <span class="tag">Changed</span>}
                </div>
                {agent.long_term.length > 0
                    ? <ul class="stack" style="gap:8px">{agent.long_term.map((long_goal) => <li>{long_goal.title}</li>)}</ul>
                    : <div class="empty">None received.</div>}
                {fresh(agent.long_change) && <div class="reason">{agent.long_change!.reason}</div>}
            </section>
        </article>
    );
}

function changeText(change: GoalChange): string {
    const parts: string[] = [];
    if (change.added.length > 0) parts.push(`New goal: ${change.added.join(' · ')}.`);
    if (change.removed.length > 0) parts.push(`Ended: ${change.removed.join(' · ')}.`);
    return parts.join(' ') || 'Reordered.';
}

export function Agents() {
    const { live, roster, processes, loaded } = useClient();
    const now = useNow(1000);
    const names = [...roster.map((agent) => agent.name), ...Object.keys(live.agents).filter((name) => !roster.some((agent) => agent.name === name))];
    const feed = live.goal_changes.slice(0, 8);
    return (
        <>
            <main class="agents">
                {names.map((name) => live.agents[name] && (
                    <AgentCard live={live} agent={live.agents[name]} role={roleOf(roster, name)} now={now}
                        process={processes?.find((process) => process.name === name) ?? null} />
                ))}
                {loaded && names.length === 0 && <div class="empty">No agent has sent an event.</div>}
            </main>
            <section class="panel">
                <h2 class="title" style="margin-bottom:8px">Goal changes</h2>
                {feed.length === 0 ? <div class="empty">None yet.</div> : (
                    <ol class="rule feed">
                        {feed.map((change) => (
                            <li>
                                <span class="when">{dayTime(change.at)}</span>
                                <span class="whom">
                                    <span class="name">{change.agent}</span>
                                    <span class="small muted" style="font-size:12px">{change.scope === 'long_term' ? 'Long-term' : 'Short-term'} · {sourceLabel(change.source)}</span>
                                </span>
                                <span class="what">
                                    <span>{changeText(change)}</span>
                                    <span class="small muted" style="font-style:italic">{change.reason}</span>
                                </span>
                            </li>
                        ))}
                    </ol>
                )}
            </section>
        </>
    );
}
