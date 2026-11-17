// Found on the first real run (Paper 1.21.6): agents were kicked with "Invalid move player packet
// received" right after a fight. The bot's velocity had become NaN, and the next movement packet
// carried it. The cause was a bot library that did not belong with the installed game data (fixed in
// package.json); the guard tested here makes sure no such value leaves the bot whatever the cause.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installMovementGuard, badMovementFields, movementGuardOf, MOVEMENT_PACKETS } from '../lib/movement_guard.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// A stand-in bot: look and lookAt as mineflayer has them (lib/plugins/physics.js), and a client that records.
function fakeBot() {
    const sent = [];
    const bot = {
        username: 'Mira',
        entity: { yaw: 1, pitch: 0.5, eyeHeight: 1.62, position: { x: 0, y: 64, z: 0 } },
        _client: { write(name, data) { sent.push([name, data]); return 'written'; } },
        async look(yaw, pitch) { bot.entity.yaw = yaw; bot.entity.pitch = pitch; return 'looked'; },
        async lookAt(point) {
            const dy = point.y - (bot.entity.position.y + bot.entity.eyeHeight);
            await bot.look(Math.atan2(-point.x, -point.z), Math.atan2(dy, Math.hypot(point.x, point.z)));
            return 'looked at';
        },
    };
    return { bot, sent };
}

test('movement guard: a look that is not a finite number is not taken, and the bot keeps its last good angles', async () => {
    const { bot } = fakeBot();
    const lines = [];
    const guard = installMovementGuard(bot, { warn: (line) => lines.push(JSON.parse(line)) });
    assert.equal(installMovementGuard(bot), guard, 'installed once');
    assert.equal(movementGuardOf(bot), guard);

    assert.equal(await bot.look(2, 0.25), 'looked');
    assert.deepEqual([bot.entity.yaw, bot.entity.pitch], [2, 0.25]);
    for (const [yaw, pitch] of [[NaN, 0], [0, NaN], [Infinity, 0], [undefined, 0], ['1', 0]]) {
        assert.equal(await bot.look(yaw, pitch), undefined);
    }
    assert.deepEqual([bot.entity.yaw, bot.entity.pitch], [2, 0.25], 'a refused look changes nothing');
    assert.equal(guard.stats.looks_refused, 5);

    // what upstream's idle_staring does with an entity mineflayer gave no height: offset(0, undefined, 0)
    assert.equal(await bot.lookAt({ x: 3, y: NaN, z: 4 }), undefined);
    assert.equal(await bot.lookAt(null), undefined);
    assert.equal(guard.stats.look_ats_refused, 2);
    assert.equal(await bot.lookAt({ x: 3, y: 66, z: 4 }), 'looked at');
    assert.ok(Number.isFinite(bot.entity.yaw) && Number.isFinite(bot.entity.pitch));

    // each kind is reported once, with where the call came from
    assert.deepEqual(lines.map((line) => [line.event, line.agent, line.kind]), [['genesis_movement_guard', 'Mira', 'look'], ['genesis_movement_guard', 'Mira', 'lookAt']]);
    assert.ok(Array.isArray(lines[0].from));
});

