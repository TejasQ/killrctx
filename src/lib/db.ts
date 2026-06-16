// ============================================================================
// db.ts — the tiny SQLite database that holds *our* metadata
// ============================================================================
//
// _Basically_, this is a 100-line module with one job: persist the things
// OpenRAG doesn't track for us. OpenRAG owns the documents, embeddings, and
// chat memory; we own the notebook list, message history (so the UI can
// render past turns instantly without hitting OpenRAG), document filenames,
// and podcast status rows.
//
// Why SQLite and not Postgres?
//   This is a single-user local app. SQLite gives us zero-config persistence
//   in one file (`data/killrctx.db`), survives `docker compose down -v`,
//   and is fast enough that we use synchronous prepared statements
//   throughout the API routes — no connection pooling, no async ceremony.
//
// Why `better-sqlite3` and not `node:sqlite`?
//   `better-sqlite3` is synchronous and has been the de-facto standard for
//   years. Its API (`db.prepare(sql).get(...)`, `.run(...)`, `.all(...)`) is
//   what the codebase uses everywhere.
//
// Schema overview (one notebook -> many of everything else):
//   notebooks      user-created notebook (one row per notebook in the UI)
//   documents      files the user uploaded; we cache filename/size for the UI
//                  and the OpenRAG task ID for debugging. The actual chunks
//                  live in OpenSearch.
//   conversations  named chat threads within a notebook. A notebook starts
//                  with one default conversation; the user can create more.
//   messages       user/assistant turns, scoped to a conversation.
//                  `response_id` is OpenRAG's reply ID for threading.
//   notes          anything the Studio generates: podcast, summary, mindmap,
//                  outline, qa. Each type is self-contained; podcast rows also
//                  carry status/audio_url/script/error (null on other types).
//
// Foreign keys all cascade on delete so removing a notebook cleans up
// everything owned by it.
// ============================================================================

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

// Row types — these are *exactly* the columns SQLite returns. Keep them in
// sync with the CREATE TABLE statements below; no ORM will yell at you if
// they drift.
export type Notebook = {
  id: string;
  title: string;
  created_at: number; // ms since epoch (Date.now())
  openrag_collection: string; // unused right now (no per-notebook isolation)
};

export type Document = {
  id: string;
  notebook_id: string;
  filename: string;
  bytes: number;
  openrag_id: string | null; // OpenRAG task ID returned by /router/upload_ingest
  ingest_status: "indexing" | "ready" | "failed";
  ingest_error: string | null; // error message from OpenRAG if ingest_status = 'failed'
  created_at: number;
};

export type Message = {
  id: string;
  notebook_id: string;
  conversation_id: string | null; // null only for legacy rows before the migration
  role: "user" | "assistant";
  content: string;
  response_id: string | null; // OpenRAG response ID — chains turns into a thread
  created_at: number;
};

export type Conversation = {
  id: string;
  notebook_id: string;
  title: string;
  created_at: number;
};

export type Note = {
  id: string;
  notebook_id: string;
  type: "podcast" | "summary" | "mindmap" | "outline" | "qa";
  title: string;
  content: string | null;      // AI-generated markdown; null while podcast is in-flight
  response_id: string | null;  // OpenRAG chatId — used to clean up the thread on delete
  status: "pending" | "scripting" | "synthesizing" | "ready" | "failed" | null; // podcast only
  audio_url: string | null;    // podcast only
  script: string | null;       // podcast only
  error: string | null;        // podcast only
  created_at: number;
};

let _db: Database.Database | null = null;

/**
 * Open the database lazily on first use.
 *
 * **Why lazy?** During `next build`, Next.js spawns multiple worker processes
 * to collect page data in parallel. If we opened the SQLite file at module
 * load time, every worker would race for the same file and we'd hit
 * SQLITE_BUSY. Deferring open() until the first query means workers that
 * never need the db never touch it.
 *
 * WAL (write-ahead logging) lets readers and one writer coexist without
 * blocking — important because the UI polls for podcast status while the
 * generator is writing.
 */
