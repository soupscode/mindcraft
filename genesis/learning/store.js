// Genesis learning: where experience, decisions, network versions and the kept state are
// stored. Two implementations of one interface:
//
//   memoryLearningStore()   everything in memory. What the tests and the simulation use.
//   pgLearningStore(pool)   Postgres, the tables of genesis/store/migrations/004_learning.sql.
//                           NOT RUN AGAINST A REAL POSTGRES: the tests only check, with a recording
//                           stand-in for the pool, that every statement names columns of the migration
//                           and passes as many values as it has placeholders (the same check
//                           genesis/adapters/pg_stores.js gets). The MindServer uses it when a database
//                           address is configured (genesis/planning/server.js).
//
// Interface (every method returns a promise):
//   recordDecision(decision)                 a decision from makeDecision()
//   beginExperience(fields)                  -> the open experience; throws when the fields do not hold
//   endExperience(id, end)                   -> the closed experience; throws for an unknown or already ended one
//   experience(id) -> experience | null
//   listExperience({ agent?, ended?, since?, limit? })   oldest first (training reads it in order)
//   listDecisions({ agent?, limit? })                    newest first
//   countExperience({ agent? })                          ended ones
//   saveVersion(row) / listVersions() / markVersion(v, state, reason?)
//   getState(name) -> value | null / setState(name, value, now)
//   builds: saveBuild(row) / listBuilds({ builder?, plot? })
//
// The prediction is stored when the goal starts. endExperience has no way to write it: in
// memory closeExperience refuses it, in Postgres the UPDATE does not name the column and
// only matches a row whose outcome is still empty.
//
// Depends only on genesis/learning/experience.js.

import { openExperience, closeExperience, makeDecision } from './experience.js';

export const VERSION_STATES = Object.freeze(['candidate', 'in_use', 'kept', 'refused', 'rolled_back']);

const copy = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const iso = (value) => new Date(value).toISOString();

// max_rows: how many experiences and decisions are kept (the oldest go first). Without a database the
// rows are only what the Learning screen shows of the recent past: what was learned from them is in the
// count table and the network, which are kept on their own.
export function memoryLearningStore({ max_rows = 20000 } = {}) {
    const experiences = new Map();   // id -> experience, in insertion order
    const decisions = [];
    const versions = new Map();
    const state = new Map();
    const builds = new Map();
    return {
        async recordDecision(fields) {
            const made = makeDecision(fields);
            if (!made.ok) throw new Error(`decision refused: ${made.problems.join('; ')}`);
            decisions.push(copy(made.decision));
            if (decisions.length > max_rows) decisions.shift();
            return made.decision;
        },
        async beginExperience(fields) {
            const opened = openExperience(fields);
            if (!opened.ok) throw new Error(`experience refused: ${opened.problems.join('; ')}`);
            if (experiences.has(opened.experience.id)) throw new Error(`experience ${opened.experience.id} already exists`);
            experiences.set(opened.experience.id, copy(opened.experience));
            if (experiences.size > max_rows) experiences.delete(experiences.keys().next().value);
            return opened.experience;
        },
        async endExperience(id, end) {
            const open = experiences.get(id);
            if (!open) throw new Error(`experience ${id} was never started: no prediction was stored for it`);
            const closed = closeExperience(open, end);
            if (!closed.ok) throw new Error(`experience ${id} not ended: ${closed.problems.join('; ')}`);
            experiences.set(id, copy(closed.experience));
            return closed.experience;
        },
        async experience(id) { return copy(experiences.get(id)) ?? null; },
        async listExperience({ agent = null, ended = true, since = null, limit = null } = {}) {
            let rows = [...experiences.values()].filter((e) => (agent === null || e.agent === agent)
                && (ended === null || (e.outcome !== null) === ended)
                && (since === null || (e.ended_at ?? e.started_at) >= since));
            if (ended) rows.sort((a, b) => a.ended_at - b.ended_at);
            if (limit !== null) rows = rows.slice(-limit);
            return copy(rows);
        },
        async listDecisions({ agent = null, limit = null } = {}) {
            const rows = decisions.filter((d) => agent === null || d.agent === agent).reverse();
            return copy(limit === null ? rows : rows.slice(0, limit));
        },
        async countExperience({ agent = null } = {}) {
            let n = 0;
            for (const e of experiences.values()) if (e.outcome !== null && (agent === null || e.agent === agent)) n++;
            return n;
        },
        async saveVersion(row) {
            if (!VERSION_STATES.includes(row.state)) throw new Error(`version state must be one of ${VERSION_STATES.join(', ')}`);
            versions.set(row.v, copy(row));
        },
        async listVersions() { return copy([...versions.values()].sort((a, b) => b.v - a.v)); },
        async markVersion(v, new_state, reason = null) {
            if (!VERSION_STATES.includes(new_state)) throw new Error(`version state must be one of ${VERSION_STATES.join(', ')}`);
            const row = versions.get(v);
            if (row) { row.state = new_state; row.reason = reason; }
        },
        async getState(name) { return copy(state.get(name)) ?? null; },
        async setState(name, value) { state.set(name, copy(value)); },
        async saveBuild(row) { builds.set(row.build_id, copy(row)); },
        async listBuilds({ builder = null, plot = null } = {}) {
            return copy([...builds.values()].filter((b) => (builder === null || b.builder === builder) && (plot === null || b.plot === plot)));
        },
    };
}

