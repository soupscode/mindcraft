// The frame every page shares: the masthead with its status pills, and the navigation.

import type { ComponentChildren } from 'preact';
import { incidentIsOpen } from '../shared/fold';
import { useClient, useNow } from './store';
import { clockTime, duration } from './format';

export const PAGES: { path: string; label: string }[] = [
    { path: '/', label: 'Agents' },
    { path: '/incidents', label: 'Incidents' },
    { path: '/messages', label: 'Messages' },
    { path: '/trace', label: 'Decision trace' },
    { path: '/controls', label: 'Controls' },
    { path: '/digest', label: 'Digest' },
    { path: '/routines', label: 'Routines' },
    { path: '/learning', label: 'Learning' },
    { path: '/town', label: 'Town' },
    { path: '/memory', label: 'Memory' },
    { path: '/world', label: 'World' },
    { path: '/skins', label: 'Skins' },
    { path: '/repair', label: 'Repair' },
];

export function Monogram({ name, small = false }: { name: string; small?: boolean }) {
    return <div class={small ? 'monogram sm' : 'monogram'} aria-hidden="true">{name.charAt(0).toUpperCase()}</div>;
}

export function roleOf(roster: { name: string; role: string }[], name: string): string {
    return roster.find((agent) => agent.name === name)?.role ?? '';
}

// The pills that say what the dashboard itself can and cannot see right now.
function StatusPills() {
    const { live, health, processes, connected, loaded, page_pills } = useClient();
    const now = useNow(1000);
    const online = processes ? processes.filter((agent) => agent.in_game).length : null;
    const model = live.model;
    const since = (iso: string | null) => (iso ? ` ${duration(now - Date.parse(iso))}` : '');
    return (
        <div class="pills">
            <div class="pill mono">{clockTime(now)}</div>
            {page_pills.map((pill) => <div class={pill.kind ? `pill ${pill.kind}` : 'pill'}>{pill.text}</div>)}
            {online !== null && <div class="pill">{online} online</div>}
            {loaded && health?.mindserver_ok === false && <div class="pill quiet">MindServer not connected</div>}
            {model.state === 'available' && <div class="pill">Model available</div>}
            {(model.state === 'away' || model.state === 'leaving') && <div class="pill gold">Model away{since(model.since)}</div>}
            {model.state === 'unknown' && loaded && <div class="pill quiet">Model unknown</div>}
            {Object.keys(live.server?.waiting ?? {}).length > 0 && <div class="pill gold" title={Object.values(live.server.waiting)[0]?.message}>Minecraft server unreachable · {Object.keys(live.server.waiting).length} waiting</div>}
            {health?.redis_ok === false && <div class="pill fail">Redis down{since(health.redis_down_since)}</div>}
            {health?.postgres_ok === false && <div class="pill fail">Postgres down{since(health.postgres_down_since)}</div>}
            {health?.postgres_ok === false && <div class="pill quiet">Live view from memory</div>}
            {!connected && <div class="pill fail">{loaded ? 'Reconnecting' : 'Connecting'}</div>}
        </div>
    );
}

export function Shell({ path, children }: { path: string; children: ComponentChildren }) {
    const { live } = useClient();
    const page = PAGES.find((candidate) => candidate.path === path) ?? PAGES[0];
    const waiting = live.incidents.filter((incident) => incident.needs_operator && incidentIsOpen(incident)).length;
    return (
        <div class="page">
            <header class="masthead">
                <h1>Genesis{page.path !== '/' && <span class="sub">{page.label}</span>}</h1>
                <StatusPills />
            </header>
            <nav class="nav" aria-label="Views">
                {PAGES.map((candidate) => (
                    <a href={`#${candidate.path}`} aria-current={candidate.path === page.path ? 'page' : undefined}>
                        {candidate.label}
                        {candidate.path === '/incidents' && waiting > 0 && <span class="count">{waiting}</span>}
                    </a>
                ))}
            </nav>
            {children}
        </div>
    );
}

// A page (or a part of one) whose data no event carries yet. Says what is missing, shows nothing made up.
export function NotConnected({ what, missing }: { what: string; missing: string }) {
    return <div class="note"><b>{what}: not connected yet.</b> {missing}</div>;
}

export function Fallback({ source }: { source: string | undefined }) {
    if (source !== 'memory') return null;
    return <div class="note"><b>Postgres is down.</b> Showing what is in memory.</div>;
}
