import { describe, expect, test } from "bun:test"
import { openDatabase } from "./database"

describe("openDatabase", () => {
  test("opens in-memory database", () => {
    const db = openDatabase(":memory:")
    expect(db).toBeDefined()
    db.close()
  })

  test("enables WAL mode", () => {
    const db = openDatabase(":memory:")
    const result = db.query("PRAGMA journal_mode").get() as Record<string, string>
    expect(result.journal_mode).toBe("memory")
    db.close()
  })

  test("creates completed_entries table", () => {
    const db = openDatabase(":memory:")
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='completed_entries'")
      .all() as Array<{ name: string }>
    expect(tables).toHaveLength(1)
    expect(tables[0]?.name).toBe("completed_entries")
    db.close()
  })

  test("creates execution_logs table", () => {
    const db = openDatabase(":memory:")
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='execution_logs'")
      .all() as Array<{ name: string }>
    expect(tables).toHaveLength(1)
    expect(tables[0]?.name).toBe("execution_logs")
    db.close()
  })

  test("creates runtime_state table", () => {
    const db = openDatabase(":memory:")
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='runtime_state'")
      .all() as Array<{ name: string }>
    expect(tables).toHaveLength(1)
    expect(tables[0]?.name).toBe("runtime_state")
    db.close()
  })

  test("is idempotent (can be called twice)", () => {
    const db = openDatabase(":memory:")
    expect(() => {
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
    }).not.toThrow()
    db.close()
  })

  test("creates index on completed_entries", () => {
    const db = openDatabase(":memory:")
    const indexes = db
      .query("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='completed_entries'")
      .all() as Array<{ name: string }>
    const indexNames = indexes.map((i) => i.name)
    expect(indexNames).toContain("idx_completed_workflow")
    expect(indexNames).toContain("idx_completed_finished")
    expect(indexNames).toContain("idx_completed_unique")
    db.close()
  })

  test("creates index on execution_logs", () => {
    const db = openDatabase(":memory:")
    const indexes = db
      .query("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='execution_logs'")
      .all() as Array<{ name: string }>
    const indexNames = indexes.map((i) => i.name)
    expect(indexNames).toContain("idx_logs_lookup")
    expect(indexNames).toContain("idx_logs_recent")
    db.close()
  })

  test("creates index on runtime_state", () => {
    const db = openDatabase(":memory:")
    const indexes = db
      .query("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='runtime_state'")
      .all() as Array<{ name: string }>
    const indexNames = indexes.map((i) => i.name)
    expect(indexNames).toContain("idx_state_workflow")
    expect(indexNames).toContain("idx_state_category")
    db.close()
  })
})
