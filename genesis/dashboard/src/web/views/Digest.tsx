// The Digest view: the daily digests the alerter wrote (kept a year), one at a time.

import { useState } from 'preact/hooks';
import { useClient, useJson } from '../store';
import { clockTime, dayOnly, dayTime, duration } from '../format';
import { Monogram, NotConnected, roleOf } from '../ui';

interface DigestRow { period_end: string; period_start: string; tz: string; local_date: string; body: any; created_at: string; pushed_at: string | null }

const OUTCOMES: [string, string][] = [['auto_recovered', 'Auto-recovered'], ['expected', 'Expected'], ['gave_up', 'Gave up'], ['needs_operator', 'Operator'], ['pending', 'Still open']];

export function Digest() {
    const { roster } = useClient();
    const { data, loading } = useJson<{ source: string; digests: DigestRow[] }>('/api/digests?limit=366');
    const [index, setIndex] = useState(0);
    const digests = data?.digests ?? [];
    if (loading && !data) return <div class="empty">Loading.</div>;
    if (data?.source === 'unavailable') return <div class="note"><b>Postgres is down.</b> Digests are kept there.</div>;
    if (digests.length === 0) {
        return <div class="note"><b>No digest yet.</b> The alerter writes one every day at 18:00 in its time zone, about the 24 hours before.</div>;
    }
    const row = digests[Math.min(index, digests.length - 1)];
    const body = row.body;
    const t = body.totals;
    const span = Date.parse(row.period_end) - Date.parse(row.period_start);
    const pctOf = (ms: number) => `${Math.max(0, Math.min(100, (ms / span) * 100))}%`;
    return (
        <>
            <div class="row">
                <button type="button" class="btn sm" disabled={index >= digests.length - 1} onClick={() => setIndex(index + 1)}>Previous</button>
                <div class="pill mono">{row.local_date}</div>
                <button type="button" class="btn sm" disabled={index === 0} onClick={() => setIndex(index - 1)}>Next</button>
                <div class={row.pushed_at ? 'pill' : 'pill quiet'}>{row.pushed_at ? `Sent ${clockTime(row.pushed_at)}` : 'Not sent'}</div>
                <div class="pill quiet mono">{dayTime(row.period_start)} – {dayTime(row.period_end)} · {row.tz}</div>
            </div>

            <section class="panel tint" aria-label="Day summary">
                <dl class="facts big">
                    <div><dt>Goals</dt><dd>{t.goals}</dd></div>
                    <div><dt>Deaths</dt><dd>{t.deaths}</dd></div>
                    <div><dt>Incidents</dt><dd>{t.incidents}</dd></div>
                    <div><dt>Model</dt><dd>{t.model_pct === null ? 'unknown' : `${t.model_pct}%`}</dd></div>
                    <div><dt>Critical</dt><dd style={t.critical > 0 ? 'color:var(--crimson)' : ''}>{t.critical}</dd></div>
                    <div><dt>Warnings</dt><dd>{t.warnings}</dd></div>
                </dl>
            </section>

            <section class="cards" aria-label="Agents">
                {body.agents.map((agent: any) => (
                    <article class="panel stack">
                        <div class="row">
                            <Monogram name={agent.name} />
                            <div><h2 class="title">{agent.name}</h2><div class="small muted">{roleOf(roster, agent.name)}</div></div>
                        </div>
                        <dl class="facts">
                            <div><dt>Goals</dt><dd>{agent.goals}</dd></div>
                            <div><dt>Deaths</dt><dd style={agent.deaths > 0 ? 'color:var(--crimson)' : ''}>{agent.deaths}</dd></div>
                            <div><dt>Skills</dt><dd>{agent.skills}</dd></div>
                        </dl>
                        <section class="stack" style="gap:8px">
                            <div class="label">Time</div>
                            <div class="bar split" role="img" aria-label={`Model-led ${duration(agent.model_led_ms)}, routine ${duration(agent.routine_ms)}`}>
                                <div style={`width:${pctOf(agent.model_led_ms)};background:var(--purple)`} />
                                <div style={`width:${pctOf(agent.routine_ms)};background:var(--gold-line)`} />
                            </div>
                            <dl class="facts">
                                <div><dt>Model-led</dt><dd>{duration(agent.model_led_ms)}</dd></div>
                                <div><dt>Routine</dt><dd>{duration(agent.routine_ms)}</dd></div>
                                {agent.unknown_ms > 0 && <div><dt>Unknown</dt><dd>{duration(agent.unknown_ms)}</dd></div>}
                            </dl>
                        </section>
                    </article>
                ))}
            </section>

            <section class="panel stack">
                <div class="between"><h2 class="title">Incidents</h2><span class="name">{body.incidents.total}</span></div>
                <div class="cards">
                    {OUTCOMES.filter(([key]) => body.incidents.by_outcome[key]).map(([key, label]) => (
                        <div class="stack" style="gap:6px">
                            <div class="between label"><span>{label}</span><span class="plain" style={key === 'needs_operator' ? 'color:var(--crimson)' : ''}>{body.incidents.by_outcome[key].count}</span></div>
                            <ul class="ladder">
                                {Object.entries(body.incidents.by_outcome[key].kinds).map(([kind, count]) => <li><span>{kind}</span><span class="res">{String(count)}</span></li>)}
                            </ul>
                        </div>
                    ))}
                    {body.incidents.total === 0 && <div class="empty">None.</div>}
                </div>
            </section>

            <section class="panel stack">
                <div class="between"><h2 class="title">Model</h2><span class="name">{body.model.pct === null ? 'unknown' : `${body.model.pct}%`}</span></div>
                <div>
                    <div class="bar split" style="position:relative;height:10px" role="img" aria-label={`Available ${duration(body.model.available_ms)}, away ${duration(body.model.away_ms)}`}>
                        {body.model.away.map((away: any) => (
                            <div style={`position:absolute;height:10px;left:${pctOf(Date.parse(away.from) - Date.parse(row.period_start))};width:${pctOf(away.ms)};background:var(--gold-line)`} />
                        ))}
                    </div>
                    <div class="hours"><span>{clockTime(row.period_start)}</span><span>+6h</span><span>+12h</span><span>+18h</span><span>{clockTime(row.period_end)}</span></div>
                </div>
                <dl class="facts">
                    <div><dt>Available</dt><dd>{duration(body.model.available_ms)}</dd></div>
                    <div><dt>Away</dt><dd>{duration(body.model.away_ms)}</dd></div>
                    {body.model.unknown_ms > 0 && <div><dt>Unknown</dt><dd>{duration(body.model.unknown_ms)}</dd></div>}
                </dl>
                <ul class="ladder">
                    {body.model.away.map((away: any) => (
                        <li><span>Away <span class="mono small muted">{clockTime(away.from)} – {clockTime(away.to)}</span></span><span class="res">{duration(away.ms)}</span></li>
                    ))}
                </ul>
            </section>

            <section class="panel stack">
                <div class="between"><h2 class="title">Alerts</h2><span class="name">{body.alerts.critical + body.alerts.warnings}</span></div>
                <dl class="facts">
                    <div><dt>Critical</dt><dd style={body.alerts.critical > 0 ? 'color:var(--crimson)' : ''}>{body.alerts.critical}</dd></div>
                    <div><dt>Warnings</dt><dd>{body.alerts.warnings}</dd></div>
                    <div><dt>Hourly pushes</dt><dd>{body.alerts.warning_pushes}</dd></div>
                </dl>
            </section>

            <NotConnected what="Automatic fixes" missing="Repair sessions are not built; no event reports a fix." />
            <div class="small muted">{digests.length} digest{digests.length === 1 ? '' : 's'} kept · oldest {dayOnly(digests[digests.length - 1].period_end)}</div>
        </>
    );
}
