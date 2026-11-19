// The Decision trace view: one decision from what triggered it to how its steps ended.
//
// What the model wrote and what code decided are kept apart: the thought and the choice are
// labelled "model output", the steps "skill template", a routine choice "Routine".

import type { DecisionView, GenesisEvent } from '../../shared/types';
import { thoughtOf } from '../../shared/fold';
import { useClient, useJson } from '../store';
import { clockSeconds, dayTime, duration, sourceLabel } from '../format';
import { Fallback, Monogram, NotConnected, roleOf } from '../ui';

interface TraceData {
    source: string;
    decision: GenesisEvent;
    events: GenesisEvent[];
    goal_changes: GenesisEvent[];
    call: Record<string, any> | null;
    call_source: 'postgres' | 'unavailable' | 'none';
}

const seconds = (ms: unknown) => (typeof ms === 'number' ? `${(ms / 1000).toFixed(2)} s` : 'unknown');
const titlesOf = (goals: any[]) => (Array.isArray(goals) && goals.length > 0 ? goals.map((goal) => goal?.title ?? goal?.option_id ?? '?') : []);

function Steps({ decision, events }: { decision: GenesisEvent; events: GenesisEvent[] }) {
    const steps: string[] = Array.isArray(decision.data.steps) ? decision.data.steps : [];
    const results = new Map<number, GenesisEvent>();
    for (const event of events) if (event.type === 'skill.result' && Number.isInteger(event.data.step)) results.set(event.data.step, event);
    return (
        <ol class="ladder">
            {steps.map((step, i) => {
                const result = results.get(i);
                const text = !result ? 'not run' : result.data.ok ? `ok · ${duration(result.data.duration_ms)}` : result.data.timedout ? 'timed out' : result.data.interrupted ? 'interrupted' : 'failed';
                return (
                    <li>
                        <span class="mono">{step}</span>
                        <span class={`res ${result && !result.data.ok ? 'failed' : ''}`}>{text}{result?.data.attempt > 1 ? ` · try ${result!.data.attempt}` : ''}</span>
                    </li>
                );
            })}
        </ol>
    );
}

