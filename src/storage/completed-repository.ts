import type { Database } from "bun:sqlite"
import type { CompletedRecord, CompletedRepository } from "./types"

export class SqliteCompletedRepository implements CompletedRepository {
  constructor(private readonly db: Database) {}

  save(record: CompletedRecord): void {
    this.db
      .query(
        `INSERT INTO completed_entries
          (workflow_key, issue_id, issue_identifier, issue_title, issue_url, issue_state,
           issue_data, status, error, session_id, workspace_path, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(workflow_key, issue_id) DO UPDATE SET
           issue_identifier = excluded.issue_identifier,
           issue_title = excluded.issue_title,
           issue_url = excluded.issue_url,
           issue_state = excluded.issue_state,
           issue_data = excluded.issue_data,
           status = excluded.status,
           error = excluded.error,
           session_id = excluded.session_id,
           workspace_path = excluded.workspace_path,
           finished_at = excluded.finished_at`,
      )
      .run(
        record.workflowKey,
        record.issueId,
        record.issue.identifier,
        record.issue.title,
        record.issue.url,
        record.issue.state,
        JSON.stringify(record.issue),
        record.status,
        record.error,
        record.sessionId,
        record.workspacePath,
        record.finishedAt,
      )
  }

  loadRecent(workflowKey: string, limit: number): CompletedRecord[] {
    const rows = this.db
      .query(
        `SELECT issue_id, issue_data, status, error, session_id, workspace_path, finished_at
         FROM completed_entries
         WHERE workflow_key = ?
         ORDER BY finished_at DESC
         LIMIT ?`,
      )
      .all(workflowKey, limit) as Array<{
      issue_id: string
      issue_data: string
      status: string
      error: string | null
      session_id: string | null
      workspace_path: string | null
      finished_at: string
    }>

    return rows.map((row) => ({
      workflowKey,
      issueId: row.issue_id,
      issue: JSON.parse(row.issue_data),
      status: row.status as CompletedRecord["status"],
      error: row.error,
      sessionId: row.session_id,
      workspacePath: row.workspace_path,
      finishedAt: row.finished_at,
    }))
  }

  loadCount(workflowKey: string): number {
    const row = this.db
      .query("SELECT COUNT(*) as count FROM completed_entries WHERE workflow_key = ?")
      .get(workflowKey) as { count: number }
    return row.count
  }

  deleteOlderThan(workflowKey: string, limit: number): void {
    if (limit <= 0) return
    this.db
      .query(
        `DELETE FROM completed_entries
         WHERE workflow_key = ?
         AND id NOT IN (
           SELECT id FROM completed_entries
           WHERE workflow_key = ?
           ORDER BY finished_at DESC
           LIMIT ?
         )`,
      )
      .run(workflowKey, workflowKey, limit)
  }
}
