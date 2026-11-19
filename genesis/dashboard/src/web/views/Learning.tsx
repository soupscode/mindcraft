// The Learning view (mock-up: Knowledge). What the shared network and each agent's head have
// learned, as the learner in the MindServer process reports it (genesis/learning/service.js).
//
// Honesty rules: every number is computed from stored predictions and outcomes and carries
// its n; "Trying" is the exploration setting the scorer really uses; a lesson would be the
// model's words and is labelled Model; nothing is shown that was not measured.

import { useState } from 'preact/hooks';
import { useClient, useJson, setPagePills } from '../store';
import { clockTime, dayTime, tryingText } from '../format';
import { Monogram } from '../ui';

const whole = (n: number | null | undefined) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '–');
const pct = (n: number | null | undefined) => (typeof n === 'number' && Number.isFinite(n) ? `${Math.round(n * 100)}%` : '–');
const err = (n: number | null | undefined) => (typeof n === 'number' && Number.isFinite(n) ? n.toFixed(3) : '–');
const short = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

function Fact({ label, value }: { label: string; value: string }) {
    return <div class="fact"><dt>{label}</dt><dd>{value}</dd></div>;
}

// The two error lines over examples: network (solid) against count table (dashed). Lower is better.
function Curve({ name, points }: { name: string; points: { examples: number; net: number | null; table: number | null }[] }) {
    const usable = points.filter((point) => typeof point.net === 'number' && typeof point.table === 'number') as { examples: number; net: number; table: number }[];
    if (usable.length < 2) return <div class="empty curve-none">No curve yet · {usable.length} of 2 points</div>;
    const [w, h] = [286, 84];
    const top = Math.max(0.2, ...usable.map((point) => Math.max(point.net, point.table))) * 1.08;
    const last = usable[usable.length - 1].examples || 1;
    const line = (key: 'net' | 'table') => usable.map((point) => `${((point.examples / last) * w).toFixed(1)},${(h - 2 - (point[key] / top) * (h - 6)).toFixed(1)}`).join(' ');
    return (
        <svg class="curve" role="img" aria-label={`${name} prediction error over examples, network against count table`} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
            <line x1="0" y1={h - 0.5} x2={w} y2={h - 0.5} stroke="var(--border)" stroke-width="1" />
            <line x1="0" y1={h / 2} x2={w} y2={h / 2} stroke="var(--border)" stroke-width="1" stroke-dasharray="2 4" />
            <polyline points={line('table')} fill="none" stroke="var(--muted)" stroke-width="1.5" stroke-dasharray="5 4" vector-effect="non-scaling-stroke" />
            <polyline points={line('net')} fill="none" stroke="var(--purple)" stroke-width="2" vector-effect="non-scaling-stroke" />
        </svg>
    );
}

