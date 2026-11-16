// The HTTP side: JSON endpoints, the one SSE stream and the static front end.
//
// History comes from Postgres. While Postgres is down the same endpoints answer from the
// live view in memory and say so ("source": "memory"), so the pages keep working.

import Fastify, { type FastifyInstance } from 'fastify';
import { applyEvent, emptyState, foldIncidents } from '../shared/fold.js';
import type { Entry, GenesisEvent } from '../shared/types.js';
import type { Clock, EventQuery, Store } from './ports.js';
import type { Live } from './live.js';
import { openStream, SID_PATTERN } from './sse.js';
import { originOf, type Command } from './controls.js';
import { DAY_MS, RETENTION_DAYS } from './retention.js';

export interface Controls {
    execute(command: Command, origin?: string): Promise<{ ok: boolean; error?: string; record?: any }>;
    log(limit?: number): Promise<{ source: string; records: any[] }>;
    readSettings(agent: string): Promise<Record<string, unknown>>;
}

export interface AppDeps {
    live: Live;
    store: Store;
    controls: Controls | null;
    roster: { name: string; role: string }[];
    clock?: Clock;
    public_dir?: string | null;
    heartbeat_ms?: number;
}

const clampInt = (value: unknown, fallback: number, min: number, max: number) => {
    const n = Number(value);
    return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const word = (value: unknown, max = 64) => (typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined);

function matches(entry: Entry, query: EventQuery): boolean {
    const e = entry.event;
    if (query.agent && e.agent !== query.agent) return false;
    if (query.type && e.type !== query.type) return false;
    if (query.severity && e.severity !== query.severity) return false;
    if (query.corr && e.corr !== query.corr) return false;
    if (query.q) {
        const hay = JSON.stringify(e).toLowerCase();
        if (!query.q.toLowerCase().split(/\s+/).filter(Boolean).every((term) => hay.includes(term))) return false;
    }
    return true;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
    const { live, store, controls, roster } = deps;
    const clock = deps.clock ?? { now: Date.now };
    const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });
    app.removeContentTypeParser('text/plain'); // only JSON bodies are read (a plain HTML form cannot send one)

    // Events, newest first: Postgres, or the ring in memory while Postgres is down.
    async function events(query: EventQuery): Promise<{ source: 'postgres' | 'memory'; entries: Entry[] }> {
        try {
            return { source: 'postgres', entries: await store.searchEvents(query) };
        } catch {
            const held = live.ring().reverse().filter((entry) => matches(entry, query));
            return { source: 'memory', entries: held.slice(0, query.limit) };
        }
    }

    // The panel has no password (decided). A page of another site still cannot use it from the
    // operator's browser: only JSON bodies are read, and a request that names another origin is refused.
    app.addHook('onRequest', async (request, reply) => {
        if (request.method === 'GET' || request.method === 'HEAD') return;
        const origin = request.headers.origin;
        if (origin) {
            let host = '';
            try { host = new URL(origin).host; } catch { /* not an address */ }
            if (host !== request.headers.host) return reply.code(403).send({ error: 'cross-site request refused' });
        }
    });

    app.get('/api/health', async () => ({ ...live.health, cursor: live.state.cursor, last_event_at: live.state.last_event_at, subscribers: live.subscribers() }));

    app.get('/api/state', async () => ({ ...live.snapshot().data, roster }));

    app.get('/api/stream', (request, reply) => {
        const header = request.headers['last-event-id'];
        const asked = (request.query as any)?.last_event_id;
        const last_id = typeof header === 'string' ? header : typeof asked === 'string' ? asked : null;
        reply.hijack();
        const raw = reply.raw;
        raw.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
        });
        raw.write('retry: 2000\n\n');
        let close = () => {};
        const beat = setInterval(() => { raw.write(': keep-alive\n\n'); }, deps.heartbeat_ms ?? 20000);
        beat.unref?.();
        const end = () => { clearInterval(beat); close(); };
        raw.on('close', end);
        openStream(live, store, last_id, (text) => { raw.write(text); })
            .then((unsubscribe) => { close = unsubscribe; if (raw.destroyed) unsubscribe(); })
            .catch(() => { end(); raw.end(); });
    });

    app.get('/api/events', async (request) => {
        const q = request.query as Record<string, unknown>;
        const before = word(q.before, 32);
        return events({
            agent: word(q.agent), type: word(q.type), severity: word(q.severity, 8), corr: word(q.corr), q: word(q.q, 200),
            before: before && SID_PATTERN.test(before) ? before : undefined, limit: clampInt(q.limit, 100, 1, 500),
        });
    });

    app.get('/api/incidents', async (request) => {
        const days = clampInt((request.query as any)?.days, 7, 1, RETENTION_DAYS.incidents);
        try {
            const rows = await store.incidentEvents(new Date(clock.now() - days * DAY_MS));
            return { source: 'postgres', days, incidents: foldIncidents(rows) };
        } catch {
            return { source: 'memory', days, incidents: live.state.incidents };
        }
    });

    app.get('/api/messages', async () => {
        const found = await events({ type: 'agent.message', limit: 500 });
        if (found.source === 'memory') return { source: 'memory', messages: live.state.messages };
        const folded = emptyState();
        for (const entry of found.entries.reverse()) applyEvent(folded, entry.event);
        return { source: 'postgres', messages: folded.messages };
    });

    app.get('/api/decisions', async (request) => {
        const agent = word((request.query as any)?.agent);
        const found = await events({ type: 'agent.decision', agent, limit: clampInt((request.query as any)?.limit, 60, 1, 200) });
        const folded = emptyState();
        for (const entry of found.entries.reverse()) applyEvent(folded, entry.event);
        return { source: found.source, decisions: folded.decisions };
    });

    // Everything known about one decision: its own event, what ran under it, the goal change
    // of the planning call behind it, and that call's record when the planner writes to this database.
    app.get('/api/decisions/:id', async (request, reply) => {
        const id = word((request.params as any).id, 80);
        if (!id) return reply.code(400).send({ error: 'bad id' });
        const under = await events({ corr: id, limit: 300 });
        const chain = under.entries.map((entry) => entry.event).reverse();
        const decision = chain.find((event) => event.type === 'agent.decision' && event.data.decision_id === id) ?? null;
        if (!decision) return reply.code(404).send({ error: 'unknown decision', source: under.source });
        const call_id = typeof decision.data.call_id === 'string' ? decision.data.call_id : null;
        let goal_changes: GenesisEvent[] = [];
        let call: Record<string, any> | null = null;
        let call_source: 'postgres' | 'unavailable' | 'none' = 'none';
        if (call_id) {
            const changed = await events({ type: 'goal.changed', agent: decision.agent, q: call_id, limit: 20 });
            goal_changes = changed.entries.map((entry) => entry.event).filter((event) => event.data.call_id === call_id).reverse();
            try { call = await store.plannerCall(call_id); call_source = 'postgres'; } catch { call_source = 'unavailable'; }
        }
        return { source: under.source, decision, events: chain.filter((event) => event !== decision), goal_changes, call, call_source };
    });

    app.get('/api/alerts', async (request) => {
        const days = clampInt((request.query as any)?.days, 7, 1, 90);
        try { return { source: 'postgres', alerts: await store.alerts(new Date(clock.now() - days * DAY_MS), 300) }; } catch { return { source: 'unavailable', alerts: [] }; }
    });

    app.get('/api/digests', async (request) => {
        try { return { source: 'postgres', digests: await store.digests(clampInt((request.query as any)?.limit, 30, 1, 366)) }; } catch { return { source: 'unavailable', digests: [] }; }
    });

    app.get('/api/controls', async () => ({
        available: controls !== null, connected: live.health.mindserver_ok === true, processes: live.processes,
        log: controls ? await controls.log(40) : { source: 'memory', records: [] },
    }));

    app.get('/api/controls/settings/:agent', async (request, reply) => {
        if (!controls) return reply.code(503).send({ error: 'controls are not configured' });
        try { return { settings: await controls.readSettings(String((request.params as any).agent)) }; } catch (err: any) {
            return reply.code(502).send({ error: String(err?.message ?? err) });
        }
    });

    app.post('/api/controls/command', async (request, reply) => {
        if (!controls) return reply.code(503).send({ ok: false, error: 'controls are not configured' });
        const body = request.body;
        if (!body || typeof body !== 'object' || Array.isArray(body)) return reply.code(400).send({ ok: false, error: 'a JSON object is expected' });
        const result = await controls.execute(body as Command, originOf(request.ip));
        return reply.code(result.ok ? 200 : 409).send(result);
    });

    if (deps.public_dir) {
        const { default: serveStatic } = await import('@fastify/static');
        await app.register(serveStatic, { root: deps.public_dir, prefix: '/', maxAge: '1h', immutable: false });
        app.setNotFoundHandler((request, reply) => {
            if (request.method === 'GET' && !request.url.startsWith('/api/')) return (reply as any).sendFile('index.html', { maxAge: 0 });
            return reply.code(404).send({ error: 'not found' });
        });
    }
    return app;
}
