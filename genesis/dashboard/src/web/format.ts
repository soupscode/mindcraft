// How times, durations and names are written on every page.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const two = (n: number) => String(n).padStart(2, '0');

export function clockTime(value: string | number | Date): string {
    const d = new Date(value);
    return `${two(d.getHours())}:${two(d.getMinutes())}`;
}
export function clockSeconds(value: string | number | Date): string {
    const d = new Date(value);
    return `${clockTime(d)}:${two(d.getSeconds())}`;
}
export function dayTime(value: string | number | Date): string {
    const d = new Date(value);
    return `${d.getDate()} ${MONTHS[d.getMonth()]} ${clockTime(d)}`;
}
export function dayOnly(value: string | number | Date): string {
    const d = new Date(value);
    return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

// 41s · 6m 12s · 5h 08m · 3d 4h
export function duration(ms: number): string {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return s % 60 === 0 || m >= 10 ? `${m}m` : `${m}m ${two(s % 60)}s`;
    const h = Math.floor(m / 60);
    if (h < 48) return `${h}h ${two(m % 60)}m`;
    return `${Math.floor(h / 24)}d ${h % 24}h`;
}

// now · 12s · 4m · 2h
export function age(from: string | null, now: number): string {
    if (!from) return '';
    const s = Math.max(0, Math.round((now - Date.parse(from)) / 1000));
    if (s < 3) return 'now';
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.round(s / 60)}m`;
    if (s < 48 * 3600) return `${Math.round(s / 3600)}h`;
    return `${Math.round(s / 86400)}d`;
}

const KINDS: Record<string, string> = {
    'nav.stuck': 'Navigation stuck', 'agent.death': 'Death', 'process.exit': 'Process exit', 'server.down': 'Server disconnect',
    'login.refused': 'Login refused', 'step.parked': 'Step parked', 'model.away': 'Model away', 'model.available': 'Model available',
    incident: 'Parked after deaths',
};
export const kindLabel = (kind: string) => KINDS[kind] ?? kind;

const OUTCOMES: Record<string, string> = {
    pending: 'Recovering', auto_recovered: 'Auto-recovered', needs_operator: 'Waiting', expected: 'Expected', gave_up: 'Gave up',
};
export const outcomeLabel = (outcome: string) => OUTCOMES[outcome] ?? outcome;

const SOURCES: Record<string, string> = { planner: 'Model', routine: 'Routine', operator: 'Operator', executor: 'Executor', recovery: 'Recovery' };
export const sourceLabel = (source: string | null) => (source ? SOURCES[source] ?? source : '');

// step names of the recovery ladder: "park_step" -> "Park step"
export function words(name: string): string {
    const spaced = name.replace(/[_.]+/g, ' ').trim();
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// { item: "oak_log", count: 24 } -> "oak_log × 24"; anything else as key value pairs
export function bodyLine(body: Record<string, any>): string {
    const one = (b: any) => (b && typeof b.item === 'string' && Number.isFinite(b.count) ? `${b.item} × ${b.count}` : null);
    const parts: string[] = [];
    const item = one(body);
    if (item) parts.push(item);
    for (const [key, value] of Object.entries(body)) {
        if (key === 'item' || key === 'count') continue;
        const nested = one(value);
        if (nested) parts.push(`${key} ${nested}`);
        else if (value !== null && typeof value !== 'object') parts.push(`${key} ${String(value)}`);
    }
    return parts.join(' · ');
}

// The Learning screen's "Trying": "1 in 4" from the rate the scorer really uses (0.25). Never a number typed in the page.
export function tryingText(rate: number | null | undefined): string {
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0) return '–';
    return rate === 0 ? 'Off' : `1 in ${Math.round(1 / rate)}`;
}
