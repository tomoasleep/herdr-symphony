import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { openDatabase } from "./database"
import { SqliteStateRepository } from "./state-repository"

describe("SqliteStateRepository", () => {
  let db: ReturnType<typeof openDatabase>
  let repo: SqliteStateRepository

  beforeAll(() => {
    db = openDatabase(":memory:")
    repo = new SqliteStateRepository(db)
  })

  afterAll(() => {
    db.close()
  })

  test("save and loadByCategory for stopped", () => {
    repo.save({
      workflowKey: "wf-1",
      issueId: "issue-1",
      category: "stopped",
      data: { reason: "manual" },
    })
    const records = repo.loadByCategory("wf-1", "stopped")
    expect(records).toHaveLength(1)
    expect(records[0]?.issueId).toBe("issue-1")
    expect(records[0]?.data).toEqual({ reason: "manual" })
  })

  test("save and loadByCategory for retry", () => {
    repo.save({
      workflowKey: "wf-1",
      issueId: "issue-2",
      category: "retry",
      data: {
        issueId: "issue-2",
        identifier: "repo#2",
        attempt: 1,
        dueAtMs: 1700000000000,
        error: "timeout",
      },
    })
    const records = repo.loadByCategory("wf-1", "retry")
    expect(records).toHaveLength(1)
    expect(records[0]?.issueId).toBe("issue-2")
  })

  test("save and loadByCategory for running", () => {
    repo.save({
      workflowKey: "wf-1",
      issueId: "issue-3",
      category: "running",
      data: { sessionId: "s-1", workspacePath: "/tmp/ws" },
    })
    const records = repo.loadByCategory("wf-1", "running")
    expect(records).toHaveLength(1)
  })

  test("loadByCategory isolates by category", () => {
    expect(repo.loadByCategory("wf-1", "stopped")).toHaveLength(1)
    expect(repo.loadByCategory("wf-1", "retry")).toHaveLength(1)
    expect(repo.loadByCategory("wf-1", "running")).toHaveLength(1)
  })

  test("loadByCategory isolates by workflowKey", () => {
    repo.save({
      workflowKey: "wf-2",
      issueId: "issue-1",
      category: "stopped",
      data: {},
    })
    expect(repo.loadByCategory("wf-1", "stopped")).toHaveLength(1)
    expect(repo.loadByCategory("wf-2", "stopped")).toHaveLength(1)
  })

  test("save upserts on same key", () => {
    repo.save({
      workflowKey: "wf-up",
      issueId: "up-1",
      category: "stopped",
      data: { v: 1 },
    })
    repo.save({
      workflowKey: "wf-up",
      issueId: "up-1",
      category: "stopped",
      data: { v: 2 },
    })
    const records = repo.loadByCategory("wf-up", "stopped")
    expect(records).toHaveLength(1)
    expect(records[0]?.data).toEqual({ v: 2 })
  })

  test("delete removes specific entry", () => {
    repo.save({ workflowKey: "wf-del", issueId: "d1", category: "stopped", data: {} })
    repo.save({ workflowKey: "wf-del", issueId: "d2", category: "stopped", data: {} })
    repo.delete("wf-del", "stopped", "d1")
    const records = repo.loadByCategory("wf-del", "stopped")
    expect(records).toHaveLength(1)
    expect(records[0]?.issueId).toBe("d2")
  })

  test("delete is no-op for missing entry", () => {
    repo.delete("wf-del", "stopped", "nonexistent")
    expect(repo.loadByCategory("wf-del", "stopped")).toHaveLength(1)
  })

  test("deleteAllInCategory removes all in category", () => {
    repo.save({ workflowKey: "wf-all", issueId: "a1", category: "stopped", data: {} })
    repo.save({ workflowKey: "wf-all", issueId: "a2", category: "stopped", data: {} })
    repo.save({ workflowKey: "wf-all", issueId: "a3", category: "retry", data: {} })
    repo.deleteAllInCategory("wf-all", "stopped")
    expect(repo.loadByCategory("wf-all", "stopped")).toHaveLength(0)
    expect(repo.loadByCategory("wf-all", "retry")).toHaveLength(1)
  })
})
