import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, rmSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readReport, writeReport } from "./write-report"

describe("report file", () => {
  const tmpDirs: string[] = []

  afterEach(() => {
    for (const dir of tmpDirs) {
      rmSync(dir, { recursive: true, force: true })
    }
    tmpDirs.length = 0
  })

  async function reportPath(): Promise<string> {
    const dir = join(tmpdir(), `hs-report-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    tmpDirs.push(dir)
    await mkdir(dir, { recursive: true })
    return join(dir, "report.json")
  }

  test("done report を書いて読める", async () => {
    const path = await reportPath()

    writeReport(path, "done", "実装完了")

    expect(existsSync(path)).toBe(true)
    expect(readReport(path)).toMatchObject({ status: "done", summary: "実装完了" })
  })

  test("pending report を書いて読める", async () => {
    const path = await reportPath()

    writeReport(path, "pending", "background task 待ち")

    expect(readReport(path)).toMatchObject({ status: "pending", summary: "background task 待ち" })
  })

  test("failed report を書いて読める", async () => {
    const path = await reportPath()

    writeReport(path, "failed", "テスト失敗")

    expect(readReport(path)).toMatchObject({ status: "failed", summary: "テスト失敗" })
  })

  test("存在しない report は null", async () => {
    const path = await reportPath()

    expect(readReport(path)).toBeNull()
  })

  test("壊れた JSON は null", async () => {
    const path = await reportPath()
    await Bun.write(path, "{")

    expect(readReport(path)).toBeNull()
  })

  test("再書き込みした report は最新を読む", async () => {
    const path = await reportPath()

    writeReport(path, "pending", "待機中")
    writeReport(path, "done", "完了")

    expect(readReport(path)).toMatchObject({ status: "done", summary: "完了" })
  })
})
