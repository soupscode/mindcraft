// The HTTP side: JSON endpoints, the one SSE stream and the static front end.
//
// History comes from Postgres. While Postgres is down the same endpoints answer from the
// live view in memory and say so ("source": "memory"), so the pages keep working.

import { SKIN_LIMITS, type Skins } from './skins.js';
import Fastify, { type FastifyInstance } from 'fastify';
import { applyEvent, emptyState, foldIncidents } from '../shared/fold.js';
import type { Entry, GenesisEvent } from '../shared/types.js';
import type { Clock, EventQuery, Store } from './ports.js';
import type { Live } from './live.js';
import { openStream, SID_PATTERN } from './sse.js';
import { originOf, type Command } from './controls.js';
import { DAY_MS, RETENTION_DAYS } from './retention.js';
import { UPLOAD_LIMIT_BYTES, type TownLearning } from './town_learning.js';

export interface Controls {
    execute(command: Command, origin?: string): Promise<{ ok: boolean; error?: string; record?: any }>;
    log(limit?: number): Promise<{ source: string; records: any[] }>;
    readSettings(agent: string): Promise<Record<string, unknown>>;
}

export interface AppDeps {
    allow?: string[];
    skins?: Skins | null;
    town_learning?: TownLearning | null;
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
    const skins = deps.skins ?? null;
    const clock = deps.clock ?? { now: Date.now };
    const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });
    app.removeContentTypeParser('text/plain'); // only JSON bodies are read (a plain HTML form cannot send one)
    // ... and a PNG, for an agent's skin: taken as bytes, never parsed here (the same size cap applies)
    app.addContentTypeParser('image/png', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
    // ... and a schematic the operator uploads on the Town screen: bytes, handed on unread (its own, larger cap is on its route)
    app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));

    // Events, newest first: Postgres, or the ring in memory while Postgres is down.
    async function events(query: EventQuery): Promise<{ source: 'postgres' | 'memory'; entries: Entry[] }> {
        try {
            return { source: 'postgres', entries: await store.searchEvents(query) };
        } catch {
            const held = live.ring().reverse().filter((entry) => matches(entry, query));
            return { source: 'memory', entries: held.slice(0, query.limit) };
        }
    }

    // An optional allow-list (the env file's GENESIS_DASHBOARD_ALLOW): with one, only those addresses and
    // this machine itself are answered. UNVERIFIED on the VM: which address the container sees for a
    // client behind Docker's published port; a refusal names the address that was seen.
    const allow = (deps.allow ?? []).filter(Boolean);
    const local = (ip: string) => ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    if (allow.length > 0) {
        app.addHook('onRequest', async (request, reply) => {
            const ip = request.ip.replace(/^::ffff:/, '');
            if (local(request.ip) || allow.includes(ip)) return;
            return reply.code(403).send({ error: `this address is not on the dashboard's allow-list (seen: ${ip})` });
        });
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

    // ---- the agents' skins (the operator uploads them; the skin service applies them) ----
    app.get('/api/skins', async (_request, reply) => {
        if (!skins) return reply.code(503).send({ error: 'skins are not configured' });
        // signing: whether the MineSkin API key is set (never the key), and what a custom skin's texture address is: public
        try { return { limits: SKIN_LIMITS, skins: await skins.list(), signing: await skins.signing() }; } catch (err: any) { return reply.code(503).send({ error: String(err?.message ?? err) }); }
    });
    app.get('/api/skins/:agent/image', async (request, reply) => {
        if (!skins) return reply.code(503).send({ error: 'skins are not configured' });
        const png = await skins.image(String((request.params as any).agent)).catch(() => null);
        if (!png) return reply.code(404).send({ error: 'no skin is set for this agent' });
        return reply.header('content-type', 'image/png').header('cache-control', 'no-store').send(png);
    });
    app.put('/api/skins/:agent', async (request, reply) => {
        if (!skins) return reply.code(503).send({ ok: false, error: 'skins are not configured' });
        if (!String(request.headers['content-type'] ?? '').startsWith('image/png')) return reply.code(415).send({ ok: false, error: 'send the PNG file as the body, with content-type image/png' });
        try {
            const result = await skins.upload(String((request.params as any).agent), request.body, String((request.query as any)?.variant ?? 'classic'));
            return result.ok ? result : reply.code(result.status).send({ ok: false, error: result.error });
        } catch (err: any) { return reply.code(503).send({ ok: false, error: String(err?.message ?? err) }); }
    });
    app.delete('/api/skins/:agent', async (request, reply) => {
        if (!skins) return reply.code(503).send({ ok: false, error: 'skins are not configured' });
        try {
            const result = await skins.clear(String((request.params as any).agent));
            return result.ok ? result : reply.code(result.status).send({ ok: false, error: result.error });
        } catch (err: any) { return reply.code(503).send({ ok: false, error: String(err?.message ?? err) }); }
    });

    // ---- Learning and Town: asked of the learner and the town in the MindServer process (src/server/town_learning.ts) ----
    const tl = deps.town_learning ?? null;
    const none = { ok: false, error: 'the MindServer link is not configured' };
    const send = (reply: any, answer: any) => (answer.ok ? answer : reply.code(answer.status ?? 502).send((({ status: _status, ...rest }) => rest)(answer)));
    const body = (request: any) => (request.body && typeof request.body === 'object' && !Array.isArray(request.body) && !Buffer.isBuffer(request.body) ? request.body : null);

    app.get('/api/learning', async (_request, reply) => (tl ? send(reply, await tl.learning()) : reply.code(503).send(none)));
    app.get('/api/learning/versions', async (_request, reply) => {
        if (!tl) return reply.code(503).send(none);
        const got = await tl.learning();
        return got.ok ? { ok: true, versions: got.view.versions ?? [] } : send(reply, got);
    });
    // one agent's part of the same view: curve | calibration | situations | changes
    app.get('/api/learning/:agent/:part', async (request, reply) => {
        if (!tl) return reply.code(503).send(none);
        const { agent, part } = request.params as { agent: string; part: string };
        const got = await tl.learning();
        if (!got.ok) return send(reply, got);
        const mine = (got.view.agents ?? []).find((entry: any) => entry.name === agent);
        if (!mine) return reply.code(404).send({ ok: false, error: 'unknown agent' });
        if (part === 'curve') return { ok: true, agent, curve: mine.error?.curve ?? [], network: mine.error?.network ?? null, table: mine.error?.table ?? null };
        if (part === 'calibration') return { ok: true, agent, calibration: mine.calibration ?? [] };
        if (part === 'situations') return { ok: true, agent, most_sure: mine.most_sure ?? [], least_sure: mine.least_sure ?? [] };
        if (part === 'changes') return { ok: true, agent, changed: mine.changed ?? [], today: mine.today ?? [] };
        return reply.code(404).send({ ok: false, error: 'unknown part' });
    });
    app.post('/api/learning/control', async (request, reply) => (tl ? send(reply, await tl.learningControl(body(request))) : reply.code(503).send(none)));

    app.get('/api/town', async (_request, reply) => (tl ? send(reply, await tl.town()) : reply.code(503).send(none)));
    app.get('/api/prefabs', async (_request, reply) => {
        if (!tl) return reply.code(503).send(none);
        const got = await tl.town();
        return got.ok ? { ok: true, generated: got.view.ladder?.generated ?? null, operator: got.view.ladder?.operator ?? null } : send(reply, got);
    });
    app.get('/api/prefabs/:name', async (request, reply) => {
        if (!tl) return reply.code(503).send(none);
        const got = await tl.town();
        if (!got.ok) return send(reply, got);
        const name = String((request.params as any).name);
        const found = [...(got.view.ladder?.generated?.list ?? []), ...(got.view.ladder?.operator?.list ?? [])].find((entry: any) => entry.name === name);
        return found ? { ok: true, prefab: found } : reply.code(404).send({ ok: false, error: 'unknown prefab' });
    });
    app.post('/api/town/proposals/:id', async (request, reply) => (tl ? send(reply, await tl.proposal(String((request.params as any).id), body(request))) : reply.code(503).send(none)));
    app.post('/api/town/goals/:agent', async (request, reply) => (tl ? send(reply, await tl.goals(String((request.params as any).agent), body(request))) : reply.code(503).send(none)));
    // the schematic file as the body (application/octet-stream); name, title, kind, substitute and save in the query
    app.post('/api/prefabs/import', { bodyLimit: UPLOAD_LIMIT_BYTES + 1024 }, async (request, reply) => {
        if (!tl) return reply.code(503).send(none);
        if (!String(request.headers['content-type'] ?? '').startsWith('application/octet-stream')) return reply.code(415).send({ ok: false, error: 'send the schematic file as the body, with content-type application/octet-stream' });
        return send(reply, await tl.importPrefab(request.body, request.query as Record<string, unknown>));
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
