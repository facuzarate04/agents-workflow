import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import crypto from "node:crypto";
import Database from "better-sqlite3";

const MEMORY_DIR = path.join(os.homedir(), ".agents-hub");
const MEMORY_DB_PATH = path.join(MEMORY_DIR, "memory.db");

let _db = null;

function getDb() {
  if (_db) return _db;

  fs.mkdirSync(MEMORY_DIR, { recursive: true });

  _db = new Database(MEMORY_DB_PATH, { fileMustExist: false });
  _db.pragma("journal_mode = WAL");
  _db.pragma("busy_timeout = 5000");
  _db.pragma("synchronous = NORMAL");

  initSchema(_db);
  return _db;
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT UNIQUE NOT NULL,
      project TEXT,
      channel TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      summary TEXT
    );

    CREATE TABLE IF NOT EXISTS observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      project TEXT,
      scope TEXT DEFAULT 'project',
      topic_key TEXT,
      normalized_hash TEXT,
      revision_count INTEGER DEFAULT 1,
      duplicate_count INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(session_id)
    );

    CREATE INDEX IF NOT EXISTS idx_obs_project ON observations(project);
    CREATE INDEX IF NOT EXISTS idx_obs_type ON observations(type);
    CREATE INDEX IF NOT EXISTS idx_obs_topic_key ON observations(topic_key);
    CREATE INDEX IF NOT EXISTS idx_obs_hash ON observations(normalized_hash);
    CREATE INDEX IF NOT EXISTS idx_obs_session ON observations(session_id);
    CREATE INDEX IF NOT EXISTS idx_obs_created ON observations(created_at);
  `);

  // FTS5 virtual table — created separately to handle "already exists" gracefully
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
        title, content, type, project,
        content=observations,
        content_rowid=id
      );
    `);
  } catch {
    // FTS5 table already exists with different schema — skip
  }

  // Triggers to keep FTS in sync
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS obs_ai AFTER INSERT ON observations BEGIN
      INSERT INTO observations_fts(rowid, title, content, type, project)
      VALUES (new.id, new.title, new.content, new.type, new.project);
    END;

    CREATE TRIGGER IF NOT EXISTS obs_au AFTER UPDATE ON observations BEGIN
      INSERT INTO observations_fts(observations_fts, rowid, title, content, type, project)
      VALUES ('delete', old.id, old.title, old.content, old.type, old.project);
      INSERT INTO observations_fts(rowid, title, content, type, project)
      VALUES (new.id, new.title, new.content, new.type, new.project);
    END;

    CREATE TRIGGER IF NOT EXISTS obs_ad AFTER DELETE ON observations BEGIN
      INSERT INTO observations_fts(observations_fts, rowid, title, content, type, project)
      VALUES ('delete', old.id, old.title, old.content, old.type, old.project);
    END;
  `);
}

// --- Hashing & Dedup ---

function normalizeForHash(text) {
  return (text || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function computeHash({ title, content, type, project, scope }) {
  const payload = [title, content, type, project, scope].map(normalizeForHash).join("|");
  return crypto.createHash("sha256").update(payload).digest("hex");
}

// --- Sessions ---

export function startSession({ sessionId, project, channel }) {
  const db = getDb();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT OR IGNORE INTO sessions (session_id, project, channel, started_at)
    VALUES (?, ?, ?, ?)
  `).run(sessionId, project || null, channel || null, now);

  return { sessionId, startedAt: now };
}

export function endSession({ sessionId, summary }) {
  const db = getDb();
  const now = new Date().toISOString();

  db.prepare(`
    UPDATE sessions SET ended_at = ?, summary = ? WHERE session_id = ?
  `).run(now, summary || null, sessionId);

  return { sessionId, endedAt: now };
}

// --- Save (with dedup + topic_key upsert) ---

export function saveObservation({ sessionId, type, title, content, project, scope, topicKey }) {
  const db = getDb();
  const now = new Date().toISOString();
  const hash = computeHash({ title, content, type, project, scope });

  // Check for exact duplicate within last 15 minutes
  const recent = db.prepare(`
    SELECT id, duplicate_count FROM observations
    WHERE normalized_hash = ? AND deleted_at IS NULL
      AND created_at > datetime('now', '-15 minutes')
    ORDER BY created_at DESC LIMIT 1
  `).get(hash);

  if (recent) {
    db.prepare(`
      UPDATE observations SET duplicate_count = duplicate_count + 1, updated_at = ? WHERE id = ?
    `).run(now, recent.id);
    return { id: recent.id, action: "deduplicated", duplicateCount: recent.duplicate_count + 1 };
  }

  // Check for topic_key upsert
  if (topicKey) {
    const existing = db.prepare(`
      SELECT id, revision_count FROM observations
      WHERE project = ? AND scope = ? AND topic_key = ? AND deleted_at IS NULL
      ORDER BY created_at DESC LIMIT 1
    `).get(project || null, scope || "project", topicKey);

    if (existing) {
      db.prepare(`
        UPDATE observations
        SET title = ?, content = ?, type = ?, normalized_hash = ?,
            revision_count = revision_count + 1, updated_at = ?
        WHERE id = ?
      `).run(title, content, type, hash, now, existing.id);
      return { id: existing.id, action: "updated", revisionCount: existing.revision_count + 1 };
    }
  }

  // Insert new
  const result = db.prepare(`
    INSERT INTO observations (session_id, type, title, content, project, scope, topic_key, normalized_hash, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(sessionId || null, type, title, content, project || null, scope || "project", topicKey || null, hash, now, now);

  return { id: result.lastInsertRowid, action: "created" };
}

// --- 3-Layer Retrieval ---

// Layer 1: Compact search (FTS5)
export function searchObservations({ query, type, project, scope, limit = 10 }) {
  const db = getDb();
  const conditions = ["o.deleted_at IS NULL"];
  const params = [];

  if (type) {
    conditions.push("o.type = ?");
    params.push(type);
  }
  if (project) {
    conditions.push("o.project = ?");
    params.push(project);
  }
  if (scope) {
    conditions.push("o.scope = ?");
    params.push(scope);
  }

  if (query) {
    // FTS5 search
    const ftsQuery = query.split(/\s+/).map((w) => `"${w.replace(/"/g, "")}"`).join(" OR ");
    const sql = `
      SELECT o.id, o.type, o.title, substr(o.content, 1, 200) AS content_preview,
             o.project, o.topic_key, o.created_at, o.revision_count
      FROM observations o
      JOIN observations_fts f ON f.rowid = o.id
      WHERE f.observations_fts MATCH ? AND ${conditions.join(" AND ")}
      ORDER BY rank
      LIMIT ?
    `;
    return db.prepare(sql).all(ftsQuery, ...params, limit);
  }

  // No query — return recent
  const sql = `
    SELECT id, type, title, substr(content, 1, 200) AS content_preview,
           project, topic_key, created_at, revision_count
    FROM observations o
    WHERE ${conditions.join(" AND ")}
    ORDER BY created_at DESC
    LIMIT ?
  `;
  return db.prepare(sql).all(...params, limit);
}

