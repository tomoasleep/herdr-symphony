import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { openDatabase } from "./database"
import { SqliteLogRepository } from "./log-repository"
import type { LogRecord } from "./types"

function makeLog(overrides: Partial<LogRecord> = {}): LogRecord {
  return {
    workflowKey: "wf-1",
    issueId: "issue-1",
    issueIdentifier: "owner/repo#1",
    kind: "stdout",
    message: "hello world",
    timestamp: "2025-01-01T00:00:00.000Z",
    ...overrides,
  }
}

describe("SqliteLogRepository", () => {
  let db: ReturnType<typeof openDatabase>
  let repo: SqliteLogRepository

  beforeAll(() => {
    db = openDatabase(":memory:")
    repo = new SqliteLogRepository(db)
  })

  afterAll(() => {
    db.close()
  })

  test("append and loadRecent", () => {
    repo.append(makeLog())
    const logs = repo.loadRecent("wf-1", "issue-1", 10)
    expect(logs).toHaveLength(1)
    expect(logs[0]?.message).toBe("hello world")
    expect(logs[0]?.kind).toBe("stdout")
  })

  test("loadRecent returns in insertion order (most recent first)", () => {
    repo.append(
      makeLog({ issueId: "issue-2", message: "first", timestamp: "2025-01-01T00:00:01.000Z" }),
    )
    repo.append(
      makeLog({ issueId: "issue-2", message: "second", timestamp: "2025-01-01T00:00:02.000Z" }),
    )
    repo.append(
      makeLog({ issueId: "issue-2", message: "third", timestamp: "2025-01-01T00:00:03.000Z" }),
    )
    const logs = repo.loadRecent("wf-1", "issue-2", 10)
    expect(logs).toHaveLength(3)
    expect(logs[0]?.message).toBe("third")
    expect(logs[1]?.message).toBe("second")
    expect(logs[2]?.message).toBe("first")
  })

  test("loadRecent respects limit", () => {
    const logs = repo.loadRecent("wf-1", "issue-2", 2)
    expect(logs).toHaveLength(2)
    expect(logs[0]?.message).toBe("third")
    expect(logs[1]?.message).toBe("second")
  })

  test("loadRecent isolates by issueId", () => {
    const logs = repo.loadRecent("wf-1", "issue-1", 10)
    expect(logs).toHaveLength(1)
  })

  test("loadGlobalRecent returns across all issues", () => {
    const logs = repo.loadGlobalRecent("wf-1", 10)
    expect(logs.length).toBeGreaterThanOrEqual(4)
  })

  test("loadGlobalRecent respects limit", () => {
    const logs = repo.loadGlobalRecent("wf-1", 2)
    expect(logs).toHaveLength(2)
  })

  test("isolates by workflowKey", () => {
    repo.append(makeLog({ workflowKey: "wf-2", issueId: "issue-x", message: "other workflow" }))
    const wf1Logs = repo.loadRecent("wf-1", "issue-2", 10)
    const wf2Logs = repo.loadRecent("wf-2", "issue-x", 10)
    expect(wf2Logs).toHaveLength(1)
    expect(wf1Logs.every((l) => l.workflowKey === "wf-1")).toBe(true)
  })

  test("pruneOlderThan removes old logs beyond limit", () => {
    for (let i = 0; i < 10; i++) {
      repo.append(
        makeLog({
          workflowKey: "wf-prune",
          issueId: "prune-1",
          message: `log-${i}`,
          timestamp: `2025-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
        }),
      )
    }
    repo.pruneOlderThan("wf-prune", 3)
    const logs = repo.loadRecent("wf-prune", "prune-1", 100)
    expect(logs).toHaveLength(3)
    expect(logs[0]?.message).toBe("log-9")
    expect(logs[2]?.message).toBe("log-7")
  })

  test("pruneOlderThan with limit 0 keeps all", () => {
    repo.append(makeLog({ workflowKey: "wf-prune0", issueId: "p1" }))
    repo.append(makeLog({ workflowKey: "wf-prune0", issueId: "p2" }))
    repo.pruneOlderThan("wf-prune0", 0)
    expect(repo.loadGlobalRecent("wf-prune0", 100)).toHaveLength(2)
  })

  test("preserves durationMs when provided", () => {
    repo.append(makeLog({ workflowKey: "wf-dur", issueId: "dur-1", durationMs: 5000 }))
    const logs = repo.loadRecent("wf-dur", "dur-1", 10)
    expect(logs[0]?.durationMs).toBe(5000)
  })
})
