// Genesis: the signer behind the skin service (genesis/skins/skins.js). Decided: the SERVER sends an
// operator's custom skin to MineSkin, which uploads it to a Mojang account of its own and answers
// with the signed texture. THE IMAGE LEAVES THE OPERATOR'S NETWORK HERE, and only here: one request,
// made when the operator uploads a skin, never on its own, never again for the same image.
//
// WHAT IS KNOWN, AND FROM WHERE
//   MineSkin, read in its own documentation (docs.mineskin.org: "Getting started", "API", the
//   OpenAPI file of api.mineskin.org) on 16 Nov 2026:
//     POST https://api.mineskin.org/v2/generate          multipart/form-data
//       file        the PNG                              variant     classic | slim | unknown
//       name        at most 48 characters                visibility  public | unlisted | private
//     headers: "Authorization: Bearer <API key>" and a "User-Agent" (required).
//     200: { success: true, skin: { uuid, texture: { data: { value, signature }, url: { skin } } } }
//          url.skin is an address on textures.minecraft.net: Mojang's texture server, PUBLIC.
//     an error: { success: false, errors: [{ code, message }] }; 400 a bad request, 429 rate limited
//          (headers Retry-After, X-RateLimit-*; "e.g. 5 requests per 10 seconds"), 500.
//     API keys: account.mineskin.org/keys.
//   VISIBILITY. The API file lists the three values and says nothing more about them. This asks
//   for "private", the least public of the three (GENESIS_MINESKIN_VISIBILITY changes it).
//   UNVERIFIED: what exactly "private" and "unlisted" hide, and whether every key may ask for
//   "private" (a refusal is reported with MineSkin's own code; nothing is tried again with another
//   value). SkinsRestorer's documentation says of its own setting that asks for an unlisted skin:
//   it "does not make a Minecraft texture URL private or prevent others from copying it".
//   Whatever is asked for: the texture's address is public, and every client that sees the agent
//   in the game is sent the texture.
//   SKINSRESTORER takes no texture value and signature in any documented command ("Do not hand-edit
//   a texture value or signature"). The documented route is used: sr createcustom <name> "<address>"
//   <variant>, with the address MineSkin returned. UNVERIFIED: whether SkinsRestorer, given an
//   address on textures.minecraft.net, asks MineSkin again by itself (from the Minecraft server).
// NOT RUN: no request was ever sent from here; the tests give it a stand-in for fetch.
//
// The API key comes from the launcher's environment (GENESIS_MINESKIN_API_KEY, the env file of
// genesis/up.sh). It is kept in this closure only: never logged, never in an event, an error or an
// answer (every text that leaves this file is scrubbed of it).
//
// Injected: fetch, timers { setTimeout, clearTimeout }. Depends on nothing else.

export const MINESKIN_API_KEY_ENV = 'GENESIS_MINESKIN_API_KEY';
export const MINESKIN_VISIBILITY_ENV = 'GENESIS_MINESKIN_VISIBILITY';
export const MINESKIN_ENDPOINT = 'https://api.mineskin.org/v2/generate';
export const MINESKIN_VISIBILITIES = Object.freeze(['private', 'unlisted', 'public']); // the least public first
export const MINESKIN_DEFAULTS = Object.freeze({
    visibility: 'private',
    timeout_ms: 30 * 1000,                    // proposed: one upload is given this long, then it has failed
    user_agent: 'genesis-skins/1.0',          // MineSkin requires a User-Agent; it names the program, nobody and no place
});
// Every reason an upload can fail with (the `reason` of the skin_failed event).
export const MINESKIN_FAILURES = Object.freeze(['no_api_key', 'mineskin_timeout', 'mineskin_unreachable', 'mineskin_rate_limited',
    'mineskin_key_refused', 'mineskin_refused', 'mineskin_error', 'mineskin_bad_answer']);

export class MineSkinError extends Error {
    constructor(code, message, more = {}) {
        super(message);
        this.name = 'MineSkinError';
        this.code = code;
        Object.assign(this, more);
    }
}

// The plain sentence for an upload that is refused because no key is set (the dashboard shows the same).
export const NO_KEY_MESSAGE = `custom skins are signed by MineSkin and need its API key: set ${MINESKIN_API_KEY_ENV} in the env file (genesis/FIRST_RUN.md says how to get one), then run genesis/up.sh`;

const clip = (text, max = 200) => { const value = String(text ?? '').replace(/\s+/g, ' ').trim(); return value.length > max ? `${value.slice(0, max)}...` : value; };
// Mojang's texture server only: nothing else is ever handed to SkinsRestorer as an address.
const TEXTURE_URL = /^https?:\/\/textures\.minecraft\.net\/texture\/[0-9a-f]{20,80}$/;

