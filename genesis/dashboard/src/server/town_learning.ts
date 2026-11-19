// The Learning and Town screens. Their data is not in the event stream: the learner and the
// town live in the MindServer process (genesis/learning/service.js, genesis/town/server.js),
// and this asks them over the socket the dashboard already has. Nothing is computed here and
// nothing is made up: without the MindServer the screens say so.
//
// What the operator can do from here (decided):
//   learning   freeze, unfreeze, roll back to a version
//   town       move or remove a plot or bridge that code proposed; set or lift an agent's long-term goals;
//              upload a schematic, which is converted to a prefab, checked for blocks the agents cannot
//              get, and given a tier by its cells and footprint
// Model-written code is not among them and cannot be reached from any of them.

import type { MindLink } from './controls.js';

export const UPLOAD_LIMIT_BYTES = 2 * 1024 * 1024;       // a schematic: the same cap the town service applies
const NAME = /^[A-Za-z0-9_-]{1,40}$/;
const BLOCK = /^[a-z0-9_]{1,60}$/;

export type Answer = { ok: true; [key: string]: any } | { ok: false; status: number; error: string; [key: string]: any };

export function createTownLearning({ link }: { link: MindLink | null }) {
    const ask = async (event: string, arg: any, timeout_ms = 8000): Promise<any> => {
        if (!link || !link.connected()) return { ok: false, reason: 'mindserver_not_connected' };
        try { return (await link.ask(event, arg, timeout_ms)) ?? { ok: false, reason: 'no_answer' }; } catch (err: any) {
            return { ok: false, reason: String(err?.message ?? err).includes('did not answer') ? 'the service did not answer (is learning or the town switched off?)' : String(err?.message ?? err) };
        }
    };
    const fail = (answer: any, status = 502): Answer => ({ ok: false, status: answer?.reason === 'mindserver_not_connected' ? 503 : status, error: String(answer?.reason ?? 'no answer').slice(0, 300), ...(answer?.report ? { report: answer.report } : {}), ...(answer?.problems ? { problems: answer.problems } : {}), ...(answer?.prefab ? { prefab: answer.prefab } : {}) });
    const whole = (value: unknown): value is number => Number.isInteger(value) && Math.abs(value as number) < 30000000;

    return {
        async learning(): Promise<Answer> {
            const got = await ask('genesis-learning-view', {});
            return got?.ok === true && got.view ? { ok: true, view: got.view } : fail(got);
        },
        async learningControl(body: any): Promise<Answer> {
            const action = body?.action;
            if (!['freeze', 'unfreeze', 'rollback'].includes(action)) return { ok: false, status: 400, error: 'action must be freeze, unfreeze or rollback' };
            if (action === 'rollback' && body.v !== undefined && !(whole(body.v) && body.v >= 0)) return { ok: false, status: 400, error: 'v must be a version number' };
            const got = await ask('genesis-learning-control', { action, ...(whole(body?.v) ? { v: body.v } : {}) });
            return got?.ok === true ? { ok: true, ...got } : fail(got, 409);
        },
        async town(): Promise<Answer> {
            const got = await ask('genesis-town-view', {});
            return got?.ok === true && got.view ? { ok: true, view: got.view } : fail(got);
        },
        // Move or remove a plot or bridge code proposed.
        async proposal(id: string, body: any): Promise<Answer> {
            if (!NAME.test(id)) return { ok: false, status: 400, error: 'bad id' };
            const action = body?.action;
            if (action === 'remove') {
                const got = await ask('genesis-town-operator', { kind: 'remove', id });
                return got?.ok === true ? { ok: true, id } : fail(got, 409);
            }
            if (action === 'move') {
                const min = body.min;
                if (!Array.isArray(min) || min.length !== 3 || !min.every(whole)) return { ok: false, status: 400, error: 'min must be [x, y, z] in whole blocks' };
                const got = await ask('genesis-town-operator', { kind: 'move', id, min });
                return got?.ok === true ? { ok: true, id } : fail(got, 409);
            }
            return { ok: false, status: 400, error: 'action must be move or remove' };
        },
        // An agent's long-term goals: 1 to 3 titles, or null to give them back to the agent.
        async goals(agent: string, body: any): Promise<Answer> {
            if (!/^[A-Za-z0-9_]{1,32}$/.test(agent)) return { ok: false, status: 400, error: 'bad agent' };
            const titles = body?.titles;
            if (titles !== null && !(Array.isArray(titles) && titles.length >= 1 && titles.length <= 3 && titles.every((title) => typeof title === 'string' && title.trim().length > 0 && title.length <= 200))) {
                return { ok: false, status: 400, error: 'titles must be 1 to 3 goals, or null to lift the override' };
            }
            const got = await ask('genesis-town-operator', { kind: 'goal', agent, titles });
            return got?.ok === true ? { ok: true, agent, titles: got.titles ?? null } : fail(got, 409);
        },
        // A schematic the operator uploads. `file` is the file's bytes; nothing of it is read here.
        async importPrefab(file: unknown, query: Record<string, unknown>): Promise<Answer> {
            if (!Buffer.isBuffer(file) || file.length === 0) return { ok: false, status: 400, error: 'send the schematic file as the body' };
            if (file.length > UPLOAD_LIMIT_BYTES) return { ok: false, status: 413, error: `the file is larger than ${UPLOAD_LIMIT_BYTES / 1024 / 1024} MB` };
            const name = String(query.name ?? '');
            if (!NAME.test(name)) return { ok: false, status: 400, error: 'a prefab name is letters, digits, _ and -, at most 40' };
            const kind = query.kind === 'home' ? 'home' : 'shared';
            const substitute: Record<string, string> = {};
            if (typeof query.substitute === 'string' && query.substitute.length > 0) {
                // "stone_bricks:cobblestone,oak_stairs:oak_planks"
                for (const pair of query.substitute.slice(0, 2000).split(',')) {
                    const [from, to] = pair.split(':').map((part) => part.trim());
                    if (!BLOCK.test(from ?? '') || !BLOCK.test(to ?? '')) return { ok: false, status: 400, error: `"${pair}" is not block:block` };
                    substitute[from] = to;
                }
            }
            const got = await ask('genesis-prefab-import', {
                name, kind, title: typeof query.title === 'string' && query.title.trim().length > 0 ? query.title.trim().slice(0, 40) : null,
                file_base64: file.toString('base64'), substitute, save: query.save === '1' || query.save === 'true',
            }, 20000);
            return got?.ok === true ? { ok: true, report: got.report, prefab: got.prefab, saved: got.saved === true } : fail(got, 422);
        },
    };
}
export type TownLearning = ReturnType<typeof createTownLearning>;
