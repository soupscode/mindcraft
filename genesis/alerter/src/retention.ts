// Retention (decided): alerts 90 days, digests a year. The digest's own facts are kept 8
// days (one day of digest plus the look-back). A row goes only when it is past its window.

import type { AlertStore, Clock } from './ports.js';

export const DAY_MS = 24 * 60 * 60 * 1000;
export const RETENTION_DAYS = Object.freeze({ alerts: 90, digests: 365, facts: 8 });

export async function runRetention(store: AlertStore, clock: Clock = { now: Date.now }) {
    const cutoff = (days: number) => new Date(clock.now() - days * DAY_MS);
    return {
        alerts: await store.deleteAlertsBefore(cutoff(RETENTION_DAYS.alerts)),
        facts: await store.deleteFactsBefore(cutoff(RETENTION_DAYS.facts)),
        digests: await store.deleteDigestsBefore(cutoff(RETENTION_DAYS.digests)),
    };
}
