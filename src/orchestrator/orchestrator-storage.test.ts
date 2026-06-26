import { describe, expect, test } from "bun:test"
import type { ServiceConfig } from "../domain/types"
import { SqliteCompletedRepository } from "../storage/completed-repository"
import { openDatabase } from "../storage/database"
import { SqliteLogRepository } from "../storage/log-repository"
import { SqliteStateRepository } from "../storage/state-repository"
import type { Storage } from "../storage/types"
import type { IssueTrackerClient } from "../tracker/types"
import { OrchestratorState } from "./orchestrator"
import { isActiveState } from "./scheduling"

function makeConfig(): ServiceConfig {
  return {
    tracker: {
      kind: "github_project",
      github_project: { owner: "@me", number: 4 },
      file: null,
      schedule: null,
    },
    polling: { intervalMs: 30_000 },
    hooks: { beforeRun: null, afterRun: null, timeoutMs: 60_000 },
    agent: {
      maxConcurrentAgents: 2,
      maxRetryBackoffMs: 300_000,
      maxConcurrentAgentsByState: { backlog: 1 },
    },
    work: {
      activeStates: ["Backlog", "Ready"],
      terminalStates: ["Done"],
      runningState: null,
      successState: null,
      failureState: null,
      stoppedState: null,
      runner: "herdr_agent",
      herdrAgent: {
        agent: "opencode",
        opencode: { model: null, agent: null },
        claude: { model: null },
        workspaceLabel: null,
        turnTimeoutMs: 3_600_000,
      },
      workspace: {
        provider: "gwq",
        reuseExisting: true,
        createIfMissing: true,
        branch: null,
        path: null,
        baseDir: null,
        repository: null,
        gwq: { command: "gwq", createBranch: true },
      },
      reporter: ["file"],
    },
  }
}

function makeTrackerClient(): IssueTrackerClient {
  return {
    fetchCandidateIssues: async () => [],
    fetchIssuesByStates: async () => [],
    fetchIssueStatesByIds: async () => [],
    moveIssueToState: async () => {},
    shouldRun: (issue, activeStates) => isActiveState(issue.state, activeStates),
  }
}

function makeIssue(overrides: Partial<{ id: string; identifier: string; state: string }> = {}): {
  id: string
  identifier: string
  title: string
  description: null
  priority: number
  state: string
  repository: null
  fields: Record<string, never>
  url: null
  labels: never[]
  blockedBy: never[]
  createdAt: null
  updatedAt: null
} {
  return {
    id: "1",
    identifier: "A-1",
    title: "test",
    description: null,
    priority: 1,
    state: "Ready",
    repository: null,
    fields: {},
    url: null,
    labels: [],
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
    ...overrides,
  }
}

function makeStorage(): Storage {
  const db = openDatabase(":memory:")
  return {
    completed: new SqliteCompletedRepository(db),
    logs: new SqliteLogRepository(db),
    state: new SqliteStateRepository(db),
    close: () => db.close(),
  }
}

