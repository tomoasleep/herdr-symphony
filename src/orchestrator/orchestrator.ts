import type { Issue, RetryEntry, ServiceConfig } from "../domain/types"
import type { Storage } from "../storage/types"
import type { IssueTrackerClient } from "../tracker/types"
import {
  computeAvailableStateSlots,
  computeFailureBackoffMs,
  hasOpenTodoBlocker,
  sortIssues,
} from "./scheduling"

const MAX_COMPLETED_ENTRIES = 100

export type RunningEntry = {
  issue: Issue
  startedAt: number
  lastEventAt: number
  sessionId: string | null
  workspacePath: string | null
}

export type CompletedEntry = {
  issue: Issue
  status: "succeeded" | "failed" | "timeout"
  error: string | null
  finishedAt: string
  sessionId: string | null
  workspacePath: string | null
}

export type RuntimeSnapshot = {
  generatedAt: string
  counts: {
    running: number
    retrying: number
    completed: number
  }
  running: Array<{
    issueId: string
    issueIdentifier: string
    issueUrl: string | null
    state: string
    startedAt: string
    lastEventAt: string
    sessionId: string | null
    workspacePath: string | null
  }>
  retrying: Array<RetryEntry>
  completed: Array<{
    issueId: string
    issueIdentifier: string
    issueUrl: string | null
    state: string
    status: "succeeded" | "failed" | "timeout"
    error: string | null
    finishedAt: string
    sessionId: string | null
    workspacePath: string | null
  }>
}

export class OrchestratorState {
  readonly running = new Map<string, RunningEntry>()
  readonly claimed = new Set<string>()
  readonly retryAttempts = new Map<string, RetryEntry>()
  readonly completed = new Map<string, CompletedEntry>()
  readonly stopped = new Set<string>()

  public config: ServiceConfig
  private readonly storage?: Storage
  private readonly workflowKey?: string

  constructor(config: ServiceConfig, storage?: Storage, workflowKey?: string) {
    this.config = config
    this.storage = storage
    this.workflowKey = workflowKey
  }

  updateConfig(config: ServiceConfig): void {
    this.config = config
  }

  snapshot(): RuntimeSnapshot {
    return {
      generatedAt: new Date().toISOString(),
      counts: {
        running: this.running.size,
        retrying: this.retryAttempts.size,
        completed: this.completed.size,
      },
      running: [...this.running.entries()].map(([issueId, entry]) => ({
        issueId,
        issueIdentifier: entry.issue.identifier,
        issueUrl: entry.issue.url,
        state: entry.issue.state,
        startedAt: new Date(entry.startedAt).toISOString(),
        lastEventAt: new Date(entry.lastEventAt).toISOString(),
        sessionId: entry.sessionId,
        workspacePath: entry.workspacePath,
      })),
      retrying: [...this.retryAttempts.values()],
      completed: [...this.completed.entries()].map(([issueId, entry]) => ({
        issueId,
        issueIdentifier: entry.issue.identifier,
        issueUrl: entry.issue.url,
        state: entry.issue.state,
        status: entry.status,
        error: entry.error,
        finishedAt: entry.finishedAt,
        sessionId: entry.sessionId,
        workspacePath: entry.workspacePath,
      })),
    }
  }

  dispatchable(candidates: Issue[], trackerClient: IssueTrackerClient): Issue[] {
    const sorted = sortIssues(candidates)
    const runningStates = [...this.running.values()].map((entry) => entry.issue.state)
    const globalSlots = Math.max(this.config.agent.maxConcurrentAgents - this.running.size, 0)

    if (globalSlots <= 0) {
      return []
    }

    const selected: Issue[] = []
    for (const issue of sorted) {
      if (selected.length >= globalSlots) {
        break
      }

      if (trackerClient.shouldRun?.(issue, this.config.work.activeStates) === false) {
        continue
      }

      if (this.running.has(issue.id) || this.claimed.has(issue.id) || this.stopped.has(issue.id)) {
        continue
      }

      if (hasOpenTodoBlocker(issue, this.config.work.activeStates, this.config.work.runningState)) {
        continue
      }

      const stateSlots = computeAvailableStateSlots(
        issue.state,
        [...runningStates, ...selected.map((item) => item.state)],
        this.config.agent.maxConcurrentAgents,
        this.config.agent.maxConcurrentAgentsByState,
      )

      if (stateSlots <= 0) {
        continue
      }

      selected.push(issue)
    }

    return selected
  }

