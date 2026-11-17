// The agents' skins: the store and the three things the operator can do with it (upload a
// PNG for an agent, list what is set, clear one). The dashboard keeps the image; APPLYING it
// is the skin service's work in the MindServer process (genesis/skins/server.js), which
// tells SkinsRestorer over RCON and reports every outcome as an event. Nothing here talks to
// the Minecraft server or to any outside service.
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
            outcome = await link.ask('genesis-skin-apply', { agent: record.agent, png_base64: record.png.toString('base64'), variant: record.variant }, 30000);
        } catch (err: any) {
            outcome = { ok: false, reason: String(err?.message ?? err).includes('did not answer') ? 'skin_service_did_not_answer' : String(err?.message ?? err) };
        }
        const applied = outcome?.ok === true;
        const reason = applied ? null : String(outcome?.reason ?? 'no_answer').slice(0, 80);
        await store.skinState(record.agent, applied ? 'applied' : 'failed', iso(), reason);
        return { applied, reason };
    }

    return {
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
            const at = iso();
            const record: SkinRecord = {
                agent, png: Buffer.from(body as Buffer), width: Number(checked.width), height: Number(checked.height), bytes: Number(checked.bytes), sha256: String(checked.sha256),
                variant, set_at: at, set_by: SKIN_ACTOR, state: 'stored', state_at: at, detail: null,
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
