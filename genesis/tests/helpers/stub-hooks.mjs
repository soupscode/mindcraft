// Module loader hooks for the Genesis tests (runs on Node's loader thread).
// Replaces chosen modules with small stand-ins, so tests can import upstream
// files without installing the repo's heavy dependencies (mineflayer, canvas, ...).
//
// `stubs` maps a module to replacement source code. A key is either a bare
// package specifier ("yargs") or the end of a file path ("src/agent/coder.js").

let stubs = {};

export function initialize(data) {
    stubs = data?.stubs ?? {};
}

const PREFIX = 'genesis-stub:';

export async function resolve(specifier, context, nextResolve) {
    if (Object.hasOwn(stubs, specifier)) {
        return { url: PREFIX + specifier, shortCircuit: true };
    }
    const resolved = await nextResolve(specifier, context);
    const key = Object.keys(stubs).find((k) => resolved.url.endsWith('/' + k));
    if (key) {
        return { url: PREFIX + key, shortCircuit: true };
    }
    return resolved;
}

export async function load(url, context, nextLoad) {
    if (url.startsWith(PREFIX)) {
        return { format: 'module', source: stubs[url.slice(PREFIX.length)], shortCircuit: true };
    }
    return nextLoad(url, context);
}
