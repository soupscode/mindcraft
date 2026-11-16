// Genesis: two last lines of defence on the bot itself, for agents run by the executor.
//
//   1. Nothing in a protected zone (the camp, the field, a plot) is broken, whoever asks
//      the bot to dig, except the one cell the step that is running was allowed to break
//      (a mature crop, natural ground on the agent's own plot, the agent's own scaffold).
//      The templates and the pathing permit already see to that; this guard is for
//      whatever they did not think of.
//   2. Every block the bot places is reported, so scaffolding left inside a zone is known
//      and can be taken away again (genesis/executor/scaffold.js). mineflayer-pathfinder
//      places its scaffolding through bot.placeBlock(referenceBlock, faceVector)
//      (index.js of 2.4.5), the same call the skills use. The report says what the bot held
//      when it placed the block: onPlace(pos, { item }). That is how a torch of upstream's
//      idle torch reflex is told from scaffolding (decided: such a torch may stay).
//
// installBotGuards(bot, { zones, onPlace }) wraps bot.dig and bot.placeBlock once.
// Depends only on the bot it is given.

const guarded = new WeakMap();

const same = (a, b) => Math.floor(a.x) === Math.floor(b.x) && Math.floor(a.y) === Math.floor(b.y) && Math.floor(a.z) === Math.floor(b.z);

export function installBotGuards(bot, { zones, onPlace = () => {} } = {}) {
    if (guarded.has(bot)) return guarded.get(bot);
    if (typeof bot?.dig !== 'function' || typeof bot?.placeBlock !== 'function') {
        throw new Error('genesis: bot.dig or bot.placeBlock is missing, the zone guard cannot be installed');
    }
    const stats = { digs_refused: 0, digs_allowed_in_zone: 0, placed: 0 };
    let allowed = null; // the one cell the running step may break inside a zone
    const dig = bot.dig.bind(bot);
    const placeBlock = bot.placeBlock.bind(bot);

    bot.dig = async function guardedDig(block, ...rest) {
        const position = block?.position;
        const zone = position ? zones.protectedAt(position) : null;
        if (zone !== null) {
            if (!allowed || !same(allowed, position)) {
                stats.digs_refused++;
                const err = new Error(`genesis: not breaking ${block.name ?? 'a block'} at ${position.x}, ${position.y}, ${position.z}: it is inside the ${zone}`);
                err.name = 'ProtectedZone';
                throw err;
            }
            stats.digs_allowed_in_zone++;
        }
        return dig(block, ...rest);
    };

    bot.placeBlock = async function trackedPlaceBlock(reference, face, ...rest) {
        // read before the block is placed: the last item of a stack is gone from the hand afterwards
        let item = null;
        try { item = bot.heldItem?.name ?? null; } catch { /* unknown: reported without a name */ }
        const result = await placeBlock(reference, face, ...rest);
        try {
            const at = reference.position;
            stats.placed++;
            onPlace({ x: at.x + (face?.x ?? 0), y: at.y + (face?.y ?? 0), z: at.z + (face?.z ?? 0) }, { item });
        } catch { /* reporting must not turn a placed block into an error */ }
        return result;
    };

    const guards = {
        // pos: { x, y, z } of the cell the running step may break inside a zone, or null (none)
        allowBreak(pos) { allowed = pos ? { x: pos.x, y: pos.y, z: pos.z } : null; },
        stats: () => ({ ...stats }),
    };
    guarded.set(bot, guards);
    return guards;
}