  markStopped(issueId: string): void {
    this.stopped.add(issueId)
    if (this.storage && this.workflowKey) {
      this.storage.state.save({
        workflowKey: this.workflowKey,
        issueId,
        category: "stopped",
        data: {},
      })
    }
  }

  isStopped(issueId: string): boolean {
    return this.stopped.has(issueId)
  }

  clearStopped(issueId: string): void {
    this.stopped.delete(issueId)
    if (this.storage && this.workflowKey) {
      this.storage.state.delete(this.workflowKey, "stopped", issueId)
    }
  }

  markRunning(issue: Issue, sessionId: string | null, workspacePath: string | null = null): void {
    this.completed.delete(issue.id)
    this.claimed.add(issue.id)
    this.running.set(issue.id, {
      issue,
      startedAt: Date.now(),
      lastEventAt: Date.now(),
      sessionId,
      workspacePath,
    })
    if (this.storage && this.workflowKey) {
      this.storage.state.save({
        workflowKey: this.workflowKey,
        issueId: issue.id,
        category: "running",
        data: {
          issue,
          startedAt: Date.now(),
          lastEventAt: Date.now(),
          sessionId,
          workspacePath,
        },
      })
    }
  }

  markEvent(issueId: string): void {
    const current = this.running.get(issueId)
    if (!current) {
      return
    }
    current.lastEventAt = Date.now()
    this.running.set(issueId, current)
  }

  setSessionId(issueId: string, sessionId: string): void {
    const current = this.running.get(issueId)
    if (!current) {
      return
    }
    current.sessionId = sessionId
    this.running.set(issueId, current)
  }

  setWorkspacePath(issueId: string, workspacePath: string): void {
    const current = this.running.get(issueId)
    if (!current) {
      return
    }
    current.workspacePath = workspacePath
    this.running.set(issueId, current)
  }

  release(
    issueId: string,
    completed?: {
      status: "succeeded" | "failed" | "timeout"
      error: string | null
      finishedAt: string
    },
  ): void {
    const running = this.running.get(issueId)
    if (running && completed) {
      this.completed.set(issueId, {
        issue: running.issue,
        status: completed.status,
        error: completed.error,
        finishedAt: completed.finishedAt,
        sessionId: running.sessionId,
        workspacePath: running.workspacePath,
      })
      if (this.storage && this.workflowKey) {
        this.storage.completed.save({
          workflowKey: this.workflowKey,
          issueId,
          issue: running.issue,
          status: completed.status,
          error: completed.error,
          sessionId: running.sessionId,
          workspacePath: running.workspacePath,
          finishedAt: completed.finishedAt,
        })
      }
    }
    if (!this.storage) {
      this.evictOldCompletedEntries()
    }
    this.running.delete(issueId)
    this.claimed.delete(issueId)
    this.retryAttempts.delete(issueId)
    if (this.storage && this.workflowKey) {
      this.storage.state.delete(this.workflowKey, "running", issueId)
      this.storage.state.delete(this.workflowKey, "retry", issueId)
    }
  }

  private evictOldCompletedEntries(): void {
    if (this.completed.size <= MAX_COMPLETED_ENTRIES) {
      return
    }
    const entries = [...this.completed.entries()].sort((a, b) =>
      a[1].finishedAt.localeCompare(b[1].finishedAt),
    )
    const evictCount = this.completed.size - MAX_COMPLETED_ENTRIES
    for (let i = 0; i < evictCount; i++) {
      const entry = entries[i]
      if (entry) {
        this.completed.delete(entry[0])
      }
    }
  }

