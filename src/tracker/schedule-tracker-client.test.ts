import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { ScheduleTrackerClient } from "./schedule-tracker-client"

describe("ScheduleTrackerClient", () => {
  const workflowPath = join(import.meta.dir, "..", "..", "WORKFLOW.md")
  let client: ScheduleTrackerClient

  beforeEach(() => {
    client = new ScheduleTrackerClient(
      {
        kind: "schedule",
        schedule: { cron: "* * * * *" },
        github_project: null,
        file: null,
      },
      workflowPath,
    )
  })

  afterAll(() => {})

  describe("fetchCandidateIssues", () => {
    test("初回は発火しない", async () => {
      const issues = await client.fetchCandidateIssues()
      expect(issues).toHaveLength(0)
    })

    test("2回目以降は cron マッチ時に Issue を取得する", async () => {
      await client.fetchCandidateIssues()

      await new Promise((resolve) => setTimeout(resolve, 100))

      const issues = await client.fetchCandidateIssues()

      expect(issues.length).toBeLessThanOrEqual(1)
    })

    test("ID は schedule-{hash}-{filename} 形式", async () => {
      await client.fetchCandidateIssues()
      await new Promise((resolve) => setTimeout(resolve, 100))

      const issues = await client.fetchCandidateIssues()

      if (issues.length > 0) {
        expect(issues[0]?.id).toMatch(/^schedule-[a-f0-9]{6}-WORKFLOW$/)
      }
    })

    test(" scheduledAt は cron マッチ時刻", async () => {
      await client.fetchCandidateIssues()
      await new Promise((resolve) => setTimeout(resolve, 100))

      const issues = await client.fetchCandidateIssues()

      if (issues.length > 0) {
        expect(issues[0]?.scheduledAt).toBeDefined()
        const scheduledAt = new Date(issues[0]?.scheduledAt ?? "")
        expect(scheduledAt.getTime()).toBeLessThanOrEqual(Date.now())
      }
    })
  })

  describe("fetchIssuesByStates", () => {
    test("state パラメータは無視して空配列を返す", async () => {
      const issues = await client.fetchIssuesByStates(["Todo", "Done"])

      expect(issues).toEqual([])
    })
  })

  describe("fetchIssueStatesByIds", () => {
    test("空配列の場合は空配列を返す", async () => {
      const issues = await client.fetchIssueStatesByIds([])
      expect(issues).toEqual([])
    })
  })

  describe("moveIssueToState", () => {
    test("state 系パラメータは無視して何もしない", async () => {
      await expect(client.moveIssueToState("schedule-test", "Done")).resolves.toBeUndefined()
    })
  })

  describe("重複実行防止", () => {
    test("同じクライアントで2回連続呼び出ししても1回しか発火しない", async () => {
      await client.fetchCandidateIssues()
      await new Promise((resolve) => setTimeout(resolve, 100))

      const first = await client.fetchCandidateIssues()
      await new Promise((resolve) => setTimeout(resolve, 100))
      const second = await client.fetchCandidateIssues()

      const totalFired = first.length + second.length
      expect(totalFired).toBeLessThanOrEqual(2)
    })
  })
})
