// The agents' skins: the store and the three things the operator can do with it (upload a
// PNG for an agent, list what is set, clear one). The dashboard keeps the image; APPLYING it
// is the skin service's work in the MindServer process (genesis/skins/server.js): it sends the
// image to MineSkin to be signed (decided; an outside service, and the texture's address is
// PUBLIC), tells SkinsRestorer over RCON, and reports every outcome as an event. Nothing here
// talks to the Minecraft server or to any outside service, and the MineSkin API key never
// comes here: the dashboard only learns whether one is set.
//
// The image check is the one of genesis/skins/skins.js (the same file the skin service
// uses): a real PNG, 64 by 64 or 64 by 32, 64 KiB at most.

// @ts-ignore: plain JavaScript shared with the agents' side, like the event contract
import { checkSkinPng, SKIN_LIMITS, SKIN_VARIANTS } from '../../../skins/skins.js';
import type { MindLink } from './controls.js';
import type { SkinRecord, Store } from './ports.js';

export { SKIN_LIMITS };
export const SKIN_ACTOR = 'Operator'; // the panel has no login (decided)

export type SkinView = Omit<SkinRecord, 'png'>;
// Whether custom skins can be signed at all: the key itself never leaves the MindServer process.
export const MINESKIN_KEY_ENV = 'GENESIS_MINESKIN_API_KEY';
export interface SkinSigning {
    service_connected: boolean;
    key_set: boolean | null;      // null: not known (the skin service did not answer)
    key_env: string;              // the name of the env key that holds the MineSkin API key
    visibility: string | null;    // what MineSkin is asked for: private | unlisted | public
}
export const noKeyMessage = (key_env = MINESKIN_KEY_ENV) =>
    `Custom skins are signed by MineSkin and need its API key: set ${key_env} in the env file, then run genesis/up.sh. Nothing was stored or sent.`;
// The texture's address outside: only Mojang's texture server is ever shown as a link.
const TEXTURE_URL = /^https:\/\/textures\.minecraft\.net\/texture\/[0-9a-f]{20,80}$/;
export type SkinResult = { ok: true; skin: SkinView | null; applied: boolean; reason: string | null } | { ok: false; status: number; error: string };

const view = ({ png: _png, ...rest }: SkinRecord): SkinView => rest;

