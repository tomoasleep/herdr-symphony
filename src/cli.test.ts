import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync, rmSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runCli } from "./cli"

function makeDeps() {
  const output: string[] = []
  return {
    deps: {
      cwd: "/test",
      env: {},
      start: async () => {},
      write: (chunk: string) => output.push(chunk),
    },
    output,
  }
}

describe("runCli", () => {
  const tmpDirs: string[] = []

  afterEach(() => {
    for (const dir of tmpDirs) {
      rmSync(dir, { recursive: true, force: true })
    }
    tmpDirs.length = 0
  })

  test("--help で usage を表示する", async () => {
    const { deps, output } = makeDeps()
    const code = await runCli(["--help"], deps)
    expect(code).toBe(0)
    expect(output.join("")).toContain("Usage: herdr-symphony")
  })

  test("validate で WORKFLOW.md を検証する", async () => {
    const tmpDir = join(tmpdir(), `hs-cli-${Date.now()}`)
    tmpDirs.push(tmpDir)
    await mkdir(tmpDir, { recursive: true })
    await writeFile(
      join(tmpDir, "WORKFLOW.md"),
      "---\ntracker:\n  kind: file\n  file:\n    base_dir: ./issues\n---\nprompt\n",
    )

    const { output } = makeDeps()
    const code = await runCli(["validate", "--workflow", join(tmpDir, "WORKFLOW.md")], {
      cwd: tmpDir,
      env: {},
      start: async () => {},
      write: (chunk) => output.push(chunk),
    })
    expect(code).toBe(0)
    expect(output.join("")).toContain("検証完了")
  })

  test("--workflow を複数指定できる", async () => {
    let receivedPaths: string[] = []
    const code = await runCli(["--workflow", "/a/WORKFLOW.md", "--workflow", "/b/WORKFLOW.md"], {
      cwd: "/test",
      env: {},
      start: async (paths) => {
        receivedPaths = paths
      },
      write: () => {},
    })
    expect(code).toBe(0)
    expect(receivedPaths).toEqual(["/a/WORKFLOW.md", "/b/WORKFLOW.md"])
  })

  test("workflow 未指定時は WORKFLOW_PATH 環境変数を使う", async () => {
    let receivedPaths: string[] = []
    const code = await runCli([], {
      cwd: "/test",
      env: { WORKFLOW_PATH: "/env/WORKFLOW.md" },
      start: async (paths) => {
        receivedPaths = paths
      },
      write: () => {},
    })
    expect(code).toBe(0)
    expect(receivedPaths).toEqual(["/env/WORKFLOW.md"])
  })

  test("workflow も環境変数もない場合は ./WORKFLOW.md を使う", async () => {
    let receivedPaths: string[] = []
    const code = await runCli([], {
      cwd: "/test",
      env: {},
      start: async (paths) => {
        receivedPaths = paths
      },
      write: () => {},
    })
    expect(code).toBe(0)
    expect(receivedPaths).toEqual(["/test/WORKFLOW.md"])
  })

  test("report command が HERDR_SYMPHONY_REPORT_PATH に done report を書く", async () => {
    const tmpDir = join(tmpdir(), `hs-cli-report-${Date.now()}`)
    tmpDirs.push(tmpDir)
    await mkdir(tmpDir, { recursive: true })
    const reportPath = join(tmpDir, "report.json")
    const { output } = makeDeps()

    const code = await runCli(["report", "--status", "done", "--summary", "作業完了"], {
      cwd: tmpDir,
      env: { HERDR_SYMPHONY_REPORT_PATH: reportPath },
      start: async () => {},
      write: (chunk) => output.push(chunk),
    })

    expect(code).toBe(0)
    expect(JSON.parse(readFileSync(reportPath, "utf8"))).toMatchObject({
      status: "done",
      summary: "作業完了",
    })
  })

  test("report command は summary を必須にする", async () => {
    const { deps, output } = makeDeps()

    const code = await runCli(["report", "--status", "done"], deps)

    expect(code).toBe(1)
    expect(output.join("")).toContain("--summary")
  })

  test("report command は HERDR_SYMPHONY_REPORT_PATH を必須にする", async () => {
    const { deps, output } = makeDeps()

    const code = await runCli(["report", "--status", "done", "--summary", "作業完了"], deps)

    expect(code).toBe(1)
    expect(output.join("")).toContain("HERDR_SYMPHONY_REPORT_PATH")
  })

  test("report command は status を検証する", async () => {
    const { deps, output } = makeDeps()

    const code = await runCli(["report", "--status", "failure", "--summary", "失敗"], {
      ...deps,
      env: { HERDR_SYMPHONY_REPORT_PATH: "/tmp/report.json" },
    })

    expect(code).toBe(1)
    expect(output.join("")).toContain("done / pending / failed")
  })
})
