// Genesis building: from a WorldEdit schematic (.schem) to a prefab.
//
// FORMAT: UNCHECKED AGAINST A REAL FILE. This is written against the Sponge Schematic
// Specification, versions 2 and 3, as published (github.com/SpongePowered/Schematic-Specification,
// read 17 Nov 2026), and tested only against files this code itself builds to that
// specification. No file saved by WorldEdit 7.4.6 on Paper 1.21.6 has been read with it: no
// such file and no WorldEdit were available, and no library that reads schematics is
// installed (only prismarine-nbt 2.8.0, which the tests use to cross-check the NBT writer).
// Before it is relied on, convert one real //schem save and compare it with the build.
//
// What the specification says, and what this reads:
//   the file is NBT, gzip-compressed.
//   version 3: a root compound holding one compound "Schematic" with
//       Version (int 3), DataVersion (int), Width, Height, Length (short), Offset (int array, optional),
//       Blocks { Palette { "<block state>": int }, Data (byte array of varints), BlockEntities (list, optional) }
//   version 2: the root compound is the schematic itself, with
//       Version (int 2), DataVersion, Width, Height, Length, Palette, BlockData (byte array of varints), BlockEntities
//   Data holds one palette index per block as a varint, indexed  x + z * Width + y * Width * Length.
//   A block state is "minecraft:oak_stairs[facing=north,half=bottom]": the id, then properties in brackets.
//
// schemToPrefab(buffer, options) -> { prefab, report }. It never guesses; what it cannot carry
// over it reports:
//   report.unobtainable    { block: cells }   blocks the catalog cannot obtain (the prefab is then "Not buildable yet")
//   report.no_item         blocks whose item has another name or that are not items at all (water, fire); reported, kept
//   report.dropped_states  { block: [properties] }   facing, half and the like: not carried over, not verified
//   report.block_entities  how many block entities (chest contents, sign texts) were ignored
//   report.floating        cells that would be placed against nothing in build order
//   report.too_big         the footprint is larger than the largest plot (32 by 32)
//   report.needs_facing    blocks the bot cannot place the right way round (stairs, beds, wall torches)
// The tier comes from the size against the generated ladder (tierFor in unlock.js), and the
// prefab is labelled by: "Operator" with the hash of the source file.
//
// The NBT reader and writer below are the format's eleven tag types and nothing else, so
// this file needs no package. encodeNbt and buildSchematic exist for tests and tools.
//
// Depends only on Node built-ins and other files of genesis/build.

