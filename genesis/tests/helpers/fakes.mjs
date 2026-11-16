// In-memory stand-ins for the things Genesis reaches through injected interfaces:
// Redis streams, the clock, files and the stores. Node built-ins only, no network.

// Lets every promise that can settle without a timer do so.
export async function settle(rounds = 10) {
    for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
}

// A clock that only moves when the test says so. Has the shape the broker, the stores and
// the event hub take: now(), setTimeout(fn, ms), clearTimeout(handle).
export function fakeClock(start = Date.parse('2026-01-01T00:00:00.000Z')) {
    let now = start;
    let next_id = 1;
    const timers = new Map();
    return {
        now: () => now,
        setTimeout(fn, ms) {
            const id = next_id++;
            timers.set(id, { id, at: now + Math.max(0, Number(ms) || 0), fn });
            return id;
        },
        clearTimeout(id) { timers.delete(id); },
        pending: () => timers.size,
        // Moves time forward by ms. Timers that come due run in order, and promises get the
        // chance to settle before and after each of them.
        async advance(ms) {
            const target = now + ms;
            for (;;) {
                await settle();
                const due = [...timers.values()].filter((t) => t.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
                if (!due) break;
                timers.delete(due.id);
                now = Math.max(now, due.at);
                due.fn();
            }
            now = target;
            await settle();
        },
    };
}

// Redis streams behind the event hub's interface: xadd(stream, fields, { maxlen }).
// Set `failing` to make every write reject, `hanging` to make writes never answer.
export function fakeRedis() {
    const streams = new Map();
    const fake = {
        failing: false,
        hanging: false,
        calls: 0,
        streams,
        async xadd(stream, fields, { maxlen } = {}) {
            fake.calls++;
            if (fake.hanging) return new Promise(() => {});
            if (fake.failing) throw new Error('connect ECONNREFUSED (the fake Redis is down)');
            for (const [key, value] of Object.entries(fields)) {
                if (typeof value !== 'string') throw new Error(`field ${key} is not a string`);
            }
            if (!streams.has(stream)) streams.set(stream, []);
            const entries = streams.get(stream);
            const id = `${entries.length + 1}-0`;
            entries.push({ id, fields: { ...fields } });
            if (Number.isInteger(maxlen) && entries.length > maxlen) entries.splice(0, entries.length - maxlen);
            return id;
        },
        // The events written to a stream, oldest first.
        events(stream = 'genesis:events') {
            return (streams.get(stream) ?? []).map((entry) => JSON.parse(entry.fields.event));
        },
    };
    return fake;
}

// Files behind the checkpoint store's interface: write, rename, read, remove.
//   fail_write / fail_rename / fail_read: an Error to throw on the next call of that kind (then cleared)
//   partial_write: true makes the next write leave half the text behind and then fail (a full disk, a crash)
export function fakeFiles() {
    const store = new Map();
    const fake = {
        store,
        log: [],
        fail_write: null, fail_rename: null, fail_read: null, partial_write: false,
        async write(file, text) {
            fake.log.push(['write', file]);
            if (fake.partial_write) {
                fake.partial_write = false;
                store.set(file, text.slice(0, Math.floor(text.length / 2)));
                throw new Error('ENOSPC: no space left on device');
            }
            if (fake.fail_write) { const err = fake.fail_write; fake.fail_write = null; throw err; }
            store.set(file, text);
        },
        async rename(from, to) {
            fake.log.push(['rename', from, to]);
            if (fake.fail_rename) { const err = fake.fail_rename; fake.fail_rename = null; throw err; }
            if (!store.has(from)) throw new Error(`ENOENT: no such file, rename '${from}'`);
            store.set(to, store.get(from));
            store.delete(from);
        },
        async read(file) {
            if (fake.fail_read) { const err = fake.fail_read; fake.fail_read = null; throw err; }
            return store.has(file) ? store.get(file) : null;
        },
        async remove(file) {
            fake.log.push(['remove', file]);
            store.delete(file);
        },
    };
    return fake;
}

// The Postgres mirror of the checkpoints: save(checkpoint), load(agent).
export function fakeMirror() {
    const fake = {
        rows: new Map(), failing: false, saves: 0,
        async save(checkpoint) {
            fake.saves++;
            if (fake.failing) throw new Error('connection terminated (the fake Postgres is down)');
            fake.rows.set(checkpoint.agent, JSON.parse(JSON.stringify(checkpoint)));
        },
        async load(agent) {
            if (fake.failing) throw new Error('connection terminated (the fake Postgres is down)');
            return fake.rows.has(agent) ? JSON.parse(JSON.stringify(fake.rows.get(agent))) : null;
        },
    };
    return fake;
}

// The goal store's storage: load(agent), save(agent, goals, change).
export function fakeGoalStorage() {
    const fake = {
        goals: new Map(), changes: [], failing: false,
        async load(agent) {
            if (fake.failing) throw new Error('connection terminated (the fake Postgres is down)');
            return fake.goals.has(agent) ? JSON.parse(JSON.stringify(fake.goals.get(agent))) : null;
        },
        async save(agent, goals, change) {
            if (fake.failing) throw new Error('connection terminated (the fake Postgres is down)');
            fake.goals.set(agent, JSON.parse(JSON.stringify(goals)));
            fake.changes.push(JSON.parse(JSON.stringify(change)));
        },
    };
    return fake;
}

// A stand-in for a pg.Pool that records every statement and answers with the rows given.
export function recordingPool(rows = []) {
    const pool = {
        queries: [],
        async query(text, values = []) {
            pool.queries.push({ text, values });
            return { rows };
        },
    };
    return pool;
}