test('movement guard: a movement packet with a NaN is not sent, the angles are repaired, and every other packet passes untouched', () => {
    const { bot, sent } = fakeBot();
    const guard = installMovementGuard(bot, { warn: () => {} });
    assert.deepEqual([...MOVEMENT_PACKETS], ['position', 'position_look', 'look', 'flying']);

    assert.equal(bot._client.write('position_look', { x: 1, y: 64, z: 2, yaw: 90, pitch: 0, flags: { onGround: true } }), 'written');
    assert.equal(bot._client.write('chat_message', { message: 'NaN is fine in a chat line', x: NaN }), 'written', 'only movement packets are looked at');
    assert.equal(sent.length, 2);

    // the bot's own velocity went NaN (the knock-back the old library misread) and the position followed
    assert.equal(bot._client.write('position', { x: NaN, y: 64, z: 2, flags: { onGround: true } }), undefined);
    assert.equal(bot._client.write('position_look', { x: 1, y: 64, z: 2, yaw: NaN, pitch: Infinity }), undefined);
    assert.equal(bot._client.write('look', { yaw: 90, pitch: NaN }), undefined);
    assert.equal(sent.length, 2, 'none of the three left the bot');
    assert.equal(guard.stats.packets_dropped, 3);
    assert.deepEqual(badMovementFields({ x: 1, y: NaN, z: 2, yaw: Infinity, pitch: 0 }), ['y', 'yaw']);
    assert.deepEqual(badMovementFields({ flags: { onGround: true } }), []);
    assert.deepEqual(badMovementFields(null), []);

    // angles that went bad inside the bot are put back to the last good ones when a bad packet is stopped
    bot.entity.yaw = NaN;
    bot.entity.pitch = NaN;
    bot._client.write('look', { yaw: NaN, pitch: NaN });
    assert.deepEqual([bot.entity.yaw, bot.entity.pitch], [1, 0.5]);
    assert.equal(guard.stats.angles_repaired, 2);
    assert.equal(bot._client.write('look', { yaw: 10, pitch: 5, flags: { onGround: true } }), 'written');
});

test('movement guard: upstream loads it for Genesis agents only, and a login the server throttles is waited out, not counted as a crash', async () => {
    const mcdata = readFileSync(path.join(REPO_ROOT, 'src', 'utils', 'mcdata.js'), 'utf8');
    assert.match(mcdata, /if \(settings\.genesis_planning\?\.enabled === true \|\| settings\.movement_guard === true\) bot\.loadPlugin\(movementGuardPlugin\)/);
    assert.ok(mcdata.indexOf('loadPlugin(movementGuardPlugin)') < mcdata.indexOf('bot.loadPlugin(pathfinder)'), 'before anything that moves the bot');

    // "connection throttled! please wait before reconnecting." (Paper, four agents from one address)
    const handler = readFileSync(path.join(REPO_ROOT, 'src', 'agent', 'connection_handler.js'), 'utf8');
    const network = /'network_error': \{\s*keywords: \[([^\]]+)\]/.exec(handler)[1];
    assert.match(network, /'throttled'/);
    const { SERVER_DOWN_TYPES } = await import('../recovery/exit_codes.js');
    assert.ok(SERVER_DOWN_TYPES.includes('network_error'), 'a throttled login ends with the wait-and-reconnect exit code');
});

test('packages: the bot library is the release that belongs with the locked game data', () => {
    const root = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    const lock = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package-lock.json'), 'utf8')).packages;
    const mineflayer = lock['node_modules/mineflayer'];
    const data = lock['node_modules/minecraft-data'];
    assert.equal(mineflayer.version, root.dependencies.mineflayer, 'an exact version, and the lockfile has it');
    // mineflayer 4.33.0 with minecraft-data 3.119.0 was the pair that got agents kicked: 4.33.0 read
    // packet.velocityX, and the data had renamed it. The locked data must be inside the range the locked
    // library asks for AND not newer than the library's own generation knows.
    const wants = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(mineflayer.dependencies['minecraft-data']);
    assert.ok(wants, 'mineflayer names a minimum minecraft-data');
    const have = data.version.split('.').map(Number);
    assert.equal(have[0], Number(wants[1]));
    assert.ok(have[1] > Number(wants[2]) || (have[1] === Number(wants[2]) && have[2] >= Number(wants[3])), `minecraft-data ${data.version} is older than mineflayer ${mineflayer.version} asks for`);
    assert.ok(have[1] - Number(wants[2]) <= 10, `minecraft-data ${data.version} is far ahead of what mineflayer ${mineflayer.version} was made for (${mineflayer.dependencies['minecraft-data']}): update mineflayer with it, and run genesis/tools/preflight.js`);
});
