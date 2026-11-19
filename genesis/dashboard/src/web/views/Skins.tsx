// The Skins view: one card per agent with the skin's preview, the upload, the model (classic
// or slim), how applying it went and when, who set it (always the operator), the name
// SkinsRestorer knows it by, and Clear. A custom skin is sent to MineSkin to be signed (the
// agents' side does that, never this page): the address the texture then lives at is shown,
// labelled Public. Without the signing key the upload is disabled and the env key is named.

import { useEffect, useRef, useState } from 'preact/hooks';
import { setPagePills, useClient, useJson } from '../store';
import { dayTime } from '../format';
import { FIGURE, fileProblem, skinCards, skinCounts, skinParts, uploadGate, type SkinCard, type SkinsAnswer } from '../skins_data';

const SCALE = 6; // the figure is 16 by 32 skin pixels: drawn 96 by 192

// The front of the figure, cut from the uploaded PNG itself.
function Preview({ card }: { card: SkinCard }) {
    const canvas = useRef<HTMLCanvasElement>(null);
    const [broken, setBroken] = useState(false);
    useEffect(() => {
        setBroken(false);
        if (!card.image_url || !canvas.current) return undefined;
        let alive = true;
        const image = new Image();
        image.onload = () => {
            const context = alive ? canvas.current?.getContext('2d') : null;
            if (!context) return;
            context.imageSmoothingEnabled = false;
            context.clearRect(0, 0, FIGURE.width * SCALE, FIGURE.height * SCALE);
            for (const part of skinParts(image.naturalHeight === 32 ? 32 : 64, card.variant)) {
                context.save();
                if (part.mirror) {
                    context.translate((part.dx + part.w) * SCALE, part.dy * SCALE);
                    context.scale(-1, 1);
                    context.drawImage(image, part.sx, part.sy, part.w, part.h, 0, 0, part.w * SCALE, part.h * SCALE);
                } else {
                    context.drawImage(image, part.sx, part.sy, part.w, part.h, part.dx * SCALE, part.dy * SCALE, part.w * SCALE, part.h * SCALE);
                }
                context.restore();
            }
        };
        image.onerror = () => { if (alive) setBroken(true); };
        image.src = card.image_url;
        return () => { alive = false; };
    }, [card.image_url, card.variant]);
    return (
        <div class="skin-stage">
            {card.image_url && !broken
                ? <canvas ref={canvas} width={FIGURE.width * SCALE} height={FIGURE.height * SCALE} role="img" aria-label={`${card.agent}'s skin, seen from the front`} />
                : <div class="skin-empty" role="img" aria-label="No skin" />}
        </div>
    );
}

