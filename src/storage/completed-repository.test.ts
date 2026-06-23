import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Issue } from "../domain/types"
import { SqliteCompletedRepository } from "./completed-repository"
import { openDatabase } from "./database"
import type { CompletedRecord } from "./types"

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    identifier: "owner/repo#1",
    title: "Test issue",
    description: null,
    priority: null,
    state: "Done",
    repository: "owner/repo",
    fields: {},
    url: "https://github.com/owner/repo/issues/1",
    labels: [],
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
    ...overrides,
  }
}

function makeRecord(overrides: Partial<CompletedRecord> = {}): CompletedRecord {
  return {
    workflowKey: "wf-1",
    issueId: "issue-1",
    issue: makeIssue(),
    status: "succeeded",
    error: null,
    sessionId: "session-1",
    workspacePath: "/tmp/workspace",
    finishedAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  }
}

describe("SqliteCompletedRepository", () => {
  let db: ReturnType<typeof openDatabase>
  let repo: SqliteCompletedRepository

  beforeAll(() => {
    db = openDatabase(":memory:")
    repo = new SqliteCompletedRepository(db)
  })

  afterAll(() => {
    db.close()
  })

  test("save and loadRecent", () => {
    repo.save(makeRecord())
    const records = repo.loadRecent("wf-1", 10)
    expect(records).toHaveLength(1)
    expect(records[0]?.issueId).toBe("issue-1")
    expect(records[0]?.status).toBe("succeeded")
    expect(records[0]?.issue.identifier).toBe("owner/repo#1")
  })

  test("loadRecent returns most recent first", () => {
    repo.save(makeRecord({ issueId: "issue-2", finishedAt: "2025-01-02T00:00:00.000Z" }))
    repo.save(makeRecord({ issueId: "issue-3", finishedAt: "2025-01-03T00:00:00.000Z" }))
    const records = repo.loadRecent("wf-1", 10)
    expect(records).toHaveLength(3)
    expect(records[0]?.issueId).toBe("issue-3")
    expect(records[1]?.issueId).toBe("issue-2")
    expect(records[2]?.issueId).toBe("issue-1")
  })

  test("loadRecent respects limit", () => {
    const records = repo.loadRecent("wf-1", 2)
    expect(records).toHaveLength(2)
    expect(records[0]?.issueId).toBe("issue-3")
    expect(records[1]?.issueId).toBe("issue-2")
  })

  test("loadCount returns total count", () => {
    expect(repo.loadCount("wf-1")).toBe(3)
    expect(repo.loadCount("wf-other")).toBe(0)
  })

  test("save upserts on same workflow_key + issue_id", () => {
    repo.save(makeRecord({ issueId: "issue-1", status: "failed", error: "oops" }))
    expect(repo.loadCount("wf-1")).toBe(3)
    const records = repo.loadRecent("wf-1", 10)
    const updated = records.find((r) => r.issueId === "issue-1")
    expect(updated?.status).toBe("failed")
    expect(updated?.error).toBe("oops")
  })

  test("isolates by workflowKey", () => {
    repo.save(makeRecord({ workflowKey: "wf-2", issueId: "issue-a" }))
    expect(repo.loadCount("wf-1")).toBe(3)
    expect(repo.loadCount("wf-2")).toBe(1)
  })

  test("deleteOlderThan removes oldest entries beyond limit", () => {
    repo.save(
      makeRecord({ workflowKey: "wf-del", issueId: "d1", finishedAt: "2025-01-01T00:00:00.000Z" }),
    )
    repo.save(
      makeRecord({ workflowKey: "wf-del", issueId: "d2", finishedAt: "2025-01-02T00:00:00.000Z" }),
    )
    repo.save(
      makeRecord({ workflowKey: "wf-del", issueId: "d3", finishedAt: "2025-01-03T00:00:00.000Z" }),
    )

    repo.deleteOlderThan("wf-del", 1)
    expect(repo.loadCount("wf-del")).toBe(1)
    const records = repo.loadRecent("wf-del", 10)
    expect(records[0]?.issueId).toBe("d3")
  })

  test("deleteOlderThan with limit 0 keeps all", () => {
    repo.save(makeRecord({ workflowKey: "wf-zero", issueId: "z1" }))
    repo.save(makeRecord({ workflowKey: "wf-zero", issueId: "z2" }))
    repo.deleteOlderThan("wf-zero", 0)
    expect(repo.loadCount("wf-zero")).toBe(2)
  })

  test("preserves issue data through serialization", () => {
    const complexIssue = makeIssue({
      id: "complex-1",
      fields: { Priority: "P0", Status: "Done" },
      labels: ["bug", "urgent"],
      blockedBy: [{ id: "blk-1", identifier: "owner/repo#99", state: "Todo" }],
    })
    repo.save(makeRecord({ workflowKey: "wf-complex", issueId: "complex-1", issue: complexIssue }))
    const records = repo.loadRecent("wf-complex", 10)
    expect(records[0]?.issue.fields.Priority).toBe("P0")
    expect(records[0]?.issue.labels).toEqual(["bug", "urgent"])
    expect(records[0]?.issue.blockedBy).toHaveLength(1)
  })
})