describe("OrchestratorState with storage", () => {
  const workflowKey = "wf-test"

  test("release() writes completed entry to SQLite", () => {
    const storage = makeStorage()
    const orchestrator = new OrchestratorState(makeConfig(), storage, workflowKey)
    const issue = makeIssue({ id: "1", identifier: "A-1" })

    orchestrator.markRunning(issue, "session-1", "/tmp/ws")
    orchestrator.release("1", {
      status: "succeeded",
      error: null,
      finishedAt: "2026-01-01T00:00:00.000Z",
    })

    const records = storage.completed.loadRecent(workflowKey, 10)
    expect(records).toHaveLength(1)
    expect(records[0]?.issueId).toBe("1")
    expect(records[0]?.status).toBe("succeeded")
    expect(records[0]?.sessionId).toBe("session-1")
    expect(records[0]?.workspacePath).toBe("/tmp/ws")
    storage.close()
  })

  test("markStopped() persists to SQLite", () => {
    const storage = makeStorage()
    const orchestrator = new OrchestratorState(makeConfig(), storage, workflowKey)

    orchestrator.markStopped("issue-1")

    const records = storage.state.loadByCategory(workflowKey, "stopped")
    expect(records).toHaveLength(1)
    expect(records[0]?.issueId).toBe("issue-1")
    storage.close()
  })

  test("clearStopped() deletes from SQLite", () => {
    const storage = makeStorage()
    const orchestrator = new OrchestratorState(makeConfig(), storage, workflowKey)

    orchestrator.markStopped("issue-1")
    orchestrator.clearStopped("issue-1")

    expect(storage.state.loadByCategory(workflowKey, "stopped")).toHaveLength(0)
    storage.close()
  })

  test("markRunning() persists running state to SQLite", () => {
    const storage = makeStorage()
    const orchestrator = new OrchestratorState(makeConfig(), storage, workflowKey)
    const issue = makeIssue({ id: "r1" })

    orchestrator.markRunning(issue, "session-1", "/tmp/ws")

    const records = storage.state.loadByCategory(workflowKey, "running")
    expect(records).toHaveLength(1)
    expect(records[0]?.issueId).toBe("r1")
    storage.close()
  })

  test("release() deletes running state from SQLite", () => {
    const storage = makeStorage()
    const orchestrator = new OrchestratorState(makeConfig(), storage, workflowKey)
    const issue = makeIssue({ id: "r1" })

    orchestrator.markRunning(issue, null, null)
    orchestrator.release("r1", {
      status: "succeeded",
      error: null,
      finishedAt: "2026-01-01T00:00:00.000Z",
    })

    expect(storage.state.loadByCategory(workflowKey, "running")).toHaveLength(0)
    storage.close()
  })

  test("release() without completed data deletes running state", () => {
    const storage = makeStorage()
    const orchestrator = new OrchestratorState(makeConfig(), storage, workflowKey)
    const issue = makeIssue({ id: "r1" })

    orchestrator.markRunning(issue, null, null)
    orchestrator.release("r1")

    expect(storage.state.loadByCategory(workflowKey, "running")).toHaveLength(0)
    storage.close()
  })

  test("scheduleFailureRetry() persists retry to SQLite", () => {
    const storage = makeStorage()
    const orchestrator = new OrchestratorState(makeConfig(), storage, workflowKey)
    const issue = makeIssue({ id: "retry-1", identifier: "A-1" })

    orchestrator.scheduleFailureRetry(issue, 1, "timeout")

    const records = storage.state.loadByCategory(workflowKey, "retry")
    expect(records).toHaveLength(1)
    expect(records[0]?.issueId).toBe("retry-1")
    const data = records[0]?.data as { attempt: number; error: string }
    expect(data.attempt).toBe(1)
    expect(data.error).toBe("timeout")
    storage.close()
  })

  test("processDueRetries() deletes from SQLite", () => {
    const storage = makeStorage()
    const orchestrator = new OrchestratorState(makeConfig(), storage, workflowKey)
    const issue = makeIssue({ id: "retry-1", identifier: "A-1" })

    orchestrator.scheduleContinuationRetry(issue)
    const entry = orchestrator.retryAttempts.get("retry-1")
    if (entry) entry.dueAtMs = Date.now() - 1
    expect(storage.state.loadByCategory(workflowKey, "retry")).toHaveLength(1)

    const due = orchestrator.processDueRetries()
    expect(due).toHaveLength(1)

    expect(storage.state.loadByCategory(workflowKey, "retry")).toHaveLength(0)
    storage.close()
  })

  test("completed entries exceed 100 without eviction", () => {
    const storage = makeStorage()
    const orchestrator = new OrchestratorState(makeConfig(), storage, workflowKey)

    for (let i = 0; i < 120; i++) {
      const issue = makeIssue({ id: `issue-${i}`, identifier: `A-${i}` })
      orchestrator.markRunning(issue, null, null)
      orchestrator.release(`issue-${i}`, {
        status: "succeeded",
        error: null,
        finishedAt: `2026-01-01T${String(i % 24).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00.000Z`,
      })
    }

    expect(orchestrator.completed.size).toBe(120)
    expect(storage.completed.loadCount(workflowKey)).toBe(120)
    storage.close()
  })

  test("snapshot includes completed entries from in-memory cache", () => {
    const storage = makeStorage()
    const orchestrator = new OrchestratorState(makeConfig(), storage, workflowKey)
    const issue = makeIssue({ id: "1", identifier: "A-1" })

    orchestrator.markRunning(issue, "session-1", "/tmp/ws")
    orchestrator.release("1", {
      status: "succeeded",
      error: null,
      finishedAt: "2026-01-01T00:00:00.000Z",
    })

    const snapshot = orchestrator.snapshot()
    expect(snapshot.completed).toHaveLength(1)
    expect(snapshot.completed[0]?.issueId).toBe("1")
    expect(snapshot.completed[0]?.sessionId).toBe("session-1")
    storage.close()
  })

  test("restoreFromStorage restores stopped entries", () => {
    const storage = makeStorage()
    const orchestrator1 = new OrchestratorState(makeConfig(), storage, workflowKey)
    orchestrator1.markStopped("stopped-1")

    const orchestrator2 = new OrchestratorState(makeConfig(), storage, workflowKey)
    orchestrator2.restoreFromStorage()

    expect(orchestrator2.isStopped("stopped-1")).toBeTrue()
    storage.close()
  })

  test("restoreFromStorage restores retry entries", () => {
    const storage = makeStorage()
    const orchestrator1 = new OrchestratorState(makeConfig(), storage, workflowKey)
    const issue = makeIssue({ id: "retry-1", identifier: "A-1" })
    orchestrator1.scheduleFailureRetry(issue, 2, "error")

    const orchestrator2 = new OrchestratorState(makeConfig(), storage, workflowKey)
    orchestrator2.restoreFromStorage()

    expect(orchestrator2.retryAttempts.has("retry-1")).toBeTrue()
    const entry = orchestrator2.retryAttempts.get("retry-1")
    expect(entry?.attempt).toBe(2)
    expect(entry?.error).toBe("error")
    storage.close()
  })

  test("restoreFromStorage moves running entries to completed as interrupted", () => {
    const storage = makeStorage()
    const orchestrator1 = new OrchestratorState(makeConfig(), storage, workflowKey)
    const issue = makeIssue({ id: "running-1", identifier: "A-1" })
    orchestrator1.markRunning(issue, "session-1", "/tmp/ws")

    const orchestrator2 = new OrchestratorState(makeConfig(), storage, workflowKey)
    orchestrator2.restoreFromStorage()

    expect(orchestrator2.running.has("running-1")).toBeFalse()

    const completed = storage.completed.loadRecent(workflowKey, 10)
    const interrupted = completed.find((c) => c.issueId === "running-1")
    expect(interrupted?.status).toBe("interrupted")
    expect(interrupted?.error).toContain("restart")

    expect(storage.state.loadByCategory(workflowKey, "running")).toHaveLength(0)
    storage.close()
  })

  test("restoreFromStorage loads recent completed into cache", () => {
    const storage = makeStorage()
    const orchestrator1 = new OrchestratorState(makeConfig(), storage, workflowKey)

    for (let i = 0; i < 5; i++) {
      const issue = makeIssue({ id: `done-${i}`, identifier: `A-${i}` })
      orchestrator1.markRunning(issue, null, null)
      orchestrator1.release(`done-${i}`, {
        status: "succeeded",
        error: null,
        finishedAt: `2026-01-0${i + 1}T00:00:00.000Z`,
      })
    }

    const orchestrator2 = new OrchestratorState(makeConfig(), storage, workflowKey)
    orchestrator2.restoreFromStorage()

    const snapshot = orchestrator2.snapshot()
    expect(snapshot.counts.completed).toBe(5)
    expect(snapshot.completed).toHaveLength(5)
    storage.close()
  })

  test("without storage, existing behavior unchanged (100 entry limit)", () => {
    const orchestrator = new OrchestratorState(makeConfig())

    for (let i = 0; i < 110; i++) {
      const issue = makeIssue({ id: `issue-${i}`, identifier: `A-${i}` })
      orchestrator.markRunning(issue, null, null)
      orchestrator.release(`issue-${i}`, {
        status: "succeeded",
        error: null,
        finishedAt: `2026-01-01T${String(i % 24).padStart(2, "0")}:00:00.000Z`,
      })
    }

    expect(orchestrator.completed.size).toBe(100)
  })

  test("dispatchable works correctly with storage-backed stopped", () => {
    const storage = makeStorage()
    const orchestrator = new OrchestratorState(makeConfig(), storage, workflowKey)
    const issue = makeIssue({ id: "1", identifier: "A-1", state: "Backlog" })

    orchestrator.markStopped("1")
    expect(orchestrator.dispatchable([issue], makeTrackerClient())).toHaveLength(0)

    orchestrator.clearStopped("1")
    expect(orchestrator.dispatchable([issue], makeTrackerClient())).toHaveLength(1)
    storage.close()
  })
})
