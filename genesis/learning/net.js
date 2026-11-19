// Genesis learning: the neural network, in plain JavaScript on Float32Array. No library.
//
// One network: 96 inputs -> 64 -> 32 (ReLU) -> one linear head of 4 outputs PER AGENT.
// The trunk is shared (what is true for everyone is learned once, from everyone's examples);
// what is particular to an agent lives in its head. 8,816 weights with four agents:
// 6,208 + 2,080 + 4 heads of 132. (The plan says 8,848: it counts the second layer as 2,112,
// but 64 x 32 weights and 32 biases are 2,080.)
//
// The four outputs are CORRECTIONS added to the count table's estimates (the offsets):
//   0  success     logit(p_ok)      = logit(table p_ok)     + head output
//   1  danger      logit(p_danger)  = logit(table p_danger) + head output
//   2  time        log(seconds)     = log(table seconds)    + head output
//   3  yield       logit(yield)     = logit(table yield)    + head output
// Every head starts at zero, so with no data the network says exactly what the table says.
//
// An ensemble is five such networks with different starting weights, each trained on its
// own resampling of the data. Their mean is the estimate; how far they disagree is the
// uncertainty (spread).
//
// Training: binary cross-entropy for success and danger (unweighted), Huber loss on log
// seconds, cross-entropy on yield as a soft target; weights 1, 1, 0.5, 0.5; weight decay
// 0.001; Adam (the plan's section 1.4). Learning rate 0.001: the plan proposed 0.0005, which
// in the simulation was only 2.6% below the count table after 4,000 examples; 0.001 gave 5
// to 9%. A label that is null is masked: a goal a new plan replaced has no success label, a
// failed goal no duration.
//
// Deterministic: the same seed and the same examples in the same order give the same
// weights, bit for bit (weightsHash).
//
// Depends only on genesis/learning/rng.js and node:crypto.

import { createHash } from 'node:crypto';
import { createRng } from './rng.js';

export const ARCH = Object.freeze({ inputs: 96, hidden: Object.freeze([64, 32]), outputs: 4 });
export const ENSEMBLE_SIZE = 5;
export const HYPER = Object.freeze({
    lr: 0.001, beta1: 0.9, beta2: 0.999, eps: 1e-8, weight_decay: 0.001,
    loss_weights: Object.freeze([1, 1, 0.5, 0.5]), huber_delta: 1,
});
export const OUT = Object.freeze({ ok: 0, danger: 1, secs: 2, yield: 3 });
const P_MIN = 0.02;
const P_MAX = 0.98;

export const sigmoid = (z) => 1 / (1 + Math.exp(-z));
export const logit = (p) => Math.log(p / (1 - p));
const clampP = (p) => Math.min(P_MAX, Math.max(P_MIN, p));

// The four offsets for one option. Success and danger start from the count table's estimate
// for this option; time and yield start from the table's fixed priors (60 seconds, 0.7), so
// that what the head has to learn does not move while the table is still filling up.
export const SECS_PRIOR = 60;
export const YIELD_PRIOR = 0.7;
export function offsetsOf(table) {
    return Float32Array.of(logit(clampP(table.p_ok)), logit(clampP(table.p_danger)), Math.log(SECS_PRIOR), logit(YIELD_PRIOR));
}

// The indices of the inputs that are not zero (most are: the one-hot groups). The first
// layer only walks these.
export function nonZero(x) {
    const list = [];
    for (let i = 0; i < x.length; i++) if (x[i] !== 0) list.push(i);
    return Uint16Array.from(list);
}

const PARAM_KEYS = ['W1', 'b1', 'W2', 'b2', 'Wo', 'bo'];

export function paramCount(arch = ARCH, heads = 4) {
    const [h1, h2] = arch.hidden;
    return arch.inputs * h1 + h1 + h1 * h2 + h2 + heads * (h2 * arch.outputs + arch.outputs);
}

export function createNet({ agents, seed = 1, arch = ARCH } = {}) {
    if (!Array.isArray(agents) || agents.length === 0) throw new Error('the network needs the list of agents (one head each)');
    const rng = createRng(seed);
    const [h1, h2] = arch.hidden;
    const uniform = (n, fan_in) => Float32Array.from({ length: n }, () => (rng() * 2 - 1) * Math.sqrt(6 / fan_in));
    const p = {
        W1: uniform(arch.inputs * h1, arch.inputs),     // W1[i * h1 + j]: input i to hidden unit j
        b1: new Float32Array(h1),
        W2: uniform(h1 * h2, h1),                       // W2[j2 * h1 + j1]
        b2: new Float32Array(h2),
        Wo: new Float32Array(agents.length * arch.outputs * h2),   // the heads start at zero
        bo: new Float32Array(agents.length * arch.outputs),
    };
    const zeros = () => Object.fromEntries(PARAM_KEYS.map((key) => [key, new Float32Array(p[key].length)]));
    return {
        arch, agents: [...agents], p, m: zeros(), v: zeros(), g: zeros(), t: 0,
        buf: { h1: new Float32Array(h1), h2: new Float32Array(h2), o: new Float32Array(arch.outputs), dh1: new Float32Array(h1), dh2: new Float32Array(h2) },
    };
}