function TraceBody({ id }: { id: string }) {
    const { roster } = useClient();
    const { data, error, loading } = useJson<TraceData>(`/api/decisions/${encodeURIComponent(id)}`);
    if (loading && !data) return <div class="empty">Loading.</div>;
    if (error || !data) return <div class="note"><b>This decision is not in the history.</b> Events are kept 7 days.</div>;
    const d = data.decision.data;
    const routine = d.trigger === 'routine';
    const call = data.call;
    const change = data.goal_changes.find((event) => event.data.scope === 'short_term' && !String(event.data.reason).startsWith('replaced by')) ?? data.goal_changes[0] ?? null;
    // the model's own sentence: the `thought` field of the goal change that carries the planner's decision
    const thought = data.goal_changes.map((event) => thoughtOf(event.data)).find((sentence) => sentence !== null) ?? null;
    const end = data.events.find((event) => event.type === 'agent.state' && /^goal_(completed|failed|abandoned|dropped)$|^routine_yielded$/.test(event.data.state));
    const offered: any[] = Array.isArray(call?.options_offered) ? call!.options_offered : [];
    const chosen: string[] = Array.isArray(call?.chosen_ids) ? call!.chosen_ids : [];
    return (
        <div class="stack">
            <Fallback source={data.source} />
            <section class="panel row">
                <Monogram name={data.decision.agent} />
                <div style="flex:1;min-width:0">
                    <h2 class="title">{data.decision.agent}</h2>
                    <div class="small muted">{roleOf(roster, data.decision.agent)} · {dayTime(data.decision.ts)}</div>
                </div>
                <dl class="facts" style="flex:2 1 280px">
                    <div><dt>Chosen by</dt><dd>{sourceLabel(d.trigger) || 'unknown'}</dd></div>
                    <div><dt>Goal</dt><dd>{d.summary}</dd></div>
                    <div><dt>Ended</dt><dd>{end ? String(end.data.state).replace('goal_', '').replace('_', ' ') : 'in hand'}</dd></div>
                </dl>
            </section>

            {routine && <div class="note"><b>Routine.</b> Code chose this goal from the role routine. No model call was made.</div>}
            {d.trigger === 'operator' && <div class="note"><b>Operator.</b> This goal came from the operator. No model call was made.</div>}

            {!routine && d.call_id && (
                <>
                    <section class="panel stack">
                        <div class="between"><h2 class="title">Decision</h2><span class="tag line">model output</span></div>
                        <div class="label">Thought</div>
                        {thought ? <p class="thought" style="min-height:0">{thought}</p> : <div class="empty">The model gave no sentence.</div>}
                        {call?.raw_output && (<><div class="label">Raw reply</div><pre class="raw">{call.raw_output}</pre></>)}
                    </section>

                    {data.call_source === 'postgres' && call ? (
                        <>
                            <section class="panel stack">
                                <div class="between"><h2 class="title">Offered</h2><span class="plain">{offered.length} options · built by code</span></div>
                                <ol class="stack" style="gap:6px">
                                    {offered.map((option) => (
                                        <li class="option" aria-current={chosen.includes(option?.id) ? 'true' : undefined}>
                                            <span class="mono">{option?.id}</span>
                                            <span style="flex:1">{option?.description}</span>
                                            {chosen.includes(option?.id) && <span class="tag">Chosen</span>}
                                        </li>
                                    ))}
                                </ol>
                            </section>
                            <section class="panel stack">
                                <div class="between"><h2 class="title">Context</h2><span class="plain">{call.prompt_tokens ?? 'unknown'} tokens · built by code</span></div>
                                <pre class="raw">{call.context ?? ''}</pre>
                            </section>
                            <section class="panel stack">
                                <h2 class="title">Call</h2>
                                <dl class="facts">
                                    <div><dt>Latency</dt><dd>{seconds(call.latency_ms)}</dd></div>
                                    <div><dt>Queue wait</dt><dd>{seconds(call.queue_wait_ms)}</dd></div>
                                    <div><dt>Prompt tokens</dt><dd>{call.prompt_tokens ?? 'unknown'}</dd></div>
                                    <div><dt>Output tokens</dt><dd>{call.completion_tokens ?? 'unknown'}</dd></div>
                                    <div><dt>Attempt</dt><dd>{call.attempt} of 2</dd></div>
                                    <div><dt>Schema</dt><dd>{call.valid ? 'valid' : 'invalid'}</dd></div>
                                    <div><dt>Outcome</dt><dd>{call.outcome}</dd></div>
                                    <div><dt>Trigger</dt><dd>{call.call_trigger ?? 'unknown'}</dd></div>
                                </dl>
                            </section>
                        </>
                    ) : (
                        <NotConnected what="Call record"
                            missing={data.call_source === 'unavailable'
                                ? 'Postgres is down.'
                                : `No row for call ${d.call_id} in planner_calls. The planner writes it only when its postgres_url points at this database.`} />
                    )}
                </>
            )}

            {change && (
                <section class="panel stack">
                    <div class="between"><h2 class="title">Goal change</h2><span class="tag line">{sourceLabel(change.data.source)}</span></div>
                    <dl class="facts">
                        <div><dt>Before</dt><dd>{titlesOf(change.data.before).join(' · ') || 'none'}</dd></div>
                        <div><dt>After</dt><dd>{titlesOf(change.data.after).join(' · ') || 'none'}</dd></div>
                    </dl>
                </section>
            )}

            <section class="panel stack">
                <div class="between">
                    <h2 class="title">Steps</h2>
                    <span class="tag line">{d.steps_from === 'template' ? 'skill template' : d.steps_from ?? 'source unknown'}</span>
                </div>
                <div class="mono small muted">{d.command} · {Array.isArray(d.args) ? d.args.join(' ') : ''}</div>
                <Steps decision={data.decision} events={data.events} />
            </section>

            <section class="panel stack">
                <h2 class="title">Events</h2>
                <ol class="rule">
                    {data.events.map((event) => (
                        <li class="logline">
                            <span class="mono muted">{clockSeconds(event.ts)}</span>
                            <span class="mono" style="overflow-wrap:anywhere">{event.type}{event.type === 'agent.state' ? ` · ${event.data.state}` : event.data.skill ? ` · ${event.data.skill}` : ''}</span>
                            <span class={event.severity === 'info' ? 'mono small muted' : 'mono small'} style={event.severity === 'error' ? 'color:var(--crimson)' : ''}>{event.severity}</span>
                        </li>
                    ))}
                </ol>
            </section>
        </div>
    );
}

export function Trace({ selected }: { selected: string | null }) {
    const { live } = useClient();
    const stored = useJson<{ source: string; decisions: DecisionView[] }>('/api/decisions?limit=80');
    const by_id = new Map<string, DecisionView>();
    for (const decision of [...(stored.data?.decisions ?? []), ...live.decisions]) by_id.set(decision.decision_id, decision);
    const decisions = [...by_id.values()].sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 80);
    const current = selected ?? decisions[0]?.decision_id ?? null;
    return (
        <div class="trace">
            <nav class="panel" aria-label="Decisions" style="padding:8px;max-height:80vh;overflow:auto">
                {decisions.length === 0 && <div class="empty" style="padding:12px">{stored.loading ? 'Loading.' : 'No decision in the last 7 days.'}</div>}
                {decisions.map((decision) => (
                    <button type="button" class="pick" aria-current={decision.decision_id === current ? 'true' : undefined}
                        onClick={() => { location.hash = `#/trace/${encodeURIComponent(decision.decision_id)}`; }}>
                        <span class="between">
                            <span class="name">{decision.agent}</span>
                            <span class="mono small muted">{dayTime(decision.at)}</span>
                        </span>
                        <span class="small">{decision.summary}</span>
                        <span class="row" style="gap:6px">
                            <span class={decision.trigger === 'routine' || decision.trigger === 'operator' ? 'tag' : 'tag line'}>{sourceLabel(decision.trigger) || 'unknown'}</span>
                        </span>
                    </button>
                ))}
            </nav>
            {current ? <TraceBody id={current} key={current} /> : <div class="empty">Pick a decision.</div>}
        </div>
    );
}