function AgentLearning({ agent }: { agent: any }) {
    const right = agent.called_right ?? {};
    const rows = agent.calibration ?? [];
    return (
        <article class="panel learn" aria-label={`${agent.name} learning`}>
            <div class="who">
                <Monogram name={agent.name} />
                <div class="id"><h2 class="title">{agent.name}</h2><div class="small muted cap">{agent.role ?? ''}</div></div>
                <div class={agent.state === 'In use' ? 'status line' : 'status'}>{agent.state}</div>
            </div>
            <section>
                <div class="between label"><span>Examples</span><span class="chip">Learned</span></div>
                <dl class="pair"><div><dt>Own</dt><dd>{whole(agent.examples?.own)}</dd></div><div><dt>From others</dt><dd class="muted">{whole(agent.examples?.from_others)}</dd></div></dl>
            </section>
            <section>
                <div class="between label"><span>Called right</span><span class="plain">last {whole(right.window)}</span></div>
                <dl class="pair end"><div><dt>Network</dt><dd class="big">{pct(right.network)}</dd></div><div><dt>Count table</dt><dd class="muted">{pct(right.table)}</dd></div></dl>
            </section>
            <section>
                <div class="between label"><span>Error</span><span class="plain">0 to {short(agent.error?.to ?? 0)}</span></div>
                <Curve name={agent.name} points={agent.error?.curve ?? []} />
                <div class="legend"><span><i class="solid" />Network {err(agent.error?.network)}</span><span><i class="dashed" />Count table {err(agent.error?.table)}</span></div>
            </section>
            <section>
                <table class="grid">
                    <thead><tr><th scope="col">Said</th><th scope="col">Happened</th><th scope="col" class="num">n</th></tr></thead>
                    <tbody>{rows.map((row: any) => <tr><td>{pct(row.said)}</td><td>{pct(row.happened)}</td><td class="num">{whole(row.n)}</td></tr>)}</tbody>
                </table>
            </section>
            <section>
                <div class="label">Most sure</div>
                {(agent.most_sure ?? []).length === 0 ? <div class="empty">None yet · needs n 20</div>
                    : <ul class="lines">{agent.most_sure.map((o: any) => <li><span>{o.title}</span><span class="plain">{pct(o.p_ok)} · n {whole(o.n)}</span></li>)}</ul>}
            </section>
            <section>
                <div class="label">Least sure</div>
                {(agent.least_sure ?? []).length === 0 ? <div class="empty">None yet</div>
                    : <ul class="lines">{agent.least_sure.map((o: any) => <li><span>{o.title}</span><span class="plain">n {whole(o.n)}</span></li>)}</ul>}
            </section>
            <section>
                <div class="between label"><span>Changed</span><span class="chip">Computed</span></div>
                {(agent.changed ?? []).length === 0 ? <div class="empty">None yet</div>
                    : <ul class="lines">{agent.changed.map((c: any) => <li><span>{c.text}</span><span class="plain">n {whole(c.n)}</span></li>)}</ul>}
            </section>
            <section class="last">
                <div class="between label"><span>Today</span><span class="chip">Computed</span></div>
                {(agent.today ?? []).length === 0 ? <div class="empty">None yet · needs 20 a side</div>
                    : <ul class="lines">{agent.today.map((t: any) => <li><span>{t.text}</span><span class="plain">{whole(t.done)} of {whole(t.of)}</span></li>)}</ul>}
            </section>
        </article>
    );
}

