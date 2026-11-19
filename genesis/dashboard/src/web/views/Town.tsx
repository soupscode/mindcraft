// The Town view (mock-up: Town). The plan of the town, Arthur's project, the homes, the
// prefab ladder and the plots, as the town service in the MindServer process reports them
// (genesis/town/server.js).
//
// Honesty rules: every plot and prefab says whose it is (Operator, Code, Generated); a build
// is "Verified" only after its builder matched every cell by name twice; counts come from the
// builder's own survey. Decided: code proposes plots and bridges, the operator can move or
// remove a proposal here; operator prefabs arrive by upload here.

import { useRef, useState } from 'preact/hooks';
import { useClient, useJson, setPagePills } from '../store';
import { Monogram } from '../ui';

const cap = (text: string | null | undefined) => (text ? text.charAt(0).toUpperCase() + text.slice(1) : '');
const SIZE: Record<string, string> = { S: 'S · 16', M: 'M · 24', L: 'L · 32' };
const dims = (box: any) => `${box.max[0] - box.min[0] + 1} × ${box.max[box.max.length - 1] - box.min[box.min.length - 1] + 1}`;

async function post(url: string, body: unknown): Promise<{ ok: boolean; answer: any }> {
    try {
        const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        return { ok: response.ok, answer: await response.json().catch(() => ({})) };
    } catch (failure: any) { return { ok: false, answer: { error: String(failure?.message ?? failure) } }; }
}

// The plan, drawn to scale from the two files' boxes: north is up, 1 block is `k` units.
function Plan({ view }: { view: any }) {
    const boxes: { x0: number; z0: number; x1: number; z1: number }[] = [];
    const flat = (box: any) => ({ x0: box.min[0], z0: box.min[box.min.length - 1], x1: box.max[0] + 1, z1: box.max[box.max.length - 1] + 1 });
    const limit = flat(view.limit);
    boxes.push(limit, flat(view.camp), flat(view.field), ...view.plots.map(flat));
    const pad = 10;
    const x0 = Math.min(...boxes.map((b) => b.x0)) - pad, x1 = Math.max(...boxes.map((b) => b.x1)) + pad;
    const z0 = Math.min(...boxes.map((b) => b.z0)) - pad, z1 = Math.max(...boxes.map((b) => b.z1)) + pad;
    const k = 4;
    const X = (x: number) => (x - x0) * k, Z = (z: number) => (z - z0) * k;
    const rect = (box: any) => { const f = flat(box); return { x: X(f.x0), y: Z(f.z0), width: (f.x1 - f.x0) * k, height: (f.z1 - f.z0) * k }; };
    const building = new Set((view.builds ?? []).filter((b: any) => !b.verified_at).map((b: any) => b.plot));
    const W = (x1 - x0) * k, H = (z1 - z0) * k;
    return (
        <svg class="plan" role="img" aria-label={`Town plan: camp, field and ${view.plots.length} plots`} viewBox={`0 0 ${W} ${H}`}>
            <rect {...rect(view.limit)} fill="none" stroke="#B7A8CF" stroke-width="1" stroke-dasharray="6 5" />
            <text x={X(limit.x0) + 8} y={Z(limit.z0) + 16} class="cap">TOWN LIMIT</text>
            <rect {...rect(view.camp)} fill="var(--tint)" stroke="var(--muted)" stroke-width="1" />
            <text x={rect(view.camp).x + 8} y={rect(view.camp).y + 20} class="serif">Camp</text>
            <text x={rect(view.camp).x + 8} y={rect(view.camp).y + 34} class="cap">OPERATOR</text>
            <rect {...rect(view.field)} fill="var(--track)" stroke="var(--muted)" stroke-width="1" />
            <text x={rect(view.field).x} y={rect(view.field).y - 6} class="serif sm">Field</text>
            {view.plots.map((plot: any) => {
                const r = rect(plot);
                const proposed = !plot.world && !plot.built && !building.has(plot.id);
                const project = plot.kind === 'shared' || plot.kind === 'bridge';
                const stroke = plot.owner ? 'var(--purple)' : '#B7A8CF';
                if (plot.kind === 'bridge') {
                    // a span is small: its id beside it, away from the camp
                    const west = r.x + r.width / 2 < X(0);
                    return (
                        <g>
                            <rect {...r} fill={proposed ? 'none' : '#FFFFFF'} stroke="var(--purple)" stroke-width={proposed ? 1.5 : 2.5} stroke-dasharray={proposed ? '5 4' : undefined} />
                            <text x={west ? r.x - 6 : r.x + r.width + 6} y={r.y + r.height / 2 + 4} text-anchor={west ? 'end' : 'start'} class="mono">{plot.id}</text>
                        </g>
                    );
                }
                return (
                    <g>
                        <rect {...r} fill={proposed ? 'none' : '#FFFFFF'} stroke={stroke} stroke-width={project && !proposed ? 2.5 : 1.5} stroke-dasharray={proposed ? '5 4' : undefined} />
                        {plot.built && <rect x={r.x + r.width * 0.3} y={r.y + r.height * 0.22} width={r.width * 0.4} height={r.height * 0.4} fill="#D9CCEE" />}
                        {building.has(plot.id) && <rect x={r.x + r.width * 0.24} y={r.y + r.height * 0.16} width={r.width * 0.52} height={r.height * 0.52} fill="none" stroke="var(--purple)" stroke-width="1" stroke-dasharray="3 3" />}
                        <text x={r.x} y={r.y - 6} class={plot.owner ? 'serif sm' : 'serif sm muted'}>{project ? cap(plot.prefab) : plot.owner ?? 'Free'}</text>
                        <text x={r.x + 5} y={r.y + r.height - 6} class="mono">{plot.id}</text>
                    </g>
                );
            })}
            <g transform={`translate(${W - 96}, ${H - 18})`}><line x1="0" y1="0" x2={16 * k} y2="0" stroke="var(--muted)" stroke-width="1.5" /><text x="0" y="-5" class="mono">16 blocks</text></g>
            <text x={W - 16} y="18" class="cap">N</text>
        </svg>
    );
}

