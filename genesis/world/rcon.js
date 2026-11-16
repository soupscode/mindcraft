// Genesis: a small RCON client, for the world bootstrap (genesis/world/bootstrap.js).
//
// NOT RUN AGAINST A REAL MINECRAFT SERVER. The packet format below is the Source RCON
// protocol as Minecraft's server speaks it; the tests check the bytes against that
// description and drive the client with an in-memory socket. Nothing here has ever talked
// to a real server.
//
// A packet, all integers little-endian and signed 32 bit:
//   size   the number of bytes that follow (id + type + body + two zero bytes)
//   id     chosen by the client; the answer carries the same id (-1: the password was refused)
//   type   3 log in (the body is the password)   2 run a command, and the answer to a log in
//          0 the answer to a command
//   body   text, ended by one zero byte, followed by one more zero byte
// A request body may be at most 1446 bytes (Minecraft's limit). An answer longer than 4096
// bytes comes in several packets with the same id; a body shorter than that ends the answer.
//
// Injected: connect({ host, port }) -> a socket with write(buffer), on('data' | 'error' |
// 'close', fn) and end() / destroy() (node:net's createConnection is the real one), and the
// clock for the time-outs.
// Depends only on Node built-ins.

import net from 'node:net';

export const RCON_TYPES = Object.freeze({ response: 0, command: 2, auth_response: 2, auth: 3 });
export const RCON_LIMITS = Object.freeze({ request_body: 1446, response_body: 4096, packet: 4110 });
export const RCON_DEFAULT_PORT = 25575;

// The bytes of one packet.
export function encodePacket(id, type, body = '') {
    const text = Buffer.from(String(body), 'utf8');
    const packet = Buffer.alloc(4 + 4 + 4 + text.length + 2);
    packet.writeInt32LE(4 + 4 + text.length + 2, 0);
    packet.writeInt32LE(id, 4);
    packet.writeInt32LE(type, 8);
    text.copy(packet, 12);
    return packet; // the two zero bytes are already there
}

// Takes the whole packets off the front of what has been received.
// Returns { packets: [{ id, type, body }], rest } where `rest` is the bytes of a packet that
// has not arrived completely yet. Throws on a size no RCON packet can have.
export function decodePackets(buffer) {
    const packets = [];
    let at = 0;
    while (buffer.length - at >= 4) {
        const size = buffer.readInt32LE(at);
        if (size < 10 || size > RCON_LIMITS.packet) throw new Error(`RCON: a packet says it is ${size} bytes long, which no RCON packet is`);
        if (buffer.length - at - 4 < size) break;
        const id = buffer.readInt32LE(at + 4);
        const type = buffer.readInt32LE(at + 8);
        const body = buffer.subarray(at + 12, at + 4 + size - 2);
        packets.push({ id, type, body: body.toString('utf8'), bytes: body.length });
        at += 4 + size;
    }
    return { packets, rest: buffer.subarray(at) };
}

// Section signs and the colour letter after them, which a Bukkit server may put into an answer.
export const stripFormatting = (text) => String(text ?? '').replace(/§[0-9a-fk-orx]/gi, '');

export function createRconClient({
    host, port = RCON_DEFAULT_PORT, password, connect = (target) => net.createConnection(target),
    clock = { setTimeout, clearTimeout }, timeout_ms = 10000,
} = {}) {
    let socket = null;
    let received = Buffer.alloc(0);
    let next_id = 1;
    let waiting = null;   // { id, auth, parts, resolve, reject, timer }
    let closed_reason = null;
    let chain = Promise.resolve(); // one request at a time: Minecraft answers them in order
    const stats = { sent: 0, received: 0 };

    function fail(err) {
        closed_reason ??= err;
        const pending = waiting;
        waiting = null;
        if (pending) { clock.clearTimeout(pending.timer); pending.reject(err); }
    }

    function onData(chunk) {
        let decoded;
        try {
            decoded = decodePackets(Buffer.concat([received, chunk]));
        } catch (err) {
            fail(err);
            try { socket.destroy(); } catch { /* already gone */ }
            return;
        }
        received = Buffer.from(decoded.rest);
        for (const packet of decoded.packets) {
            stats.received++;
            if (!waiting) continue; // an answer nobody waits for
            if (waiting.auth) {
                // the answer to a log in: the same id means yes, -1 means the password was refused.
                // (Some servers send an empty type 0 packet first: that one is passed over.)
                if (packet.type !== RCON_TYPES.auth_response) continue;
                const pending = waiting;
                waiting = null;
                clock.clearTimeout(pending.timer);
                if (packet.id === pending.id) pending.resolve('');
                else pending.reject(new Error('RCON: the server refused the password'));
                continue;
            }
            if (packet.id !== waiting.id) continue;
            waiting.parts.push(packet.body);
            if (packet.bytes >= RCON_LIMITS.response_body) continue; // a full packet: more of the answer follows
            const pending = waiting;
            waiting = null;
            clock.clearTimeout(pending.timer);
            pending.resolve(stripFormatting(pending.parts.join('')));
        }
    }

    function request(type, body, auth) {
        return new Promise((resolve, reject) => {
            if (!socket || closed_reason) { reject(closed_reason ?? new Error('RCON: not connected')); return; }
            if (Buffer.byteLength(body, 'utf8') > RCON_LIMITS.request_body) {
                reject(new Error(`RCON: the command is longer than ${RCON_LIMITS.request_body} bytes`));
                return;
            }
            const id = next_id++;
            if (next_id > 0x7ffffff0) next_id = 1;
            const timer = clock.setTimeout(() => {
                if (waiting?.id !== id) return;
                waiting = null;
                reject(new Error(`RCON: no answer within ${timeout_ms} ms`));
            }, timeout_ms);
            waiting = { id, auth, parts: [], resolve, reject, timer };
            try {
                socket.write(encodePacket(id, type, body));
                stats.sent++;
            } catch (err) {
                waiting = null;
                clock.clearTimeout(timer);
                reject(err);
            }
        });
    }

    const inTurn = (work) => {
        const turn = chain.then(work, work);
        chain = turn.catch(() => {});
        return turn;
    };

    return {
        // Connects and logs in. Rejects when the server cannot be reached or refuses the password.
        async connect() {
            if (typeof password !== 'string' || password.length === 0) throw new Error('RCON: no password given');
            closed_reason = null;
            received = Buffer.alloc(0);
            socket = connect({ host, port });
            socket.on('data', onData);
            socket.on('error', (err) => fail(new Error(`RCON: ${err?.message ?? err}`)));
            socket.on('close', () => fail(new Error('RCON: the connection was closed')));
            await inTurn(() => request(RCON_TYPES.auth, password, true));
        },
        // Runs one command and resolves to the server's answer as text.
        send: (command) => inTurn(() => request(RCON_TYPES.command, String(command), false)),
        end() {
            closed_reason ??= new Error('RCON: the connection was ended');
            try { socket?.end(); } catch { /* already gone */ }
            try { socket?.destroy?.(); } catch { /* already gone */ }
        },
        stats: () => ({ ...stats }),
    };
}
