// The RCON client of the world bootstrap (genesis/world/rcon.js): the packet bytes, logging
// in, commands and their answers, and what happens when the server is slow, wrong or gone.
//
// NOTHING HERE TALKS TO A REAL MINECRAFT SERVER. The bytes are checked against the Source
// RCON packet layout written out by hand below; the "server" is an in-memory socket.
// Run from the repository root:  node --test genesis/tests/*.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeClock, settle } from './helpers/fakes.mjs';
import { encodePacket, decodePackets, createRconClient, stripFormatting, RCON_TYPES, RCON_LIMITS, RCON_DEFAULT_PORT } from '../world/rcon.js';

// An in-memory socket and the server behind it. `answer(packet)` returns the packets to send back.
function fakeServer({ password = 'secret', answer = null } = {}) {
    const server = { received: [], targets: [], socket: null, written: Buffer.alloc(0) };
    server.connect = (target) => {
        server.targets.push(target);
        const handlers = {};
        const socket = {
            destroyed: false,
            on(name, fn) { handlers[name] = fn; return socket; },
            write(buffer) {
                const { packets, rest } = decodePackets(Buffer.concat([server.written, buffer]));
                server.written = Buffer.from(rest);
                for (const packet of packets) {
                    server.received.push(packet);
                    let replies;
                    if (packet.type === RCON_TYPES.auth) replies = [encodePacket(packet.body === password ? packet.id : -1, RCON_TYPES.auth_response, '')];
                    else replies = (answer ?? ((p) => [encodePacket(p.id, RCON_TYPES.response, `ran: ${p.body}`)]))(packet);
                    for (const reply of replies ?? []) queueMicrotask(() => handlers.data?.(reply));
                }
            },
            end() { socket.destroyed = true; },
            destroy() { socket.destroyed = true; },
            fire: (name, value) => handlers[name]?.(value),
        };
        server.socket = socket;
        return socket;
    };
    return server;
}

test('rcon packets: the bytes are the Source RCON layout (size, id, type, text, two zero bytes; little-endian)', () => {
    // "seed" as command 7:  size = 4 (id) + 4 (type) + 4 (text) + 2 = 14
    const packet = encodePacket(7, RCON_TYPES.command, 'seed');
    assert.deepEqual([...packet], [
        14, 0, 0, 0,            // size
        7, 0, 0, 0,             // id
        2, 0, 0, 0,             // type 2: run a command
        0x73, 0x65, 0x65, 0x64, // "seed"
        0, 0,
    ]);
    assert.deepEqual([...encodePacket(1, RCON_TYPES.auth, 'pw')], [12, 0, 0, 0, 1, 0, 0, 0, 3, 0, 0, 0, 0x70, 0x77, 0, 0]);
    assert.deepEqual({ ...RCON_TYPES }, { response: 0, command: 2, auth_response: 2, auth: 3 });
    assert.equal(RCON_DEFAULT_PORT, 25575);
    // a refused log in comes back with id -1
    const refused = decodePackets(Buffer.from([10, 0, 0, 0, 0xff, 0xff, 0xff, 0xff, 2, 0, 0, 0, 0, 0])).packets[0];
    assert.deepEqual([refused.id, refused.type, refused.body], [-1, 2, '']);
    // several packets in one read, and a packet cut in two
    const both = Buffer.concat([encodePacket(1, 0, 'Test passed'), encodePacket(2, 0, 'Seed: [42]')]);
    assert.deepEqual(decodePackets(both).packets.map((p) => [p.id, p.body]), [[1, 'Test passed'], [2, 'Seed: [42]']]);
    const cut = decodePackets(both.subarray(0, both.length - 5));
    assert.deepEqual(cut.packets.map((p) => p.id), [1]);
    assert.deepEqual(decodePackets(Buffer.concat([cut.rest, both.subarray(both.length - 5)])).packets.map((p) => p.body), ['Seed: [42]']);
    assert.equal(decodePackets(Buffer.from([1, 2])).packets.length, 0, 'not even a size yet');
    assert.throws(() => decodePackets(Buffer.from([0xff, 0xff, 0xff, 0x7f, 0, 0, 0, 0])), /no RCON packet is/);
    assert.throws(() => decodePackets(Buffer.from([3, 0, 0, 0, 0, 0, 0])), /no RCON packet is/);
    // text beyond ASCII keeps its bytes
    assert.equal(decodePackets(encodePacket(3, 0, 'Bäcker §a')).packets[0].body, 'Bäcker §a');
    assert.equal(stripFormatting('§aTest passed§r'), 'Test passed');
});

