import type { Database } from "bun:sqlite"
import type { LogRecord, LogRepository } from "./types"

export class SqliteLogRepository implements LogRepository {
  constructor(private readonly db: Database) {}

  append(record: LogRecord): void {
    this.db
      .query(
        `INSERT INTO execution_logs
          (workflow_key, issue_id, issue_identifier, kind, message, timestamp, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.workflowKey,
        record.issueId,
        record.issueIdentifier,
        record.kind,
        record.message,
        record.timestamp,
        record.durationMs ?? null,
      )
  }

  loadRecent(workflowKey: string, issueId: string, limit: number): LogRecord[] {
    const rows = this.db
      .query(
        `SELECT issue_id, issue_identifier, kind, message, timestamp, duration_ms
         FROM execution_logs
         WHERE workflow_key = ? AND issue_id = ?
         ORDER BY id DESC
         LIMIT ?`,
      )
      .all(workflowKey, issueId, limit) as Array<{
      issue_id: string
      issue_identifier: string | null
      kind: string
      message: string
      timestamp: string
      duration_ms: number | null
    }>

    return rows.map((row) => ({
      workflowKey,
      issueId: row.issue_id,
      issueIdentifier: row.issue_identifier ?? "",
      kind: row.kind,
      message: row.message,
      timestamp: row.timestamp,
      ...(row.duration_ms !== null ? { durationMs: row.duration_ms } : {}),
    }))
  }

  loadGlobalRecent(workflowKey: string, limit: number): LogRecord[] {
    const rows = this.db
      .query(
        `SELECT issue_id, issue_identifier, kind, message, timestamp, duration_ms
         FROM execution_logs
         WHERE workflow_key = ?
         ORDER BY id DESC
         LIMIT ?`,
      )
      .all(workflowKey, limit) as Array<{
      issue_id: string
      issue_identifier: string | null
      kind: string
      message: string
      timestamp: string
      duration_ms: number | null
    }>

    return rows.map((row) => ({
      workflowKey,
      issueId: row.issue_id,
      issueIdentifier: row.issue_identifier ?? "",
      kind: row.kind,
      message: row.message,
      timestamp: row.timestamp,
      ...(row.duration_ms !== null ? { durationMs: row.duration_ms } : {}),
    }))
  }

  pruneOlderThan(workflowKey: string, limit: number): void {
    if (limit <= 0) return
    this.db
      .query(
        `DELETE FROM execution_logs
         WHERE workflow_key = ?
         AND id NOT IN (
           SELECT id FROM execution_logs
           WHERE workflow_key = ?
           ORDER BY id DESC
           LIMIT ?
         )`,
      )
      .run(workflowKey, workflowKey, limit)
  }
}