export function Learning() {
    const { live } = useClient();
    const [nonce, setNonce] = useState(0);
    const [busy, setBusy] = useState<string | null>(null);
    const [said, setSaid] = useState<string | null>(null);
    // asked again whenever the learner said something (every few goals), at most every other tick
    const { data, error, loading } = useJson<any>('/api/learning', `${Math.floor(live.learning.tick / 2)}|${nonce}`);
    const view = data?.view ?? null;
    setPagePills(view ? [{ text: `${whole(view.header.examples)} examples` }, ...(view.header.frozen ? [{ text: 'Frozen', kind: 'gold' as const }] : [])] : []);

    async function control(action: string, v?: number) {
        setBusy(action);
        setSaid(null);
        try {
            const response = await fetch('/api/learning/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...(v !== undefined ? { v } : {}) }) });
            const answer = await response.json().catch(() => ({}));
            setSaid(response.ok ? (action === 'rollback' ? `Rolled back to v${answer.version}` : action === 'freeze' ? 'Frozen' : 'Learning again') : String(answer.error ?? response.status));
        } catch (failure: any) { setSaid(String(failure?.message ?? failure)); }
        setBusy(null);
        setNonce((n) => n + 1);
    }

    if (!view) {
        return <div class="note"><b>Learning: {loading ? 'asking the learner' : 'not connected'}.</b> {loading ? '' : `The learner runs in the MindServer process${error ? ` (${error})` : ''}.`}</div>;
    }
    const h = view.header;
    return (
        <>
            <section class="panel tint shared" role="status" aria-label={`Shared network, version ${h.version}${h.frozen ? ', frozen' : ''}`}>
                <div class="row" style="gap:18px"><span class="diamond" aria-hidden="true" /><h2 class="title xl">Shared network</h2></div>
                <dl class="factrow">
                    <Fact label="Examples" value={whole(h.examples)} />
                    <Fact label="Version" value={`v${h.version}`} />
                    <Fact label="Updated" value={h.updated_at ? clockTime(new Date(h.updated_at).toISOString()) : '–'} />
                    <Fact label="In use" value={`${h.in_use.n} / ${h.in_use.of}`} />
                    <Fact label="Error" value={err(h.error)} />
                    <Fact label="Count table" value={err(h.table_error)} />
                    <Fact label="Trying" value={tryingText(h.trying?.rate)} />
                </dl>
                <div class="row">
                    <button class="btn sm" disabled={busy !== null} aria-pressed={h.frozen ? 'true' : 'false'} onClick={() => control(h.frozen ? 'unfreeze' : 'freeze')}>{h.frozen ? 'Frozen' : 'Freeze'}</button>
                    <button class="btn sm" disabled={busy !== null || (view.versions ?? []).length < 2} onClick={() => control('rollback')}>Roll back</button>
                    {said && <span class="small muted" role="status">{said}</span>}
                </div>
            </section>

            <main class="agents">{(view.agents ?? []).map((agent: any) => <AgentLearning agent={agent} />)}</main>

            <div class="twocol">
                <section class="panel stack" aria-label="Lessons">
                    <div class="between"><h2 class="title">Lessons</h2><span class="plain">{view.lessons.active} active · {view.lessons.stale} stale</span></div>
                    {view.lessons.list.length === 0 ? <div class="empty">None yet</div> : (
                        <ul class="rule">{view.lessons.list.map((lesson: any) => (
                            <li class="lesson">
                                <div class="when">{dayTime(new Date(lesson.at).toISOString())}<br />{lesson.agent}</div>
                                <div><p class="quote">{lesson.text}</p>{(lesson.basis ?? []).map((b: any) => <div class="plain"><span class="chip">Computed</span> {b.statement} · {b.value} of {b.n}</div>)}</div>
                                <div class="row"><span class="chip">Model</span><span class={lesson.state === 'active' ? 'chip on' : 'chip'}>{lesson.state}</span></div>
                            </li>
                        ))}</ul>
                    )}
                </section>
                <section class="panel stack" aria-label="Plays">
                    <div class="between"><h2 class="title">Plays</h2><span class="plain">{view.plays.active} active · {view.plays.retired} retired</span></div>
                    {view.plays.list.length === 0 ? <div class="empty">None yet</div> : (
                        <ul class="rule">{view.plays.list.map((play: any) => (
                            <li class="between"><div><div class="name">{play.name}</div><div class="plain">{(play.steps ?? []).map((step: any) => `${step.skill}`).join(' › ')}</div></div><span class="plain">{play.worked} / {play.tried} · {play.state}</span></li>
                        ))}</ul>
                    )}
                </section>
            </div>

            <section class="panel stack" aria-label="Versions">
                <div class="between"><h2 class="title">Versions</h2><span class="plain">{(view.versions ?? []).length}</span></div>
                <ul class="versions">
                    {(view.versions ?? []).slice(0, 12).map((version: any) => (
                        <li>
                            <span class="mono v">v{version.v}</span>
                            <span class={version.state === 'In use' ? 'chip on' : version.state === 'Rolled back' || version.state === 'Refused' ? 'chip warn' : 'chip'}>{version.state}</span>
                            <span class="plain">{version.at ? dayTime(new Date(version.at).toISOString()) : ''} · n {whole(version.n)}{version.err !== null && version.err !== undefined ? ` · err ${err(version.err)}` : ''}</span>
                            {version.state === 'Kept' && <button class="btn sm link" disabled={busy !== null} onClick={() => control('rollback', version.v)}>Use</button>}
                        </li>
                    ))}
                </ul>
            </section>
        </>
    );
}
