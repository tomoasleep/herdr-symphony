import type { Issue, RetryEntry } from "../domain/types"
import type { CompletedEntry, RunningEntry } from "../orchestrator/orchestrator"

export type CompletedRecord = {
  workflowKey: string
  issueId: string
  issue: Issue
  status: CompletedEntry["status"] | "interrupted"
  error: string | null
  sessionId: string | null
  workspacePath: string | null
  finishedAt: string
}

export type LogRecord = {
  workflowKey: string
  issueId: string
  issueIdentifier: string
  kind: string
  message: string
  timestamp: string
  durationMs?: number
}

export type StateCategory = "stopped" | "retry" | "running"

export type StateRecord = {
  workflowKey: string
  issueId: string
  category: StateCategory
  data: unknown
}

export interface CompletedRepository {
  save(record: CompletedRecord): void
  loadRecent(workflowKey: string, limit: number): CompletedRecord[]
  loadCount(workflowKey: string): number
  deleteOlderThan(workflowKey: string, limit: number): void
}

export interface LogRepository {
  append(record: LogRecord): void
  loadRecent(workflowKey: string, issueId: string, limit: number): LogRecord[]
  loadGlobalRecent(workflowKey: string, limit: number): LogRecord[]
  pruneOlderThan(workflowKey: string, limit: number): void
}

export interface StateRepository {
  save(record: StateRecord): void
  delete(workflowKey: string, category: StateCategory, issueId: string): void
  loadByCategory(workflowKey: string, category: StateCategory): StateRecord[]
  deleteAllInCategory(workflowKey: string, category: StateCategory): void
}

export type Storage = {
  completed: CompletedRepository
  logs: LogRepository
  state: StateRepository
  close(): void
}

export type StorageConfig = {
  databasePath: string
  completedRetention: number
  logRetention: number
}

export function serializeRunningEntry(entry: RunningEntry): unknown {
  return {
    issue: entry.issue,
    startedAt: entry.startedAt,
    lastEventAt: entry.lastEventAt,
    sessionId: entry.sessionId,
    workspacePath: entry.workspacePath,
  }
}

export function serializeRetryEntry(entry: RetryEntry): unknown {
  return entry
}

export function deserializeRetryEntry(data: unknown): RetryEntry {
  return data as RetryEntry
}

export type DeserializedRunningEntry = {
  issue: Issue
  startedAt: number
  lastEventAt: number
  sessionId: string | null
  workspacePath: string | null
}

export function deserializeRunningEntry(data: unknown): DeserializedRunningEntry {
  return data as DeserializedRunningEntry
}
