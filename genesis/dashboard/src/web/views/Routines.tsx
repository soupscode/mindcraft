// The Routines view, as far as events carry it: who is on the role routine, since when, the
// routine goal in hand and its steps. The routine's phases and bounds are not in any event.

import { isRoutineWork } from '../../shared/fold';
import { useClient, useNow } from '../store';
import { clockTime, duration } from '../format';
import { Monogram, NotConnected, roleOf } from '../ui';

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
            <NotConnected what="Phases and bounds" missing="The routine's name, cycle, phase and its limits (distance, daylight, health, food, slots, deaths) are in the agent's checkpoint only; no event carries them." />
        </>
    );
}
