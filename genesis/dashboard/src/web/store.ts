// The browser's copy of the live view. It is filled by the ONE server-sent-events stream:
// a snapshot first, then every event, folded with the same code the server uses
// (src/shared/fold.ts). The browser's EventSource reconnects by itself and sends the id of
// the last event it got (Last-Event-ID), so the server replays what was missed.

import { useEffect, useState } from 'preact/hooks';
import { applyEntry, emptyState } from '../shared/fold';
import type { Health, LiveState, ProcessStatus } from '../shared/types';

export interface ClientState {
    live: LiveState;
    health: Health | null;
    processes: ProcessStatus[] | null;
    roster: { name: string; role: string }[];
    connected: boolean;
    loaded: boolean;
    last_control: Record<string, any> | null;
}

export const client: ClientState = {
    live: emptyState(), health: null, processes: null, roster: [], connected: false, loaded: false, last_control: null,
};

const listeners = new Set<() => void>();
let scheduled = false;
function changed() {
    if (scheduled) return;
    scheduled = true;
    // many events in one moment redraw once
    requestAnimationFrame(() => { scheduled = false; for (const listener of [...listeners]) listener(); });
}

export function useClient(): ClientState {
    const [, bump] = useState(0);
    useEffect(() => {
        const listener = () => bump((n) => n + 1);
        listeners.add(listener);
        return () => { listeners.delete(listener); };
    }, []);
    return client;
}

// A clock for ages and durations: redraws the caller every `ms`.
export function useNow(ms = 1000): number {
    const [now, setNow] = useState(Date.now());
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), ms);
        return () => clearInterval(timer);
    }, [ms]);
    return now;
}

export async function getJson<T = any>(url: string): Promise<T> {
    const response = await fetch(url, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`${response.status}`);
    return response.json();
}

export function useJson<T = any>(url: string | null, refresh_key: unknown = null): { data: T | null; error: string | null; loading: boolean } {
    const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: url !== null });
    useEffect(() => {
        if (url === null) { setState({ data: null, error: null, loading: false }); return undefined; }
        let alive = true;
        setState((before) => ({ ...before, loading: true }));
        getJson<T>(url).then((data) => { if (alive) setState({ data, error: null, loading: false }); })
            .catch((err) => { if (alive) setState({ data: null, error: String(err?.message ?? err), loading: false }); });
        return () => { alive = false; };
    }, [url, refresh_key]);
    return state;
}

export function connect() {
    getJson('/api/state').then((first) => { client.roster = first.roster ?? []; changed(); }).catch(() => {});
    const source = new EventSource('/api/stream');
    source.onopen = () => { client.connected = true; changed(); };
    source.onerror = () => { client.connected = false; changed(); };
    source.addEventListener('snapshot', (message) => {
        const data = JSON.parse((message as MessageEvent).data);
        client.live = data.state;
        client.health = data.health;
        client.processes = data.processes;
        client.loaded = true;
        changed();
    });
    source.addEventListener('event', (message) => {
        const m = message as MessageEvent;
        if (applyEntry(client.live, { sid: m.lastEventId, event: JSON.parse(m.data) })) changed();
    });
    source.addEventListener('health', (message) => { client.health = JSON.parse((message as MessageEvent).data); changed(); });
    source.addEventListener('processes', (message) => { client.processes = JSON.parse((message as MessageEvent).data); changed(); });
    source.addEventListener('control', (message) => { client.last_control = JSON.parse((message as MessageEvent).data); changed(); });
}