import { gunzipSync, gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { checkPrefab, billOf, prefabSize, floatingCells, needsFacing, unobtainable, PREFAB_VERSION, PREFAB_NAME } from './prefab.js';
import { tierFor } from './unlock.js';

export const SCHEMATIC_FORMAT_CHECKED = false;
export const LARGEST_PLOT = 32;
const AIR = new Set(['air', 'cave_air', 'void_air', 'structure_void']);
// blocks whose item has another name (the bill uses the item's)
export const ITEM_FOR_BLOCK = Object.freeze({ wall_torch: 'torch', redstone_wall_torch: 'redstone_torch', soul_wall_torch: 'soul_torch', tripwire: 'string', redstone_wire: 'redstone' });
const NOT_ITEMS = new Set(['water', 'lava', 'fire', 'soul_fire', 'bubble_column', 'nether_portal', 'end_portal', 'moving_piston', 'piston_head']);

// ---- NBT -------------------------------------------------------------------------------------

const TAG = { end: 0, byte: 1, short: 2, int: 3, long: 4, float: 5, double: 6, byte_array: 7, string: 8, list: 9, compound: 10, int_array: 11, long_array: 12 };

// Reads uncompressed NBT: { name, value } of the root compound. Values are plain: numbers,
// bigint for longs, strings, Buffer for a byte array, arrays, and objects for compounds.
export function decodeNbt(buffer) {
    let at = 0;
    const need = (n) => { if (at + n > buffer.length) throw new Error('the NBT data ends early'); };
    const text = () => { need(2); const n = buffer.readUInt16BE(at); at += 2; need(n); const s = buffer.toString('utf8', at, at + n); at += n; return s; };
    function payload(type) {
        switch (type) {
        case TAG.byte: need(1); return buffer.readInt8(at++);
        case TAG.short: { need(2); const v = buffer.readInt16BE(at); at += 2; return v; }
        case TAG.int: { need(4); const v = buffer.readInt32BE(at); at += 4; return v; }
        case TAG.long: { need(8); const v = buffer.readBigInt64BE(at); at += 8; return v; }
        case TAG.float: { need(4); const v = buffer.readFloatBE(at); at += 4; return v; }
        case TAG.double: { need(8); const v = buffer.readDoubleBE(at); at += 8; return v; }
        case TAG.byte_array: { need(4); const n = buffer.readInt32BE(at); at += 4; need(n); const v = buffer.subarray(at, at + n); at += n; return v; }
        case TAG.string: return text();
        case TAG.list: {
            need(5);
            const of = buffer.readUInt8(at); const n = buffer.readInt32BE(at + 1); at += 5;
            const list = [];
            for (let i = 0; i < n; i++) list.push(payload(of));
            return list;
        }
        case TAG.compound: {
            const value = {};
            for (;;) {
                need(1);
                const t = buffer.readUInt8(at++);
                if (t === TAG.end) return value;
                const key = text();
                value[key] = payload(t);
            }
        }
        case TAG.int_array: { need(4); const n = buffer.readInt32BE(at); at += 4; need(4 * n); const v = []; for (let i = 0; i < n; i++) { v.push(buffer.readInt32BE(at)); at += 4; } return v; }
        case TAG.long_array: { need(4); const n = buffer.readInt32BE(at); at += 4; need(8 * n); const v = []; for (let i = 0; i < n; i++) { v.push(buffer.readBigInt64BE(at)); at += 8; } return v; }
        default: throw new Error(`unknown NBT tag type ${type}`);
        }
    }
    need(1);
    if (buffer.readUInt8(at++) !== TAG.compound) throw new Error('NBT must start with a compound');
    const name = text();
    return { name, value: payload(TAG.compound) };
}

// Writes NBT from a typed tree: nbt.compound({ Version: nbt.int(3), ... }).
export const nbt = Object.freeze({
    byte: (v) => ({ t: TAG.byte, v }), short: (v) => ({ t: TAG.short, v }), int: (v) => ({ t: TAG.int, v }), long: (v) => ({ t: TAG.long, v: BigInt(v) }),
    string: (v) => ({ t: TAG.string, v }), bytes: (v) => ({ t: TAG.byte_array, v: Buffer.from(v) }), ints: (v) => ({ t: TAG.int_array, v }),
    list: (of, v) => ({ t: TAG.list, of: TAG[of], v }), compound: (v) => ({ t: TAG.compound, v }),
});

export function encodeNbt(root, name = '') {
    const chunks = [];
    const u8 = (v) => chunks.push(Buffer.from([v & 0xff]));
    const text = (s) => { const b = Buffer.from(s, 'utf8'); const n = Buffer.alloc(2); n.writeUInt16BE(b.length); chunks.push(n, b); };
    const i32 = (v) => { const b = Buffer.alloc(4); b.writeInt32BE(v); chunks.push(b); };
    function payload(node) {
        switch (node.t) {
        case TAG.byte: { const b = Buffer.alloc(1); b.writeInt8(node.v); chunks.push(b); break; }
        case TAG.short: { const b = Buffer.alloc(2); b.writeInt16BE(node.v); chunks.push(b); break; }
        case TAG.int: i32(node.v); break;
        case TAG.long: { const b = Buffer.alloc(8); b.writeBigInt64BE(node.v); chunks.push(b); break; }
        case TAG.string: text(node.v); break;
        case TAG.byte_array: i32(node.v.length); chunks.push(node.v); break;
        case TAG.int_array: i32(node.v.length); for (const v of node.v) i32(v); break;
        case TAG.list: u8(node.v.length === 0 ? TAG.end : node.of); i32(node.v.length); for (const item of node.v) payload(item); break;
        case TAG.compound: for (const [key, child] of Object.entries(node.v)) { u8(child.t); text(key); payload(child); } u8(TAG.end); break;
        default: throw new Error(`cannot write NBT tag type ${node.t}`);
        }
    }
    u8(TAG.compound); text(name); payload(root);
    return Buffer.concat(chunks);
}

// ---- varints -----------------------------------------------------------------------------------

export function decodeVarints(bytes, expected) {
    const out = [];
    let value = 0;
    let shift = 0;
    for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i] & 0xff;
        value |= (b & 0x7f) << shift;
        if (b & 0x80) { shift += 7; if (shift > 28) throw new Error('a varint in the block data is too long'); continue; }
        out.push(value >>> 0);
        value = 0;
        shift = 0;
    }
    if (shift !== 0) throw new Error('the block data ends in the middle of a varint');
    if (expected !== undefined && out.length !== expected) throw new Error(`the block data holds ${out.length} blocks, the size says ${expected}`);
    return out;
}

