// Genesis: keeps track of the blocks an agent put down while walking (scaffolding).
// Scaffolding is allowed. But a scaffold block the agent placed inside the camp, the field
// or a plot has to be taken away again by that agent before the step it was placed in
// counts as done. Blocks placed outside those zones are not tracked: they may stay.
//
// Decided: a torch placed by upstream's idle torch reflex is EXEMPT. It may stay inside the
// camp, the field and the plots, and is never tracked or taken away. Every other block the
// agent puts down in a zone is still cleaned up. (A reflex torch that stands where a
// blueprint wants something else does not block the build: genesis/catalog/defaults.js
// lists torches among what a plot may be cleared of.)
//
//   begin(intend)   a step starts; `intend` lists the cells the step places on purpose
//                   (the cells of a blueprint), which are not scaffolding
//   placed(pos, what)   the bot placed a block there (called for every block the bot places:
//                   genesis/lib/bot_guards.js reports them). what.reflex_torch: true for a torch
//                   of the idle torch reflex (isReflexTorch below), which is not tracked
//   left(view)      the tracked blocks that are still standing, as [{x,y,z}]
//   snapshot() / restore()   the list goes into the checkpoint, so a restart does not forget it
//
// zones: { isProtected(pos) }   (genesis/catalog/zones.js)
// No imports.

const key = (pos) => `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
const EMPTY = new Set(['air', 'cave_air', 'void_air', 'water', 'lava']);

// Upstream's idle torch reflex: the "torch_placing" mode (src/agent/modes.js lines 226-242)
// places a torch at the bot's feet through skills.placeBlock (modes.js line 238), and every
// mode runs under the action label `mode:<name>` (modes.js line 317; the action manager keeps
// it in currentActionLabel while the action runs, src/agent/action_manager.js line 101).
export const TORCH_REFLEX_ACTION = 'mode:torch_placing';
export const REFLEX_TORCH_ITEM = 'torch';

// Is a block the bot placed a torch of the idle torch reflex?
//   item    what the bot held when it placed the block     action   the label of the action that was running
export const isReflexTorch = ({ item = null, action = null } = {}) => action === TORCH_REFLEX_ACTION && item === REFLEX_TORCH_ITEM;

// What genesis/lib/bot_guards.js is given as `onPlace` for a real agent: every block the bot
// places goes to the tracker, marked when it is a torch of the idle torch reflex.
//   currentAction() -> the label of the action the bot is carrying out right now
export function placementSink(tracker, currentAction = () => null) {
    return (pos, placed = {}) => {
        let action = null;
        try { action = currentAction(); } catch { /* no label: nothing is exempt */ }
        return tracker.placed(pos, { reflex_torch: isReflexTorch({ item: placed?.item ?? null, action }) });
    };
}

export function createScaffoldTracker({ zones } = {}) {
    const tracked = new Map(); // key -> { x, y, z }
    let intended = new Set();
    let exempted = 0;          // reflex torches placed inside a zone, which may stay

    return {
        begin(intend = []) {
            intended = new Set((intend ?? []).map(key));
        },
        placed(pos, { reflex_torch = false } = {}) {
            if (!pos || ![pos.x, pos.y, pos.z].every(Number.isFinite)) return false;
            const cell = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) };
            if (intended.has(key(cell))) return false;
            if (!zones.isProtected(cell)) return false;
            if (reflex_torch === true) { exempted++; return false; } // decided: a reflex torch may stay
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
        // how many reflex torches were placed inside a zone and left there
        exempted: () => exempted,
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
