import { afterEach } from "bun:test"
import { spawn } from "node:child_process"
import { mkdir, rm } from "node:fs/promises"
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
  [
    /\n\nWhat's next:\n {4}Try Docker Debug[^\n]*\n {4}Learn more at https:\/\/docs\.docker\.com\/go\/debug-cli\//g,
    "",
  ],
  [/\/var\/folders\/[\w/-]+/g, "TEMP_DIR"],
  [/\/tmp\/[\w/.-]+/g, "TEMP_DIR"],
  [/~\/\.ghq\/[\w/.-]+/g, "PROJECT_PATH"],
  [/\([0-9a-f]{7,}\)(?: \+\d+ -\d+)?(?: \[[$!?]+\])?/g, "(SHA)"],
  [/\bmain ↑\d+\b/g, "main"],
  [/\bmain\s+│/g, "main                  │"],
  [/\bconfigure-ci\s+│/g, "main                  │"],
  [/v\d+\.\d+\.\d+/g, "VERSION"],
  [/term_[0-9a-f]+/gi, "TERMINAL_ID"],
  [/-e2e-test-claude-[0-9a-z]+/g, "-e2e-test-claude-TS"],
  [/-e2e-test-[0-9a-z]+/g, "-e2e-test-TS"],
  [/\b[0-9a-z]{3}-e2e-test-TS-TS/g, "ID-e2e-test-TS-TS"],
  [/\btest-claude-[0-9a-z]+/g, "test-claude-ID"],
  [/\bplain-probe-[0-9a-z]+/g, "plain-probe-ID"],
  [/\bprobe-[0-9a-z]+/g, "probe-ID"],
  [/\bplain-[0-9a-z]+/g, "plain-ID"],
  [/\bw\d+:p\d+\b/g, "PANE_ID"],
  [/\bw\d+:t\d+\b/g, "TAB_ID"],
  [/\bw\d+\b/g, "WORKSPACE_ID"],
  [/✻ \S+ for 0s/g, "✻ Worked for 0s"],
  [/✻ Worked for 0s\s+▐/g, "✻ Worked for 0s ▐"],
  [/✻ Worked for 0s\s+│/g, "✻ Worked for 0s │"],
  [/│ What's new\s+│/g, "│ WHAT_NEW │"],
  [/│ Added [^\n]*?│\s*│/g, "│ CLAUDE_WHATS_NEW_LINE │"],
  [/│ Fixed [^\n]*?│\s*│/g, "│ CLAUDE_WHATS_NEW_LINE │"],
  [/│ Auto mode[^\n]*?│\s*│/g, "│ CLAUDE_WHATS_NEW_LINE │"],
  [/│ \/release-notes[^\n]*?│\s*│/g, "│ CLAUDE_WHATS_NEW_LINE │"],
  [/┌▌/g, "┌"],
  [/● menu/g, "menu"],
]

export function normalizeOutput(text: string): string {
  let result = text.trimEnd()
  for (const [pattern, replacement] of DYNAMIC_REPLACEMENTS) {
    result = result.replace(pattern, replacement)
  }
  return result
}

export function normalizeScreenOutput(text: string): string {
  let result = text
  for (const [pattern, replacement] of DYNAMIC_REPLACEMENTS) {
    result = result.replace(pattern, replacement)
  }
  result = result.replace(/▕/g, "▐")
  return result
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("│")
      if (idx === -1) return line
      return line.slice(idx)
    })
    .join("\n")
}

export async function captureOutput(session: Session): Promise<string> {
  const text = await session.text({ trimEnd: true })
  return normalizeOutput(text)
}

export type HerdrIsolation = {
  sharedDir: string
  cleanup: () => Promise<void>
}

export async function createHerdrIsolation(prefix: string): Promise<HerdrIsolation> {
  const shortId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const sharedDir = `/tmp/herdr-e2e-${prefix}-${shortId}`

  await mkdir(sharedDir, { recursive: true })

  return {
    sharedDir,
    cleanup: async () => {
      await rm(sharedDir, { recursive: true, force: true }).catch(() => {})
    },
  }
}

export async function execInContainer(
  _containerId: string,
  command: string[],
  timeoutMs = 30_000,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0]!, command.slice(1), { stdio: ["ignore", "pipe", "pipe"] })
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
      reject(new Error(`${command.join(" ")} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ stdout, stderr, exitCode: code ?? 1 })
    })
    child.on("error", reject)
  })
}

export function directCommand(
  command: string[],
  env?: Record<string, string>,
): { command: string; args: string[] } {
  if (env) {
    const envArgs: string[] = []
    for (const [key, value] of Object.entries(env)) {
      envArgs.push(`${key}=${value}`)
    }
    return { command: "env", args: [...envArgs, ...command] }
  }
  return { command: command[0]!, args: command.slice(1) }
}
