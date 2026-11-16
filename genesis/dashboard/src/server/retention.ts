// Retention (decided): events are searchable for 7 days; incidents (and the control log)
// are kept 90 days. The alerter keeps its own tables (alerts 90 days, digests a year).
// A row goes only when it is older than its window.

import type { Clock, Store } from './ports.js';

export const DAY_MS = 24 * 60 * 60 * 1000;
export const RETENTION_DAYS = Object.freeze({ events: 7, incidents: 90, controls: 90 });

export async function runRetention(store: Store, clock: Clock = { now: Date.now }) {
    const now = clock.now();
    const cutoff = (days: number) => new Date(now - days * DAY_MS);
    return {
        events: await store.deleteEventsBefore(cutoff(RETENTION_DAYS.events)),
        incident_events: await store.deleteIncidentEventsBefore(cutoff(RETENTION_DAYS.incidents)),
        controls: await store.deleteControlsBefore(cutoff(RETENTION_DAYS.controls)),
    };
}
