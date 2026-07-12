import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runWrap, type WrapResult } from "./wrap-command"

describe("runWrap", () => {
  const tmpDirs: string[] = []

  afterEach(() => {
    for (const dir of tmpDirs) {
      rmSync(dir, { recursive: true, force: true })
    }
    tmpDirs.length = 0
  })

  async function makeTmpDir(): Promise<string> {
    const dir = join(tmpdir(), `hs-wrap-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(dir, { recursive: true })
    tmpDirs.push(dir)
    return dir
  }

  test("stdout と stderr と exitCode を結果ファイルに書き出す", async () => {
    const dir = await makeTmpDir()
    const resultPath = join(dir, "result.json")

    const exitCode = await runWrap(
      resultPath,
      ["sh", "-c", 'echo "hello stdout"; echo "hello stderr" >&2; exit 0'],
      dir,
    )

    expect(exitCode).toBe(0)

    const result = JSON.parse(readFileSync(resultPath, "utf8")) as WrapResult
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("hello stdout")
    expect(result.stderr).toContain("hello stderr")
  })

  test("stdout と stderr を対応する親ストリームへ転送する", async () => {
    const dir = await makeTmpDir()
    const resultPath = join(dir, "result.json")
    const stdout: string[] = []
    const stderr: string[] = []

    await runWrap(resultPath, ["sh", "-c", 'echo "hello stdout"; echo "hello stderr" >&2'], dir, {
      stdout: (chunk) => stdout.push(chunk),
      stderr: (chunk) => stderr.push(chunk),
    })

    expect(stdout.join("")).toContain("hello stdout")
    expect(stderr.join("")).toContain("hello stderr")
  })

  test("非ゼロ exit code を結果ファイルに記録し、wrap 自身は exit 0 を返す", async () => {
    const dir = await makeTmpDir()
    const resultPath = join(dir, "result.json")

    const exitCode = await runWrap(resultPath, ["sh", "-c", 'echo "fail output"; exit 42'], dir)

    expect(exitCode).toBe(0)

    const result = JSON.parse(readFileSync(resultPath, "utf8")) as WrapResult
    expect(result.exitCode).toBe(42)
    expect(result.stdout).toContain("fail output")
  })

  test("コマンドが存在しない場合は exitCode=1 で結果ファイルに書き出す", async () => {
    const dir = await makeTmpDir()
    const resultPath = join(dir, "result.json")

    const exitCode = await runWrap(resultPath, ["nonexistent-cmd-xyz"], dir)

    expect(exitCode).toBe(0)

    const result = JSON.parse(readFileSync(resultPath, "utf8")) as WrapResult
    expect(result.exitCode).toBe(1)
  })

  test("結果ファイルは atomic write される (temp file が残らない)", async () => {
    const dir = await makeTmpDir()
    const resultPath = join(dir, "result.json")

    await runWrap(resultPath, ["sh", "-c", "echo ok"], dir)

    expect(existsSync(resultPath)).toBe(true)
    const tempFiles = readdirSync(dir).filter((f) => f.endsWith(".tmp"))
    expect(tempFiles).toHaveLength(0)
  })

  test("結果ファイルのディレクトリが存在しない場合は作成される", async () => {
    const dir = await makeTmpDir()
    const nestedDir = join(dir, "nested", "deep")
    const resultPath = join(nestedDir, "result.json")

    await runWrap(resultPath, ["sh", "-c", "echo ok"], dir)

    expect(existsSync(resultPath)).toBe(true)
  })

  test("コマンドが空の場合は exit 1 を返す", async () => {
    const dir = await makeTmpDir()
    const resultPath = join(dir, "result.json")

    const exitCode = await runWrap(resultPath, [], dir)

    expect(exitCode).toBe(1)
    expect(existsSync(resultPath)).toBe(false)
  })
})
