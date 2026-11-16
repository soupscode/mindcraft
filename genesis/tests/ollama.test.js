// Step 2: the Ollama client rejects with typed errors and never returns placeholder text.
// Run from the repository root:  node --test genesis/tests/*.test.js
// Needs no installed dependencies.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { Ollama } from '../../src/models/ollama.js';
import {
    ModelError, ModelUnavailableError, ModelTimeoutError, ModelInvalidResponseError,
} from '../lib/model_errors.js';
import { refusedPort, silentServer, httpServer, captureConsole, closeAllServers } from './helpers/stubs.mjs';

// a regression (for example a lost timeout) must fail the run, not hang it
const LIMIT = { timeout: 15000 };
after(closeAllServers);

const TURNS = [{ role: 'user', content: 'steve: hello' }];
const PLACEHOLDERS = ['No response data', 'My brain disconnected', 'I thought too hard'];

// Runs a call that must fail. Returns the error and how long it took.
async function failure(promise_fn) {
    const started = Date.now();
    let error = null;
    let value;
    const { lines } = await captureConsole(async () => {
        try { value = await promise_fn(); } catch (err) { error = err; }
    });
    assert.ok(error, `expected a rejection, got the value ${JSON.stringify(value)}`);
    for (const text of PLACEHOLDERS) {
        assert.ok(!String(error.message).includes(text), `error message holds placeholder text: ${error.message}`);
        assert.ok(!lines.join('\n').includes(text), 'console output holds placeholder text');
    }
    return { error, elapsed: Date.now() - started };
}

test('connection refused: chat request rejects with ModelUnavailableError', LIMIT, async () => {
    const port = await refusedPort();
    const model = new Ollama('test-model', `http://127.0.0.1:${port}`, { request_timeout_ms: 2000 });
    const { error, elapsed } = await failure(() => model.sendRequest(TURNS, 'system'));
    assert.ok(error instanceof ModelUnavailableError, `got ${error.name}: ${error.message}`);
    assert.ok(error instanceof ModelError);
    assert.equal(error.name, 'ModelUnavailableError');
    assert.equal(error.provider, 'ollama');
    assert.equal(error.model, 'test-model');
    assert.ok(elapsed < 2000, `took ${elapsed} ms`);
});

test('connection refused: embedding request rejects with ModelUnavailableError', LIMIT, async () => {
    const port = await refusedPort();
    const model = new Ollama('embed-model', `http://127.0.0.1:${port}`, { request_timeout_ms: 2000 });
    const { error } = await failure(() => model.embed('some text'));
    assert.ok(error instanceof ModelUnavailableError, `got ${error.name}: ${error.message}`);
});

test('server never answers: chat request rejects with ModelTimeoutError within the timeout', LIMIT, async () => {
    const server = await silentServer();
    try {
        const model = new Ollama('test-model', server.url, { request_timeout_ms: 300 });
        const { error, elapsed } = await failure(() => model.sendRequest(TURNS, 'system'));
        assert.ok(error instanceof ModelTimeoutError, `got ${error.name}: ${error.message}`);
        assert.equal(error.timeout_ms, 300);
        assert.ok(elapsed >= 250, `rejected too early: ${elapsed} ms`);
        assert.ok(elapsed < 1500, `rejected too late: ${elapsed} ms`);
    } finally {
        await server.close();
    }
});

test('server never answers: embedding request rejects with ModelTimeoutError', LIMIT, async () => {
    const server = await silentServer();
    try {
        const model = new Ollama('embed-model', server.url, { request_timeout_ms: 300 });
        const { error, elapsed } = await failure(() => model.embed('some text'));
        assert.ok(error instanceof ModelTimeoutError, `got ${error.name}: ${error.message}`);
        assert.ok(elapsed < 1500, `rejected too late: ${elapsed} ms`);
    } finally {
        await server.close();
    }
});

