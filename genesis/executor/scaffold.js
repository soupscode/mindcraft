// Genesis: keeps track of the blocks an agent put down while walking (scaffolding).
// Scaffolding is allowed. But a scaffold block the agent placed inside the camp, the field
// or a plot has to be taken away again by that agent before the step it was placed in
// counts as done. Blocks placed outside those zones are not tracked: they may stay.
//
//   begin(intend)   a step starts; `intend` lists the cells the step places on purpose
//                   (the cells of a blueprint), which are not scaffolding
//   placed(pos)     the bot placed a block there (called for every block the bot places:
//                   genesis/lib/bot_guards.js reports them)
//   left(view)      the tracked blocks that are still standing, as [{x,y,z}]
//   snapshot() / restore()   the list goes into the checkpoint, so a restart does not forget it
//
// zones: { isProtected(pos) }   (genesis/catalog/zones.js)
// No imports.

const key = (pos) => `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
const EMPTY = new Set(['air', 'cave_air', 'void_air', 'water', 'lava']);

export function createScaffoldTracker({ zones } = {}) {
    const tracked = new Map(); // key -> { x, y, z }
    let intended = new Set();

    return {
        begin(intend = []) {
            intended = new Set((intend ?? []).map(key));
        },
        placed(pos) {
            if (!pos || ![pos.x, pos.y, pos.z].every(Number.isFinite)) return false;
            const cell = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) };
            if (intended.has(key(cell))) return false;
            if (!zones.isProtected(cell)) return false;
            tracked.set(key(cell), cell);
            return true;
        },
        // Forgets the tracked blocks that are gone and returns the ones still standing.
        // A cell that cannot be read (not loaded) counts as still standing.
        left(view) {
            const standing = [];
            for (const [id, cell] of tracked) {
                const block = view.blockAt(cell);
                if (block && EMPTY.has(block.name)) tracked.delete(id);
                else standing.push({ ...cell });
            }
            return standing;
        },
        count: () => tracked.size,
        snapshot: () => [...tracked.values()].map((cell) => [cell.x, cell.y, cell.z]),
        restore(snapshot) {
            tracked.clear();
            for (const entry of Array.isArray(snapshot) ? snapshot : []) {
                if (Array.isArray(entry) && entry.length === 3 && entry.every(Number.isFinite)) {
                    const cell = { x: entry[0], y: entry[1], z: entry[2] };
                    tracked.set(key(cell), cell);
                }
            }
        },
    };
}
