// Genesis: agent skins (decided: the server is in offline mode, so skins come through the
// SkinsRestorer plugin; the operator provides them through the dashboard). This is the
// application step: it makes SkinsRestorer give an agent its skin, over the same RCON path
// the bootstrap uses, never through an agent.
//
// WHAT IS KNOWN, AND FROM WHERE (skinsrestorer.net/docs, "Commands and Permissions", "Custom
// skins", "MineSkin"):
//   /sr createcustom <skinName> <skinInput> <skinVariant>   "stores a named skin"; the documented
//        example for an image is  /sr createcustom lobby "https://example.com/lobby.png" classic
//        (the URL quoted, the model named). Console access is enough.
//   /skin set <skinName> <selector>     "changes a target's saved selection"
//   /sr applyskin <selector>            "reapplies the skin resolved for the target"
//   /skin clear <selector>
//   "Console commands omit the leading slash."
//   A custom image has to be SIGNED before a client shows it: SkinsRestorer has MineSkin (an
//   outside service) generate the skin from the URL. So the image must be at an address that
//   service can fetch. This file never sends anything anywhere itself: `signer` is injected
//   and turns the PNG into such an address; without one, a skin is stored and NOT applied.
// NOT RUN AGAINST A REAL SERVER, and the answers' wording is not in the documentation: an
// answer that looks like a refusal (unknown command, an error word) is a failure with the raw
// text; anything else counts as sent, and the event says "sent", not "seen in the game".
// Unverified risk for the live test: applying a skin makes the server send that player's data
// again, which may disturb a mineflayer bot.
//
// Injected: rcon { send(command) }, signer { sign({ agent, png, sha256, variant }) -> { url } } | null,
//           emit(type, data, opts), clock.
// Depends only on Node built-ins.

import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';

export const SKIN_LIMITS = Object.freeze({ max_bytes: 64 * 1024, sizes: Object.freeze([[64, 64], [64, 32]]) });
export const SKIN_VARIANTS = Object.freeze(['classic', 'slim']);
export const SKIN_COMMANDS = Object.freeze([
    { command: 'sr createcustom <skinName> "<url>" <classic|slim>', answer: 'not in the documentation: a refusal is read from "unknown command" or an error word' },
    { command: 'skin set <skinName> <player>', answer: 'as above' },
    { command: 'sr applyskin <player>', answer: 'as above (sent each time the agent logs in again)' },
    { command: 'skin clear <player>', answer: 'as above' },
]);

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Is this a real PNG skin? { ok: true, width, height, bytes, sha256 } or { ok: false, reason }.
// Checked: the size cap, the PNG signature, a first chunk that is a whole IHDR with a right
// checksum, 64 by 64 or 64 by 32, and a closing IEND chunk. Nothing is decoded.
export function checkSkinPng(input) {
    const png = Buffer.isBuffer(input) ? input : (input instanceof Uint8Array ? Buffer.from(input) : null);
    if (!png || png.length === 0) return { ok: false, reason: 'not_an_image' };
    if (png.length > SKIN_LIMITS.max_bytes) return { ok: false, reason: 'too_large' };
    if (png.length < 8 + 25 + 12 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) return { ok: false, reason: 'not_a_png' };
    if (png.readUInt32BE(8) !== 13 || png.toString('latin1', 12, 16) !== 'IHDR') return { ok: false, reason: 'not_a_png' };
    if (crc32(png.subarray(12, 29)) !== png.readUInt32BE(29)) return { ok: false, reason: 'broken_png' };
    if (png.toString('latin1', png.length - 8, png.length - 4) !== 'IEND') return { ok: false, reason: 'broken_png' };
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    if (!SKIN_LIMITS.sizes.some(([w, h]) => w === width && h === height)) return { ok: false, reason: 'wrong_size', width, height };
    return { ok: true, width, height, bytes: png.length, sha256: createHash('sha256').update(png).digest('hex') };
}

const AGENT_NAME = /^[A-Za-z0-9_]{3,16}$/;
const refused = (answer) => /unknown (or incomplete )?command|no permission|not found|could not|couldn't|error|invalid|failed|exception/i.test(String(answer ?? ''));
const clip = (text) => { const value = String(text ?? '').replace(/§[0-9a-fk-orx]/gi, '').replace(/\s+/g, ' ').trim(); return value.length > 200 ? `${value.slice(0, 200)}...` : value; };

