// The Routines view: who is on the role routine, since when, the routine goal in hand and its
// steps, and the routine's phase and bounds as its own "routine" event reports them (when the
// phase or a breached bound changes, and once a minute otherwise).

import { isRoutineWork } from '../../shared/fold';
import { useClient, useNow } from '../store';
import { clockTime, duration } from '../format';
import { Monogram, roleOf } from '../ui';

export function Routines() {
    const { live, roster, processes } = useClient();
    const now = useNow(1000);
    const away = live.model.state === 'away' || live.model.state === 'leaving';
    const names = [...roster.map((agent) => agent.name), ...Object.keys(live.agents).filter((name) => !roster.some((agent) => agent.name === name))];
    const on_routine = names.filter((name) => live.agents[name] && isRoutineWork(live.agents[name])).length;
    return (
        <>
            <section class="panel tint" aria-label="Model">
                <div class="between"><h2 class="title">{away ? 'Model away' : live.model.state === 'available' ? 'Model available' : 'Model unknown'}</h2>{away && <span class="tag">Expected</span>}</div>
                <dl class="facts" style="margin-top:12px">
                    <div><dt>Since</dt><dd>{live.model.since ? clockTime(live.model.since) : 'unknown'}</dd></div>
                    <div><dt>Duration</dt><dd>{live.model.since ? duration(now - Date.parse(live.model.since)) : 'unknown'}</dd></div>
                    <div><dt>Routines</dt><dd>{on_routine} / {names.length}</dd></div>
                </dl>
            </section>
            <main class="cards">
                {names.map((name) => {
                    const agent = live.agents[name];
                    if (!agent) return null;
                    const routine = isRoutineWork(agent);
                    const plan = agent.plan && agent.plan.source === 'routine' ? agent.plan : null;
                    const progress = plan ? agent.progress : null;
                    const pct = progress && progress.total ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 0;
                    const pos = processes?.find((process) => process.name === name)?.pos;
                    return (
                        <article class="panel stack" aria-label={`${name} routine`}>
                            <div class="row">
                                <Monogram name={name} />
                                <div style="flex:1;min-width:0">
                                    <h2 class="title">{name}</h2>
                                    <div class="small muted">{roleOf(roster, name)}{pos && <> · <span class="mono" style="font-size:12px">x {pos[0]}, z {pos[2]}</span></>}</div>
                                </div>
                                <span class={routine ? 'tag' : 'tag line'}>{routine ? 'Routine' : agent.mode === 'model' ? 'Model-led' : 'Unknown'}</span>
                            </div>
                            <dl class="facts">
                                <div><dt>Since</dt><dd>{agent.mode_since ? `${clockTime(agent.mode_since)} · ${duration(now - Date.parse(agent.mode_since))}` : 'unknown'}</dd></div>
                                {agent.parked && <div><dt>State</dt><dd style="color:var(--crimson)">parked at home</dd></div>}
                            </dl>
                            {agent.routine ? (() => {
                                const r = agent.routine!;
                                const b = r.bounds;
                                const out = (name: string) => b?.breached.includes(name) ?? false;
                                const bound = (label: string, value: string, name: string) => <div><dt>{label}</dt><dd style={out(name) ? 'color:var(--crimson)' : ''}>{value}</dd></div>;
                                return (
                                    <section class="stack" style="gap:6px">
                                        <div class="between label"><span>{r.name}</span><span class="plain">{clockTime(r.at)}</span></div>
                                        <ol class="steps">{r.phases.map((phase) => <li class={phase === r.phase ? 'now' : ''}>{phase}</li>)}</ol>
                                        {b && (
                                            <dl class="facts">
                                                {bound('Daylight', `${Math.max(0, Math.round(b.daylight_ticks_left / 20))} s`, 'daylight')}
                                                {bound('Health', `${b.health} / min ${b.limits.min_health}`, 'health')}
                                                {bound('Food', `${b.food} / min ${b.limits.min_food}`, 'food')}
                                                {bound('Free slots', `${b.free_slots} / min ${b.limits.min_free_slots}`, 'free_slots')}
                                                <div><dt>From home</dt><dd>{b.home_distance ?? '?'}{b.limits.range !== null ? ` / ${b.limits.range}` : ''}</dd></div>
                                                <div><dt>Deaths</dt><dd style={r.parked ? 'color:var(--crimson)' : ''}>{r.deaths} / {b.limits.max_deaths}</dd></div>
                                            </dl>
                                        )}
                                    </section>
                                );
                            })() : <div class="empty">No routine report yet.</div>}
                            <section class="stack" style="gap:6px">
                                <div class="label">Routine goal</div>
                                <div class="goal">{plan ? plan.title : <span class="muted" style="font-weight:400">None in hand</span>}</div>
                                {plan && (
                                    <>
                                        <div class="between label"><span>Steps <span class="plain">skill template</span></span>
                                            <span class="plain">{Math.min(plan.cursor + 1, plan.steps.length)} / {plan.steps.length}{plan.attempt > 0 ? ` · try ${plan.attempt} / 3` : ''}</span></div>
                                        <ol class="steps">{plan.steps.map((step, i) => <li class={i <= plan.done_through ? 'done' : i === plan.cursor ? 'now' : ''}>{step}</li>)}</ol>
                                    </>
                                )}
                            </section>
                            {progress && (
                                <section class="stack" style="gap:6px">
                                    <div class="between label"><span>Skill</span><span class="plain">{progress.done}{progress.total !== null ? ` / ${progress.total}` : ''} {progress.unit ?? ''}</span></div>
                                    <div class="mono small">{progress.skill}</div>
                                    <div class="bar" role="img" aria-label={`${progress.skill} ${pct} percent complete`}><div style={`width:${pct}%`} /></div>
                                </section>
                            )}
                        </article>
                    );
                })}
            </main>
        </>
    );
}
