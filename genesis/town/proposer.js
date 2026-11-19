// Genesis: where a new plot or a bridge goes. CODE PROPOSES (decided); the operator can move
// or remove a proposal in the dashboard. Everything here is a pure function of a survey: the
// agent that needs the plot looks at the land with its own world view and hands the heights
// in (genesis/town/tracker.js); no RCON, no WorldEdit, nothing is changed in the world.
//
//   proposePlot({ size, home, limit, taken, ranges, heightAt })
//       size       S | M | L (16, 24, 32 blocks square)
//       home       { x, y, z }   the home point: the grid is laid out from it, nearest cell first
//       limit      { min: [x, z], max: [x, z] }   the town limit
//       taken      [{ name, min: { x, z }, max: { x, z } }]   the camp, the field and every plot of both files
//       ranges     [{ agent, home: { x, z }, range }]   every corner must lie inside each of these (the owner's and the builder's)
//       heightAt   (x, z) -> { y, wet } | null     the top solid block of a column (null: not loaded, nothing is known)
//       blockedAt  (x, z) -> boolean               (optional) true for a column the builder may not clear: asked of every
//                                                   column of the best cells, so that no plot is put on a tree
//     -> { ok: true, plot: { min: [x, y, z], max: [x, y, z], size }, score: { relief, distance, columns }, looked }
//        | { ok: false, reason, looked }
//     The best cell is the flattest; among equally flat ones the nearest to home. A cell is refused when it is
//     closer than a lane (4 blocks) to anything taken, leaves the limit or a range, holds water, has a column that
//     is not loaded, or is rougher than `max_relief` (the builder levels it by hand: decided).
//
//   proposeSpan({ from, to, columnAt })
//       from, to   { x, y, z }   where the walk started and where it was going (it found no way without digging)
//       columnAt   (x, z) -> { y, wet } | null
//     -> { ok: true, span: { from: [x, y, z], to: [x, y, z], length, axis: 'x' | 'z', min, max, rotation } } | { ok: false, reason }
//     Looks along the straighter axis of the walk for the first stretch that cannot be walked (water, or a drop of
//     3 or more) with ground of about the same height on both sides, 5 to 15 blocks long.
//
// Depends only on genesis/town/town_file.js.

import { PLOT_SIZES, PLOT_HEIGHT, LANE, SPAN_WIDTH } from './town_file.js';

export const PROPOSER_RULES = Object.freeze({
    grid: 4,            // candidate corners lie on a 4-block grid from the home point
    sample: 4,          // one surveyed column every 4 blocks (the method automatic site selection uses)
    max_relief: 3,      // the land of a plot may differ this much in height: more is not levelled by hand
    span_min: 5,
    span_max: 15,
    drop: 3,            // a step down of this many blocks cannot be walked
    bank_step: 1,       // the two banks of a span may differ this much in height
});

const overlaps = (a, b, margin = 0) => a.min.x - margin <= b.max.x && b.min.x - margin <= a.max.x && a.min.z - margin <= b.max.z && b.min.z - margin <= a.max.z;
const mode = (values) => { const counts = new Map(); for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1); return [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0]; };

