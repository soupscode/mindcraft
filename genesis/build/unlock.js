// Genesis building: the one earned ladder. Everything else an agent can do is open from the
// start (decided); only bigger builds are earned.
//
// THE UNLOCK RULE. A prefab is OPEN to a builder when all of this holds:
//   1. every block of it is something the catalog can obtain (else: "Not buildable yet")
//   2. it is the builder's to build: a home prefab is for anyone (on their own plot); shared and
//      bridge prefabs are Arthur's (decided: everyone builds and upgrades their own home, Arthur
//      also builds the shared and large projects)
//   3. the builder has a VERIFIED build of the tier below, of any kind. Tiers 0 and 1 need none.
//   4. the town holds the WHOLE FIRST STAGE of its materials (decided): counted from the shared
//      chest ledger plus the builder's inventory, which the caller adds up into `stock`
//   -> { state: 'open' | 'locked' | 'not_buildable', code, reason, needs, short }
//      reason is the exact sentence the Town view shows: "Needs Cabin", "Short 49 oak_slab", "Materials ready".
//
// An operator's prefab gets its tier from its size (tierFor) and is earned the same way.
//
// ladderView / projectView / homesView shape what the Town screen (mock-up Town.dc.html)
// shows of this. The screen itself is not built here.
//
// Depends only on other files of genesis/build.

import { stageBills, unobtainable, billOf, prefabSize } from './prefab.js';
import { shortfall, remainingBill } from './verify.js';

export const SHARED_BUILDER = 'Arthur';
export const OPEN_FROM_START = 1;       // tiers 0 and 1 need no earlier build

// The highest tier a builder has verified, or -1. builds: [{ builder, tier, verified_at }].
export function highestVerified(builds, builder) {
    return builds.filter((b) => b.builder === builder && b.verified_at).reduce((top, b) => Math.max(top, b.tier), -1);
}

// The prefab the "Needs ..." sentence names: the tier below, of the same kind when there is one.
function tierBelow(prefab, ladder) {
    if (prefab.upgrade_of) { const named = ladder.find((p) => p.name === prefab.upgrade_of); if (named) return named; }
    const below = ladder.filter((p) => p.tier === prefab.tier - 1);
    return below.find((p) => p.kind === prefab.kind) ?? below.find((p) => p.kind !== 'bridge') ?? below[0] ?? null;
}

export function unlockState({ prefab, builder, builds = [], stock = {}, ladder = [], obtainable = () => true, shared_builder = SHARED_BUILDER }) {
    const missing = unobtainable(prefab, obtainable);
    if (missing.length > 0) return { state: 'not_buildable', code: 'not_buildable', reason: `Not buildable yet: ${missing.join(', ')}`, needs: null, short: null, blocks: missing };
    if (prefab.kind !== 'home' && builder !== shared_builder) {
        return { state: 'locked', code: 'not_yours', reason: `${shared_builder} builds the shared projects`, needs: null, short: null };
    }
    if (prefab.tier > OPEN_FROM_START && highestVerified(builds, builder) < prefab.tier - 1) {
        const below = tierBelow(prefab, ladder);
        return { state: 'locked', code: 'needs_tier', reason: `Needs ${below?.title ?? `a tier ${prefab.tier - 1} build`}`, needs: below?.name ?? null, short: null };
    }
    const first = stageBills(prefab)[0];
    const short = shortfall(first.materials, stock);
    const items = Object.keys(short).sort((a, b) => short[b] - short[a] || a.localeCompare(b));
    if (items.length > 0) {
        return { state: 'locked', code: 'town_short', reason: `Short ${short[items[0]]} ${items[0]}${items.length > 1 ? ` and ${items.length - 1} more` : ''}`, needs: null, short, stage: first.name };
    }
    return { state: 'open', code: 'open', reason: 'Materials ready', needs: null, short: null, stage: first.name };
}

// The tier of a prefab that is not on the generated ladder: the lowest tier whose biggest
// generated prefab is at least as big, in cells and in every dimension of its footprint and
// height. Bigger than everything: one above the top.  (Proposed. The mock-up's sample
// "Clock tower", 386 cells, is shown as tier 3; by this rule it is tier 4, because the
// biggest tier 3 prefab has 244 cells.)
export function tierFor(prefab, ladder) {
    const size = prefabSize(prefab);
    const cells = billOf(prefab).cells;
    const tiers = [...new Set(ladder.map((p) => p.tier))].sort((a, b) => a - b);
    for (const tier of tiers) {
        const of_tier = ladder.filter((p) => p.tier === tier && p.kind !== 'bridge');
        if (of_tier.length === 0) continue;
        const max = (pick) => Math.max(...of_tier.map(pick));
        const footprint = Math.max(max((p) => prefabSize(p).x), max((p) => prefabSize(p).z));
        if (cells <= max((p) => billOf(p).cells) && Math.max(size.x, size.z) <= footprint) return tier;
    }
    return (tiers.at(-1) ?? 0) + 1;
}

const STATE_WORD = { open: 'Open', locked: 'Locked', not_buildable: 'Not buildable' };