// The outline of a prefab seen from above: taller columns darker.
function Outline({ rows }: { rows: number[][] | null }) {
    if (!rows || rows.length === 0) return <svg class="outline" aria-hidden="true" viewBox="0 0 48 36" />;
    const [w, d] = [rows[0].length, rows.length];
    const cell = Math.min(44 / w, 32 / d);
    const top = Math.max(1, ...rows.flat());
    return (
        <svg class="outline" aria-hidden="true" viewBox="0 0 48 36">
            {rows.map((row, z) => row.map((n, x) => (n > 0 ? <rect x={(48 - w * cell) / 2 + x * cell} y={(36 - d * cell) / 2 + z * cell} width={cell + 0.2} height={cell + 0.2} fill="var(--purple)" opacity={0.18 + 0.5 * (n / top)} /> : null)))}
        </svg>
    );
}

function LadderCard({ entry }: { entry: any }) {
    const state_class = entry.state === 'Open' ? 'chip on' : entry.state === 'Building' ? 'chip solid' : entry.state === 'Not buildable' ? 'chip warn' : 'chip';
    return (
        <li class="rung">
            <div class="between top"><Outline rows={entry.outline} /><span class="plain">T{entry.tier}</span></div>
            <div><div class="name lg">{entry.title}</div><div class="small muted">{cap(entry.kind)}</div></div>
            <div class="plain col"><span>{entry.size.x} × {entry.size.z} × {entry.size.y}</span><span>{entry.cells} cells</span></div>
            <div class="foot"><div class="row" style="gap:6px"><span class="chip">{entry.by}</span><span class={state_class}>{entry.state}</span></div><div class="plain">{entry.detail}</div></div>
        </li>
    );
}