export function encodeVarints(values) {
    const bytes = [];
    for (let value of values) {
        while (value >= 0x80) { bytes.push((value & 0x7f) | 0x80); value >>>= 7; }
        bytes.push(value);
    }
    return Buffer.from(bytes);
}

// ---- reading a schematic --------------------------------------------------------------------------

// "minecraft:oak_stairs[facing=north,half=bottom]" -> { name: "oak_stairs", namespace: "minecraft", states: { facing: "north", half: "bottom" } }
export function parseBlockState(text) {
    const found = /^(?:([a-z0-9_.-]+):)?([a-z0-9_/.-]+)(?:\[(.*)\])?$/.exec(String(text));
    if (!found) throw new Error(`not a block state: ${text}`);
    const states = {};
    for (const pair of (found[3] ?? '').split(',').filter(Boolean)) { const [key, value] = pair.split('='); states[key.trim()] = (value ?? '').trim(); }
    return { namespace: found[1] ?? 'minecraft', name: found[2], states };
}

// -> { version, data_version, width, height, length, offset, palette: [block state text by index], data: [index per block], block_entities }
export function readSchematic(file) {
    const bytes = Buffer.isBuffer(file) ? file : Buffer.from(file);
    const raw = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
    const root = decodeNbt(raw).value;
    const s = root.Schematic && typeof root.Schematic === 'object' && !Array.isArray(root.Schematic) ? root.Schematic : root;
    const version = s.Version;
    if (version !== 2 && version !== 3) throw new Error(`schematic version ${version} is not supported (2 and 3 are)`);
    const [width, height, length] = [s.Width, s.Height, s.Length].map((n) => n & 0xffff);     // unsigned shorts
    if (!(width > 0 && height > 0 && length > 0)) throw new Error('the schematic has no size');
    const palette_map = version === 3 ? s.Blocks?.Palette : s.Palette;
    const data_bytes = version === 3 ? s.Blocks?.Data : s.BlockData;
    if (!palette_map || !data_bytes) throw new Error('the schematic has no block palette or no block data');
    const palette = [];
    for (const [state, index] of Object.entries(palette_map)) palette[index] = state;
    const data = decodeVarints(data_bytes, width * height * length);
    for (const index of data) if (palette[index] === undefined) throw new Error(`the block data names palette entry ${index}, which does not exist`);
    const entities = (version === 3 ? s.Blocks?.BlockEntities : s.BlockEntities) ?? [];
    return { version, data_version: s.DataVersion ?? null, width, height, length, offset: s.Offset ?? [0, 0, 0], palette, data, block_entities: entities };
}