// The ladder as the Town view shows it, for one builder's eyes (Arthur's for the shared ones).
//   prefabs   every prefab, generated and operator      builds   rows of `builds` with their tier
//   stock     ({ builder, prefab }) -> { item: count }, or one { item: count } for all
//   active    [{ prefab, builder, cells_matching, cells_total }]   builds under way
export function ladderView({ prefabs, builds = [], stock = {}, active = [], obtainable = () => true, builder_for = (prefab) => (prefab.kind === 'home' ? null : SHARED_BUILDER), viewer = SHARED_BUILDER }) {
    const generated = prefabs.filter((p) => p.by === 'Generated');
    const entries = prefabs.map((prefab) => {
        const builder = builder_for(prefab) ?? viewer;
        const mine = typeof stock === 'function' ? stock({ builder, prefab }) : stock;
        const unlock = unlockState({ prefab, builder, builds, stock: mine, ladder: generated, obtainable });
        const under_way = active.find((a) => a.prefab === prefab.name);
        const built = builds.filter((b) => b.prefab === prefab.name && b.verified_at).length;
        const state = under_way ? 'Building' : STATE_WORD[unlock.state];
        return {
            name: prefab.name, title: prefab.title ?? prefab.name, tier: prefab.tier, kind: prefab.kind, by: prefab.by,
            size: prefabSize(prefab), cells: billOf(prefab).cells, state, built,
            detail: under_way ? `${under_way.cells_matching} / ${under_way.cells_total}` : unlock.state === 'open' ? `Built ${built}` : unlock.reason,
            unlock,
        };
    }).sort((a, b) => a.tier - b.tier || a.cells - b.cells);
    const count = (list, state) => list.filter((e) => e.state === state).length;
    const split = (by) => { const list = entries.filter((e) => e.by === by); return { list, open: count(list, 'Open'), building: count(list, 'Building'), locked: count(list, 'Locked'), not_buildable: count(list, 'Not buildable') }; };
    return { generated: split('Generated'), operator: split('Operator') };
}

// One build under way: the project panel.
//   build   the `builds` row      survey   surveyBuild()      stock   { item: count } the town holds for it
//   asked   { item: agent }  who was asked for what (from the message desk; left out: nothing is shown as asked)
export function projectView({ prefab, build, survey, stock = {}, asked = {}, verification = null, next = null }) {
    const still = remainingBill(prefab, survey);
    const total = billOf(prefab).materials;
    const materials = Object.keys(total).sort((a, b) => (still[b] ?? 0) - (still[a] ?? 0) || a.localeCompare(b)).map((item) => {
        const need = still[item] ?? 0;
        const have = stock[item] ?? 0;
        const short = Math.max(0, need - have);
        return { item, need, have, short, state: short === 0 ? 'Ready' : asked[item] ? `Asked ${asked[item]}` : 'Short' };
    });
    return {
        build_id: build?.build_id ?? null, prefab: prefab.name, title: prefab.title ?? prefab.name, kind: prefab.kind, tier: prefab.tier, by: prefab.by,
        plot: build?.plot ?? null, builder: build?.builder ?? null, size: prefabSize(prefab),
        state: build?.verified_at ? 'Verified' : survey.matching > 0 ? 'Building' : 'Not started',
        cells: { done: survey.matching, total: survey.total },
        stage: survey.stage,
        stages: survey.stages.map((s) => ({ name: s.name, done: s.matching, total: s.total, label: 'Computed' })),
        materials,
        verified: build?.verified_at ? { at: build.verified_at, day: build.verified_day ?? null } : null,
        verification: verification?.state ?? null,
        check: 'By name',
        next,
    };
}

// The homes panel: for each agent its verified home and what comes next.
//   homes   { agent: { plot, prefab } }  the agent's last verified home (or none)
export function homesView({ agents, roles = {}, plots = {}, builds = [], prefabs, stock = {}, active = [], obtainable = () => true }) {
    const generated = prefabs.filter((p) => p.by === 'Generated');
    const home_tiers = generated.filter((p) => p.kind === 'home').sort((a, b) => a.tier - b.tier);
    return agents.map((agent) => {
        const mine = builds.filter((b) => b.builder === agent && b.verified_at && home_tiers.some((p) => p.name === b.prefab)).sort((a, b) => b.tier - a.tier)[0] ?? null;
        const current = mine ? home_tiers.find((p) => p.name === mine.prefab) : null;
        const next = home_tiers.find((p) => p.tier > (current?.tier ?? -1)) ?? null;
        const under_way = next ? active.find((a) => a.prefab === next.name && a.builder === agent) : null;
        const unlock = next ? unlockState({ prefab: next, builder: agent, builds, stock: typeof stock === 'function' ? stock({ builder: agent, prefab: next }) : stock, ladder: generated, obtainable }) : null;
        return {
            agent, role: roles[agent] ?? null, plot: plots[agent] ?? mine?.plot ?? null,
            home: current ? { tier: current.tier, prefab: current.name, title: current.title, verified_day: mine.verified_day ?? null, state: 'Verified', bed: current.bed ?? null, chest: current.keeps?.[0] ?? null } : null,
            next: next ? {
                prefab: next.name, title: next.title,
                state: under_way ? 'Building' : STATE_WORD[unlock.state],
                detail: under_way ? `${under_way.cells_matching} / ${under_way.cells_total}` : unlock.reason,
            } : null,
        };
    });
}
