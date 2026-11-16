// The Controls view. Commands go to the MindServer through the dashboard server, with the
// calls the MindServer already has. Decided: no confirmation, except Shut down (one).
// Model-written code stays off: the row is shown locked and nothing here can change it.

import { useEffect, useState } from 'preact/hooks';
import { useClient, getJson, useNow } from '../store';
import { clockSeconds } from '../format';
import { Monogram, roleOf } from '../ui';

interface LogLine { id: string; at: string; actor: string; origin: string; action: string; target: string | null; ok: boolean; detail: string | null }
type Settings = Record<string, boolean | number>;

const TOGGLES: [string, string][] = [['narrate_behavior', 'Narration'], ['chat_ingame', 'Game chat'], ['log_all_prompts', 'Prompt log']];

async function command(body: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
    try {
        const response = await fetch('/api/controls/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        return await response.json();
    } catch { return { ok: false, error: 'the dashboard did not answer' }; }
}

export function Controls() {
    const { roster, processes, health, last_control } = useClient();
    useNow(5000);
    const connected = health?.mindserver_ok === true;
    const [to, setTo] = useState<string | null>(null);
    const [text, setText] = useState('');
    const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
    const [log, setLog] = useState<{ source: string; records: LogLine[] }>({ source: 'postgres', records: [] });
    const [saved, setSaved] = useState<Settings | null>(null);
    const [draft, setDraft] = useState<Settings>({});
    const [settings_error, setSettingsError] = useState<string | null>(null);
    const [confirming, setConfirming] = useState(false);

    const names = roster.length > 0 ? roster.map((agent) => agent.name) : (processes ?? []).map((agent) => agent.name);
    const statusOf = (name: string) => processes?.find((agent) => agent.name === name) ?? null;
    const reachable = (name: string) => statusOf(name)?.socket_connected === true;
    const target = to && reachable(to) ? to : names.find(reachable) ?? null;

    useEffect(() => { getJson('/api/controls').then((page) => setLog(page.log)).catch(() => {}); }, [last_control?.id]);
    useEffect(() => {
        setSaved(null); setDraft({}); setSettingsError(null);
        if (!target || !connected) return;
        getJson(`/api/controls/settings/${encodeURIComponent(target)}`).then((answer) => setSaved(answer.settings)).catch(() => setSettingsError('The MindServer gave no settings.'));
    }, [target, connected]);

    async function run(body: Record<string, unknown>, label: string) {
        const result = await command(body);
        setNote({ ok: result.ok, text: result.ok ? `${label}: sent.` : `${label}: ${result.error}` });
        return result.ok;
    }
    const changed = Object.keys(draft).filter((key) => saved !== null && draft[key] !== saved[key]);
    const value = (key: string) => (key in draft ? draft[key] : saved?.[key]);

    return (
        <>
            {!connected && <div class="note"><b>MindServer not connected.</b> Commands cannot be sent until it answers.</div>}
            {note && <div class="note" role="status" style={note.ok ? '' : 'border-color:var(--crimson);color:var(--crimson)'}>{note.text}</div>}

            <main class="cards" aria-label="Agents">
                {names.map((name) => {
                    const status = statusOf(name);
                    const state = !status ? 'Unknown' : status.in_game ? 'Online' : status.socket_connected ? 'Starting' : 'Stopped';
                    return (
                        <article class="panel stack" aria-label={name}>
                            <div class="row">
                                <Monogram name={name} />
                                <div style="flex:1;min-width:0">
                                    <h2 class="title">{name}</h2>
                                    <div class="small muted">{roleOf(roster, name)}</div>
                                </div>
                                <div class={state === 'Online' ? 'status on' : state === 'Starting' ? 'status gold' : 'status'}>{state}</div>
                            </div>
                            <dl class="facts">
                                <div><dt>Action</dt><dd>{status?.action ?? 'none'}</dd></div>
                                <div><dt>Health</dt><dd>{status?.health ?? 'unknown'}{status?.health !== null && status?.health !== undefined ? ' / 20' : ''}</dd></div>
                            </dl>
                            <div class="row" aria-label={`${name} process`}>
                                <button type="button" class="btn sm" disabled={!connected || !status || status.socket_connected} onClick={() => run({ action: 'start', agent: name }, `Start · ${name}`)}>Start</button>
                                <button type="button" class="btn sm" disabled={!connected || !status || !status.socket_connected} onClick={() => run({ action: 'stop', agent: name }, `Stop · ${name}`)}>Stop</button>
                                <button type="button" class="btn sm" disabled={!connected || !status || !status.in_game} onClick={() => run({ action: 'restart', agent: name }, `Restart · ${name}`)}>Restart</button>
                            </div>
                        </article>
                    );
                })}
            </main>

            <section class="panel stack" aria-labelledby="ctl-message">
                <h2 class="title" id="ctl-message">Message</h2>
                <div class="label" id="ctl-to">To</div>
                <div class="row" role="group" aria-labelledby="ctl-to">
                    {names.map((name) => (
                        <button type="button" class="btn sm" aria-pressed={name === target} disabled={!reachable(name)} onClick={() => setTo(name)}>{name}</button>
                    ))}
                </div>
                <label class="label" for="ctl-text">Text</label>
                <form class="row" onSubmit={async (event) => { event.preventDefault(); if (target && await run({ action: 'message', agent: target, text }, `Message · ${target}`)) setText(''); }}>
                    <input id="ctl-text" class="input" style="flex:1 1 240px" value={text} maxLength={2000} autocomplete="off" onInput={(event) => setText((event.target as HTMLInputElement).value)} />
                    <button type="submit" class="btn solid" disabled={!target || text.trim().length === 0}>Send</button>
                </form>
                <div class="row">
                    <button type="button" class="btn" disabled={!target} onClick={() => target && run({ action: 'halt', agent: target }, `Halt action · ${target}`)}>Halt action</button>
                    <button type="button" class="btn" disabled={!target} onClick={() => target && run({ action: 'stay', agent: target }, `Stay still · ${target}`)}>Stay still</button>
                </div>
            </section>

            <section class="panel stack" aria-labelledby="ctl-settings">
                <div class="between"><h2 class="title" id="ctl-settings">Settings</h2><span class="plain">{target ?? 'no agent'}</span></div>
                {settings_error && <div class="empty">{settings_error}</div>}
                <ul class="rule">
                    {TOGGLES.map(([key, label]) => (
                        <li class="setting">
                            <span id={`set-${key}`}>{label} {changed.includes(key) && <span class="tag">Changed</span>}</span>
                            <button type="button" role="switch" class="switch" aria-checked={value(key) === true} aria-labelledby={`set-${key}`} disabled={saved === null}
                                onClick={() => setDraft({ ...draft, [key]: !(value(key) === true) })}>{saved === null ? '—' : value(key) === true ? 'On' : 'Off'}</button>
                        </li>
                    ))}
                    <li class="setting">
                        <label for="set-context">Context {changed.includes('max_messages') && <span class="tag">Changed</span>}</label>
                        <input id="set-context" class="input mono" style="width:96px" inputMode="numeric" disabled={saved === null} value={String(value('max_messages') ?? '')}
                            onInput={(event) => { const n = Number((event.target as HTMLInputElement).value); if (Number.isInteger(n)) setDraft({ ...draft, max_messages: n }); }} />
                    </li>
                    <li class="setting">
                        <span>Model code</span>
                        <span class="row"><span class="mono small">off</span><span class="tag line">Locked</span></span>
                    </li>
                </ul>
                <div class="row">
                    <button type="button" class="btn solid" disabled={!target || changed.length === 0}
                        onClick={async () => { if (target && await run({ action: 'settings', agent: target, settings: Object.fromEntries(changed.map((key) => [key, draft[key]])) }, `Settings · ${target}`)) { setSaved({ ...saved!, ...draft }); setDraft({}); } }}>Apply</button>
                    <button type="button" class="btn" disabled={changed.length === 0} onClick={() => setDraft({})}>Discard</button>
                    <span class="small muted">Restarts the agent</span>
                </div>
            </section>

            <section class="panel stack" aria-labelledby="ctl-log">
                <div class="between"><h2 class="title" id="ctl-log">Log</h2>{log.source === 'memory' && <span class="plain">from memory</span>}</div>
                {log.records.length === 0 ? <div class="empty">Nothing sent yet.</div> : (
                    <ol class="rule">
                        {log.records.map((line) => (
                            <li class="logline">
                                <span class="mono muted">{clockSeconds(line.at)}</span>
                                <span><span class="tag">{line.actor}</span> <span class="mono small muted">{line.origin}</span> {line.action}{line.target ? ` · ${line.target}` : ''}
                                    {!line.ok && line.detail && <span class="small muted"> · {line.detail}</span>}</span>
                                <span class="mono small" style={line.ok ? 'color:var(--muted)' : 'color:var(--crimson)'}>{line.ok ? 'ok' : 'failed'}</span>
                            </li>
                        ))}
                    </ol>
                )}
            </section>

            <section class="panel fail stack" aria-labelledby="ctl-danger">
                <h2 class="title" id="ctl-danger">Destructive</h2>
                <div class="row">
                    <button type="button" class="btn fail" disabled={!connected} onClick={() => run({ action: 'stop_all' }, 'Stop all')}>Stop all</button>
                    <button type="button" class="btn fail" disabled={!connected} aria-expanded={confirming} aria-controls="ctl-confirm" onClick={() => setConfirming(true)}>Shut down</button>
                </div>
                {confirming && (
                    <div id="ctl-confirm" class="row" role="group" aria-label="Confirm shut down">
                        <span>Shut down the MindServer and every agent.</span>
                        <button type="button" class="btn fail solid" onClick={async () => { setConfirming(false); await run({ action: 'shutdown', confirm: true }, 'Shut down'); }}>Confirm</button>
                        <button type="button" class="btn" onClick={() => setConfirming(false)}>Cancel</button>
                    </div>
                )}
            </section>
        </>
    );
}
