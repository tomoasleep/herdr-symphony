import { spawn } from "node:child_process"
import { mkdirSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

export type WrapResult = {
  exitCode: number
  stdout: string
  stderr: string
}

export async function runWrap(resultPath: string, command: string[], cwd: string): Promise<number> {
  const [cmd, ...args] = command
  if (!cmd) return 1

  const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] })

  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk: Buffer | string) => {
    stdout += String(chunk)
  })
  child.stderr.on("data", (chunk: Buffer | string) => {
    stderr += String(chunk)
  })

  const exitCode = await new Promise<number>((resolve) => {
    child.on("close", (code) => resolve(code ?? 1))
    child.on("error", () => resolve(1))
  })

  const result: WrapResult = { exitCode, stdout, stderr }
  mkdirSync(dirname(resultPath), { recursive: true })
  const tmp = `${resultPath}.${Date.now()}.tmp`
  writeFileSync(tmp, JSON.stringify(result))
  renameSync(tmp, resultPath)

  return 0
}
