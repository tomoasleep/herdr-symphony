import { spawn } from "node:child_process"
import { mkdirSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

export type WrapResult = {
  exitCode: number
  stdout: string
  stderr: string
}

type WrapOutput = {
  stdout?: (chunk: string) => void
  stderr?: (chunk: string) => void
}

export async function runWrap(
  resultPath: string,
  command: string[],
  cwd: string,
  output: WrapOutput = {},
): Promise<number> {
  const [cmd, ...args] = command
  if (!cmd) return 1

  const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
  const writeStdout = output.stdout ?? ((chunk: string) => process.stdout.write(chunk))
  const writeStderr = output.stderr ?? ((chunk: string) => process.stderr.write(chunk))

  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk: Buffer | string) => {
    const text = String(chunk)
    stdout += text
    writeStdout(text)
  })
  child.stderr.on("data", (chunk: Buffer | string) => {
    const text = String(chunk)
    stderr += text
    writeStderr(text)
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