// Layer 2: Timeline context
export function getTimeline({ observationId, before = 5, after = 5 }) {
  const db = getDb();

  const target = db.prepare(`
    SELECT id, session_id, created_at FROM observations WHERE id = ?
  `).get(observationId);

  if (!target) return { before: [], target: null, after: [] };

  const beforeRows = db.prepare(`
    SELECT id, type, title, substr(content, 1, 200) AS content_preview, created_at
    FROM observations
    WHERE session_id = ? AND created_at < ? AND deleted_at IS NULL
    ORDER BY created_at DESC LIMIT ?
  `).all(target.session_id, target.created_at, before).reverse();

  const afterRows = db.prepare(`
    SELECT id, type, title, substr(content, 1, 200) AS content_preview, created_at
    FROM observations
    WHERE session_id = ? AND created_at > ? AND deleted_at IS NULL
    ORDER BY created_at ASC LIMIT ?
  `).all(target.session_id, target.created_at, after);

  return { before: beforeRows, target, after: afterRows };
}

// Layer 3: Full content
export function getObservation(id) {
  const db = getDb();
  return db.prepare(`
    SELECT id, session_id, type, title, content, project, scope,
           topic_key, revision_count, duplicate_count, created_at, updated_at
    FROM observations WHERE id = ? AND deleted_at IS NULL
  `).get(id) || null;
}

// --- Context Injection ---

export function getRelevantContext({ project, query, limit = 8 }) {
  const results = [];

  // Always include recent decisions and errors for this project
  const db = getDb();
  const recentImportant = db.prepare(`
    SELECT id, type, title, substr(content, 1, 300) AS content_preview,
           topic_key, created_at, revision_count
    FROM observations
    WHERE project = ? AND deleted_at IS NULL
      AND type IN ('decision', 'error_pattern', 'preference', 'project_context')
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(project, Math.ceil(limit / 2));

  results.push(...recentImportant);

  // If there's a query, add FTS matches
  if (query) {
    const existingIds = new Set(results.map((r) => r.id));
    const ftsResults = searchObservations({
      query,
      project,
      limit: Math.ceil(limit / 2)
    });
    for (const r of ftsResults) {
      if (!existingIds.has(r.id)) {
        results.push(r);
      }
    }
  }

  return results.slice(0, limit);
}

export function formatContextForPrompt(observations) {
  if (!observations.length) return "";

  const lines = ["Memory context (from previous sessions):"];
  for (const obs of observations) {
    const revisionTag = obs.revision_count > 1 ? ` [rev ${obs.revision_count}]` : "";
    lines.push(`- [${obs.type}] ${obs.title}${revisionTag}: ${obs.content_preview || ""}`);
  }
  return lines.join("\n");
}

// --- Stats ---

export function getStats() {
  const db = getDb();

  const totalObs = db.prepare("SELECT COUNT(*) AS count FROM observations WHERE deleted_at IS NULL").get();
  const totalSessions = db.prepare("SELECT COUNT(*) AS count FROM sessions").get();
  const byType = db.prepare(`
    SELECT type, COUNT(*) AS count FROM observations
    WHERE deleted_at IS NULL GROUP BY type ORDER BY count DESC
  `).all();
  const byProject = db.prepare(`
    SELECT project, COUNT(*) AS count FROM observations
    WHERE deleted_at IS NULL AND project IS NOT NULL GROUP BY project ORDER BY count DESC
  `).all();

  return {
    totalObservations: totalObs.count,
    totalSessions: totalSessions.count,
    byType,
    byProject,
    dbPath: MEMORY_DB_PATH
  };
}

// --- Cleanup ---

export function softDelete(id) {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare("UPDATE observations SET deleted_at = ? WHERE id = ?").run(now, id);
}

export function closeMemory() {
  if (_db) {
    _db.close();
    _db = null;
  }
}
