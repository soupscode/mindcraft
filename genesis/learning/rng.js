// Genesis learning: a seeded random number generator. Everything in genesis/learning that
// needs chance takes one of these, so the same seed gives the same weights, the same
// exploratory choices and the same simulated outcomes.
// No imports.

// mulberry32: 32 bits of state, good enough for sampling batches and choices.
export function createRng(seed = 1) {
    let s = seed >>> 0;
    const next = () => {
        s = (s + 0x6D2B79F5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    next.int = (n) => Math.floor(next() * n);                  // 0 .. n-1
    next.chance = (p) => next() < p;
    next.pick = (list) => list[Math.floor(next() * list.length)];
    next.normal = () => Math.sqrt(-2 * Math.log(next() + 1e-12)) * Math.cos(2 * Math.PI * next());
    next.state = () => s;
    return next;
}

// FNV-1a over the text: a stable 32-bit number for a name (item buckets, per-name seeds).
export function hashText(text) {
    let h = 0x811c9dc5;
    const s = String(text);
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}