export function createSkinService({ rcon = null, signer = null, emit = () => null, clock = { now: Date.now }, agents = null } = {}) {
    const applied = new Map(); // agent -> { skin_name, sha256, at }
    const stats = { applied: 0, failed: 0, reapplied: 0, cleared: 0 };
    const known = (agent) => typeof agent === 'string' && AGENT_NAME.test(agent) && (!agents || agents.includes(agent));
    const tell = (state, detail) => { try { emit('agent.state', { state, detail }, { severity: state === 'skin_failed' ? 'warn' : 'info', corr: null }); } catch { /* an event must never disturb the service */ } };
    const failed = (agent, reason, more = {}) => {
        stats.failed++;
        const result = { ok: false, agent, reason, at: new Date(clock.now()).toISOString(), ...more };
        tell('skin_failed', { ...result, by: 'Operator' });
        return result;
    };
    // One console command. Resolves to null, or to why it failed.
    async function run(command) {
        let answer;
        try { answer = await rcon.send(command); } catch (err) { return { reason: 'rcon_error', answer: clip(err?.message ?? err), command }; }
        return refused(answer) ? { reason: 'refused', answer: clip(answer), command } : null;
    }
    return {
        // Gives the agent this skin. Resolves (never rejects) to { ok, agent, at, ... }; every outcome is an event.
        async apply({ agent, png, variant = 'classic' } = {}) {
            if (!known(agent)) return failed(String(agent ?? '').slice(0, 20), 'unknown_agent');
            const checked = checkSkinPng(png);
            if (!checked.ok) return failed(agent, checked.reason);
            if (!SKIN_VARIANTS.includes(variant)) return failed(agent, 'unknown_variant');
            if (!rcon) return failed(agent, 'no_rcon', { sha256: checked.sha256 });
            // the image has to be signed by an outside service before any client shows it: without a way to it, nothing is sent anywhere
            if (!signer) return failed(agent, 'no_signer', { sha256: checked.sha256 });
            let url;
            try {
                url = (await signer.sign({ agent, png, sha256: checked.sha256, variant }))?.url;
            } catch (err) { return failed(agent, 'signer_failed', { sha256: checked.sha256, answer: clip(err?.message ?? err) }); }
            if (typeof url !== 'string' || !/^https:\/\/[^\s"]+$/.test(url)) return failed(agent, 'signer_gave_no_address', { sha256: checked.sha256 });
            const skin_name = `genesis_${agent.toLowerCase()}`;
            const stopped = await run(`sr createcustom ${skin_name} "${url}" ${variant}`) ?? await run(`skin set ${skin_name} ${agent}`);
            if (stopped) return failed(agent, stopped.reason, { sha256: checked.sha256, command: stopped.command.replace(/"[^"]*"/, '"<address>"'), answer: stopped.answer });
            stats.applied++;
            const result = { ok: true, agent, skin_name, variant, sha256: checked.sha256, at: new Date(clock.now()).toISOString() };
            applied.set(agent, result);
            tell('skin_applied', { ...result, by: 'Operator', sent: true });
            return result;
        },
        // The agent logged in again: SkinsRestorer is asked to apply what it has for it.
        async onLogin(agent) {
            if (!rcon || !applied.has(agent)) return null;
            const stopped = await run(`sr applyskin ${agent}`);
            if (stopped) return failed(agent, stopped.reason, { command: stopped.command, answer: stopped.answer, on: 'login' });
            stats.reapplied++;
            const result = { ...applied.get(agent), at: new Date(clock.now()).toISOString(), on: 'login' };
            tell('skin_applied', { ...result, by: 'Operator', sent: true });
            return result;
        },
        // Takes the skin off again.
        async clear(agent) {
            if (!known(agent)) return failed(String(agent ?? '').slice(0, 20), 'unknown_agent');
            applied.delete(agent);
            if (!rcon) return failed(agent, 'no_rcon');
            const stopped = await run(`skin clear ${agent}`);
            if (stopped) return failed(agent, stopped.reason, { command: stopped.command, answer: stopped.answer });
            stats.cleared++;
            const result = { ok: true, agent, cleared: true, at: new Date(clock.now()).toISOString() };
            tell('skin_cleared', { ...result, by: 'Operator' });
            return result;
        },
        // What is known of an agent's skin after a restart of this process (the dashboard's store says so).
        remember(agent, sha256) { if (known(agent)) applied.set(agent, { ok: true, agent, skin_name: `genesis_${agent.toLowerCase()}`, sha256 }); },
        stats: () => ({ ...stats, known: applied.size }),
    };
}
