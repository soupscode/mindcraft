// What the Skins view shows, worked out from what the server says (GET /api/skins) and the
// roster. No DOM here: the view draws it, the tests check it.

export interface SkinRow {
    agent: string;
    width: number; height: number; bytes: number; sha256: string;
    variant: string;                     // classic | slim
    set_at: string; set_by: string;      // set_by is always "Operator"
    state: 'stored' | 'applied' | 'failed';
    state_at: string;
    detail: string | null;               // the named reason of a failure
    message?: string | null;             // the skin service's words about it
    texture_url?: string | null;         // where the signed texture lives outside: public
}
export interface Signing {
    service_connected: boolean;
    key_set: boolean | null;
    key_env: string;
    visibility: string | null;
}
export interface SkinsAnswer {
    limits: { max_bytes: number; sizes?: number[][] };
    skins: SkinRow[];
    signing?: Signing;
}

export type CardState = 'applied' | 'failed' | 'stored' | 'none';
export interface SkinCard {
    agent: string;
    role: string;
    state: CardState;
    tag: string;                         // Applied | Failed | Stored | None
    when_label: string;                  // the label of the time: Applied | Failed | Stored
    at: string | null;                   // when (ISO), null when there is no skin
    set_by: string | null;               // "Operator", or null when there is no skin
    reason: string | null;               // the named reason of a failure (mineskin_rate_limited, ...)
    reason_text: string | null;          // the same in a plain sentence
    variant: 'classic' | 'slim';
    skin_name: string | null;            // the name SkinsRestorer knows it by
    image_url: string | null;            // the uploaded PNG, for the preview
    height: number | null;               // 64 or 32: which layout the PNG has
    texture_url: string | null;          // the texture's address outside, shown labelled Public
}

// The reasons the skin service and the signer name, in a sentence. A reason that is not here is shown by its name alone.
export const REASON_TEXT: Readonly<Record<string, string>> = Object.freeze({
    no_api_key: 'The MineSkin API key is not set.',
    no_signer: 'No signing service is set up.',
    mineskin_rate_limited: 'MineSkin\'s rate limit was reached. Upload again later.',
    mineskin_timeout: 'MineSkin did not answer in time.',
    mineskin_unreachable: 'MineSkin could not be reached.',
    mineskin_key_refused: 'MineSkin refused the API key.',
    mineskin_refused: 'MineSkin refused the skin.',
    mineskin_error: 'MineSkin failed.',
    mineskin_bad_answer: 'MineSkin answered without a signed texture.',
    no_rcon: 'The Minecraft server\'s console is not reachable (no RCON password).',
    rcon_error: 'The Minecraft server\'s console did not take the command.',
    refused: 'SkinsRestorer refused the command.',
    mindserver_not_connected: 'The agents\' side is not connected.',
    skin_service_did_not_answer: 'The skin service did not answer.',
});

const TEXTURE_URL = /^https:\/\/textures\.minecraft\.net\/texture\/[0-9a-f]{20,80}$/;
const NAME = /^[A-Za-z0-9_]{3,16}$/;

// One card per agent of the roster, in its order; a stored skin of someone who is not on the roster is not shown.
export function skinCards(roster: { name: string; role?: string }[], answer: SkinsAnswer | null): SkinCard[] {
    const rows = new Map((answer?.skins ?? []).map((row) => [row.agent, row]));
    return roster.filter((entry) => NAME.test(entry.name)).map((entry) => {
        const row = rows.get(entry.name) ?? null;
        if (!row) {
            return {
                agent: entry.name, role: entry.role ?? '', state: 'none' as const, tag: 'None', when_label: 'Applied', at: null, set_by: null, reason: null, reason_text: null,
                variant: 'classic' as const, skin_name: null, image_url: null, height: null, texture_url: null,
            };
        }
        const state: CardState = row.state === 'applied' || row.state === 'failed' ? row.state : 'stored';
        const reason = state === 'failed' ? String(row.detail ?? 'unknown').slice(0, 80) : null;
        const texture = typeof row.texture_url === 'string' && TEXTURE_URL.test(row.texture_url) ? row.texture_url : null;
        return {
            agent: entry.name, role: entry.role ?? '', state,
            tag: state === 'applied' ? 'Applied' : state === 'failed' ? 'Failed' : 'Stored',
            when_label: state === 'applied' ? 'Applied' : state === 'failed' ? 'Failed' : 'Stored',
            at: row.state_at ?? row.set_at ?? null, set_by: row.set_by || 'Operator',
            reason, reason_text: reason === null ? null : REASON_TEXT[reason] ?? (row.message ? String(row.message).slice(0, 200) : null),
            variant: row.variant === 'slim' ? 'slim' as const : 'classic' as const,
            skin_name: `genesis_${entry.name.toLowerCase()}`,
            image_url: `/api/skins/${encodeURIComponent(entry.name)}/image?v=${encodeURIComponent(String(row.sha256 ?? '').slice(0, 12))}`,
            height: row.height === 32 ? 32 : 64,
            // a failed signing has no texture outside; one that failed after it (the game refused the command) still has
            texture_url: texture,
        };
    });
}