function Card({ card, answer, onChanged }: { card: SkinCard; answer: SkinsAnswer | null; onChanged: () => void }) {
    const input = useRef<HTMLInputElement>(null);
    const [variant, setVariant] = useState<'classic' | 'slim'>(card.variant);
    const [picked, setPicked] = useState<string | null>(null);
    const [busy, setBusy] = useState<'upload' | 'clear' | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    useEffect(() => { setVariant(card.variant); }, [card.variant, card.image_url]);
    const gate = uploadGate(answer?.signing);

    const upload = async (file: File) => {
        setPicked(file.name);
        const refused = fileProblem(file, answer?.limits);
        if (refused) { setProblem(refused); return; }
        setProblem(null);
        setBusy('upload');
        try {
            const response = await fetch(`/api/skins/${encodeURIComponent(card.agent)}?variant=${variant}`, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: file });
            const result = await response.json().catch(() => null);
            if (!response.ok) setProblem(String(result?.error ?? `The upload was refused (${response.status}).`));
        } catch {
            setProblem('The dashboard did not answer.');
        }
        setBusy(null);
        onChanged();
    };
    const clear = async () => {
        setBusy('clear');
        setProblem(null);
        try {
            const response = await fetch(`/api/skins/${encodeURIComponent(card.agent)}`, { method: 'DELETE' });
            if (!response.ok) setProblem(String((await response.json().catch(() => null))?.error ?? `Not cleared (${response.status}).`));
        } catch {
            setProblem('The dashboard did not answer.');
        }
        setBusy(null);
        setPicked(null);
        onChanged();
    };

    return (
        <article class={card.state === 'failed' ? 'panel skin fail' : 'panel skin'} aria-label={card.agent}>
            <div class="skin-who">
                <div class="crest" aria-hidden="true">{card.agent.charAt(0).toUpperCase()}</div>
                <div class="id"><h2>{card.agent}</h2><div class="small muted">{card.role}</div></div>
                <span class={card.state === 'applied' ? 'tag' : card.state === 'failed' ? 'tag fail' : 'tag line'}>{card.tag}</span>
            </div>
            <Preview card={{ ...card, variant }} />
            <div class="skin-upload">
                <input ref={input} type="file" accept="image/png,.png" hidden
                    onChange={(event) => { const file = (event.currentTarget as HTMLInputElement).files?.[0]; (event.currentTarget as HTMLInputElement).value = ''; if (file) upload(file); }} />
                <button type="button" class="btn solid sm" disabled={!gate.enabled || busy !== null} onClick={() => input.current?.click()}>
                    {busy === 'upload' ? 'Signing…' : 'Upload PNG'}
                </button>
                <span class="skin-file" title={picked ?? undefined}>{gate.enabled ? picked ?? '64 × 64' : ''}</span>
            </div>
            {!gate.enabled && <p class="skin-key">{gate.note}</p>}
            <div class="segment" role="group" aria-label="Model">
                {(['classic', 'slim'] as const).map((choice) => (
                    <button type="button" aria-pressed={variant === choice} disabled={busy !== null} onClick={() => setVariant(choice)}>{choice === 'classic' ? 'Classic' : 'Slim'}</button>
                ))}
            </div>
            <dl class="skin-facts">
                <div><dt>{card.when_label}</dt><dd class={card.state === 'failed' ? 'bad' : undefined}>{card.at ? dayTime(card.at) : 'never'}</dd></div>
                {card.state === 'failed'
                    ? <div><dt>Reason</dt><dd class="bad" title={card.reason_text ?? undefined}>{card.reason}</dd></div>
                    : <div><dt>Set by</dt><dd>{card.set_by ?? 'none'}</dd></div>}
            </dl>
            {card.state === 'failed' && card.reason_text && <p class="small muted">{card.reason_text}</p>}
            {problem && <p class="small skin-problem" role="alert">{problem}</p>}
            {card.texture_url && (
                <div class="skin-public">
                    <span class="tag">Public</span>
                    <a href={card.texture_url} target="_blank" rel="noreferrer noopener" title={card.texture_url}>{card.texture_url.replace(/^https:\/\//, '')}</a>
                </div>
            )}
            <div class="skin-foot">
                <span class="plain">{card.skin_name ?? ''}</span>
                <button type="button" class="btn sm" disabled={card.state === 'none' || busy !== null} onClick={clear}>{busy === 'clear' ? 'Clearing…' : 'Clear'}</button>
            </div>
        </article>
    );
}

export function Skins() {
    const { roster, live } = useClient();
    const [round, setRound] = useState(0);
    // the skin service's own events (applied, failed, cleared) bring the list up to date
    const seen = roster.map((agent) => live.agents[agent.name]?.skin?.at ?? '').join('|');
    const { data, error } = useJson<SkinsAnswer>('/api/skins', `${round}:${seen}`);
    const [kept, setKept] = useState<SkinsAnswer | null>(null);
    useEffect(() => { if (data) setKept(data); }, [data]);
    const answer = data ?? kept;
    const cards = skinCards(roster, answer);
    const counts = skinCounts(cards);
    useEffect(() => {
        setPagePills(answer ? [{ text: `${counts.set} set` }, ...(counts.failed > 0 ? [{ text: `${counts.failed} failed`, kind: 'fail' as const }] : [])] : []);
        return () => setPagePills([]);
    }, [answer === null, counts.set, counts.failed]);

    if (!answer && error) return <div class="note"><b>Skins: not available.</b> The dashboard answered {error}.</div>;
    return (
        <main class="skins" aria-label="Agents">
            {cards.map((card) => <Card key={card.agent} card={card} answer={answer} onChanged={() => setRound((n) => n + 1)} />)}
        </main>
    );
}