test('rcon client: logs in with the password first, then runs commands one at a time and returns their answers', async () => {
    const server = fakeServer();
    const rcon = createRconClient({ host: '192.0.2.7', port: 25575, password: 'secret', connect: server.connect, clock: fakeClock() });
    await rcon.connect();
    assert.deepEqual(server.targets, [{ host: '192.0.2.7', port: 25575 }]);
    assert.deepEqual(server.received.map((p) => [p.type, p.body]), [[3, 'secret']]);

    const answers = await Promise.all([rcon.send('seed'), rcon.send('difficulty'), rcon.send('worldborder get')]);
    assert.deepEqual(answers, ['ran: seed', 'ran: difficulty', 'ran: worldborder get']);
    assert.deepEqual(server.received.slice(1).map((p) => [p.type, p.body]), [[2, 'seed'], [2, 'difficulty'], [2, 'worldborder get']]);
    const ids = server.received.map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length, 'two requests shared an id');
    assert.deepEqual(rcon.stats(), { sent: 4, received: 4 });
    rcon.end();
    assert.equal(server.socket.destroyed, true);
    await assert.rejects(rcon.send('seed'), /RCON: the connection was ended/);
});

test('rcon client: a refused password, a missing password and an unreachable server are errors, not hangs', async () => {
    const server = fakeServer({ password: 'the real one' });
    const wrong = createRconClient({ host: 'h', password: 'a guess', connect: server.connect, clock: fakeClock() });
    await assert.rejects(wrong.connect(), /RCON: the server refused the password/);
    await assert.rejects(createRconClient({ host: 'h', password: '', connect: server.connect }).connect(), /RCON: no password given/);
    assert.equal(server.targets.length, 1, 'a connection was opened without a password');

    // nothing listens: the socket reports an error
    const dead = { connect: () => { const handlers = {}; const socket = { on(name, fn) { handlers[name] = fn; return socket; }, write() { queueMicrotask(() => handlers.error?.(new Error('connect ECONNREFUSED'))); }, end() {}, destroy() {} }; return socket; } };
    await assert.rejects(createRconClient({ host: 'h', password: 'x', connect: dead.connect, clock: fakeClock() }).connect(), /RCON: connect ECONNREFUSED/);

    // a server that accepts the connection and never answers: the time-out ends the wait
    const clock = fakeClock();
    const silent = createRconClient({ host: 'h', password: 'x', connect: () => ({ on() {}, write() {}, end() {}, destroy() {} }), clock, timeout_ms: 5000 });
    const waiting = assert.rejects(silent.connect(), /RCON: no answer within 5000 ms/);
    await clock.advance(5000);
    await waiting;
});

test('rcon client: a long answer arrives in several packets, and a packet may arrive in pieces', async () => {
    const long = 'x'.repeat(RCON_LIMITS.response_body) + 'y'.repeat(RCON_LIMITS.response_body) + 'the end';
    const server = fakeServer({
        answer(packet) {
            if (packet.body !== 'data get block 8 64 4 Items') return [encodePacket(packet.id, 0, '§aTest passed')];
            const whole = Buffer.concat([0, 1, 2].map((part) => encodePacket(packet.id, 0, long.slice(part * RCON_LIMITS.response_body, (part + 1) * RCON_LIMITS.response_body))));
            // delivered in odd pieces, as a network would
            return [whole.subarray(0, 3), whole.subarray(3, 5000), whole.subarray(5000, 5001), whole.subarray(5001)];
        },
    });
    const rcon = createRconClient({ host: 'h', password: 'secret', connect: server.connect, clock: fakeClock() });
    await rcon.connect();
    assert.equal(await rcon.send('data get block 8 64 4 Items'), long);
    assert.equal(await rcon.send('execute if block 0 64 0 minecraft:chest'), 'Test passed', 'colour codes of a Bukkit server were left in');

    // a command the server would cut off is not sent at all
    await assert.rejects(rcon.send('x'.repeat(RCON_LIMITS.request_body + 1)), /longer than 1446 bytes/);
    assert.equal(server.received.length, 3);

    // the connection drops while an answer is awaited: the command fails, and so does the next
    const dropping = fakeServer({ answer: () => [] });
    const lost = createRconClient({ host: 'h', password: 'secret', connect: dropping.connect, clock: fakeClock() });
    await lost.connect();
    const pending = assert.rejects(lost.send('seed'), /RCON: the connection was closed/);
    await settle();
    dropping.socket.fire('close');
    await pending;
    await assert.rejects(lost.send('seed'), /RCON: the connection was closed/);

    // garbage instead of packets ends the connection with an error
    const garbage = fakeServer({ answer: () => [Buffer.from([0xff, 0xff, 0xff, 0x7f, 1, 2, 3, 4])] });
    const confused = createRconClient({ host: 'h', password: 'secret', connect: garbage.connect, clock: fakeClock() });
    await confused.connect();
    await assert.rejects(confused.send('seed'), /no RCON packet is/);
    assert.equal(garbage.socket.destroyed, true);
});