test('headers arrive but the body stalls: still a ModelTimeoutError', LIMIT, async () => {
    const server = await httpServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write('{"message":'); // and nothing more
    });
    try {
        const model = new Ollama('test-model', server.url, { request_timeout_ms: 300 });
        const { error, elapsed } = await failure(() => model.sendRequest(TURNS, 'system'));
        assert.ok(error instanceof ModelTimeoutError, `got ${error.name}: ${error.message}`);
        assert.ok(elapsed < 1500, `rejected too late: ${elapsed} ms`);
    } finally {
        await server.close();
    }
});

test('HTTP 500: rejects with ModelUnavailableError carrying the status', LIMIT, async () => {
    const server = await httpServer((req, res) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end('{"error":"model runner has stopped"}');
    });
    try {
        const model = new Ollama('test-model', server.url, { request_timeout_ms: 2000 });
        const { error } = await failure(() => model.sendRequest(TURNS, 'system'));
        assert.ok(error instanceof ModelUnavailableError, `got ${error.name}: ${error.message}`);
        assert.equal(error.status, 500);
    } finally {
        await server.close();
    }
});

test('answer without message content: rejects with ModelInvalidResponseError', LIMIT, async () => {
    const server = await httpServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"done":true}');
    });
    try {
        const model = new Ollama('test-model', server.url, { request_timeout_ms: 2000 });
        const { error } = await failure(() => model.sendRequest(TURNS, 'system'));
        assert.ok(error instanceof ModelInvalidResponseError, `got ${error.name}: ${error.message}`);
    } finally {
        await server.close();
    }
});

test('answer that never finishes its <think> block: rejects after the retries', LIMIT, async () => {
    let calls = 0;
    const server = await httpServer((req, res) => {
        calls++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: { content: '<think>still thinking' } }));
    });
    try {
        const model = new Ollama('test-model', server.url, { request_timeout_ms: 2000 });
        const { error } = await failure(() => model.sendRequest(TURNS, 'system'));
        assert.ok(error instanceof ModelInvalidResponseError, `got ${error.name}: ${error.message}`);
        assert.equal(calls, 5);
    } finally {
        await server.close();
    }
});

test('empty embedding: rejects with ModelInvalidResponseError', LIMIT, async () => {
    const server = await httpServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"embedding":[]}');
    });
    try {
        const model = new Ollama('embed-model', server.url, { request_timeout_ms: 2000 });
        const { error } = await failure(() => model.embed('some text'));
        assert.ok(error instanceof ModelInvalidResponseError, `got ${error.name}: ${error.message}`);
    } finally {
        await server.close();
    }
});

test('a healthy server still works, and the timeout option is not sent to Ollama', LIMIT, async () => {
    let seen = null;
    const server = await httpServer((req, res, body) => {
        seen = { url: req.url, body: JSON.parse(body) };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: { content: '<think>plan</think>Hello there' } }));
    });
    try {
        const model = new Ollama('test-model', server.url, { request_timeout_ms: 2000, temperature: 0.5 });
        const { result } = await captureConsole(() => model.sendRequest(TURNS, 'system'));
        assert.equal(result, 'Hello there');
        assert.equal(seen.url, '/api/chat');
        assert.equal(seen.body.model, 'test-model');
        assert.equal(seen.body.temperature, 0.5);
        assert.ok(!('request_timeout_ms' in seen.body), 'request_timeout_ms leaked into the request body');
    } finally {
        await server.close();
    }
});

test('the default timeout is 90 seconds', () => {
    assert.equal(new Ollama('m', 'http://127.0.0.1:1').timeout_ms, 90000);
    assert.equal(new Ollama('m', 'http://127.0.0.1:1', { request_timeout_ms: 0 }).timeout_ms, 90000);
    assert.equal(new Ollama('m', 'http://127.0.0.1:1', { request_timeout_ms: 9000 }).timeout_ms, 9000);
});