export function proposePlot({ size, home, limit, taken = [], ranges = [], heightAt, blockedAt = null, rules = {} } = {}) {
    const R = { ...PROPOSER_RULES, ...rules };
    const n = PLOT_SIZES[size];
    if (!n) return { ok: false, reason: 'unknown_size', looked: 0 };
    const candidates = [];
    let looked = 0;
    const refused = { taken: 0, range: 0, unloaded: 0, wet: 0, rough: 0, blocked: 0 };
    for (let x = limit.min[0]; x + n - 1 <= limit.max[0]; x++) {
        if ((((x - home.x) % R.grid) + R.grid) % R.grid !== 0) continue;
        for (let z = limit.min[1]; z + n - 1 <= limit.max[1]; z++) {
            if ((((z - home.z) % R.grid) + R.grid) % R.grid !== 0) continue;
            looked++;
            const box = { min: { x, z }, max: { x: x + n - 1, z: z + n - 1 } };
            if (taken.some((other) => overlaps(box, other, LANE))) { refused.taken++; continue; }
            const corners = [[box.min.x, box.min.z], [box.min.x, box.max.z], [box.max.x, box.min.z], [box.max.x, box.max.z]];
            if (ranges.some((r) => corners.some(([cx, cz]) => Math.hypot(cx - r.home.x, cz - r.home.z) > r.range))) { refused.range++; continue; }
            const heights = [];
            let bad = null;
            for (let sx = box.min.x; sx <= box.max.x && !bad; sx += Math.min(R.sample, n - 1)) {
                for (let sz = box.min.z; sz <= box.max.z; sz += Math.min(R.sample, n - 1)) {
                    const column = heightAt(sx, sz);
                    if (!column) { bad = 'unloaded'; break; }
                    if (column.wet) { bad = 'wet'; break; }
                    heights.push(column.y);
                }
            }
            if (bad) { refused[bad]++; continue; }
            const relief = Math.max(...heights) - Math.min(...heights);
            if (relief > R.max_relief) { refused.rough++; continue; }
            const centre = { x: x + (n - 1) / 2, z: z + (n - 1) / 2 };
            const distance = Math.hypot(centre.x - home.x, centre.z - home.z);
            const floor = mode(heights);
            candidates.push({ x, z, floor, relief, distance, columns: heights.length });
        }
    }
    // the flattest first, then the nearest; the same land always gives the same order
    candidates.sort((a, b) => a.relief - b.relief || a.distance - b.distance || a.x - b.x || a.z - b.z);
    // blockedAt(x, z) -> true for a column the builder may not clear (a tree's trunk, water between the surveyed
    // columns, land that is not loaded): the first candidate with none of those in it is taken
    let best = null;
    for (const candidate of candidates) {
        let blocked = false;
        if (typeof blockedAt === 'function') {
            for (let cx = candidate.x; cx < candidate.x + n && !blocked; cx++) for (let cz = candidate.z; cz < candidate.z + n; cz++) if (blockedAt(cx, cz)) { blocked = true; break; }
        }
        if (blocked) { refused.blocked++; continue; }
        best = candidate;
        break;
    }
    if (!best) {
        const why = Object.entries(refused).sort((a, b) => b[1] - a[1])[0];
        return { ok: false, reason: looked === 0 ? 'no_room_inside_the_limit' : `no_place: ${why[0]}`, looked, refused };
    }
    // the plot's lowest layer is the one a build stands in: the ground's top block lies one under it
    return {
        ok: true, looked,
        plot: { size, min: [best.x, best.floor + 1, best.z], max: [best.x + n - 1, best.floor + PLOT_HEIGHT, best.z + n - 1] },
        score: { relief: best.relief, distance: Math.round(best.distance * 10) / 10, columns: best.columns },
    };
}

export function proposeSpan({ from, to, columnAt, rules = {} } = {}) {
    const R = { ...PROPOSER_RULES, ...rules };
    const along = Math.abs(to.x - from.x) >= Math.abs(to.z - from.z) ? 'x' : 'z';
    const across = along === 'x' ? 'z' : 'x';
    const dir = Math.sign(to[along] - from[along]);
    if (dir === 0) return { ok: false, reason: 'nowhere_to_go' };
    const fixed = Math.round(from[across]);
    const at = (i) => (along === 'x' ? columnAt(i, fixed) : columnAt(fixed, i));
    const steps = Math.abs(Math.round(to[along]) - Math.round(from[along]));
    let last = null;        // the last column that can be stood on: { i, y }
    let gap_from = null;
    for (let s = 0; s <= steps; s++) {
        const i = Math.round(from[along]) + dir * s;
        const column = at(i);
        if (!column) return { ok: false, reason: 'not_loaded' };
        const walkable = !column.wet && (last === null || gap_from !== null || last.y - column.y < R.drop) && (last === null || gap_from !== null || column.y - last.y < R.drop);
        if (gap_from === null) {
            if (walkable) { last = { i, y: column.y }; continue; }
            if (last === null) return { ok: false, reason: 'starts_in_the_gap' };
            gap_from = last;
            continue;
        }
        // inside the gap: the far bank is the first dry column at about the near bank's height
        if (!column.wet && Math.abs(column.y - gap_from.y) <= R.bank_step) {
            const length = Math.abs(i - gap_from.i) + 1;      // from bank to bank, both ends on land
            if (length > R.span_max) return { ok: false, reason: 'too_wide' };
            const span_length = Math.max(R.span_min, length);
            const start = Math.min(gap_from.i, i) - (dir > 0 ? 0 : span_length - length);
            const half = Math.floor(SPAN_WIDTH / 2);
            // the deck lies in the layer of the banks' top blocks; the box is the deck, the rails over it and room to walk
            const y = gap_from.y;
            const lo = { [along]: start, [across]: fixed - half };
            const hi = { [along]: start + span_length - 1, [across]: fixed + half };
            return {
                ok: true,
                span: {
                    axis: along, length: span_length, rotation: along === 'x' ? 90 : 0,
                    from: along === 'x' ? [gap_from.i, y, fixed] : [fixed, y, gap_from.i], to: along === 'x' ? [i, y, fixed] : [fixed, y, i],
                    min: [lo.x, y + 1, lo.z], max: [hi.x, y + 4, hi.z],
                },
            };
        }
        if (Math.abs(i - gap_from.i) > R.span_max) return { ok: false, reason: 'too_wide' };
    }
    return { ok: false, reason: gap_from === null ? 'no_gap_on_the_way' : 'no_far_bank' };
}
