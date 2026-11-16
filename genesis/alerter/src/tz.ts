// Local wall-clock time in a named time zone, with nothing but Intl (no library, no table).
// Used for one thing: finding the instant of "18:00 local" on a given day, also across a
// daylight-saving change.

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
    let known = formatters.get(tz);
    if (!known) {
        known = new Intl.DateTimeFormat('en-US', {
            timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
        });
        formatters.set(tz, known);
    }
    return known;
}

export function isTimeZone(tz: string): boolean {
    try { formatter(tz); return true; } catch { return false; }
}

export interface LocalTime { year: number; month: number; day: number; hour: number; minute: number; second: number }

// The wall clock of `tz` at the instant `ms`.
export function localTime(ms: number, tz: string): LocalTime {
    const parts: Record<string, number> = {};
    for (const part of formatter(tz).formatToParts(new Date(ms))) if (part.type !== 'literal') parts[part.type] = Number(part.value);
    return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute, second: parts.second };
}

// local time minus UTC, in milliseconds, at the instant `ms`
export function offsetMs(ms: number, tz: string): number {
    const t = localTime(ms, tz);
    return Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second) - Math.floor(ms / 1000) * 1000;
}

// The instant at which the wall clock of `tz` shows the given local time. For a local time a
// clock change skips, the instant right after the gap; for one that happens twice, the first.
export function instantOf(year: number, month: number, day: number, hour: number, tz: string): number {
    const wall = Date.UTC(year, month - 1, day, hour, 0, 0);
    const HALF_DAY = 12 * 3600 * 1000;
    // the zone's offset shortly before and shortly after: they differ only around a clock change
    const before = wall - offsetMs(wall - HALF_DAY, tz);
    const after = wall - offsetMs(wall + HALF_DAY, tz);
    if (before === after) return before;
    const shows = (ms: number) => { const t = localTime(ms, tz); return t.day === day && t.hour === hour && t.minute === 0; };
    const valid = [before, after].filter(shows);
    if (valid.length > 0) return Math.min(...valid);
    return Math.max(before, after);
}

// The most recent instant, at or before `now`, at which it was `hour`:00 local time.
export function lastLocalHour(now: number, tz: string, hour: number): number {
    const today = localTime(now, tz);
    const candidate = instantOf(today.year, today.month, today.day, hour, tz);
    if (candidate <= now) return candidate;
    const yesterday = localTime(candidate - 20 * 3600 * 1000, tz);
    return instantOf(yesterday.year, yesterday.month, yesterday.day, hour, tz);
}

export function localDate(ms: number, tz: string): string {
    const t = localTime(ms, tz);
    return `${t.year}-${String(t.month).padStart(2, '0')}-${String(t.day).padStart(2, '0')}`;
}
