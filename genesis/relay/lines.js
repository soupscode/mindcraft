// Genesis: the spoken line of an agent message. The structured message is what counts; the
// line is only how it is shown in the Minecraft chat (decided).
//
//   templateLine(message)        the line made by code. Used when the model is away, when the
//                                agent's line budget is spent, and whenever a model line is refused.
//   lineMessages(...)            the small prompt for ONE in-character line from the model
//   lineSchema()                 its structured reply: { "line": "..." }
//   validateLine(line, message)  a model line is only spoken when it says what the message
//                                says: the same item, the same count, one short sentence, and
//                                nothing that could be read as a command. Otherwise the
//                                template is used. The line never changes the structured content:
//                                nothing here, or anywhere, writes a line back into a message body.
// No imports.

export const LINE_LIMITS = Object.freeze({
    max_chars: 140,        // proposed: one chat line (Minecraft takes 256 characters)
    max_tokens: 60,        // proposed: the model's own token limit for a line (Ollama's num_predict)
    timeout_ms: 15 * 1000, // proposed: a line that takes longer is not waited for
});

const words = (item) => String(item ?? '').split('_').filter(Boolean);
// Things that are counted get a plural; everything else ("bread", "wheat", "cobblestone") stays as it is.
const COUNTED = /(log|stick|torch|pickaxe|axe|hoe|sword|shovel|chest|carrot|potato|ingot|block|brick|slab|door|bucket|sapling|mushroom|pumpkin|seed|table|furnace)$/;
const plural = (text, count) => (count === 1 || !COUNTED.test(text) ? text : `${text}${/(ch|sh|s|x|o)$/.test(text) ? 'es' : 's'}`);
// "oak_log", 24 -> "24 oak logs"
export function itemText(item, count = null) {
    const name = words(item).join(' ');
    return Number.isFinite(count) ? `${count} ${plural(name, count)}` : name;
}
const short = (text, max = 60) => { const value = String(text ?? '').replace(/\s+/g, ' ').trim(); return value.length <= max ? value : `${value.slice(0, max - 1)}…`; };

// The line made by code. Always one sentence, always within the limit, never a command.
export function templateLine(message) {
    const { to, type } = message;
    const body = message.body ?? {};
    const what = body.item ? itemText(body.item, Number.isFinite(body.count) ? body.count : null) : null;
    // "for the hall walls" when the reason reads like that; a goal's title goes in brackets
    const reason = body.reason ? short(body.reason, 40) : null;
    const why = reason === null ? '' : (/^(the|a|an|my|our|your)\s/i.test(reason) ? ` for ${reason}` : ` (${reason})`);
    const where = body.chest ? ` from the ${body.chest} chest` : '';
    let line;
    switch (type) {
        case 'request': line = what ? `${to}, I need ${what}${where}${why}.` : `${to}, I need your help${why}.`; break;
        case 'offer': line = what ? `${to}, I can give you ${what}.` : `${to}, I can help you.`; break;
        case 'accept': line = what ? `${to}, yes, ${what} ${body.count === 1 ? 'is' : 'are'} yours.` : `${to}, yes.`; break;
        case 'decline': line = what ? `${to}, sorry, I cannot spare ${what}.` : `${to}, sorry, no.`; break;
        case 'warn': line = `${to}, careful: ${short(body.text ?? body.about ?? 'something is wrong', 80)}${what ? ` (${what})` : ''}.`; break;
        default:
            if (what && body.handoff === 'direct') line = `${to}, here ${body.count === 1 ? 'is' : 'are'} ${what}.`;
            else if (what) line = `${to}, ${what} ${body.count === 1 ? 'is' : 'are'} in the ${body.chest ?? 'shared'} chest for you.`;
            else line = `${to}, ${short(body.text ?? 'noted', 90)}.`;
    }
    return line.replace(/^[/!]+/, '').slice(0, LINE_LIMITS.max_chars);
}

// Why a line may not be spoken for this message, or null when it may.
export function lineProblem(line, message, limits = LINE_LIMITS) {
    if (typeof line !== 'string') return 'not_text';
    const text = line.trim();
    if (text.length === 0) return 'empty';
    if (text.length > limits.max_chars) return 'too_long';
    if (/[\r\n]/.test(text)) return 'more_than_one_line';
    // never anything the game or an agent could take for a command
    if (/^\s*\//.test(text) || /(^|\s)![A-Za-z]/.test(text)) return 'looks_like_a_command';
    const body = message?.body ?? {};
    // the numbers: every one in the line must be a number of the message, and the count must be there
    const allowed = new Set(Object.values(body).filter((value) => Number.isFinite(value)).map((value) => String(value)));
    const said = text.match(/\d+(?:[.,]\d+)?/g) ?? [];
    if (said.some((number) => !allowed.has(number))) return 'number_changed';
    if (Number.isFinite(body.count) && !said.includes(String(body.count))) return 'count_missing';
    // the item: every word of its name must be in the line ("oak_log" -> "oak" and "log", "logs" counts)
    if (typeof body.item === 'string' && body.item.length > 0) {
        const lower = text.toLowerCase();
        for (const word of words(body.item)) {
            if (!new RegExp(`(^|[^a-z])${word.replace(/[^a-z0-9]/g, '')}(s|es)?([^a-z]|$)`).test(lower)) return 'item_changed';
        }
    }
    return null;
}

export const validateLine = (line, message, limits = LINE_LIMITS) => lineProblem(line, message, limits) === null;

// The reply the model is asked for.
export function lineSchema(limits = LINE_LIMITS) {
    return { type: 'object', properties: { line: { type: 'string', maxLength: limits.max_chars } }, required: ['line'], additionalProperties: false };
}

// Reads the model's reply. Returns the line, or null when the reply is not { "line": "..." }.
export function parseLineReply(raw) {
    try {
        const parsed = JSON.parse(String(raw));
        return typeof parsed?.line === 'string' ? parsed.line.trim() : null;
    } catch {
        return null;
    }
}

// The prompt for one line. `role` is the speaker's role ("builder"), `template` the line made by code.
export function lineMessages({ message, role = null, template, limits = LINE_LIMITS }) {
    const system = [
        'You write ONE line of in-game chat for a character in a Minecraft village.',
        `Reply with JSON only: {"line": "..."}. One sentence, at most ${limits.max_chars} characters, in the character's own voice.`,
        'Say exactly what the message says: the same item, the same count as digits, the same person addressed. Add no other numbers.',
        'Never write a command: nothing that starts with "/" or "!".',
    ].join('\n');
    const user = [
        `Speaker: ${message.from}${role ? `, the ${role}` : ''}. Speaking to: ${message.to}.`,
        `Message (${message.type}): ${JSON.stringify(message.body ?? {})}`,
        `Plain version: ${template}`,
    ].join('\n');
    return [{ role: 'system', content: system }, { role: 'user', content: user }];
}
