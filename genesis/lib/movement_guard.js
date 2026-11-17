// Genesis: no movement packet with a value that is not a finite number ever leaves the bot.
//
// Found on the first real run (Paper 1.21.6): agents were kicked seconds to minutes after
// they spawned, the server log saying "<name> lost connection: Invalid move player packet
// received". A Minecraft server ends the connection when a movement packet carries a
// position or a rotation that is NaN or infinite. Where the NaN came from: upstream's
// idle_staring mode (src/agent/modes.js) looks at the nearest entity with
//     bot.lookAt(entity.position.offset(0, entity.height, 0))
// and mineflayer gives an entity it does not know (lib/plugins/entities.js, "unknown
// entity", and an entity it only heard of through another packet) no height. undefined
// makes the point NaN, bot.lookAt makes the pitch NaN (lib/plugins/physics.js), and the
// next movement packet carries it.
//
// Three places are guarded, so that any other source of such a value is stopped as well:
//   1. bot.look(yaw, pitch)   a yaw or pitch that is not finite is not taken
//   2. bot.lookAt(point)      a point that is not finite is not looked at
//   3. the packets themselves ("position", "position_look", "look", "flying"): one with a
//      value that is not finite is not sent, and a yaw or pitch of the bot that went bad is
//      put back to the last good one, so the next packet is whole again
// Each first case is written to the console as one JSON line, with where the call came
// from, so the cause can be found. Nothing else about how the bot moves changes.
//
// The mineflayer plugin form: bot.loadPlugin(movementGuardPlugin), after the bot is
// created. Depends only on the bot it is given.

export const MOVEMENT_PACKETS = Object.freeze(['position', 'position_look', 'look', 'flying']);
const NUMBER_FIELDS = Object.freeze(['x', 'y', 'z', 'yaw', 'pitch']);

const guarded = new WeakMap();
const finite = (value) => typeof value === 'number' && Number.isFinite(value);

// The fields of a movement packet that are present and are not finite numbers.
export function badMovementFields(data) {
    if (data === null || typeof data !== 'object') return [];
    return NUMBER_FIELDS.filter((field) => data[field] !== undefined && !finite(data[field]));
}

export function installMovementGuard(bot, { warn = console.warn, now = Date.now } = {}) {
    if (guarded.has(bot)) return guarded.get(bot);
    const stats = { looks_refused: 0, look_ats_refused: 0, packets_dropped: 0, angles_repaired: 0 };
    const reported = new Set();
    const good = { yaw: 0, pitch: 0 };

    function report(kind, detail) {
        if (reported.has(kind)) return;
        reported.add(kind);
        const from = String(new Error().stack ?? '').split('\n').slice(3, 9).map((line) => line.trim());
        try {
            warn(JSON.stringify({ ts: new Date(now()).toISOString(), level: 'warn', event: 'genesis_movement_guard', agent: bot.username ?? null, kind, ...detail, from }));
        } catch { /* reporting must never stop the bot */ }
    }

    function rememberAngles() {
        if (finite(bot.entity?.yaw)) good.yaw = bot.entity.yaw;
        if (finite(bot.entity?.pitch)) good.pitch = bot.entity.pitch;
    }

    // a yaw or pitch of the bot that is not finite goes back to the last good one
    function repairAngles() {
        if (!bot.entity) return;
        if (!finite(bot.entity.yaw)) { bot.entity.yaw = good.yaw; stats.angles_repaired++; }
        if (!finite(bot.entity.pitch)) { bot.entity.pitch = good.pitch; stats.angles_repaired++; }
    }

    if (typeof bot.look === 'function') {
        const look = bot.look.bind(bot);
        bot.look = async function guardedLook(yaw, pitch, ...rest) {
            if (!finite(yaw) || !finite(pitch)) {
                stats.looks_refused++;
                report('look', { yaw: String(yaw), pitch: String(pitch) });
                return undefined;
            }
            repairAngles();
            const result = await look(yaw, pitch, ...rest);
            rememberAngles();
            return result;
        };
    }
    if (typeof bot.lookAt === 'function') {
        const lookAt = bot.lookAt.bind(bot);
        bot.lookAt = async function guardedLookAt(point, ...rest) {
            if (!point || !finite(point.x) || !finite(point.y) || !finite(point.z)) {
                stats.look_ats_refused++;
                report('lookAt', { point: point ? `${point.x}, ${point.y}, ${point.z}` : String(point) });
                return undefined;
            }
            repairAngles();
            const result = await lookAt(point, ...rest);
            rememberAngles();
            return result;
        };
    }
    if (typeof bot._client?.write === 'function') {
        const write = bot._client.write.bind(bot._client);
        bot._client.write = function guardedWrite(name, data, ...rest) {
            if (MOVEMENT_PACKETS.includes(name)) {
                const bad = badMovementFields(data);
                if (bad.length > 0) {
                    stats.packets_dropped++;
                    report(`packet:${name}`, { fields: bad });
                    repairAngles();
                    return undefined;
                }
                rememberAngles();
            }
            return write(name, data, ...rest);
        };
    }

    const guard = { stats };
    guarded.set(bot, guard);
    return guard;
}

export const movementGuardOf = (bot) => guarded.get(bot) ?? null;

export function movementGuardPlugin(bot) {
    installMovementGuard(bot);
}