export function createMineSkinSigner({
    api_key = '', fetch = globalThis.fetch, timers = globalThis, visibility = MINESKIN_DEFAULTS.visibility,
    timeout_ms = MINESKIN_DEFAULTS.timeout_ms, user_agent = MINESKIN_DEFAULTS.user_agent, endpoint = MINESKIN_ENDPOINT,
} = {}) {
    const key = typeof api_key === 'string' ? api_key.trim() : '';
    const asked = MINESKIN_VISIBILITIES.includes(visibility) ? visibility : MINESKIN_DEFAULTS.visibility;
    const scrub = (text) => (key ? String(text ?? '').split(key).join('<key>') : String(text ?? ''));
    const done = new Map(); // "sha256:variant" -> the answer: the same image is never sent twice by this process
    const stats = { requests: 0, signed: 0, failed: 0, reused: 0 };
    const fail = (code, message, more = {}) => { stats.failed++; return new MineSkinError(code, scrub(clip(message)), more); };

    return {
        configured: () => key.length > 0,
        visibility: () => asked,
        // Sends the PNG, once. Resolves to { url, texture_url, uuid, visibility, signed: true } or throws a MineSkinError.
        async sign({ agent, png, sha256 = null, variant = 'classic' } = {}) {
            if (!key) throw fail('no_api_key', NO_KEY_MESSAGE);
            const cache_key = sha256 ? `${sha256}:${variant}` : null;
            if (cache_key && done.has(cache_key)) { stats.reused++; return { ...done.get(cache_key), reused: true }; }
            const form = new FormData();
            form.append('file', new Blob([png], { type: 'image/png' }), 'skin.png');
            form.append('variant', variant === 'slim' ? 'slim' : 'classic');
            form.append('name', `genesis_${String(agent ?? 'agent').toLowerCase()}`.slice(0, 48));
            form.append('visibility', asked);
            const controller = new AbortController();
            let timed_out = false;
            const timer = timers.setTimeout(() => { timed_out = true; controller.abort(); }, timeout_ms);
            stats.requests++;
            let response;
            let body = null;
            try {
                response = await fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'User-Agent': user_agent, Accept: 'application/json' }, body: form, signal: controller.signal });
                try { body = await response.json(); } catch { body = null; }
            } catch (err) {
                throw timed_out ? fail('mineskin_timeout', `MineSkin did not answer within ${Math.round(timeout_ms / 1000)} seconds`)
                    : fail('mineskin_unreachable', `MineSkin could not be reached: ${err?.message ?? err}`);
            } finally {
                timers.clearTimeout(timer);
            }
            const status = Number(response?.status ?? 0);
            if (status !== 200 || body?.success === false) {
                const first = Array.isArray(body?.errors) ? body.errors[0] ?? {} : {};
                const said = `${first.code ? `${first.code}: ` : ''}${first.message ?? `HTTP ${status}`}`;
                if (status === 429) {
                    const retry_after = Number(response.headers?.get?.('retry-after')) || null;
                    throw fail('mineskin_rate_limited', `MineSkin's rate limit was reached${retry_after ? ` (it says to wait ${retry_after} seconds)` : ''}: ${said}. Nothing is tried again by itself: upload the skin again later`, { status, retry_after });
                }
                if (status === 401 || status === 403) throw fail('mineskin_key_refused', `MineSkin refused the API key (${MINESKIN_API_KEY_ENV}), or what the key may do: ${said}`, { status, mineskin_code: first.code ?? null });
                if (status >= 500) throw fail('mineskin_error', `MineSkin failed: ${said}`, { status, mineskin_code: first.code ?? null });
                throw fail('mineskin_refused', `MineSkin refused the skin: ${said}`, { status, mineskin_code: first.code ?? null });
            }
            const texture = body?.skin?.texture ?? {};
            const address = String(texture.url?.skin ?? '');
            if (!TEXTURE_URL.test(address) || typeof texture.data?.value !== 'string' || typeof texture.data?.signature !== 'string') {
                throw fail('mineskin_bad_answer', 'MineSkin answered without a signed texture and its address on textures.minecraft.net', { status });
            }
            stats.signed++;
            // (the value and the signature are what SkinsRestorer would need to apply the skin without asking anyone;
            // it documents no command that takes them, so only the address is used: see the head of this file)
            const texture_url = address.replace(/^http:/, 'https:');
            const result = { url: texture_url, texture_url, uuid: typeof body.skin.uuid === 'string' ? body.skin.uuid.slice(0, 64) : null, visibility: asked, signed: true };
            if (cache_key) done.set(cache_key, result);
            return result;
        },
        stats: () => ({ ...stats }),
    };
}

// The signer the launcher gives the skin service: MineSkin with the key of the environment; without a
// key, one that refuses every upload with the plain sentence that names the env key.
export function mineSkinFromEnv(env = {}, options = {}) {
    return createMineSkinSigner({ api_key: env[MINESKIN_API_KEY_ENV] ?? '', visibility: env[MINESKIN_VISIBILITY_ENV] || MINESKIN_DEFAULTS.visibility, ...options });
}