  scheduleContinuationRetry(issue: Issue): RetryEntry {
    const entry: RetryEntry = {
      issueId: issue.id,
      identifier: issue.identifier,
      attempt: 1,
      dueAtMs: Date.now() + 1_000,
      error: null,
    }
    this.retryAttempts.set(issue.id, entry)
    this.claimed.add(issue.id)
    this.running.delete(issue.id)
    if (this.storage && this.workflowKey) {
      this.storage.state.save({
        workflowKey: this.workflowKey,
        issueId: issue.id,
        category: "retry",
        data: entry,
      })
      this.storage.state.delete(this.workflowKey, "running", issue.id)
    }
    return entry
  }

  scheduleFailureRetry(issue: Issue, currentAttempt: number, error: string): RetryEntry {
    const attempt = Math.max(currentAttempt, 1)
    const delay = computeFailureBackoffMs(attempt, this.config.agent.maxRetryBackoffMs)
    const entry: RetryEntry = {
      issueId: issue.id,
      identifier: issue.identifier,
      attempt,
      dueAtMs: Date.now() + delay,
      error,
    }
    this.retryAttempts.set(issue.id, entry)
    this.claimed.add(issue.id)
    this.running.delete(issue.id)
    if (this.storage && this.workflowKey) {
      this.storage.state.save({
        workflowKey: this.workflowKey,
        issueId: issue.id,
        category: "retry",
        data: entry,
      })
      this.storage.state.delete(this.workflowKey, "running", issue.id)
    }
    return entry
  }

  reconcileRunning(refreshedIssues: Issue[]): string[] {
    const refreshedById = new Map(refreshedIssues.map((item) => [item.id, item]))
    const stopped: string[] = []

    for (const [issueId, running] of this.running.entries()) {
      const current = refreshedById.get(issueId)
      if (!current) {
        this.release(issueId)
        stopped.push(issueId)
        continue
      }

      this.running.set(issueId, {
        ...running,
        issue: current,
      })
    }

    return stopped
  }

  processDueRetries(): Array<{ issueId: string; identifier: string; attempt: number }> {
    const now = Date.now()
    const due: Array<{ issueId: string; identifier: string; attempt: number }> = []

    for (const [issueId, entry] of this.retryAttempts.entries()) {
      if (entry.dueAtMs <= now) {
        this.claimed.delete(issueId)
        this.retryAttempts.delete(issueId)
        if (this.storage && this.workflowKey) {
          this.storage.state.delete(this.workflowKey, "retry", issueId)
        }
        due.push({ issueId, identifier: entry.identifier, attempt: entry.attempt })
      }
    }

    return due
  }

  restoreFromStorage(): void {
    if (!this.storage || !this.workflowKey) return

    for (const record of this.storage.state.loadByCategory(this.workflowKey, "stopped")) {
      this.stopped.add(record.issueId)
    }

    for (const record of this.storage.state.loadByCategory(this.workflowKey, "retry")) {
      const entry = record.data as RetryEntry
      this.retryAttempts.set(entry.issueId, entry)
    }

    const runningRecords = this.storage.state.loadByCategory(this.workflowKey, "running")
    for (const record of runningRecords) {
      const data = record.data as {
        issue: Issue
        startedAt: number
        lastEventAt: number
        sessionId: string | null
        workspacePath: string | null
      }
      this.storage.completed.save({
        workflowKey: this.workflowKey,
        issueId: data.issue.id,
        issue: data.issue,
        status: "interrupted",
        error: "process restarted",
        sessionId: data.sessionId,
        workspacePath: data.workspacePath,
        finishedAt: new Date().toISOString(),
      })
      this.storage.state.delete(this.workflowKey, "running", record.issueId)
    }

    const recent = this.storage.completed.loadRecent(this.workflowKey, 200)
    for (const record of recent) {
      this.completed.set(record.issueId, {
        issue: record.issue,
        status: record.status === "interrupted" ? "failed" : record.status,
        error: record.error,
        finishedAt: record.finishedAt,
        sessionId: record.sessionId,
        workspacePath: record.workspacePath,
      })
    }
  }
}
