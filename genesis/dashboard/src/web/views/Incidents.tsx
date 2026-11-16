// The Incidents view. History (90 days kept) comes from /api/incidents; what happens while
// the page is open comes from the live stream, and the newer of the two wins.

import { useState } from 'preact/hooks';
import { incidentIsOpen } from '../../shared/fold';
import type { Incident } from '../../shared/types';
import { useClient, useJson, useNow } from '../store';
import { clockTime, dayTime, duration, kindLabel, outcomeLabel, words } from '../format';
import { Fallback } from '../ui';

type Filter = 'all' | 'operator' | 'recovered' | 'expected';

// how an alert reached the phone (the alerter's push_state)
const PUSHED: Record<string, string> = {
    sent: 'pinged', unconfirmed: 'ping unconfirmed', failed: 'ping failed', sending: 'pinging', batched: 'hourly push', queued: 'waits for the hour', off: 'no topic set',
};

const groupOf = (incident: Incident): Filter => {
    if (!incident.is_failure || incident.outcome === 'expected') return 'expected';
    if (incident.needs_operator || incident.outcome === 'needs_operator') return 'operator';
    if (incident.outcome === 'auto_recovered') return 'recovered';
    return 'all';
};

function merge(stored: Incident[], live: Incident[]): Incident[] {
    const by_id = new Map<string, Incident>();
    for (const incident of stored) by_id.set(incident.incident_id, incident);
    for (const incident of live) {
        const known = by_id.get(incident.incident_id);
        if (!known || incident.updated_at >= known.updated_at) by_id.set(incident.incident_id, incident);
    }
    return [...by_id.values()].sort((a, b) => (a.started_at < b.started_at ? 1 : -1));
}

function IncidentCard({ incident, now, onStart }: { incident: Incident; now: number; onStart: (agent: string) => void }) {
    const open = incidentIsOpen(incident);
    const started = Date.parse(incident.started_at);
    const span = duration((incident.ended_at ? Date.parse(incident.ended_at) : open ? now : Date.parse(incident.updated_at)) - started);
    const waiting = incident.needs_operator && open;
    return (
        <article class={waiting ? 'panel fail incident' : 'panel incident'}>
            <div class="stack" style="gap:10px">
                <div>
                    <h2 class="title">{kindLabel(incident.kind)}</h2>
                    {incident.reason && <div class="mono small muted">{incident.reason}</div>}
                </div>
                <dl class="facts">
                    <div><dt>{incident.source.type === 'agent' ? 'Agent' : 'Service'}</dt><dd>{incident.source.name}</dd></div>
                    <div><dt>Started</dt><dd>{dayTime(incident.started_at)}</dd></div>
                    <div><dt>{incident.ended_at ? 'Lasted' : open ? (incident.is_failure ? 'Open' : 'Ongoing') : 'Lasted'}</dt><dd>{span}</dd></div>
                </dl>
            </div>
            <section>
                <div class="label" style="margin-bottom:6px">{incident.is_failure ? 'Recovery' : 'Handling'}</div>
                {incident.steps.length === 0 ? <div class="empty">No step reported.</div> : (
                    <ol class="ladder">
                        {incident.steps.map((step) => (
                            <li>
                                <span>{words(step.step)}{step.max !== 1 && step.attempt > 0 ? ` ${step.attempt}` : ''}</span>
                                <span class={`res ${step.result}`}>{step.result}</span>
                            </li>
                        ))}
                    </ol>
                )}
            </section>
            <section class="stack" style="gap:12px">
                <dl class="facts">
                    <div><dt>Outcome</dt><dd>{outcomeLabel(incident.outcome)}</dd></div>
                    {!incident.is_failure && <div><dt>Failure</dt><dd>No</dd></div>}
                    <div><dt>Operator</dt><dd style={waiting ? 'color:var(--crimson);font-weight:600' : ''}>{incident.needs_operator ? 'Needed' : 'Not needed'}</dd></div>
                </dl>
                {waiting && incident.kind === 'login.refused' && incident.source.type === 'agent' && (
                    <button type="button" class="btn sm" onClick={() => onStart(incident.source.name)}>Retry login</button>
                )}
            </section>
        </article>
    );
}

