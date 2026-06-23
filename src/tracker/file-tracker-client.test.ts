import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { FileTrackerClient } from "./file-tracker-client"

describe("FileTrackerClient", () => {
  const baseDir = join(import.meta.dir, "..", "..", "tmp", "file-tracker-test")
  let client: FileTrackerClient

  beforeEach(async () => {
    await rm(baseDir, { recursive: true, force: true })
    client = new FileTrackerClient({
      kind: "file",
      file: { baseDir },
      github_project: null,
      schedule: null,
    })
  })

  afterAll(async () => {
    await rm(baseDir, { recursive: true, force: true })
  })

  describe("fetchCandidateIssues", () => {
    test("空のディレクトリの場合は空配列を返す", async () => {
      await mkdir(baseDir, { recursive: true })
      const issues = await client.fetchCandidateIssues()
      expect(issues).toEqual([])
    })

    test("State ディレクトリ配下の .md ファイルを Issue として取得する", async () => {
      await mkdir(join(baseDir, "Todo"), { recursive: true })
      await writeFile(
        join(baseDir, "Todo", "issue-1.md"),
        `---
title: Test Issue
identifier: tomoasleep/fairy#1
description: Test description
labels:
  - bug
  - feature
priority: P1
blockedBy:
  - other-issue
customField: custom value
---
Content here`,
      )

      const issues = await client.fetchCandidateIssues()

      expect(issues).toHaveLength(1)
      const [issue] = issues
      if (!issue) {
        throw new Error("issue_not_found")
      }
      expect(issue.id).toBe("issue-1")
      expect(issue.identifier).toBe("tomoasleep/fairy#1")
      expect(issue.title).toBe("Test Issue")
      expect(issue.description).toBe("Test description")
      expect(issue.state).toBe("Todo")
      expect(issue.labels).toEqual(["bug", "feature"])
      expect(issue.priority).toBe(2)
      expect(issue.blockedBy).toEqual([
        { id: "other-issue", identifier: "other-issue", state: null },
      ])
      expect(issue.fields.customField).toBe("custom value")
    })

    test("frontmatter がない場合はデフォルト値を使用する", async () => {
      await mkdir(join(baseDir, "InProgress"), { recursive: true })
      await writeFile(join(baseDir, "InProgress", "no-frontmatter.md"), "Just content")

      const issues = await client.fetchCandidateIssues()

      expect(issues).toHaveLength(1)
      const [issue] = issues
      if (!issue) {
        throw new Error("issue_not_found")
      }
      expect(issue.id).toBe("no-frontmatter")
      expect(issue.title).toBe("no-frontmatter")
      expect(issue.description).toBe("Just content")
      expect(issue.state).toBe("InProgress")
      expect(issue.labels).toEqual([])
      expect(issue.priority).toBeNull()
    })

    test("階層的なパスを Issue ID として扱う", async () => {
      await mkdir(join(baseDir, "Todo", "subdir"), { recursive: true })
      await writeFile(join(baseDir, "Todo", "subdir", "nested.md"), "---\ntitle: Nested\n---\n")

      const issues = await client.fetchCandidateIssues()

      expect(issues).toHaveLength(1)
      const [issue] = issues
      if (!issue) {
        throw new Error("issue_not_found")
      }
      expect(issue.id).toBe("subdir/nested")
      expect(issue.identifier).toBe("subdir/nested")
      expect(issue.state).toBe("Todo")
    })

    test("複数の State ディレクトリから Issue を取得する", async () => {
      await mkdir(join(baseDir, "Todo"), { recursive: true })
      await mkdir(join(baseDir, "Done"), { recursive: true })
      await writeFile(join(baseDir, "Todo", "a.md"), "---\ntitle: A\n---\n")
      await writeFile(join(baseDir, "Done", "b.md"), "---\ntitle: B\n---\n")

      const issues = await client.fetchCandidateIssues()

      expect(issues).toHaveLength(2)
      expect(issues.map((i) => i.state).sort()).toEqual(["Done", "Todo"])
    })

    test(".md 以外のファイルは無視する", async () => {
      await mkdir(join(baseDir, "Todo"), { recursive: true })
      await writeFile(join(baseDir, "Todo", "issue.txt"), "text content")
      await writeFile(join(baseDir, "Todo", "issue.md"), "---\ntitle: MD\n---\n")

      const issues = await client.fetchCandidateIssues()

      expect(issues).toHaveLength(1)
      expect(issues[0]?.id).toBe("issue")
    })
  })

  describe("fetchIssuesByStates", () => {
    test("指定した state の Issue のみを返す", async () => {
      await mkdir(join(baseDir, "Todo"), { recursive: true })
      await mkdir(join(baseDir, "Done"), { recursive: true })
      await writeFile(join(baseDir, "Todo", "a.md"), "---\ntitle: A\n---\n")
      await writeFile(join(baseDir, "Done", "b.md"), "---\ntitle: B\n---\n")

      const issues = await client.fetchIssuesByStates(["Todo"])

      expect(issues).toHaveLength(1)
      expect(issues[0]?.id).toBe("a")
      expect(issues[0]?.state).toBe("Todo")
    })

    test("複数の state を指定できる", async () => {
      await mkdir(join(baseDir, "Todo"), { recursive: true })
      await mkdir(join(baseDir, "InProgress"), { recursive: true })
      await mkdir(join(baseDir, "Done"), { recursive: true })
      await writeFile(join(baseDir, "Todo", "a.md"), "---\ntitle: A\n---\n")
      await writeFile(join(baseDir, "InProgress", "b.md"), "---\ntitle: B\n---\n")
      await writeFile(join(baseDir, "Done", "c.md"), "---\ntitle: C\n---\n")

      const issues = await client.fetchIssuesByStates(["Todo", "InProgress"])

      expect(issues).toHaveLength(2)
      expect(issues.map((i) => i.id).sort()).toEqual(["a", "b"])
    })
  })

  describe("fetchIssueStatesByIds", () => {
    test("指定した ID の Issue のみを返す", async () => {
      await mkdir(join(baseDir, "Todo"), { recursive: true })
      await writeFile(join(baseDir, "Todo", "a.md"), "---\ntitle: A\n---\n")
      await writeFile(join(baseDir, "Todo", "b.md"), "---\ntitle: B\n---\n")

      const issues = await client.fetchIssueStatesByIds(["a"])

      expect(issues).toHaveLength(1)
      expect(issues[0]?.id).toBe("a")
    })

    test("空配列の場合は空配列を返す", async () => {
      await mkdir(join(baseDir, "Todo"), { recursive: true })
      await writeFile(join(baseDir, "Todo", "a.md"), "---\ntitle: A\n---\n")

      const issues = await client.fetchIssueStatesByIds([])

      expect(issues).toEqual([])
    })

    test("階層的な ID でも検索できる", async () => {
      await mkdir(join(baseDir, "Todo", "subdir"), { recursive: true })
      await writeFile(join(baseDir, "Todo", "subdir", "nested.md"), "---\ntitle: Nested\n---\n")

      const issues = await client.fetchIssueStatesByIds(["subdir/nested"])

      expect(issues).toHaveLength(1)
      expect(issues[0]?.id).toBe("subdir/nested")
    })
  })

  describe("moveIssueToState", () => {
    test("Issue を別の state ディレクトリに移動する", async () => {
      await mkdir(join(baseDir, "Todo"), { recursive: true })
      await mkdir(join(baseDir, "Done"), { recursive: true })
      await writeFile(join(baseDir, "Todo", "issue-1.md"), "---\ntitle: Test\n---\n")

      await client.moveIssueToState("issue-1", "Done")

      const issues = await client.fetchCandidateIssues()
      expect(issues).toHaveLength(1)
      expect(issues[0]?.id).toBe("issue-1")
      expect(issues[0]?.state).toBe("Done")

      const originalFile = Bun.file(join(baseDir, "Todo", "issue-1.md"))
      expect(await originalFile.exists()).toBe(false)

      const newFile = Bun.file(join(baseDir, "Done", "issue-1.md"))
      expect(await newFile.exists()).toBe(true)
    })

    test("階層的なパスの Issue も移動できる", async () => {
      await mkdir(join(baseDir, "Todo", "subdir"), { recursive: true })
      await mkdir(join(baseDir, "Done"), { recursive: true })
      await writeFile(join(baseDir, "Todo", "subdir", "nested.md"), "---\ntitle: Nested\n---\n")

      await client.moveIssueToState("subdir/nested", "Done")

      const issues = await client.fetchCandidateIssues()
      expect(issues).toHaveLength(1)
      expect(issues[0]?.id).toBe("nested")
      expect(issues[0]?.state).toBe("Done")
    })

    test("存在しない Issue の場合はエラーを投げる", async () => {
      await mkdir(join(baseDir, "Todo"), { recursive: true })

      expect(client.moveIssueToState("nonexistent", "Done")).rejects.toThrow()
    })

    test("存在しない state ディレクトリを自動作成する", async () => {
      await mkdir(join(baseDir, "Todo"), { recursive: true })
      await writeFile(join(baseDir, "Todo", "issue-1.md"), "---\ntitle: Test\n---\n")

      await client.moveIssueToState("issue-1", "Archived")

      const newFile = Bun.file(join(baseDir, "Archived", "issue-1.md"))
      expect(await newFile.exists()).toBe(true)
    })
  })

  describe("description", () => {
    test("frontmatter 後のコンテンツを description として扱う", async () => {
      await mkdir(join(baseDir, "Todo"), { recursive: true })
      await writeFile(
        join(baseDir, "Todo", "issue.md"),
        `---
title: Title
---
Line 1
Line 2`,
      )

      const issues = await client.fetchCandidateIssues()

      expect(issues[0]?.description).toBe("Line 1\nLine 2")
    })

    test("frontmatter のみでコンテンツがない場合は null", async () => {
      await mkdir(join(baseDir, "Todo"), { recursive: true })
      await writeFile(
        join(baseDir, "Todo", "issue.md"),
        `---
title: Title
---`,
      )

      const issues = await client.fetchCandidateIssues()

      expect(issues[0]?.description).toBeNull()
    })

    test("updateItemDescription は frontmatter を保ったまま本文を更新する", async () => {
      await mkdir(join(baseDir, "Todo"), { recursive: true })
      const filePath = join(baseDir, "Todo", "issue.md")
      await writeFile(
        filePath,
        `---
title: Title
identifier: test/repo#1
---
Body before`,
      )

      await client.updateItemDescription(
        {
          id: "issue",
          identifier: "test/repo#1",
          title: "Title",
          description: "Body before",
          priority: null,
          state: "Todo",
          repository: null,
          fields: {},
          url: null,
          labels: [],
          blockedBy: [],
          createdAt: null,
          updatedAt: null,
          issueNodeId: null,
        },
        "## Agent Logs\n\nupdated body",
      )

      const content = await Bun.file(filePath).text()
      expect(content).toContain("title: Title")
      expect(content).toContain("## Agent Logs")
      expect(content).not.toContain("Body before")
    })

    test("fetchIssueDescription はファイルから最新の description を取得する", async () => {
      await mkdir(join(baseDir, "Todo"), { recursive: true })
      const filePath = join(baseDir, "Todo", "issue.md")
      await writeFile(
        filePath,
        `---
title: Title
identifier: test/repo#1
---
Original body`,
      )

      await writeFile(
        filePath,
        `---
title: Title
identifier: test/repo#1
---
Updated by agent`,
      )

      const description = await client.fetchIssueDescription({
        id: "issue",
        identifier: "test/repo#1",
        title: "Title",
        description: "Original body",
        priority: null,
        state: "Todo",
        repository: null,
        fields: {},
        url: null,
        labels: [],
        blockedBy: [],
        createdAt: null,
        updatedAt: null,
        issueNodeId: null,
      })

      expect(description).toBe("Updated by agent")
    })
  })

  describe("priority", () => {
    test("P0 は 1 に変換される", async () => {
      await mkdir(join(baseDir, "Todo"), { recursive: true })
      await writeFile(join(baseDir, "Todo", "issue.md"), "---\npriority: P0\n---\n")

      const issues = await client.fetchCandidateIssues()

      expect(issues[0]?.priority).toBe(1)
    })

    test("P1 は 2 に変換される", async () => {
      await mkdir(join(baseDir, "Todo"), { recursive: true })
      await writeFile(join(baseDir, "Todo", "issue.md"), "---\npriority: P1\n---\n")

      const issues = await client.fetchCandidateIssues()

      expect(issues[0]?.priority).toBe(2)
    })

    test("無効な priority は null", async () => {
      await mkdir(join(baseDir, "Todo"), { recursive: true })
      await writeFile(join(baseDir, "Todo", "issue.md"), "---\npriority: Invalid\n---\n")

      const issues = await client.fetchCandidateIssues()

      expect(issues[0]?.priority).toBeNull()
    })
  })
})
