// The Controls view talks to the MindServer with the calls it already has
// (src/mindcraft/mindserver.js): start-agent, stop-agent, restart-agent, send-message,
// get-settings, set-agent-settings, stop-all-agents and shutdown.
//
// Decided: any command goes out without a confirmation, except "shutdown", which needs one.
// Two things are never done from here, whatever is asked:
//   - "!newAction" (model-written code) is never sent to an agent;
//   - the allow_insecure_coding setting is never changed: a settings change copies the
//     agent's current settings and replaces only the keys of EDITABLE_SETTINGS.
//
// The MindServer has no guard of its own for a restart or a settings change of an agent
// whose process is not connected (it would throw inside its socket handler), so those two
// are refused here unless the MindServer's own status says the process is connected.

import type { ProcessStatus } from '../shared/types.js';
import type { Clock, ControlRecord, Store } from './ports.js';
import type { Live } from './live.js';

// The socket to the MindServer. mindserver_link.ts is the real one; the tests record calls.
export interface MindLink {
    connected(): boolean;
    emit(event: string, ...args: any[]): void;
    // an emit that is answered through the callback the MindServer calls
    ask(event: string, arg: any, timeout_ms?: number): Promise<any>;
}

export const PANEL_SENDER = 'ADMIN'; // the name upstream's own panel uses for send-message

// The settings the panel may change (the mock-up's Settings section), with their checks.
export const EDITABLE_SETTINGS: Record<string, (value: unknown) => boolean> = Object.freeze({
    narrate_behavior: (value: unknown) => typeof value === 'boolean',
    chat_ingame: (value: unknown) => typeof value === 'boolean',
    log_all_prompts: (value: unknown) => typeof value === 'boolean',
    max_messages: (value: unknown) => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 200,
});

export const LOCKED_SETTINGS: readonly string[] = Object.freeze(['allow_insecure_coding', 'blocked_actions']);

// True when the text would hand "!newAction" to an agent, however it is spaced or cased.
export function namesNewAction(text: string): boolean {
    const squeezed = text.normalize('NFKC').replace(/[\s​-‍⁠﻿]/g, '').toLowerCase();
    return squeezed.includes('!newaction');
}

export interface Command {
    action: string;
    agent?: string;
    text?: string;
    settings?: Record<string, unknown>;
    confirm?: boolean;
}

export interface CommandResult {
    ok: boolean;
    error?: string;
    record?: ControlRecord;
}

const AGENT_NAME = /^[A-Za-z0-9_]{1,32}$/;

