import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { loadWorkflow } from "./load-workflow"

describe("loadWorkflow", () => {
  test("front matter ありの workflow を読める", async () => {
    const file = path.join(os.tmpdir(), `workflow-${Date.now()}.md`)
    await fs.writeFile(
      file,
      `---\ntracker:\n  kind: github_project\n---\n\nhello {{ issue.identifier }}`,
      "utf8",
    )

    const loaded = await loadWorkflow(file)
    expect(loaded.config).toEqual({ tracker: { kind: "github_project" } })
    expect(loaded.promptTemplate).toBe("hello {{ issue.identifier }}")
  })

  test("front matter なしの workflow を読める", async () => {
    const file = path.join(os.tmpdir(), `workflow-${Date.now()}-plain.md`)
    await fs.writeFile(file, "plain body", "utf8")

    const loaded = await loadWorkflow(file)
    expect(loaded.config).toEqual({})
    expect(loaded.promptTemplate).toBe("plain body")
  })
})