function getDb(): Database.Database {
  if (_db) return _db;

  const dataDir = join(process.cwd(), "data");
  mkdirSync(dataDir, { recursive: true });

  const conn = new Database(join(dataDir, "killrctx.db"));
  conn.pragma("journal_mode = WAL");

  // Forward-compat micro-migrations. We sniff PRAGMA table_info and ALTER
  // only if a column is missing, which is idempotent across restarts.
  // Cheap and good enough for a single-user demo app.
  conn.exec(
    `CREATE TABLE IF NOT EXISTS messages_migrate_marker (x INTEGER);`,
  );
  try {
    const cols = conn
      .prepare("PRAGMA table_info(messages)")
      .all() as { name: string }[];
    if (cols.length > 0 && !cols.some((c) => c.name === "response_id")) {
      conn.exec("ALTER TABLE messages ADD COLUMN response_id TEXT");
    }
    // Add conversation_id to messages. Existing rows get NULL here; the
    // back-fill block below assigns them to a default conversation per notebook.
    if (cols.length > 0 && !cols.some((c) => c.name === "conversation_id")) {
      conn.exec("ALTER TABLE messages ADD COLUMN conversation_id TEXT");
    }
  } catch {
    // Table doesn't exist yet — the CREATE TABLE below will create it with
    // all columns already in place, so nothing to migrate.
  }

  try {
    const docCols = conn
      .prepare("PRAGMA table_info(documents)")
      .all() as { name: string }[];
    // Default 'ready' means existing rows (ingested before this column existed)
    // are treated as fully indexed — no spinner on documents that are already in.
    if (docCols.length > 0 && !docCols.some((c) => c.name === "ingest_status")) {
      conn.exec("ALTER TABLE documents ADD COLUMN ingest_status TEXT NOT NULL DEFAULT 'ready'");
    }
    if (docCols.length > 0 && !docCols.some((c) => c.name === "ingest_error")) {
      conn.exec("ALTER TABLE documents ADD COLUMN ingest_error TEXT");
    }
  } catch {
    // documents table doesn't exist yet — CREATE TABLE below includes the column.
  }

  // Add response_id to notes if it was created before that column existed.
  try {
    const noteCols = conn
      .prepare("PRAGMA table_info(notes)")
      .all() as { name: string }[];
    if (noteCols.length > 0 && !noteCols.some((c) => c.name === "response_id")) {
      conn.exec("ALTER TABLE notes ADD COLUMN response_id TEXT");
    }
  } catch {
    // notes table doesn't exist yet — CREATE TABLE below handles it.
  }

  // Schema. `IF NOT EXISTS` makes this idempotent; we run it on every boot.
  conn.exec(`
    CREATE TABLE IF NOT EXISTS notebooks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      openrag_collection TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS conversations (
      id          TEXT PRIMARY KEY,
      notebook_id TEXT NOT NULL,
      title       TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      FOREIGN KEY(notebook_id) REFERENCES notebooks(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      notebook_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      openrag_id TEXT,
      ingest_status TEXT NOT NULL DEFAULT 'ready',
      ingest_error TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(notebook_id) REFERENCES notebooks(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS messages (
      id              TEXT PRIMARY KEY,
      notebook_id     TEXT NOT NULL,
      -- NOT NULL for fresh installs. Existing databases get conversation_id
      -- via the ALTER TABLE migration above, which is nullable for compat.
      conversation_id TEXT NOT NULL,
      role            TEXT NOT NULL,
      content         TEXT NOT NULL,
      response_id     TEXT,
      created_at      INTEGER NOT NULL,
      FOREIGN KEY(notebook_id) REFERENCES notebooks(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS notes (
      id          TEXT    PRIMARY KEY,
      notebook_id TEXT    NOT NULL,
      type        TEXT    NOT NULL,
      title       TEXT    NOT NULL,
      content     TEXT,
      response_id TEXT,
      status      TEXT,
      audio_url   TEXT,
      script      TEXT,
      error       TEXT,
      created_at  INTEGER NOT NULL,
      FOREIGN KEY(notebook_id) REFERENCES notebooks(id) ON DELETE CASCADE
    );
  `);

  // Migrate legacy `podcasts` table into `notes` on first boot after upgrade.
  // INSERT OR IGNORE is idempotent — safe to run on every restart.
  const hasPodcasts = (
    conn.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='podcasts'`).all()
  ).length > 0;
  if (hasPodcasts) {
    conn.exec(`
      INSERT OR IGNORE INTO notes
        (id, notebook_id, type, title, content, status, audio_url, script, error, created_at)
      SELECT id, notebook_id, 'podcast', title, NULL, status, audio_url, script, error, created_at
      FROM podcasts;
      DROP TABLE podcasts;
    `);
  }

  // Back-fill: for each notebook that has messages with no conversation_id,
  // create one default "Conversation 1" row and assign all its messages to it.
  // This runs on every boot but is a no-op once all rows have a conversation_id.
  const orphanedNotebooks = conn
    .prepare(
      `SELECT DISTINCT notebook_id FROM messages WHERE conversation_id IS NULL`,
    )
    .all() as { notebook_id: string }[];

  for (const { notebook_id } of orphanedNotebooks) {
    const defaultId = `conv_default_${notebook_id.replace(/-/g, "")}`;
    conn
      .prepare(
        `INSERT OR IGNORE INTO conversations (id, notebook_id, title, created_at)
         VALUES (?, ?, 'Conversation 1', ?)`,
      )
      .run(defaultId, notebook_id, Date.now());
    conn
      .prepare(
        `UPDATE messages SET conversation_id = ? WHERE notebook_id = ? AND conversation_id IS NULL`,
      )
      .run(defaultId, notebook_id);
  }

  _db = conn;
  return conn;
}

// Default export is a Proxy that forwards every property access to the real
// (lazily-opened) Database. Lets API routes write `db.prepare(...)` directly
// without anyone having to remember to call an init function.
const proxy = new Proxy({} as Database.Database, {
  get(_t, prop, receiver) {
    return Reflect.get(getDb(), prop, receiver);
  },
});

export default proxy;
