import { afterEach } from "bun:test"
import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
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
  [/\b[0-9a-z]-e2e-test-TS-TS/g, "ID-e2e-test-TS-TS"],
  [/\btest-claude-[0-9a-z]+/g, "test-claude-ID"],
  [/\bplain-probe-[0-9a-z]+/g, "plain-probe-ID"],
  [/\bprobe-[0-9a-z]+/g, "probe-ID"],
  [/\bplain-[0-9a-z]+/g, "plain-ID"],
  [/\bw\d+:p\d+\b/g, "PANE_ID"],
  [/\bw\d+:t\d+\b/g, "TAB_ID"],
  [/\bw\d+\b/g, "WORKSPACE_ID"],
  [/test\/repo#[0-9a-z]{6,}/g, "test/repo#ID"],
  [/Agent Model · \d+\.\d+s/g, "Agent Model · TIME"],
  [/^([ │]*[^\s│][^\n]*?) · done \d{1,2}:\d{2} [AP]M/gm, "$1"],
  [/^([ │]*[^\s│]) \S+ for 0s/gm, "$1 Worked for 0s"],
  [/^([ │]*[^\s│]) \S+ for (?!0s)\d+s +(?=▐)/gm, "$1 Worked for TIME "],
  [/^([ │]*[^\s│] Worked for 0s)[ \t]+(?=▐|│)/gm, "$1 "],
  [/[^\s│] [A-Za-z]+…\s*(?=▐)/g, "✽ Working… "],
  [/│ What's new\s+│/g, "│ WHAT_NEW │"],
  [/│ Added [^\n]*?│\s*│/g, "│ CLAUDE_WHATS_NEW_LINE │"],
  [/│ Fixed [^\n]*?│\s*│/g, "│ CLAUDE_WHATS_NEW_LINE │"],
  [/│ Auto mode[^\n]*?│\s*│/g, "│ CLAUDE_WHATS_NEW_LINE │"],
  [/│ \/release-notes[^\n]*?│\s*│/g, "│ CLAUDE_WHATS_NEW_LINE │"],
  [/┌▌/g, "┌"],
  [/● menu/g, "menu"],
  [/new\s+menu/g, "new menu"],
  [/┌ test-claude-ID-e2e-test-TS-TS ─+┐/g, "┌ test-claude-ID-e2e-test-TS-TS ─┐"],
  [/(reconcile running=1 refreshed=1)(?:\n\1)+/g, "$1"],
]

export function normalizeOutput(text: string): string {
  let result = text.trimEnd()
  for (const [pattern, replacement] of DYNAMIC_REPLACEMENTS) {
    result = result.replace(pattern, replacement)
  }
  return result
}

export function normalizeLogOutput(text: string): string {
  return normalizeOutput(text)
    .split("\n")
    .map((line) => line.trimStart())
    .join("\n")
}

export function normalizeScreenOutput(text: string): string {
  let result = text
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("│")
      if (idx === -1) return line
      return line.slice(idx)
    })
    .join("\n")
  for (const [pattern, replacement] of DYNAMIC_REPLACEMENTS) {
    result = result.replace(pattern, replacement)
  }
  result = result.replace(/││╭─── Claude Code VERSION[\s\S]*?╯ │\n/g, "")
  result = result.replace(/││[^\n]*Claude Code VERSION[^\n]*\n(?:││[^\n]*\n){0,2}/g, "")
  result = result.replace(
    /│╭─(?: |>)Claude Code(?:>| )VERSION[^\n]*\r?\n[\s\S]*?│╰─╯[^\n]*(?:\r?\n|$)/g,
    "",
  )
  result = result.replace(/▕/g, "▐")
  result = result.replace(
    /(?:[^\n]*?││)[^\n]*WHAT_NEW[^\n]*\r?\n(?:[^\n]*?││[^\n]*\r?\n)*?[^\n]*?│╰─+╯▐\r?\n/g,
    "││ WELCOME_BANNER │▐\n│╰─╯▐\n",
  )
  result = result.replace(
    /(?:[^\n]*?││)[^\n]*▐▛███▜▌[^\n]*\r?\n(?:[^\n]*?││[^\n]*\r?\n)*?[^\n]*?│╰─+╯▐\r?\n/g,
    "││ WELCOME_BANNER │▐\n│╰─╯▐\n",
  )
  return result.replace(/─+/g, "─")
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

type CommandResult = { stdout: string; stderr: string; exitCode: number }

function runCommand(command: string, args: string[], timeoutMs = 30_000): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] })
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
      reject(new Error(`${command} ${args.join(" ")} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ stdout, stderr, exitCode: code ?? 1 })
    })
    child.on("error", reject)
  })
}

function runDocker(args: string[], timeoutMs = 30_000): Promise<CommandResult> {
  return runCommand("docker", args, timeoutMs)
}

let imageReady: Promise<void> | undefined

async function ensureE2EImage(): Promise<void> {
  const result = await runDocker(["image", "inspect", "herdr-e2e:latest"])
  if (result.exitCode === 0) return

  const build = await runDocker(
    ["build", "-f", "docker/e2e/Dockerfile", "-t", "herdr-e2e:latest", process.cwd()],
    300_000,
  )
  if (build.exitCode !== 0) throw new Error(`docker build failed: ${build.stderr}`)
}

export async function createHerdrIsolation(prefix: string): Promise<HerdrIsolation> {
  imageReady ??= ensureE2EImage()
  await imageReady

  const shortId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const containerName = `herdr-e2e-${prefix}-${shortId}`
  const projectRoot = process.cwd()
  const sharedDir = await mkdtemp(join(projectRoot, `.herdr-e2e-${prefix}-`))

  const result = await runDocker([
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
  if (result.exitCode !== 0) throw new Error(`docker run failed: ${result.stderr}`)

  const containerId = result.stdout.trim()

  return {
    containerId,
    sharedDir,
    cleanup: async () => {
      await runDocker(["rm", "-f", containerId]).catch(() => {})
      await rm(sharedDir, { recursive: true, force: true }).catch(() => {})
    },
  }
}

export async function execInContainer(
  containerId: string,
  command: string[],
  timeoutMs = 30_000,
): Promise<CommandResult> {
  return runDocker(["exec", containerId, ...command], timeoutMs)
}

export function containerCommand(
  containerId: string,
  command: string[],
  env?: Record<string, string>,
  workdir?: string,
): { command: string; args: string[] } {
  const envArgs = ["-e", "TERM=xterm-truecolor"]
  for (const [key, value] of Object.entries(env ?? {})) {
    envArgs.push("-e", `${key}=${value}`)
  }
  const workdirArgs = workdir ? ["-w", workdir] : []
  return {
    command: "docker",
    args: ["exec", "-it", ...envArgs, ...workdirArgs, containerId, ...command],
  }
}
