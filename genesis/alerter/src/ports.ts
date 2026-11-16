// Everything outside the process is reached through these interfaces: Redis, Postgres, the
// clock and ntfy. The real ones are in redis_stream.ts, pg_store.ts and ntfy.ts; the tests
// hand in in-memory fakes.

export interface GenesisEvent {
    v: number; id: string; ts: string; agent: string; seq: number; type: string;
    corr: string | null; severity: 'info' | 'warn' | 'error'; data: Record<string, any>;
}

export interface Clock { now(): number }

export interface StreamEntry { id: string; fields: Record<string, string> | null }

export interface StreamClient {
    ping(): Promise<void>;
    ensureGroup(stream: string, group: string): Promise<void>;
    readGroup(stream: string, group: string, consumer: string, options: { from: string; count: number; block_ms?: number }): Promise<StreamEntry[]>;
    ack(stream: string, group: string, ids: string[]): Promise<void>;
    // SET key NX EX ttl: true when this call made the mark, false when it was there already
    claim(key: string, ttl_s: number): Promise<boolean>;
    close(): Promise<void>;
}

export type Priority = 'urgent' | 'default' | 'low';

export interface Push {
    title: string;
    body: string;
    priority: Priority;
    tags: string[];
}

// delivered: ntfy took it. refused: it certainly did not go out (may be tried again).
// unknown: no answer came back; it may have gone out, so it is NOT tried again.
export type SendResult = 'delivered' | 'refused' | 'unknown';

export interface Notifier {
    enabled(): boolean;
    send(push: Push): Promise<SendResult>;
}

export type Severity = 'critical' | 'warning';
// queued: a warning that waits for the hourly push. sending / sent / unconfirmed / failed:
// a critical alert's one ping. batched: told in an hourly push. off: no ntfy topic is set.
export type PushState = 'queued' | 'sending' | 'sent' | 'unconfirmed' | 'failed' | 'batched' | 'off';

export interface Alert {
    id: string;
    problem_key: string;         // one open alert per problem
    severity: Severity;
    title: string;
    subject: string;             // an agent, or a service
    kind: string;
    opened_at: string;
    updated_at: string;
    closed_at: string | null;
    occurrences: number;         // how many matching events arrived while it was open
    push_state: PushState;
    pushed_at: string | null;
}

export interface AlerterState {
    gate: 'available' | 'leaving' | 'away' | 'unknown';
    held: string[];
}

export interface DigestRecord {
    period_end: string;
    period_start: string;
    tz: string;
    local_date: string;
    body: Record<string, any>;
    created_at: string;
    pushed_at: string | null;
}

// Postgres. Every method rejects when the database cannot be reached.
export interface AlertStore {
    ping(): Promise<void>;
    saveAlert(alert: Alert): Promise<void>;                       // insert or update by id
    openAlerts(): Promise<Alert[]>;                               // not closed, or a warning still queued
    alertsBetween(from: Date, to: Date): Promise<Alert[]>;        // opened in [from, to)
    saveState(state: AlerterState): Promise<void>;
    loadState(): Promise<AlerterState | null>;
    saveFacts(facts: GenesisEvent[]): Promise<void>;              // the same event twice is stored once
    factsBetween(from: Date, to: Date): Promise<GenesisEvent[]>;  // ts in [from, to), oldest first
    saveDigest(digest: DigestRecord): Promise<boolean>;           // false: one for that period exists already
    hasDigest(period_end: string): Promise<boolean>;
    markDigestPushed(period_end: string, at: string): Promise<void>;
    saveBatch(at: string, count: number): Promise<void>;          // one row per hourly push
    batchesBetween(from: Date, to: Date): Promise<number>;
    // retention: each deletes rows older than the cutoff and returns how many went
    deleteAlertsBefore(cutoff: Date): Promise<number>;
    deleteFactsBefore(cutoff: Date): Promise<number>;
    deleteDigestsBefore(cutoff: Date): Promise<number>;
}