// The prefab and the report. options:
//   name (required), title, kind ('shared'), file (the source's file name), now,
//   obtainable(item) -> boolean, ladder (the generated prefabs, for the tier),
//   substitute { block: block }   the operator's own replacements, applied before anything is checked
//   air 'leave' (default: air in the schematic leaves the cell alone) | 'clear' (the cell is kept clear)
export function schemToPrefab(file, { name, title = null, kind = 'shared', source_file = null, now = Date.now(), obtainable = null, ladder = [], substitute = {}, air = 'leave' } = {}) {
    if (!PREFAB_NAME.test(String(name ?? ''))) throw new Error('a prefab name must match ^[A-Za-z0-9_-]+$');
    const bytes = Buffer.isBuffer(file) ? file : Buffer.from(file);
    const s = readSchematic(bytes);
    const report = {
        format_checked: SCHEMATIC_FORMAT_CHECKED, version: s.version, data_version: s.data_version,
        unobtainable: {}, no_item: [], dropped_states: {}, block_entities: s.block_entities.length, substituted: {}, foreign_namespace: [],
        floating: 0, too_big: false, needs_facing: [], trimmed_layers: 0, buildable: true, problems: [],
    };
    const parsed = s.palette.map((state) => parseBlockState(state));
    const names = parsed.map((p) => {
        if (p.namespace !== 'minecraft') { report.foreign_namespace.push(`${p.namespace}:${p.name}`); }
        if (Object.keys(p.states).length > 0 && !AIR.has(p.name)) report.dropped_states[p.name] = [...new Set([...(report.dropped_states[p.name] ?? []), ...Object.keys(p.states)])].sort();
        if (AIR.has(p.name)) return air === 'clear' ? 'air' : '';
        const swapped = substitute[p.name];
        if (swapped !== undefined) { report.substituted[p.name] = swapped; return swapped; }
        return p.name;
    });
    let blocks = [];
    for (let y = 0; y < s.height; y++) {
        const layer = [];
        for (let z = 0; z < s.length; z++) {
            const row = [];
            for (let x = 0; x < s.width; x++) row.push(names[s.data[x + z * s.width + y * s.width * s.length]]);
            layer.push(row);
        }
        blocks.push(layer);
    }
    // trim what holds nothing: layers above and below, rows and columns at the edges
    const holds = (want) => want !== '' && want !== 'air';
    const layerHolds = (layer) => layer.some((row) => row.some(holds));
    const before = blocks.length;
    while (blocks.length > 1 && !layerHolds(blocks[blocks.length - 1])) blocks.pop();
    while (blocks.length > 1 && !layerHolds(blocks[0])) blocks.shift();
    report.trimmed_layers = before - blocks.length;
    const usedZ = (z) => blocks.some((layer) => layer[z].some(holds));
    const usedX = (x) => blocks.some((layer) => layer.some((row) => holds(row[x])));
    let z0 = 0; let z1 = s.length - 1; let x0 = 0; let x1 = s.width - 1;
    while (z0 < z1 && !usedZ(z0)) z0++;
    while (z1 > z0 && !usedZ(z1)) z1--;
    while (x0 < x1 && !usedX(x0)) x0++;
    while (x1 > x0 && !usedX(x1)) x1--;
    blocks = blocks.map((layer) => layer.slice(z0, z1 + 1).map((row) => row.slice(x0, x1 + 1)));

    const top = blocks.length - 1;
    const stages = top >= 2 ? [{ name: 'Base', y: [0, 0] }, { name: 'Body', y: [1, top - 1] }, { name: 'Top', y: [top, top] }] : [{ name: 'Build', y: [0, top] }];
    const prefab = { v: PREFAB_VERSION, name, title: title ?? name, kind, tier: 0, by: 'Operator', size: null, below: 0, blocks, parts: {}, stages, materials: {} };
    prefab.size = prefabSize(prefab);
    const used = [...new Set(blocks.flat(2).filter(holds))].sort();
    if (used.length === 0) throw new Error('the schematic holds no blocks');
    // the bill is in items: a block whose item has another name is counted under the item's
    const bill = billOf(prefab);
    prefab.materials = {};
    for (const [block, count] of Object.entries(bill.materials)) {
        const item = ITEM_FOR_BLOCK[block] ?? block;
        prefab.materials[item] = (prefab.materials[item] ?? 0) + count;
    }
    report.cells = bill.cells;
    report.size = prefab.size;
    report.no_item = used.filter((block) => ITEM_FOR_BLOCK[block] !== undefined || NOT_ITEMS.has(block));
    report.needs_facing = used.filter(needsFacing);
    report.floating = floatingCells(prefab).length;
    report.too_big = Math.max(prefab.size.x, prefab.size.z) > LARGEST_PLOT;
    if (typeof obtainable === 'function') {
        const counts = {};
        for (const want of blocks.flat(2)) if (holds(want)) counts[want] = (counts[want] ?? 0) + 1;
        for (const block of unobtainable(prefab, (b) => obtainable(ITEM_FOR_BLOCK[b] ?? b) && !NOT_ITEMS.has(b))) report.unobtainable[block] = counts[block];
    }
    prefab.tier = tierFor(prefab, ladder);
    report.tier = prefab.tier;
    prefab.source = { file: source_file, sha256: createHash('sha256').update(bytes).digest('hex'), converted_at: new Date(now).toISOString(), schematic_version: s.version, format_checked: SCHEMATIC_FORMAT_CHECKED };
    // the bill of an operator prefab is in items, which checkPrefab would compare with the blocks: checked without it
    report.problems = checkPrefab({ ...prefab, materials: undefined }).filter((problem) => !problem.includes('placed against nothing'));
    report.buildable = Object.keys(report.unobtainable).length === 0 && report.problems.length === 0 && !report.too_big && report.floating === 0;
    return { prefab, report };
}

