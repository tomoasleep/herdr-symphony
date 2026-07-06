import { afterEach } from "bun:test"
import { spawn } from "node:child_process"
import { rm } from "node:fs/promises"
import type { Session } from "tuistory"

export function stripHerdrEnv(src: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, val] of Object.entries(src)) {
    if (val !== undefined && !key.startsWith("HERDR_")) {
      env[key] = val
    }
  }
  return env
}

export function createSessionManager() {
  const sessions: Session[] = []
  afterEach(() => {
    for (const session of sessions.splice(0)) {
      try {
        session.close()
      } catch {}
    }
  })
  return {
    register(session: Session): Session {
      sessions.push(session)
      return session
    },
  }
}

const DYNAMIC_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, "TIMESTAMP"],
  [/\d{4}\/\d{2}\/\d{2} [\d:]+/g, "DATETIME"],
  [/http:\/\/127\.0\.0\.1:\d+/g, "http://MOCK_URL"],
  [/\/var\/folders\/[\w/-]+/g, "TEMP_DIR"],
  [/\/tmp\/[\w/.-]+/g, "TEMP_DIR"],
  [/~\/\.ghq\/[\w/.-]+/g, "PROJECT_PATH"],
  [/\([0-9a-f]{7,}\)(?: \+\d+ -\d+)?(?: \[[$!?]+\])?/g, "(SHA)"],
  [/v\d+\.\d+\.\d+/g, "VERSION"],
  [/\bw\d+:p\d+\b/g, "PANE_ID"],
  [/\bw\d+:t\d+\b/g, "TAB_ID"],
  [/\bw\d+\b/g, "WORKSPACE_ID"],
  [/term_[0-9a-f]+/gi, "TERMINAL_ID"],
  [/-e2e-test-claude-[0-9a-z]+/g, "-e2e-test-claude-TS"],
  [/-e2e-test-[0-9a-z]+/g, "-e2e-test-TS"],
  [/\btest-claude-[0-9a-z]+/g, "test-claude-ID"],
  [/\bplain-probe-[0-9a-z]+/g, "plain-probe-ID"],
  [/\bprobe-[0-9a-z]+/g, "probe-ID"],
  [/\bplain-[0-9a-z]+/g, "plain-ID"],
]

export function normalizeOutput(text: string): string {
  let result = text.trimEnd()
  for (const [pattern, replacement] of DYNAMIC_REPLACEMENTS) {
    result = result.replace(pattern, replacement)
  }
  return result
}

export async function captureOutput(session: Session): Promise<string> {
  const text = await session.text({ trimEnd: true })
  return normalizeOutput(text)
}

export type HerdrIsolation = {
  containerId: string
  sharedDir: string
  cleanup: () => Promise<void>
}

function runDocker(
  args: string[],
  timeoutMs = 30_000,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk)
    })
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error(`docker ${args.join(" ")} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ stdout, stderr, exitCode: code ?? 1 })
    })
    child.on("error", reject)
  })
}

export async function createHerdrIsolation(prefix: string): Promise<HerdrIsolation> {
  const shortId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const containerName = `herdr-e2e-${prefix}-${shortId}`
  const sharedDir = `/tmp/herdr-e2e-${prefix}-${shortId}`
  const projectRoot = process.cwd()

  const runResult = await runDocker([
    "run",
    "-d",
    "--name",
    containerName,
    "--add-host=host.docker.internal:host-gateway",
    "-v",
    `${projectRoot}:/workspace`,
    "-v",
    `${sharedDir}:/tmp/shared`,
    "-e",
    "AGMSG_SCRIPTS_DIR=/opt/agmsg/scripts",
    "herdr-e2e:latest",
    "sleep",
    "infinity",
  ])

  if (runResult.exitCode !== 0) {
    throw new Error(`docker run failed: ${runResult.stderr}`)
  }

  const containerId = runResult.stdout.trim()

  return {
    containerId,
    sharedDir,
    cleanup: async () => {
      await runDocker(["stop", containerId], 10_000)
      await runDocker(["rm", "-f", containerId], 10_000)
      await rm(sharedDir, { recursive: true, force: true })
    },
  }
}

export async function execInContainer(
  containerId: string,
  command: string[],
  timeoutMs = 30_000,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return runDocker(["exec", containerId, ...command], timeoutMs)
}
