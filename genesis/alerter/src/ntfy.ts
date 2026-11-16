// The ntfy sender. The server and the topic come from the environment and are never
// written into the code (NTFY_SERVER, default the hosted https://ntfy.sh; NTFY_TOPIC).
//
// NOT RUN AGAINST A REAL NTFY SERVER in the tests: they use a recording Notifier.
//
// Publishing as JSON to the server's root, as ntfy documents it:
//   POST <server>   {"topic": "...", "title": "...", "message": "...", "priority": 5, "tags": [...]}

import type { Notifier, Push, SendResult } from './ports.js';
import { scrub } from './text.js';

const PRIORITY = { urgent: 5, default: 3, low: 2 } as const;

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number }>;

export function createNtfy({ server, topic, token = '', timeout_ms = 10000, fetch: doFetch = globalThis.fetch as unknown as Fetch }: {
    server: string; topic: string; token?: string; timeout_ms?: number; fetch?: Fetch;
}): Notifier {
    const base = server.replace(/\/+$/, '');
    return {
        enabled: () => topic.length > 0 && base.length > 0,
        async send(push: Push): Promise<SendResult> {
            if (topic.length === 0 || base.length === 0) return 'refused';
            const abort = new AbortController();
            const timer = setTimeout(() => abort.abort(), timeout_ms);
            let reached = false;
            try {
                const headers: Record<string, string> = { 'content-type': 'application/json' };
                if (token) headers.authorization = `Bearer ${token}`;
                const response = await doFetch(base, {
                    method: 'POST', headers, signal: abort.signal,
                    // the text is put together from fixed words; scrub() is the last gate before a public topic
                    body: JSON.stringify({ topic, title: scrub(push.title), message: scrub(push.body), priority: PRIORITY[push.priority], tags: push.tags }),
                });
                reached = true;
                return response.ok ? 'delivered' : 'refused';
            } catch (err: any) {
                if (reached) return 'unknown';
                // a refused or unresolvable connection never carried the request; a timeout may have
                const code = String(err?.cause?.code ?? err?.code ?? '');
                return ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code) ? 'refused' : 'unknown';
            } finally {
                clearTimeout(timer);
            }
        },
    };
}