// The same store with its kept state (getState / setState) in files: <dir>/<name>.json, written the way
// checkpoints are (to .tmp, read back, renamed). For a MindServer without a database: the count table and
// the place memory then outlive a restart; the experience rows do not.
//   files { write, rename, read, remove }   genesis/store/node_files.js
export const LEARNING_DIR = './bots/genesis_learning';
export const stateFile = (dir, name) => `${dir}/${String(name).replace(/[^a-z0-9_-]/gi, '_')}.json`;
export function withFileState(store, { files, dir = LEARNING_DIR } = {}) {
    if (!files) throw new Error('the file state needs files');
    return {
        ...store,
        async getState(name) {
            try { const text = await files.read(stateFile(dir, name)); return text === null ? null : JSON.parse(text).value ?? null; } catch { return null; }
        },
        async setState(name, value, now = Date.now()) {
            const file = stateFile(dir, name);
            const text = JSON.stringify({ name, updated_at: new Date(now).toISOString(), value });
            await files.write(`${file}.tmp`, text);
            if (await files.read(`${file}.tmp`) !== text) throw new Error(`${file}.tmp did not read back as written`);
            await files.rename(`${file}.tmp`, file);
        },
    };
}

const json = (value) => JSON.stringify(value ?? null);
const time = (value) => (value === null || value === undefined ? null : iso(value));
const ms = (value) => (value === null || value === undefined ? null : new Date(value).getTime());

const EXPERIENCE_COLUMNS = `id, agent, goal_id, decision_id, call_id, option_id, skill, args, chooser, explore, play_id,
                situation, predicted, predicted_at, started_at, world_sha256, outcome, reason, done, total, duration_ms, steps,
                died, health_min, health_lost, stuck, incident_ids, gained, ended_at`;

function experienceFromRow(row) {
    return { ...row, predicted_at: ms(row.predicted_at), started_at: ms(row.started_at), ended_at: ms(row.ended_at) };
}