export function createSkins({ store, link, roster, clock = { now: Date.now } }: {
    store: Store; link: MindLink | null; roster: { name: string }[]; clock?: { now(): number };
}) {
    const known = (agent: string) => roster.some((entry) => entry.name === agent);
    const iso = () => new Date(clock.now()).toISOString();

    // Hands the stored skin to the skin service. Never throws: the outcome goes into the row.
    async function apply(record: SkinRecord): Promise<{ applied: boolean; reason: string | null }> {
        let outcome: any = null;
        try {
            if (!link || !link.connected()) throw new Error('mindserver_not_connected');
            // (the skin service gives MineSkin 30 seconds, then the RCON commands follow: 45 seconds in all)
            outcome = await link.ask('genesis-skin-apply', { agent: record.agent, png_base64: record.png.toString('base64'), variant: record.variant }, 45000);
        } catch (err: any) {
            outcome = { ok: false, reason: String(err?.message ?? err).includes('did not answer') ? 'skin_service_did_not_answer' : String(err?.message ?? err) };
        }
        const applied = outcome?.ok === true;
        const reason = applied ? null : String(outcome?.reason ?? 'no_answer').slice(0, 80);
        const message = applied || typeof outcome?.answer !== 'string' ? null : outcome.answer.slice(0, 300);
        const texture_url = typeof outcome?.texture_url === 'string' && TEXTURE_URL.test(outcome.texture_url) ? outcome.texture_url : null;
        await store.skinState(record.agent, applied ? 'applied' : 'failed', iso(), reason, { message, texture_url });
        return { applied, reason };
    }

    // Can a custom skin be signed right now? Asked of the skin service; never throws.
    async function signing(): Promise<SkinSigning> {
        const unknown: SkinSigning = { service_connected: false, key_set: null, key_env: MINESKIN_KEY_ENV, visibility: null };
        if (!link || !link.connected()) return unknown;
        try {
            const got = await link.ask('genesis-skin-status', {}, 5000);
            return {
                service_connected: true, key_set: typeof got?.key_set === 'boolean' ? got.key_set : null,
                key_env: typeof got?.key_env === 'string' && /^[A-Z_]{3,60}$/.test(got.key_env) ? got.key_env : MINESKIN_KEY_ENV,
                visibility: ['private', 'unlisted', 'public'].includes(got?.visibility) ? got.visibility : null,
            };
        } catch { return { ...unknown, service_connected: true }; }
    }

    return {
        signing,
        async list(): Promise<SkinView[]> { return (await store.skins()).map(view); },
        async image(agent: string): Promise<Buffer | null> { return (await store.skin(agent))?.png ?? null; },
        // Stores the image for the agent, then asks the skin service to apply it.
        async upload(agent: string, body: unknown, variant = 'classic'): Promise<SkinResult> {
            if (!known(agent)) return { ok: false, status: 404, error: 'unknown agent' };
            if (!SKIN_VARIANTS.includes(variant)) return { ok: false, status: 400, error: 'the variant must be classic or slim' };
            const checked = checkSkinPng(body);
            if (!checked.ok) {
                const why: Record<string, string> = {
                    not_an_image: 'a PNG image is expected as the body', too_large: `the image is larger than ${SKIN_LIMITS.max_bytes} bytes`,
                    not_a_png: 'this is not a PNG file', broken_png: 'the PNG file is damaged', wrong_size: 'a skin is 64 by 64 or 64 by 32 pixels',
                };
                return { ok: false, status: checked.reason === 'too_large' ? 413 : 400, error: why[String(checked.reason)] ?? String(checked.reason) };
            }
            // without the API key nothing can be signed: refused before anything is stored or sent, naming the env key
            const can = await signing();
            if (can.key_set === false) return { ok: false, status: 409, error: noKeyMessage(can.key_env) };
            const at = iso();
            const record: SkinRecord = {
                agent, png: Buffer.from(body as Buffer), width: Number(checked.width), height: Number(checked.height), bytes: Number(checked.bytes), sha256: String(checked.sha256),
                variant, set_at: at, set_by: SKIN_ACTOR, state: 'stored', state_at: at, detail: null, message: null, texture_url: null,
            };
            await store.skinPut(record);
            const outcome = await apply(record);
            const stored = await store.skin(agent);
            return { ok: true, skin: stored ? view(stored) : null, ...outcome };
        },
        // Removes the stored image and asks the skin service to take the skin off.
        async clear(agent: string): Promise<SkinResult> {
            if (!known(agent)) return { ok: false, status: 404, error: 'unknown agent' };
            const had = await store.skinClear(agent);
            if (!had) return { ok: false, status: 404, error: 'no skin is set for this agent' };
            let outcome: any = null;
            try {
                if (!link || !link.connected()) throw new Error('mindserver_not_connected');
                outcome = await link.ask('genesis-skin-clear', { agent }, 15000);
            } catch (err: any) { outcome = { ok: false, reason: String(err?.message ?? err) }; }
            return { ok: true, skin: null, applied: outcome?.ok === true, reason: outcome?.ok === true ? null : String(outcome?.reason ?? 'no_answer').slice(0, 80) };
        },
        // After a start: the skin service is told what is stored, so that it applies it again when the agent logs in.
        async announce(): Promise<number> {
            if (!link || !link.connected()) return 0;
            const all = await store.skins();
            for (const record of all) link.emit('genesis-skin-known', { agent: record.agent, sha256: record.sha256 });
            return all.length;
        },
    };
}

export type Skins = ReturnType<typeof createSkins>;