// A schematic file to the specification, from blocks[y][z][x] of block state texts ("minecraft:stone").
// For tests and tools: version 2 or 3, gzip-compressed like a real one.
export function buildSchematic({ blocks, version = 3, data_version = 4435, block_entities = [], compress = true }) {
    const height = blocks.length;
    const length = blocks[0].length;
    const width = blocks[0][0].length;
    const palette = new Map();
    const data = [];
    for (let y = 0; y < height; y++) for (let z = 0; z < length; z++) for (let x = 0; x < width; x++) {
        const state = blocks[y][z][x];
        if (!palette.has(state)) palette.set(state, palette.size);
        data.push(palette.get(state));
    }
    const palette_tag = nbt.compound(Object.fromEntries([...palette].map(([state, index]) => [state, nbt.int(index)])));
    const entities = nbt.list('compound', block_entities.map((e) => nbt.compound({ Pos: nbt.ints(e.pos), Id: nbt.string(e.id) })));
    const common = { Version: nbt.int(version), DataVersion: nbt.int(data_version), Width: nbt.short(width), Height: nbt.short(height), Length: nbt.short(length), Offset: nbt.ints([0, 0, 0]) };
    const raw = version === 3
        ? encodeNbt(nbt.compound({ Schematic: nbt.compound({ ...common, Blocks: nbt.compound({ Palette: palette_tag, Data: nbt.bytes(encodeVarints(data)), BlockEntities: entities }) }) }), '')
        : encodeNbt(nbt.compound({ ...common, PaletteMax: nbt.int(palette.size), Palette: palette_tag, BlockData: nbt.bytes(encodeVarints(data)), BlockEntities: entities }), 'Schematic');
    return compress ? gzipSync(raw) : raw;
}
