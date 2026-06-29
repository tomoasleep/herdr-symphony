import { afterEach } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Session } from "tuistory"

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
  [/\bw\d+:p\d+\b/g, "PANE_ID"],
  [/\bw\d+:t\d+\b/g, "TAB_ID"],
  [/\bw\d+\b/g, "WORKSPACE_ID"],
  [/term_[0-9a-f]+/gi, "TERMINAL_ID"],
  [/-e2e-test-claude-[0-9a-z]+/g, "-e2e-test-claude-TS"],
  [/-e2e-test-[0-9a-z]+/g, "-e2e-test-TS"],
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
  env: Record<string, string>
  configDir: string
  cleanup: () => Promise<void>
}

export async function createHerdrIsolation(prefix: string): Promise<HerdrIsolation> {
  const shortId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const configDir = `/tmp/hdr-${prefix}-${shortId}`
  await mkdir(configDir, { recursive: true })
  const configPath = join(configDir, "config.toml")
  const socketPath = join(configDir, "h.sock")

  await writeFile(
    configPath,
    [
      "onboarding = false",
      "",
      "[theme]",
      'name = "terminal"',
      "",
      "[keys]",
      'prefix = "ctrl+b"',
      "",
    ].join("\n"),
  )

  return {
    env: {
      HERDR_SOCKET_PATH: socketPath,
      HERDR_CONFIG_PATH: configPath,
    },
    configDir,
    cleanup: async () => {
      await rm(configDir, { recursive: true, force: true })
    },
  }
}
