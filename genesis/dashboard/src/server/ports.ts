// Everything outside the process is reached through these interfaces. The real ones are in
// redis_stream.ts and pg_store.ts; the tests hand in in-memory fakes.

import type { Entry, GenesisEvent } from '../shared/types.js';

export interface Clock {
    now(): number;
}

export interface StreamEntry {
    id: string;
    // null: the entry is still listed as pending but the stream no longer holds it (trimmed)
    fields: Record<string, string> | null;
}

// The Redis stream, read through one consumer group.
export interface StreamClient {
    ping(): Promise<void>;
    // XGROUP CREATE ... MKSTREAM; an existing group is not an error
    ensureGroup(stream: string, group: string): Promise<void>;
    // XREADGROUP. from ">": entries nobody has read yet. from an id: this consumer's own
    // pending entries after that id (read but never acknowledged).
    readGroup(stream: string, group: string, consumer: string,
        options: { from: string; count: number; block_ms?: number }): Promise<StreamEntry[]>;
    ack(stream: string, group: string, ids: string[]): Promise<void>;
    // XREVRANGE, returned oldest first: the newest `count` entries, whoever read them
    tail(stream: string, count: number): Promise<StreamEntry[]>;
    close(): Promise<void>;
}

export interface EventQuery {
    agent?: string;
    type?: string;
    severity?: string;
    corr?: string;
    q?: string;          // full-text search
    before?: string;     // stream id: only entries older than this one
    limit: number;
}

export interface ControlRecord {
    id: string;
    at: string;
    actor: string;       // always "Operator": the panel has no login (decided)
    origin: string;      // lan | tailscale | local
    action: string;
    target: string | null;
    ok: boolean;
    detail: string | null;
}

// Postgres. Every method rejects when the database cannot be reached.
export interface Store {
    ping(): Promise<void>;
    insertEntries(entries: Entry[]): Promise<void>;            // the same event twice is stored once
    entriesAfter(sid: string, limit: number): Promise<Entry[]>; // oldest first
    latestEntries(limit: number): Promise<Entry[]>;             // the newest `limit`, oldest first
    searchEvents(query: EventQuery): Promise<Entry[]>;          // newest first
    incidentEvents(since: Date): Promise<GenesisEvent[]>;
    insertControl(record: ControlRecord): Promise<void>;
    controls(limit: number): Promise<ControlRecord[]>;
    // tables of other services; an empty answer when the table is not there
    plannerCall(call_id: string): Promise<Record<string, any> | null>;
    agentGoals(): Promise<{ agent: string; long_term: any[]; short_term: any[]; updated_at: string }[]>;
    alerts(since: Date, limit: number): Promise<Record<string, any>[]>;
    digests(limit: number): Promise<Record<string, any>[]>;
    // retention: each deletes rows older than the cutoff and returns how many went
    deleteEventsBefore(cutoff: Date): Promise<number>;
    deleteIncidentEventsBefore(cutoff: Date): Promise<number>;
    deleteControlsBefore(cutoff: Date): Promise<number>;
}