// Fills net.buf.h1, .h2 and .o. head: the agent's index, or -1 for an agent the network has
// no head for (the outputs are then the offsets alone: the table's estimate).
export function forward(net, x, nz, head, off) {
    const { W1, b1, W2, b2, Wo, bo } = net.p;
    const { h1, h2, o } = net.buf;
    const H1 = h1.length;
    const H2 = h2.length;
    h1.set(b1);
    for (let n = 0; n < nz.length; n++) {
        const i = nz[n];
        const xi = x[i];
        const base = i * H1;
        for (let j = 0; j < H1; j++) h1[j] += W1[base + j] * xi;
    }
    for (let j = 0; j < H1; j++) if (h1[j] < 0) h1[j] = 0;
    for (let j = 0; j < H2; j++) {
        let a = b2[j];
        const base = j * H1;
        for (let i = 0; i < H1; i++) a += W2[base + i] * h1[i];
        h2[j] = a > 0 ? a : 0;
    }
    const K = o.length;
    for (let k = 0; k < K; k++) {
        let a = off[k];
        if (head >= 0) {
            const row = head * K + k;
            a += bo[row];
            const base = row * H2;
            for (let i = 0; i < H2; i++) a += Wo[base + i] * h2[i];
        }
        o[k] = a;
    }
    return o;
}

// One Adam step on a batch of examples: [{ x, nz, head, off, y: { ok, danger, log_secs, yield } }].
// Returns the mean loss of the batch.
export function trainStep(net, batch, hyper = HYPER) {
    const { p, g, m, v, buf } = net;
    const { h1, h2, dh1, dh2 } = buf;
    const H1 = h1.length;
    const H2 = h2.length;
    const K = net.arch.outputs;
    const [w_ok, w_danger, w_secs, w_yield] = hyper.loss_weights;
    for (const key of PARAM_KEYS) g[key].fill(0);
    let loss = 0;
    const d = new Float64Array(K);
    for (const example of batch) {
        const { x, nz, head, off, y } = example;
        if (head < 0) continue;
        const o = forward(net, x, nz, head, off);
        d.fill(0);
        if (y.ok === 0 || y.ok === 1) {
            const q = sigmoid(o[0]);
            d[0] = w_ok * (q - y.ok);
            loss -= w_ok * Math.log(Math.max(1e-7, y.ok ? q : 1 - q));
        }
        if (y.danger === 0 || y.danger === 1) {
            const q = sigmoid(o[1]);
            d[1] = w_danger * (q - y.danger);
            loss -= w_danger * Math.log(Math.max(1e-7, y.danger ? q : 1 - q));
        }
        if (Number.isFinite(y.log_secs)) {
            const e = o[2] - y.log_secs;
            const a = Math.abs(e);
            d[2] = w_secs * Math.max(-hyper.huber_delta, Math.min(hyper.huber_delta, e));
            loss += w_secs * (a <= hyper.huber_delta ? 0.5 * e * e : hyper.huber_delta * (a - 0.5 * hyper.huber_delta));
        }
        if (Number.isFinite(y.yield)) {
            const q = sigmoid(o[3]);
            d[3] = w_yield * (q - y.yield);
            loss -= w_yield * (y.yield * Math.log(Math.max(1e-7, q)) + (1 - y.yield) * Math.log(Math.max(1e-7, 1 - q)));
        }
        // heads
        dh2.fill(0);
        for (let k = 0; k < K; k++) {
            if (d[k] === 0) continue;
            const row = head * K + k;
            const base = row * H2;
            g.bo[row] += d[k];
            for (let i = 0; i < H2; i++) {
                g.Wo[base + i] += d[k] * h2[i];
                dh2[i] += d[k] * p.Wo[base + i];
            }
        }
        // second hidden layer
        dh1.fill(0);
        for (let j = 0; j < H2; j++) {
            if (h2[j] <= 0 || dh2[j] === 0) continue;
            const dj = dh2[j];
            const base = j * H1;
            g.b2[j] += dj;
            for (let i = 0; i < H1; i++) {
                g.W2[base + i] += dj * h1[i];
                dh1[i] += dj * p.W2[base + i];
            }
        }
        // first hidden layer: only the inputs that are not zero carry a gradient
        for (let j = 0; j < H1; j++) {
            if (h1[j] <= 0) dh1[j] = 0;
            else g.b1[j] += dh1[j];
        }
        for (let n = 0; n < nz.length; n++) {
            const i = nz[n];
            const xi = x[i];
            const base = i * H1;
            for (let j = 0; j < H1; j++) g.W1[base + j] += dh1[j] * xi;
        }
    }
    net.t++;
    const { lr, beta1, beta2, eps, weight_decay } = hyper;
    const c1 = 1 - Math.pow(beta1, net.t);
    const c2 = 1 - Math.pow(beta2, net.t);
    const scale = 1 / Math.max(1, batch.length);
    for (const key of PARAM_KEYS) {
        const P = p[key];
        const G = g[key];
        const M = m[key];
        const V = v[key];
        for (let i = 0; i < P.length; i++) {
            const gi = G[i] * scale + weight_decay * P[i];
            M[i] = beta1 * M[i] + (1 - beta1) * gi;
            V[i] = beta2 * V[i] + (1 - beta2) * gi * gi;
            P[i] -= lr * (M[i] / c1) / (Math.sqrt(V[i] / c2) + eps);
        }
    }
    return loss * scale;
}

