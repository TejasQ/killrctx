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
//   notebooks   user-created notebook (one row per notebook in the UI)
//   documents   files the user uploaded; we cache filename/size for the UI
//               and the OpenRAG task ID for debugging. The actual chunks
//               live in OpenSearch.
//   messages    user/assistant turns. `response_id` is OpenRAG's reply ID,
//               which we feed back as `previous_response_id` to thread
//               conversations.
//   podcasts    per-episode row. `status` walks pending → scripting →
//               synthesizing → ready/failed; the UI polls until it's one
//               of the terminal states.
//
// Foreign keys all cascade on delete so removing a notebook cleans up
// everything. We don't currently expose a "delete notebook" UI but the
// schema is ready when we do.
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
  created_at: number;
};

export type Message = {
  id: string;
  notebook_id: string;
  role: "user" | "assistant";
  content: string;
  response_id: string | null; // OpenRAG response ID — chains turns into a thread
  created_at: number;
};

export type Podcast = {
  id: string;
  notebook_id: string;
  title: string;
  status: "pending" | "scripting" | "synthesizing" | "ready" | "failed";
  audio_url: string | null;
  script: string | null;
  error: string | null;
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

  // Forward-compat micro-migration: an early version of this app shipped
  // without `response_id` on messages. Rather than ship a real migration
  // framework, we sniff PRAGMA table_info and ALTER if the column is
  // missing. Cheap and good enough for a single-user demo app.
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
  } catch {
    // Table doesn't exist yet — the CREATE TABLE below will create it with
    // the column already in place, so nothing to migrate.
  }

  // Schema. `IF NOT EXISTS` makes this idempotent; we run it on every boot.
  conn.exec(`
    CREATE TABLE IF NOT EXISTS notebooks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      openrag_collection TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      notebook_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      openrag_id TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(notebook_id) REFERENCES notebooks(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      notebook_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      response_id TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(notebook_id) REFERENCES notebooks(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS podcasts (
      id TEXT PRIMARY KEY,
      notebook_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      audio_url TEXT,
      script TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(notebook_id) REFERENCES notebooks(id) ON DELETE CASCADE
    );
  `);

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