export function pgLearningStore(pool) {
    const api = {
        async recordDecision(fields) {
            const made = makeDecision(fields);
            if (!made.ok) throw new Error(`decision refused: ${made.problems.join('; ')}`);
            const d = made.decision;
            await pool.query(
                `INSERT INTO decisions
                    (decision_id, agent, chooser, call_id, situation, offered, chosen, default_choice, explore, net_version, prompt_version, ts)
                 VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10, $11, $12)
                 ON CONFLICT (decision_id) DO NOTHING`,
                [d.decision_id, d.agent, d.chooser, d.call_id, json(d.situation), json(d.offered), json(d.chosen), json(d.default_choice),
                    d.explore, d.net_version, d.prompt_version, iso(d.ts)],
            );
            return d;
        },
        async beginExperience(fields) {
            const opened = openExperience(fields);
            if (!opened.ok) throw new Error(`experience refused: ${opened.problems.join('; ')}`);
            const e = opened.experience;
            await pool.query(
                `INSERT INTO experience
                    (id, agent, goal_id, decision_id, call_id, option_id, skill, args, chooser, explore, play_id,
                     situation, predicted, predicted_at, started_at, world_sha256)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12::jsonb, $13::jsonb, $14, $15, $16)`,
                [e.id, e.agent, e.goal_id, e.decision_id, e.call_id, e.option_id, e.skill, json(e.args), e.chooser, e.explore, e.play_id,
                    json(e.situation), json(e.predicted), iso(e.predicted_at), iso(e.started_at), e.world_sha256],
            );
            return e;
        },
        async endExperience(id, end) {
            const open = await api.experience(id);
            if (!open) throw new Error(`experience ${id} was never started: no prediction was stored for it`);
            const closed = closeExperience(open, end);
            if (!closed.ok) throw new Error(`experience ${id} not ended: ${closed.problems.join('; ')}`);
            const e = closed.experience;
            // predicted is not named: what was predicted stays what it was. Only an open row is ended.
            await pool.query(
                `UPDATE experience
                    SET outcome = $2, reason = $3, done = $4, total = $5, duration_ms = $6, steps = $7::jsonb, died = $8,
                        health_min = $9, health_lost = $10, stuck = $11, incident_ids = $12::jsonb, gained = $13::jsonb, ended_at = $14
                  WHERE id = $1 AND outcome IS NULL`,
                [id, e.outcome, e.reason, e.done, e.total, e.duration_ms, json(e.steps), e.died, e.health_min, e.health_lost, e.stuck,
                    json(e.incident_ids), json(e.gained), iso(e.ended_at)],
            );
            return e;
        },
        async experience(id) {
            const { rows } = await pool.query(`SELECT ${EXPERIENCE_COLUMNS} FROM experience WHERE id = $1`, [id]);
            return rows.length > 0 ? experienceFromRow(rows[0]) : null;
        },
        async listExperience({ agent = null, ended = true, since = null, limit = null } = {}) {
            const { rows } = await pool.query(
                `SELECT ${EXPERIENCE_COLUMNS} FROM experience
                  WHERE ($1::text IS NULL OR agent = $1)
                    AND ($2::boolean IS NULL OR (outcome IS NOT NULL) = $2)
                    AND ($3::timestamptz IS NULL OR COALESCE(ended_at, started_at) >= $3)
                  ORDER BY COALESCE(ended_at, started_at) DESC LIMIT $4`,
                [agent, ended, time(since), limit ?? 1000000],
            );
            return rows.map(experienceFromRow).reverse();
        },
        async listDecisions({ agent = null, limit = null } = {}) {
            const { rows } = await pool.query(
                `SELECT decision_id, agent, chooser, call_id, situation, offered, chosen, default_choice, explore, net_version, prompt_version, ts
                   FROM decisions WHERE ($1::text IS NULL OR agent = $1) ORDER BY ts DESC LIMIT $2`,
                [agent, limit ?? 1000000],
            );
            return rows.map((row) => ({ ...row, ts: ms(row.ts) }));
        },
        async countExperience({ agent = null } = {}) {
            const { rows } = await pool.query('SELECT count(*) AS n FROM experience WHERE outcome IS NOT NULL AND ($1::text IS NULL OR agent = $1)', [agent]);
            return Number(rows[0]?.n ?? 0);
        },
        async saveVersion(row) {
            if (!VERSION_STATES.includes(row.state)) throw new Error(`version state must be one of ${VERSION_STATES.join(', ')}`);
            await pool.query(
                `INSERT INTO learning_versions (v, feature_version, parent, examples, metrics, sha256, state, reason, created_at)
                 VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)
                 ON CONFLICT (v) DO UPDATE SET state = EXCLUDED.state, reason = EXCLUDED.reason, metrics = EXCLUDED.metrics`,
                [row.v, row.feature_version, row.parent ?? null, row.examples, json(row.metrics ?? {}), row.sha256, row.state, row.reason ?? null, iso(row.created_at)],
            );
        },
        async listVersions() {
            const { rows } = await pool.query('SELECT v, feature_version, parent, examples, metrics, sha256, state, reason, created_at FROM learning_versions ORDER BY v DESC', []);
            return rows.map((row) => ({ ...row, created_at: ms(row.created_at) }));
        },
        async markVersion(v, new_state, reason = null) {
            if (!VERSION_STATES.includes(new_state)) throw new Error(`version state must be one of ${VERSION_STATES.join(', ')}`);
            await pool.query('UPDATE learning_versions SET state = $2, reason = $3 WHERE v = $1', [v, new_state, reason]);
        },
        async getState(name) {
            const { rows } = await pool.query('SELECT value FROM learning_state WHERE name = $1', [name]);
            return rows.length > 0 ? rows[0].value : null;
        },
        async setState(name, value, now = Date.now()) {
            await pool.query(
                `INSERT INTO learning_state (name, value, updated_at) VALUES ($1, $2::jsonb, $3)
                 ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
                [name, json(value), iso(now)],
            );
        },
        async saveBuild(row) {
            await pool.query(
                `INSERT INTO builds (build_id, plot, prefab, prefab_sha256, builder, stage, cells_total, cells_matching, started_at, finished_at, verified_at, verified_day)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                 ON CONFLICT (build_id) DO UPDATE
                    SET stage = EXCLUDED.stage, cells_matching = EXCLUDED.cells_matching, finished_at = EXCLUDED.finished_at,
                        verified_at = EXCLUDED.verified_at, verified_day = EXCLUDED.verified_day`,
                [row.build_id, row.plot, row.prefab, row.prefab_sha256, row.builder, row.stage ?? null, row.cells_total, row.cells_matching ?? 0,
                    iso(row.started_at), time(row.finished_at), time(row.verified_at), row.verified_day ?? null],
            );
        },
        async listBuilds({ builder = null, plot = null } = {}) {
            const { rows } = await pool.query(
                `SELECT build_id, plot, prefab, prefab_sha256, builder, stage, cells_total, cells_matching, started_at, finished_at, verified_at, verified_day
                   FROM builds WHERE ($1::text IS NULL OR builder = $1) AND ($2::text IS NULL OR plot = $2) ORDER BY started_at`,
                [builder, plot],
            );
            return rows.map((row) => ({ ...row, started_at: ms(row.started_at), finished_at: ms(row.finished_at), verified_at: ms(row.verified_at) }));
        },
    };
    return api;
}
