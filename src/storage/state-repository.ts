import type { Database } from "bun:sqlite"
import type { StateCategory, StateRecord, StateRepository } from "./types"

export class SqliteStateRepository implements StateRepository {
  constructor(private readonly db: Database) {}

  save(record: StateRecord): void {
    const key = `${record.workflowKey}:${record.category}:${record.issueId}`
    this.db
      .query(
        `INSERT INTO runtime_state (key, workflow_key, category, issue_id, data, updated_at)
         VALUES (?, ?, ?, ?, ?, unixepoch())
         ON CONFLICT(key) DO UPDATE SET
           data = excluded.data,
           updated_at = excluded.updated_at`,
      )
      .run(key, record.workflowKey, record.category, record.issueId, JSON.stringify(record.data))
  }

  delete(workflowKey: string, category: StateCategory, issueId: string): void {
    const key = `${workflowKey}:${category}:${issueId}`
    this.db.query("DELETE FROM runtime_state WHERE key = ?").run(key)
  }

  loadByCategory(workflowKey: string, category: StateCategory): StateRecord[] {
    const rows = this.db
      .query(
        `SELECT issue_id, data
         FROM runtime_state
         WHERE workflow_key = ? AND category = ?`,
      )
      .all(workflowKey, category) as Array<{
      issue_id: string
      data: string
    }>

    return rows.map((row) => ({
      workflowKey,
      issueId: row.issue_id,
      category,
      data: JSON.parse(row.data),
    }))
  }

  deleteAllInCategory(workflowKey: string, category: StateCategory): void {
    this.db
      .query("DELETE FROM runtime_state WHERE workflow_key = ? AND category = ?")
      .run(workflowKey, category)
  }
}