export function createControls({ link, store, live, clock = { now: Date.now }, ids, log_size = 60 }: {
    link: MindLink; store: Store; live: Live; clock?: Clock; ids: () => string; log_size?: number;
}) {
    const recent: ControlRecord[] = [];

    const known = (name: unknown): ProcessStatus | null =>
        (typeof name === 'string' ? (live.processes ?? []).find((agent) => agent.name === name) ?? null : null);

    function send(agent: string, message: string) {
        if (namesNewAction(message)) throw new Error('refused: !newAction is never sent');
        link.emit('send-message', agent, { from: PANEL_SENDER, message });
    }

    async function changeSettings(agent: string, edits: Record<string, unknown>) {
        const keys = Object.keys(edits);
        if (keys.length === 0) throw new Error('no setting to change');
        for (const key of keys) {
            if (!Object.hasOwn(EDITABLE_SETTINGS, key)) throw new Error(`refused: "${key}" cannot be changed from the panel`);
            if (!EDITABLE_SETTINGS[key](edits[key])) throw new Error(`"${key}" has a value that is not allowed`);
        }
        const answer = await link.ask('get-settings', agent);
        const current = answer?.settings;
        if (!current || typeof current !== 'object') throw new Error(answer?.error ?? 'the MindServer gave no settings');
        const next = { ...current };
        for (const key of keys) next[key] = edits[key];
        // belt and braces: what must never change is put back exactly as it was read
        for (const key of LOCKED_SETTINGS) {
            if (Object.hasOwn(current, key)) next[key] = current[key]; else delete next[key];
        }
        link.emit('set-agent-settings', agent, next);
    }

    // What the panel shows of an agent's settings: the editable ones, and nothing else.
    async function readSettings(agent: string): Promise<Record<string, unknown>> {
        if (!AGENT_NAME.test(agent)) throw new Error('unknown agent');
        if (!link.connected()) throw new Error('the MindServer is not connected');
        const answer = await link.ask('get-settings', agent);
        const current = answer?.settings;
        if (!current || typeof current !== 'object') throw new Error(answer?.error ?? 'the MindServer gave no settings');
        return Object.fromEntries(Object.keys(EDITABLE_SETTINGS).filter((key) => Object.hasOwn(current, key)).map((key) => [key, current[key]]));
    }

    async function perform(command: Command): Promise<{ target: string | null; detail: string | null }> {
        const { action } = command;
        if (!link.connected()) throw new Error('the MindServer is not connected');
        if (action === 'stop_all') { link.emit('stop-all-agents'); return { target: null, detail: null }; }
        if (action === 'shutdown') {
            if (command.confirm !== true) throw new Error('shut down needs its confirmation');
            link.emit('shutdown');
            return { target: null, detail: null };
        }
        const agent = command.agent;
        if (typeof agent !== 'string' || !AGENT_NAME.test(agent)) throw new Error('unknown agent');
        const status = known(agent);
        if (!status) throw new Error(`the MindServer does not know ${agent}`);
        const attached = status.socket_connected === true;
        switch (action) {
            case 'start': link.emit('start-agent', agent); return { target: agent, detail: null };
            case 'stop': link.emit('stop-agent', agent); return { target: agent, detail: null };
            case 'restart':
                if (!attached) throw new Error(`${agent} has no running process to restart`);
                link.emit('restart-agent', agent);
                return { target: agent, detail: null };
            case 'message': {
                const message = typeof command.text === 'string' ? command.text.trim() : '';
                if (message.length === 0) throw new Error('the message is empty');
                if (message.length > 2000) throw new Error('the message is longer than 2000 characters');
                if (!attached) throw new Error(`${agent} is not connected`);
                send(agent, message);
                return { target: agent, detail: message.slice(0, 120) };
            }
            case 'halt':
                if (!attached) throw new Error(`${agent} is not connected`);
                send(agent, '!stop');
                return { target: agent, detail: '!stop' };
            case 'stay':
                if (!attached) throw new Error(`${agent} is not connected`);
                send(agent, '!stay(-1)');
                return { target: agent, detail: '!stay(-1)' };
            case 'settings':
                if (!attached) throw new Error(`${agent} has no running process: its settings cannot be applied`);
                await changeSettings(agent, command.settings ?? {});
                return { target: agent, detail: Object.keys(command.settings ?? {}).join(', ') };
            default: throw new Error(`unknown action "${String(action).slice(0, 40)}"`);
        }
    }

    const LABELS: Record<string, string> = {
        start: 'Start', stop: 'Stop', restart: 'Restart', message: 'Message', halt: 'Halt action', stay: 'Stay still',
        settings: 'Settings', stop_all: 'Stop all', shutdown: 'Shut down',
    };

    return {
        readSettings,
        // Carries out one command and writes it to the log, whether it worked or not.
        async execute(command: Command, origin = 'lan'): Promise<CommandResult> {
            let ok = true;
            let error: string | undefined;
            let done = { target: typeof command?.agent === 'string' && AGENT_NAME.test(command.agent) ? command.agent : null as string | null, detail: null as string | null };
            try {
                done = await perform(command ?? ({} as Command));
            } catch (err: any) {
                ok = false;
                error = String(err?.message ?? err);
            }
            const record: ControlRecord = {
                id: ids(), at: new Date(clock.now()).toISOString(), actor: 'Operator', origin,
                action: LABELS[command?.action] ?? 'Unknown', target: done.target, ok, detail: ok ? done.detail : error ?? null,
            };
            recent.unshift(record);
            if (recent.length > log_size) recent.length = log_size;
            live.publish({ kind: 'control', data: record });
            try { await store.insertControl(record); } catch { /* Postgres is down: the log line stays in memory */ }
            return ok ? { ok, record } : { ok, error, record };
        },
        // The newest log lines: from Postgres, or from memory while it is down.
        async log(limit = 40): Promise<{ source: 'postgres' | 'memory'; records: ControlRecord[] }> {
            try { return { source: 'postgres', records: await store.controls(limit) }; } catch { return { source: 'memory', records: recent.slice(0, limit) }; }
        },
    };
}

// lan | tailscale | local, from the address the request came from (Tailscale uses 100.64.0.0/10).
export function originOf(ip: string | undefined): string {
    const address = String(ip ?? '').replace(/^::ffff:/, '');
    if (address === '127.0.0.1' || address === '::1') return 'local';
    const parts = address.split('.').map(Number);
    if (parts.length === 4 && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return 'tailscale';
    if (address.toLowerCase().startsWith('fd7a:115c:a1e0:')) return 'tailscale';
    return 'lan';
}
