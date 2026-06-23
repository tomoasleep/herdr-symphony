import { Database } from "bun:sqlite"

export function openDatabase(path: string): Database {
  const db = new Database(path, { create: true })

  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA synchronous = NORMAL")

  db.exec(`
    CREATE TABLE IF NOT EXISTS completed_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow_key TEXT NOT NULL,
      issue_id TEXT NOT NULL,
      issue_identifier TEXT NOT NULL,
      issue_title TEXT,
      issue_url TEXT,
      issue_state TEXT,
      issue_data TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      session_id TEXT,
      workspace_path TEXT,
      finished_at TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `)
  db.exec("CREATE INDEX IF NOT EXISTS idx_completed_workflow ON completed_entries(workflow_key)")
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_completed_finished ON completed_entries(finished_at DESC)",
  )
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_completed_unique ON completed_entries(workflow_key, issue_id)",
  )

  db.exec(`
    CREATE TABLE IF NOT EXISTS execution_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow_key TEXT NOT NULL,
      issue_id TEXT NOT NULL,
      issue_identifier TEXT,
      kind TEXT NOT NULL,
      message TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      duration_ms INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `)
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_logs_lookup ON execution_logs(workflow_key, issue_id, id DESC)",
  )
  db.exec("CREATE INDEX IF NOT EXISTS idx_logs_recent ON execution_logs(created_at DESC)")

  db.exec(`
    CREATE TABLE IF NOT EXISTS runtime_state (
      key TEXT PRIMARY KEY,
      workflow_key TEXT NOT NULL,
      category TEXT NOT NULL,
      issue_id TEXT NOT NULL,
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `)
  db.exec("CREATE INDEX IF NOT EXISTS idx_state_workflow ON runtime_state(workflow_key)")
  db.exec("CREATE INDEX IF NOT EXISTS idx_state_category ON runtime_state(category)")

  return db
}