export function Incidents() {
    const { live } = useClient();
    const now = useNow(1000);
    const [filter, setFilter] = useState<Filter>('all');
    const [days, setDays] = useState(7);
    const [note, setNote] = useState<string | null>(null);
    const stored = useJson<{ source: string; incidents: Incident[] }>(`/api/incidents?days=${days}`);
    const alerts = useJson<{ source: string; alerts: any[] }>(`/api/alerts?days=${days}`, live.incidents.length);
    const incidents = merge(stored.data?.incidents ?? [], live.incidents);
    const counts = { all: incidents.length, operator: 0, recovered: 0, expected: 0 };
    for (const incident of incidents) { const group = groupOf(incident); if (group !== 'all') counts[group]++; }
    const shown = incidents.filter((incident) => filter === 'all' || groupOf(incident) === filter);
    const away = live.model.state === 'away' || live.model.state === 'leaving';
    const on_routine = Object.values(live.agents).filter((agent) => agent.mode === 'routine').length;

    async function retryLogin(agent: string) {
        try {
            const response = await fetch('/api/controls/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'start', agent }) });
            const result = await response.json();
            setNote(result.ok ? `Start sent to ${agent}.` : `Start failed: ${result.error}`);
        } catch { setNote('Start failed: the dashboard did not answer.'); }
    }

    const tabs: [Filter, string][] = [['all', 'All'], ['operator', 'Needs operator'], ['recovered', 'Recovered'], ['expected', 'Expected']];
    return (
        <>
            {away && (
                <section class="panel tint" aria-label="Model away">
                    <div class="row" style="justify-content:space-between">
                        <h2 class="title">Model away</h2>
                        <span class="tag">Expected</span>
                    </div>
                    <dl class="facts" style="margin-top:12px">
                        <div><dt>Since</dt><dd>{live.model.since ? clockTime(live.model.since) : 'unknown'}</dd></div>
                        <div><dt>Duration</dt><dd>{live.model.since ? duration(now - Date.parse(live.model.since)) : 'unknown'}</dd></div>
                        <div><dt>Routines</dt><dd>{on_routine} / {Object.keys(live.agents).length}</dd></div>
                        {live.model.reason && <div><dt>Reason</dt><dd>{live.model.reason}</dd></div>}
                    </dl>
                </section>
            )}
            <Fallback source={stored.data?.source} />
            <nav class="row" aria-label="Filter">
                {tabs.map(([key, label]) => (
                    <button type="button" class="btn sm" aria-pressed={filter === key} onClick={() => setFilter(key)}>{label} {counts[key]}</button>
                ))}
                <span style="flex:1" />
                {[7, 30, 90].map((span) => (
                    <button type="button" class="btn sm" aria-pressed={days === span} onClick={() => setDays(span)}>{span}d</button>
                ))}
            </nav>
            {note && <div class="note" role="status">{note}</div>}
            {shown.length === 0
                ? <div class="empty">{stored.loading ? 'Loading.' : 'No incident in this window.'}</div>
                : <ol class="stack">{shown.map((incident) => <li><IncidentCard incident={incident} now={now} onStart={retryLogin} /></li>)}</ol>}
            <section class="panel stack" aria-label="Alerts">
                <div class="between"><h2 class="title">Alerts</h2><span class="plain">who was told · {days} days</span></div>
                {alerts.data?.source === 'unavailable' && <div class="empty">Postgres is down. Alerts are kept there; the alerter still pings.</div>}
                {alerts.data?.source !== 'unavailable' && (alerts.data?.alerts ?? []).length === 0 && <div class="empty">None.</div>}
                <ol class="rule">
                    {(alerts.data?.alerts ?? []).slice(0, 40).map((alert) => (
                        <li class="logline">
                            <span class="mono muted">{dayTime(alert.opened_at)}</span>
                            <span><span class={alert.severity === 'critical' ? 'tag fail' : 'tag line'}>{alert.severity}</span> {alert.title}{alert.occurrences > 1 ? ` ×${alert.occurrences}` : ''}</span>
                            <span class="mono small muted">{PUSHED[alert.push_state] ?? alert.push_state}{alert.pushed_at ? ` ${clockTime(alert.pushed_at)}` : ''}{alert.closed_at ? ' · closed' : ''}</span>
                        </li>
                    ))}
                </ol>
            </section>
        </>
    );
}
