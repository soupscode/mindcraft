// Fix 2: the address the MindServer listens on is a setting (mindserver_host).
// Upstream default: localhost only. Genesis: "0.0.0.0", so another container on the same
// Docker network can reach it, while the agents keep connecting through localhost.
//
// Uses the real src/mindcraft/mindserver.js and src/mindcraft/mindcraft.js with Node's real
// http server. express, socket.io and the agent process code are replaced by stand-ins.
// Run from the repository root:  node --test genesis/tests/*.test.js

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stubModules, captureConsole, REPO_ROOT } from './helpers/stubs.mjs';
import { MINDSERVER_HOSTS } from '../lib/config.js';

stubModules({
    'express': `
        export default function express() {
            const app = (req, res) => { res.statusCode = 200; res.end('mindserver stand-in'); };
            app.use = () => {};
            app.get = () => {};
            return app;
        }
        express.static = () => () => {};`,
    'socket.io': 'export class Server { constructor(server) { this.server = server; } on() {} emit() {} }',
    'open': 'export default function open() { throw new Error("the browser must not be opened in a test"); }',
    'src/process/agent_process.js': 'export class AgentProcess {}',
    'src/mindcraft/mcserver.js': 'export async function getServer() { throw new Error("not used"); }',
});

const { createMindServer, getServer } = await import('../../src/mindcraft/mindserver.js');
const Mindcraft = await import('../../src/mindcraft/mindcraft.js');

const LIMIT = { timeout: 15000 };
const LOOPBACK = ['127.0.0.1', '::1'];
const servers = new Set();
after(() => { for (const server of servers) { server.closeAllConnections(); server.close(); } });

// Starts the real MindServer on a free port. Returns the address it is bound to.
async function listen(...host_args) {
    const { result: server, lines } = await captureConsole(async () => {
        const started = createMindServer(false, 0, ...host_args);
        servers.add(started);
        await once(started, 'listening');
        return started;
    });
    return { ...server.address(), lines };
}

async function reachable(url) {
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
        return res.status === 200;
    } catch {
        return false;
    }
}

// An address of this machine that is not loopback: what another container would connect to.
const outside_address = Object.values(os.networkInterfaces()).flat()
    .find((entry) => entry && entry.family === 'IPv4' && !entry.internal)?.address;

test('upstream default: listens on localhost only', LIMIT, async (t) => {
    for (const args of [[], [undefined], [null], ['']]) {
        const bound = await listen(...args);
        assert.ok(LOOPBACK.includes(bound.address), `${JSON.stringify(args)}: bound to ${bound.address}`);
        assert.ok(await reachable(`http://localhost:${bound.port}/`));
        if (outside_address) {
            assert.equal(await reachable(`http://${outside_address}:${bound.port}/`), false, 'reachable from outside');
        }
    }
    if (!outside_address) t.diagnostic('no non-loopback IPv4 address here: "not reachable from outside" was not checked');
});

test('mindserver_host "0.0.0.0": every interface, and localhost still connects', LIMIT, async (t) => {
    const bound = await listen('0.0.0.0');
    assert.equal(bound.address, '0.0.0.0');
    assert.ok(bound.lines.some((line) => line.includes('on host 0.0.0.0')), bound.lines.join('\n'));
    // the address the agents use (src/agent/mindserver_proxy.js)
    assert.ok(await reachable(`http://localhost:${bound.port}/`));
    assert.ok(await reachable(`http://127.0.0.1:${bound.port}/`));
    if (outside_address) {
        assert.ok(await reachable(`http://${outside_address}:${bound.port}/`), `not reachable through ${outside_address}`);
    } else {
        t.diagnostic('no non-loopback IPv4 address here: "reachable from outside" was not checked');
    }
});

test('Mindcraft.init hands the host to the MindServer', LIMIT, async () => {
    await captureConsole(async () => {
        await Mindcraft.init(false, 0, false, '0.0.0.0');
        servers.add(getServer());
        await once(getServer(), 'listening');
    });
    assert.equal(getServer().address().address, '0.0.0.0');
});

test('agents still connect through localhost, which every host Genesis accepts serves', LIMIT, async () => {
    // The launcher only accepts loopback and wildcard addresses because of this line.
    // If upstream changes how agents connect, MINDSERVER_HOSTS in genesis/lib/config.js needs another look.
    const proxy = readFileSync(path.join(REPO_ROOT, 'src', 'agent', 'mindserver_proxy.js'), 'utf8');
    assert.ok(proxy.includes('io(`http://localhost:${port}`)'), 'mindserver_proxy.js no longer connects to localhost');
    assert.deepEqual(MINDSERVER_HOSTS, ['localhost', '127.0.0.1', '::1', '0.0.0.0', '::']);
});