// Upload of an operator's schematic: looked at first (nothing saved), then saved when it holds.
function Upload({ onDone }: { onDone: () => void }) {
    const file = useRef<HTMLInputElement>(null);
    const [name, setName] = useState('');
    const [swap, setSwap] = useState('');
    const [result, setResult] = useState<any>(null);
    const [busy, setBusy] = useState(false);
    async function send(save: boolean) {
        const chosen = file.current?.files?.[0];
        if (!chosen || !name) return;
        setBusy(true);
        const query = new URLSearchParams({ name, save: save ? '1' : '0', ...(swap.trim() ? { substitute: swap.replace(/\s+/g, '') } : {}) });
        try {
            const response = await fetch(`/api/prefabs/import?${query}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: chosen });
            setResult({ status: response.status, ...(await response.json().catch(() => ({}))) });
            if (response.ok && save) onDone();
        } catch (failure: any) { setResult({ ok: false, error: String(failure?.message ?? failure) }); }
        setBusy(false);
    }
    const report = result?.report ?? null;
    const blocked = Object.entries(report?.unobtainable ?? {}) as [string, number][];
    return (
        <div class="upload stack">
            <div class="between"><h3 class="name">Upload a schematic</h3><span class="plain">.schem · 2 MB</span></div>
            <div class="fields">
                <input class="input" type="file" accept=".schem,.schematic,application/octet-stream" ref={file} aria-label="Schematic file" onChange={() => { setResult(null); const picked = file.current?.files?.[0]?.name ?? ''; if (!name) setName(picked.replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40)); }} />
                <input class="input" placeholder="name" aria-label="Prefab name" value={name} onInput={(event) => setName((event.target as HTMLInputElement).value)} />
                <input class="input" placeholder="swap block:block, …" aria-label="Substitutes" value={swap} onInput={(event) => setSwap((event.target as HTMLInputElement).value)} />
                <button class="btn sm" disabled={busy || !name} onClick={() => send(false)}>Check</button>
                <button class="btn sm solid" disabled={busy || !result?.ok || result?.saved || report?.buildable === false} onClick={() => send(true)}>Save</button>
            </div>
            {result && !result.ok && <div class="small" style="color:var(--crimson)" role="alert">{result.error ?? 'Refused'}{(result.problems ?? []).length > 0 ? `: ${result.problems.join('; ')}` : ''}</div>}
            {result?.ok && (
                <dl class="facts" role="status">
                    <div><dt>Tier</dt><dd>T{result.prefab.tier}</dd></div>
                    <div><dt>Size</dt><dd>{result.prefab.size.x} × {result.prefab.size.z} × {result.prefab.size.y}</dd></div>
                    <div><dt>Cells</dt><dd>{result.prefab.cells}</dd></div>
                    <div><dt>Agents cannot get</dt><dd style={blocked.length > 0 ? 'color:var(--crimson)' : ''}>{blocked.length === 0 ? 'nothing' : blocked.map(([block, n]) => `${block} × ${n}`).join(', ')}</dd></div>
                    {(report.needs_facing ?? []).length > 0 && <div><dt>Facing not kept</dt><dd>{report.needs_facing.join(', ')}</dd></div>}
                    {report.floating > 0 && <div><dt>Floating</dt><dd style="color:var(--crimson)">{report.floating} cells</dd></div>}
                    {report.too_big && <div><dt>Footprint</dt><dd style="color:var(--crimson)">over 32</dd></div>}
                    <div><dt>State</dt><dd>{result.saved ? 'Saved' : report.buildable ? 'Buildable' : 'Not buildable yet'}</dd></div>
                </dl>
            )}
        </div>
    );
}

export function Town() {
    const { live } = useClient();
    const [nonce, setNonce] = useState(0);
    const [said, setSaid] = useState<string | null>(null);
    const [moving, setMoving] = useState<string | null>(null);
    const [where, setWhere] = useState('');
    const [goals, setGoals] = useState<{ agent: string; text: string } | null>(null);
    const { data, error, loading } = useJson<any>('/api/town', `${live.town.tick}|${nonce}`);
    const view = data?.view ?? null;
    setPagePills(view ? [{ text: `Built ${view.counts.verified}` }, ...(view.counts.building > 0 ? [{ text: `Building ${view.counts.building}` }] : [])] : []);
    if (!view) return <div class="note"><b>Town: {loading ? 'asking the town' : 'not connected'}.</b> {loading ? '' : `The town is kept in the MindServer process${error ? ` (${error})` : ''}.`}</div>;

    const again = () => setNonce((n) => n + 1);
    const started = new Set((view.builds ?? []).map((b: any) => b.plot));
    const proposals = view.plots.filter((plot: any) => !plot.world && !started.has(plot.id));
    const act = async (id: string, body: unknown) => {
        const { ok, answer } = await post(`/api/town/proposals/${encodeURIComponent(id)}`, body);
        setSaid(ok ? null : `${id}: ${String(answer.error ?? 'refused').replace(/_/g, ' ')}`);
        setMoving(null);
        again();
    };
    const saveGoals = async (agent: string, titles: string[] | null) => {
        const { ok, answer } = await post(`/api/town/goals/${encodeURIComponent(agent)}`, { titles });
        setSaid(ok ? null : `${agent}: ${String(answer.error ?? 'refused').replace(/_/g, ' ')}`);
        setGoals(null);
        again();
    };
    const project = view.project;
    const state_of = (plot: any) => (view.builds ?? []).some((b: any) => b.plot === plot.id && !b.verified_at) ? 'Building' : plot.built ? 'Verified' : plot.world ? (plot.prefab ? 'Open' : 'Free') : 'Proposed';

    return (
        <>
            <div class="town-top">
                <section class="panel stack" aria-label="Plan">
                    <div class="between"><h2 class="title">Plan</h2><span class="plain">4 px / block</span></div>
                    <Plan view={view} />
                    <div class="legend plan-key"><span><i class="box" />Plot</span><span><i class="box thick" />Project</span><span><i class="box dash" />Proposed</span><span><i class="box fill" />Built</span><span><i class="box tintbox" />Operator</span><span><i class="box pale" />Free</span></div>
                    <div class="between label" style="margin-top:4px"><span>Proposed</span><span class="plain">{proposals.length}</span></div>
                    {proposals.length === 0 && view.wanted.length === 0 ? <div class="empty">None</div> : (
                        <ul class="rule">{view.wanted.map((want: any) => (
                            <li class="proposal">
                                <div><span class="name">{cap(want.prefab?.replace(/^span_\d+$/, 'footbridge'))}</span><div class="plain">{want.size === 'span' ? 'span' : `${SIZE[want.size] ?? want.size}`} · {want.for}</div></div>
                                <span class="chip gold">No place yet</span>
                            </li>
                        ))}{proposals.map((plot: any) => (
                            <li class="proposal">
                                <div><span class="mono">{plot.id}</span> <span class="name">{cap(plot.prefab?.replace(/^span_\d+$/, 'footbridge') ?? 'plot')}</span>
                                    <div class="plain">{plot.kind === 'bridge' ? `${plot.length} long · ${plot.why ?? ''}` : `${plot.size} · ${dims(plot)} · x ${plot.min[0]}, z ${plot.min[2]}`}</div></div>
                                <span class="chip">{plot.by}</span>
                                {moving === plot.id ? (
                                    <span class="row">
                                        <input class="input narrow" aria-label={`New corner of ${plot.id}: x, z`} placeholder="x, z" value={where} onInput={(event) => setWhere((event.target as HTMLInputElement).value)} />
                                        <button class="btn sm solid" onClick={() => { const [x, z] = where.split(',').map((n) => Number(n.trim())); if (Number.isInteger(x) && Number.isInteger(z)) act(plot.id, { action: 'move', min: [x, plot.min[1], z] }); else setSaid('x, z in whole blocks'); }}>Move</button>
                                    </span>
                                ) : (
                                    <span class="row">
                                        <button class="btn sm" onClick={() => { setMoving(plot.id); setWhere(`${plot.min[0]}, ${plot.min[2]}`); }}>Move</button>
                                        <button class="btn sm fail" onClick={() => act(plot.id, { action: 'remove' })}>Remove</button>
                                    </span>
                                )}
                            </li>
                        ))}</ul>
                    )}
                    {said && <div class="small" style="color:var(--crimson)" role="alert">{said}</div>}
                </section>

                <section class="panel stack" aria-label="Arthur's project">
                    <div class="label">Arthur’s project</div>
                    {!project ? <div class="empty">None</div> : (
                        <>
                            <div class="between"><h2 class="title xl">{project.title.replace(/^span_\d+$/, 'Footbridge')}</h2><span class={project.state === 'Building' ? 'chip solid' : project.state === 'Verified' || project.state === 'Open' ? 'chip on' : 'chip'}>{project.state}</span></div>
                            <div class="plain">{cap(project.kind)} · Tier {project.tier}{project.plot ? ` · ${project.plot}` : ''} · {project.size.x} × {project.size.z} × {project.size.y}</div>
                            <div class="between"><span class="label">Cells</span><span class="mono">{project.cells.done} / {project.cells.total}</span></div>
                            <div class="bar" role="img" aria-label={`${project.cells.done} of ${project.cells.total} cells`}><div style={`width:${project.cells.total ? Math.round((project.cells.done / project.cells.total) * 100) : 0}%`} /></div>
                            <div class="between label"><span>Stages</span><span class="chip">Computed</span></div>
                            <ul class="lines">{project.stages.map((stage: any) => <li class={stage.name === project.stage ? 'now' : ''}><span>{stage.name}</span><span class="plain">{stage.done} / {stage.total}</span></li>)}</ul>
                            <div class="label">Materials <span class="plain">against {view.stock_of}</span></div>
                            <table class="grid">
                                <thead><tr><th scope="col">Item</th><th scope="col" class="num">Need</th><th scope="col" class="num">Have</th><th scope="col" class="num">Short</th><th scope="col">State</th></tr></thead>
                                <tbody>{project.materials.filter((m: any) => m.need > 0).slice(0, 10).map((m: any) => (
                                    <tr><td class="mono">{m.item}</td><td class="num">{m.need}</td><td class="num">{m.have}</td><td class="num">{m.short}</td><td><span class={m.state === 'Ready' ? 'chip on' : 'chip gold'}>{m.state}</span></td></tr>
                                ))}</tbody>
                            </table>
                            <dl class="facts"><div><dt>Verified</dt><dd>{project.verified ? `d${project.verified.day ?? '?'}` : 'Not yet'}</dd></div><div><dt>Check</dt><dd>{project.check}</dd></div>{project.lock && <div><dt>Locked</dt><dd>{project.lock}</dd></div>}</dl>
                        </>
                    )}
                </section>
            </div>

            <section class="panel stack" aria-label="Homes">
                <h2 class="title">Homes</h2>
                <div class="cards">
                    {view.homes.map((home: any) => {
                        const lt = view.long_term?.[home.agent] ?? null;
                        return (
                            <article class="home">
                                <div class="who"><Monogram name={home.agent} /><div class="id"><h3 class="name lg">{home.agent}</h3><div class="small muted">{cap(home.role)} · {home.plot ?? 'no plot'}</div></div></div>
                                <div class="halves">
                                    <section><div class="label">Home</div>{home.home ? <><div class="plain">Tier {home.home.tier}</div><div class="name">{home.home.title}</div><div class="row" style="gap:6px"><span class="plain">{home.home.verified_day !== null ? `d${home.home.verified_day}` : ''}</span><span class="chip on">Verified</span></div>
                                        {home.living?.bed && <div class="plain">Bed {home.living.bed === 'Placed' ? 'placed' : 'not placed'}</div>}</> : <div class="empty">None yet</div>}</section>
                                    <section><div class="label">Next</div>{home.next ? <><span class={home.next.state === 'Building' ? 'chip solid' : home.next.state === 'Open' ? 'chip on' : 'chip'}>{home.next.state}</span><div class="name">{home.next.title}</div><div class={home.next.state === 'Locked' ? 'plain goldbox' : 'plain'}>{home.next.detail}</div></> : <div class="empty">Top tier</div>}</section>
                                </div>
                                <section class="stack" style="gap:6px">
                                    <div class="between label"><span>Long-term</span>{(lt?.override || lt?.chosen_by) && <span class="chip">{lt.override ? 'Operator' : lt.chosen_by === 'planner' ? 'Model' : 'Role default'}</span>}</div>
                                    {goals?.agent === home.agent ? (
                                        <>
                                            <textarea class="input area" rows={3} aria-label={`Long-term goals of ${home.agent}, one a line`} value={goals!.text} onInput={(event) => setGoals({ agent: home.agent, text: (event.target as HTMLTextAreaElement).value })} />
                                            <span class="row"><button class="btn sm solid" onClick={() => saveGoals(home.agent, goals!.text.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 3))}>Set</button><button class="btn sm" onClick={() => setGoals(null)}>Cancel</button></span>
                                        </>
                                    ) : (
                                        <>
                                            <ol class="goals">{(live.agents[home.agent]?.long_term ?? []).map((goal) => <li>{goal.title}</li>)}</ol>
                                            <span class="row"><button class="btn sm" onClick={() => setGoals({ agent: home.agent, text: (lt?.override ?? live.agents[home.agent]?.long_term.map((goal) => goal.title) ?? []).join('\n') })}>Override</button>
                                                {lt?.override && <button class="btn sm" onClick={() => saveGoals(home.agent, null)}>Give back</button>}</span>
                                        </>
                                    )}
                                </section>
                            </article>
                        );
                    })}
                </div>
            </section>

            <section class="panel stack" aria-label="Prefab ladder">
                <div class="between"><h2 class="title">Ladder</h2><span class="plain">{view.ladder.generated.open} open · {view.ladder.generated.building} building · {view.ladder.generated.locked} locked</span></div>
                <ol class="ladder8">{view.ladder.generated.list.map((entry: any) => <LadderCard entry={entry} />)}</ol>
                <div class="between"><h3 class="name lg">Operator prefabs</h3><span class="plain">{view.ladder.operator.list.length} converted</span></div>
                {view.ladder.operator.list.length > 0 && <ol class="ladder8">{view.ladder.operator.list.map((entry: any) => <LadderCard entry={entry} />)}</ol>}
                <Upload onDone={again} />
            </section>

            <section class="panel stack" aria-label="Plots">
                <div class="between"><h2 class="title">Plots</h2><span class="plain">{view.plots.length + 2}</span></div>
                <div class="scroll">
                    <table class="grid wide">
                        <thead><tr><th scope="col">Plot</th><th scope="col">Owner</th><th scope="col">Size</th><th scope="col">Build</th><th scope="col">State</th><th scope="col">Levelled</th><th scope="col">Placed</th></tr></thead>
                        <tbody>
                            <tr><td class="mono">camp</td><td>All</td><td class="mono">{dims(view.camp)}</td><td>Camp</td><td>Standing</td><td><span class="chip">Operator</span></td><td><span class="chip">Operator</span></td></tr>
                            <tr><td class="mono">field</td><td>{view.field.owner ?? 'All'}</td><td class="mono">{dims(view.field)}</td><td>Field</td><td>Tilled</td><td><span class="chip">Operator</span></td><td><span class="chip">Operator</span></td></tr>
                            {view.plots.map((plot: any) => (
                                <tr>
                                    <td class="mono">{plot.id}</td><td>{plot.owner ?? 'Free'}</td><td class="mono">{SIZE[plot.size] ?? dims(plot)}</td>
                                    <td>{[plot.built, plot.prefab !== plot.built ? plot.prefab : null].filter(Boolean).map((name: string) => cap(name.replace(/^span_\d+$/, 'footbridge').replace(/_/g, '-'))).join(', ') || '·'}</td>
                                    <td>{state_of(plot)}</td>
                                    <td>{plot.levelled_by ? <span class="chip">{plot.levelled_by}</span> : '·'}</td>
                                    <td><span class="chip">{plot.world ? 'Config' : plot.by}</span></td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </section>
        </>
    );
}
