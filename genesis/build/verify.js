// Genesis building: is a build what its prefab says, cell by cell, BY BLOCK NAME.
//
// The world is the truth: nothing about a build's cells is stored, every question is
// answered by looking at the blocks again.
//
//   surveyBuild({ prefab, origin, blockAt })
//       origin    the world position of the prefab's corner cell (x 0, layer 0, z 0): prefabOrigin(plot.min, prefab)
//       blockAt   ({ x, y, z }) -> { name } | null (null: not loaded)      the world view's blockAt
//     -> { total, matching, wrong [{ x, y, z, want, have }], blocked [{ x, y, z, have }] (a cell to keep clear that is not),
//          unloaded, stages [{ name, total, matching }], stage (the earliest unfinished one, or null), complete }
//
//   createVerifier({ clock }).check(build_id, survey, { scaffold })
//       "Finished" means: every prefab cell matches by block name, every cell to keep clear is
//       clear, nothing is unloaded, no tracked scaffold block is left, AND the same holds again
//       at least 60 seconds later. Only then is the build verified.
//
// WHAT IS NOT VERIFIED: which way a block faces, whether a slab is the upper or the lower
// half, whether a door is open. The bot cannot control them and the survey reads names only,
// so the Town view says "Verified by name". A torch the bot put on the side of a block is a
// wall_torch by name: it is accepted for a torch (EQUIVALENT below), because the bot cannot
// choose which of the two a placed torch becomes.
//
// Depends only on genesis/build/prefab.js and genesis/catalog/ops.js (what counts as empty).

import { prefabCells, clearCells, stagesOf, billOfCells } from './prefab.js';
import { isEmptyBlock } from '../catalog/ops.js';

export const VERIFY_WAIT_MS = 60 * 1000;

// Other names a wanted block may have in the world. dirt: what upstream's blockSatisfied accepts.
export const EQUIVALENT = Object.freeze({ dirt: ['grass_block'], torch: ['wall_torch'] });

export const matches = (want, have, equivalent = EQUIVALENT) => have === want || (equivalent[want] ?? []).includes(have);

// The world position of the prefab's corner cell on a plot: layers under ground level go down from the plot's floor.
export function prefabOrigin(plot_min, prefab) {
    return { x: plot_min.x, y: plot_min.y - (prefab.below ?? 0), z: plot_min.z };
}

export function surveyBuild({ prefab, origin, blockAt, equivalent = EQUIVALENT }) {
    const stages = stagesOf(prefab).map((stage) => ({ name: stage.name, total: 0, matching: 0 }));
    const survey = { total: 0, matching: 0, wrong: [], blocked: [], unloaded: 0, stages, stage: null, complete: false };
    const world = (cell) => ({ x: origin.x + cell.x, y: origin.y + cell.y, z: origin.z + cell.z });
    for (const cell of prefabCells(prefab)) {
        const pos = world(cell);
        const stage = stages[cell.stage];
        survey.total++;
        if (stage) stage.total++;
        const block = blockAt(pos);
        if (!block) { survey.unloaded++; continue; }
        if (matches(cell.want, block.name, equivalent)) { survey.matching++; if (stage) stage.matching++; continue; }
        survey.wrong.push({ ...pos, want: cell.want, have: block.name, stage: cell.stage, cell });
    }
    // (decided: the owner's bed is furniture in the two cells a home keeps clear for it: a bed there blocks nothing)
    const bed_place = new Set((prefab.bed ? [prefab.bed.head, prefab.bed.foot] : []).map(([x, y, z]) => `${x},${y},${z}`));
    for (const cell of clearCells(prefab)) {
        const pos = world(cell);
        const block = blockAt(pos);
        if (!block) { survey.unloaded++; continue; }
        if (isEmptyBlock(block.name) || (bed_place.has(`${cell.x},${cell.y},${cell.z}`) && block.name.endsWith('_bed'))) continue;
        survey.blocked.push({ ...pos, have: block.name });
    }
    const unfinished = stages.find((stage) => stage.matching < stage.total);
    survey.stage = unfinished?.name ?? null;
    survey.complete = survey.unloaded === 0 && survey.wrong.length === 0 && survey.blocked.length === 0 && survey.matching === survey.total;
    return survey;
}

// What the cells that do not match yet still need: { item: count }, for the whole build or one stage.
export function remainingBill(prefab, survey, stage_name = null) {
    const index = stage_name === null ? null : stagesOf(prefab).findIndex((stage) => stage.name === stage_name);
    const cells = survey.wrong.filter((w) => index === null || w.stage === index).map((w) => w.cell);
    return billOfCells(cells, prefab.parts);
}

// { item: missing } for a bill against what is there ({ item: count }); {} when nothing is short.
export function shortfall(bill, stock = {}) {
    const short = {};
    for (const [item, need] of Object.entries(bill)) if ((stock[item] ?? 0) < need) short[item] = need - (stock[item] ?? 0);
    return short;
}

export function createVerifier({ clock = { now: () => Date.now() }, wait_ms = VERIFY_WAIT_MS } = {}) {
    const first_pass = new Map();   // build_id -> when the first full survey passed
    return {
        // -> { state: 'not_finished' | 'first_pass' | 'waiting' | 'verified', reason, verified_at? }
        check(build_id, survey, { scaffold = 0 } = {}) {
            const now = clock.now();
            const why = survey.unloaded > 0 ? `${survey.unloaded} cells are not loaded`
                : survey.wrong.length > 0 ? `${survey.wrong.length} cells do not match (first: wants ${survey.wrong[0].want}, has ${survey.wrong[0].have})`
                    : survey.blocked.length > 0 ? `${survey.blocked.length} cells that must be clear hold something (first: ${survey.blocked[0].have})`
                        : scaffold > 0 ? `${scaffold} scaffold blocks still stand` : null;
            if (why !== null) {
                first_pass.delete(build_id);       // whatever passed before no longer counts
                return { state: 'not_finished', reason: why };
            }
            const first = first_pass.get(build_id);
            if (first === undefined) {
                first_pass.set(build_id, now);
                return { state: 'first_pass', reason: `every cell matches by name; to be checked again in ${Math.round(wait_ms / 1000)} seconds` };
            }
            if (now - first < wait_ms) return { state: 'waiting', reason: `the second check is due in ${Math.ceil((wait_ms - (now - first)) / 1000)} seconds` };
            first_pass.delete(build_id);
            return { state: 'verified', reason: `every cell matched by name twice, ${Math.round((now - first) / 1000)} seconds apart`, verified_at: now };
        },
        forget(build_id) { first_pass.delete(build_id); },
    };
}