// The header's counts: how many agents have a skin applied, how many failed.
export function skinCounts(cards: SkinCard[]): { set: number; failed: number } {
    return { set: cards.filter((card) => card.state === 'applied').length, failed: cards.filter((card) => card.state === 'failed').length };
}

// May a skin be uploaded right now, and if not, what is shown instead of the control's file name?
//   key_set false: disabled, and the env key's name is shown
//   key_set null:  not known (the skin service did not say): the upload is allowed, the server decides
export function uploadGate(signing: Signing | null | undefined): { enabled: boolean; note: string | null; key_env: string | null } {
    if (signing && signing.key_set === false) {
        const key_env = /^[A-Z0-9_]{3,60}$/.test(signing.key_env) ? signing.key_env : 'GENESIS_MINESKIN_API_KEY';
        return { enabled: false, note: `${key_env} is not set`, key_env };
    }
    return { enabled: true, note: null, key_env: null };
}

// A file the operator picked: is it worth sending? (the server checks the image itself; this only spares a round trip)
export function fileProblem(file: { type: string; size: number; name: string }, limits: { max_bytes: number } | null | undefined): string | null {
    if (file.type !== 'image/png' && !/\.png$/i.test(file.name)) return 'A PNG file is expected.';
    if (file.size === 0) return 'The file is empty.';
    const max = limits?.max_bytes ?? 64 * 1024;
    if (file.size > max) return `The file is larger than ${Math.round(max / 1024)} KiB.`;
    return null;
}

// ---- the preview: the front of the figure, cut from the skin's own layout --------------------
// The figure is 16 wide and 32 high (in skin pixels): head 8x8, body 8x12, arms 4x12 (3x12 for
// the slim model), legs 4x12. Each part is a rectangle of the skin image drawn at a place of the
// figure; the outer layer (hat, jacket, sleeves, trousers) is drawn over it where the layout has
// one. The old 64 by 32 layout has no left arm or leg of its own: the right ones are mirrored.
export interface SkinPart { part: string; sx: number; sy: number; w: number; h: number; dx: number; dy: number; mirror?: boolean; overlay?: boolean }
export const FIGURE = Object.freeze({ width: 16, height: 32 });

export function skinParts(height: number, variant: string): SkinPart[] {
    const arm = variant === 'slim' ? 3 : 4;
    const right_arm_x = 4 - arm;          // the right arm ends at the body's left edge
    const parts: SkinPart[] = [
        { part: 'head', sx: 8, sy: 8, w: 8, h: 8, dx: 4, dy: 0 },
        { part: 'body', sx: 20, sy: 20, w: 8, h: 12, dx: 4, dy: 8 },
        { part: 'right_arm', sx: 44, sy: 20, w: arm, h: 12, dx: right_arm_x, dy: 8 },
        { part: 'right_leg', sx: 4, sy: 20, w: 4, h: 12, dx: 4, dy: 20 },
    ];
    if (height === 32) {
        parts.push({ part: 'left_arm', sx: 44, sy: 20, w: arm, h: 12, dx: 12, dy: 8, mirror: true });
        parts.push({ part: 'left_leg', sx: 4, sy: 20, w: 4, h: 12, dx: 8, dy: 20, mirror: true });
        parts.push({ part: 'hat', sx: 40, sy: 8, w: 8, h: 8, dx: 4, dy: 0, overlay: true });
        return parts;
    }
    parts.push({ part: 'left_arm', sx: 36, sy: 52, w: arm, h: 12, dx: 12, dy: 8 });
    parts.push({ part: 'left_leg', sx: 20, sy: 52, w: 4, h: 12, dx: 8, dy: 20 });
    parts.push({ part: 'hat', sx: 40, sy: 8, w: 8, h: 8, dx: 4, dy: 0, overlay: true });
    parts.push({ part: 'jacket', sx: 20, sy: 36, w: 8, h: 12, dx: 4, dy: 8, overlay: true });
    parts.push({ part: 'right_sleeve', sx: 44, sy: 36, w: arm, h: 12, dx: right_arm_x, dy: 8, overlay: true });
    parts.push({ part: 'left_sleeve', sx: 52, sy: 52, w: arm, h: 12, dx: 12, dy: 8, overlay: true });
    parts.push({ part: 'right_trouser', sx: 4, sy: 36, w: 4, h: 12, dx: 4, dy: 20, overlay: true });
    parts.push({ part: 'left_trouser', sx: 4, sy: 52, w: 4, h: 12, dx: 8, dy: 20, overlay: true });
    return parts;
}