// ---- the ensemble ------------------------------------------------------------------------

export function createEnsemble({ agents, seed = 1, size = ENSEMBLE_SIZE, arch = ARCH } = {}) {
    const nets = Array.from({ length: size }, (_, i) => createNet({ agents, seed: (seed * 1000003 + i * 7919 + 1) >>> 0, arch }));
    return { arch, agents: [...agents], nets, seed };
}

// What one member says: { p_ok, p_danger, secs, yield }.
function memberEstimate(net, x, nz, head, off) {
    const o = forward(net, x, nz, head, off);
    return { p_ok: sigmoid(o[0]), p_danger: sigmoid(o[1]), secs: Math.exp(Math.min(12, o[2])), yield: sigmoid(o[3]) };
}

// The ensemble's estimate for one option:
//   p_ok, p_danger, secs, yield   the mean of the members
//   spread                        how far the members disagree on success (standard deviation): the uncertainty
//   danger_max                    the highest danger any member gives (careful about dying)
//   members                       what each member says (the scorer may draw one)
export function predict(ensemble, agent, x, off, nz = nonZero(x)) {
    const head = ensemble.agents.indexOf(agent);
    const members = ensemble.nets.map((net) => memberEstimate(net, x, nz, head, off));
    const n = members.length;
    const mean = (key) => members.reduce((sum, e) => sum + e[key], 0) / n;
    const p_ok = mean('p_ok');
    const log_secs = members.reduce((sum, e) => sum + Math.log(e.secs), 0) / n;
    const spread = Math.sqrt(members.reduce((sum, e) => sum + (e.p_ok - p_ok) ** 2, 0) / n);
    return {
        p_ok, p_danger: mean('p_danger'), secs: Math.exp(log_secs), yield: mean('yield'), spread,
        danger_max: members.reduce((worst, e) => Math.max(worst, e.p_danger), 0), members,
    };
}

export function allFinite(ensemble) {
    for (const net of ensemble.nets) {
        for (const key of PARAM_KEYS) {
            const P = net.p[key];
            for (let i = 0; i < P.length; i++) if (!Number.isFinite(P[i])) return false;
        }
    }
    return true;
}

// ---- weights as a file ---------------------------------------------------------------------
// { arch, agents, seed, nets: [{ W1, b1, W2, b2, Wo, bo }] } with each array as base64 of its
// little-endian float32 bytes (exact, and a fifth of the size of decimal text).

const toBase64 = (array) => Buffer.from(array.buffer, array.byteOffset, array.byteLength).toString('base64');
function fromBase64(text, length) {
    const bytes = Buffer.from(text, 'base64');
    if (bytes.length !== length * 4) throw new Error(`weights have ${bytes.length} bytes, expected ${length * 4}`);
    const out = new Float32Array(length);
    for (let i = 0; i < length; i++) out[i] = bytes.readFloatLE(i * 4);
    return out;
}

export function exportWeights(ensemble) {
    return {
        arch: { inputs: ensemble.arch.inputs, hidden: [...ensemble.arch.hidden], outputs: ensemble.arch.outputs },
        agents: [...ensemble.agents], seed: ensemble.seed,
        nets: ensemble.nets.map((net) => Object.fromEntries(PARAM_KEYS.map((key) => [key, toBase64(net.p[key])]))),
    };
}

// A fresh ensemble with these weights (the Adam state starts again). Throws when the shapes do not fit.
export function importWeights(weights) {
    const ensemble = createEnsemble({ agents: weights.agents, seed: weights.seed ?? 1, size: weights.nets.length, arch: weights.arch });
    weights.nets.forEach((saved, n) => {
        for (const key of PARAM_KEYS) ensemble.nets[n].p[key] = fromBase64(saved[key], ensemble.nets[n].p[key].length);
    });
    return ensemble;
}

export function cloneEnsemble(ensemble) { return importWeights(exportWeights(ensemble)); }

// sha256 over every weight of every member, in order.
export function weightsHash(ensemble) {
    const hash = createHash('sha256');
    for (const net of ensemble.nets) for (const key of PARAM_KEYS) hash.update(Buffer.from(net.p[key].buffer, net.p[key].byteOffset, net.p[key].byteLength));
    return hash.digest('hex');
}
