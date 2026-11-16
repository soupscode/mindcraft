// What goes into a push. ntfy topics are public (anyone who knows the topic name can read
// it), so a push carries no secret, address or token: it is put together from fixed words,
// an agent's name and an incident's kind, and scrub() is applied to the result as a last
// gate. Free text of an event (messages, URLs, errors) never goes in.

const KINDS: Record<string, string> = {
    'nav.stuck': 'Navigation stuck', 'agent.death': 'Death', 'process.exit': 'Process exit', 'server.down': 'Server disconnect',
    'login.refused': 'Login refused', 'step.parked': 'Step parked', incident: 'Parked after deaths', model: 'Model call failed', 'model.away': 'Model away',
};

// A name as it may be shown: letters, digits, "_", "-", at most 32. Anything else is "unknown".
export function safeName(value: unknown): string {
    return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(value) ? value : 'unknown';
}

export function kindLabel(kind: unknown): string {
    if (typeof kind !== 'string') return 'Problem';
    if (KINDS[kind]) return KINDS[kind];
    return /^[a-z][a-z0-9_.]{0,39}$/.test(kind) ? kind : 'Problem';
}

// Error class names such as "ModelTimeoutError" only.
export function safeErrorName(value: unknown): string | null {
    return typeof value === 'string' && /^[A-Z][A-Za-z]{2,39}$/.test(value) ? value : null;
}

const PATTERNS: RegExp[] = [
    /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi,                                  // URLs of any scheme
    /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b/g,                      // IPv4, with or without a port
    /\[?\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{0,4}\]?(?::\d{1,5})?/gi,    // IPv6
    /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g,                              // e-mail addresses
    /\b(?:[a-z0-9-]+\.)+(?:lol|com|net|org|io|dev|local|lan|internal|ts\.net)(?::\d{1,5})?\b/gi, // host names
    /\b[a-z0-9-]+:\d{2,5}\b/gi,                                       // host:port
    /\b[A-Za-z0-9_\-+/=]{24,}\b/g,                                    // long opaque strings: keys, tokens, hashes
    /\b(?:bearer|token|password|secret|key)\s*[:=]\s*\S+/gi,
];

// Removes anything that looks like an address or a credential.
export function scrub(text: string): string {
    let out = text;
    for (const pattern of PATTERNS) out = out.replace(pattern, '[removed]');
    return out.replace(/[^\x20-\x7E\n·×]/g, '').slice(0, 600);
}
