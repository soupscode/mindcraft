// Helpers shared by the Genesis tests. Node built-ins only.

import { register } from 'node:module';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// Replace modules with stand-in source code for every import that follows.
// Call before importing the code under test (use dynamic import() after it).
export function stubModules(stubs) {
    register('./stub-hooks.mjs', { parentURL: import.meta.url, data: { stubs } });
}

// Servers started by the helpers below. Call closeAllServers in an after() hook,
// so a test that fails or times out cannot leave the process hanging on an open socket.
const open_servers = new Set();

export async function closeAllServers() {
    await Promise.all([...open_servers].map((close) => close()));
}

// A port on which nothing listens: connecting is refused.
export async function refusedPort() {
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    await new Promise((resolve) => server.close(resolve));
    return port;
}

// A server that accepts connections and never answers.
export async function silentServer() {
    const sockets = new Set();
    const server = net.createServer((socket) => {
        sockets.add(socket);
        socket.on('error', () => {});
        socket.on('close', () => sockets.delete(socket));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const close = () => new Promise((resolve) => {
        open_servers.delete(close);
        for (const socket of sockets) socket.destroy();
        server.close(resolve);
    });
    open_servers.add(close);
    return { url: `http://127.0.0.1:${server.address().port}`, close };
}

// An HTTP server driven by `handler(req, res, body)`.
export async function httpServer(handler) {
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => handler(req, res, body));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const close = () => new Promise((resolve) => {
        open_servers.delete(close);
        server.closeAllConnections();
        server.close(resolve);
    });
    open_servers.add(close);
    return { url: `http://127.0.0.1:${server.address().port}`, close };
}

// Collects everything written with console.error / console.log / console.warn while fn runs.
export async function captureConsole(fn) {
    const lines = [];
    const original = { error: console.error, log: console.log, warn: console.warn };
    for (const level of Object.keys(original)) {
        console[level] = (...args) => lines.push(args.map(String).join(' '));
    }
    try {
        const result = await fn();
        return { result, lines };
    } finally {
        Object.assign(console, original);
    }
}

// The JSON lines among captured console lines that describe a model failure.
export function modelFailureLines(lines) {
    const records = [];
    for (const line of lines) {
        try {
            const record = JSON.parse(line);
            if (record && record.event === 'model_failure') records.push(record);
        } catch { /* not a JSON line */ }
    }
    return records;
}
