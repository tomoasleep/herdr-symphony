import type {
  CommandResult,
  HerdrAgentInfo,
  HerdrAgentState,
  HerdrClient,
  HerdrClientDeps,
  StartAgentOptions,
} from "./herdr-client"
import { defaultCommandRunner } from "./herdr-client"

export type HcClientDeps = HerdrClientDeps & {
  session?: string
  pollIntervalMs?: number
  now?: () => number
}

type HcTerminalRecord = {
  address?: unknown
  name?: unknown
  labels?: Record<string, string> | null
  state?: unknown
  status?: { state?: unknown } | null
}

const DEFAULT_POLL_INTERVAL_MS = 1_000

function extractHcError(result: CommandResult, fallback: string): string {
  const text = result.stderr.trim() || result.stdout.trim()
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } }
    if (parsed.error?.message) return parsed.error.message
  } catch {
    // not a JSON error envelope
  }
  return text || fallback
}

function wrapArgvWithEnv(argv: string[], env: Record<string, string> | undefined): string[] {
  const entries = Object.entries(env ?? {})
  if (entries.length === 0) return argv
  return ["env", ...entries.map(([key, value]) => `${key}=${value}`), ...argv]
}

function extractHcStatusState(status: unknown): HerdrAgentState {
  if (status === "working" || status === "blocked" || status === "done" || status === "idle") {
    return status
  }
  return "unknown"
}

function parseRunResult(stdout: string): { address: string } | null {
  try {
    const record = JSON.parse(stdout) as HcTerminalRecord
    if (typeof record.address !== "string") return null
    return { address: record.address }
  } catch {
    return null
  }
}

function parseTerminal(stdout: string): HerdrAgentInfo | null {
  let record: HcTerminalRecord
  try {
    record = JSON.parse(stdout) as HcTerminalRecord
  } catch {
    return null
  }
  if (typeof record.address !== "string" || record.state === "finished") return null
  return {
    name: typeof record.name === "string" ? record.name : null,
    state: extractHcStatusState(record.status?.state),
    paneId: record.address,
    workspaceId: record.labels?.issue ?? null,
  }
}

export function createHcClient(deps: HcClientDeps = {}): HerdrClient {
  const hcBin = deps.herdrBin ?? "hc"
  const runCommand = deps.runCommand ?? defaultCommandRunner
  const commandEnv = deps.session ? { HC_SESSION: deps.session } : undefined
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const now = deps.now ?? Date.now

  return {
    async ensureWorkspace(cwd, label) {
      return { id: label, label, cwd, createdNow: false, rootPaneId: null }
    },

    async startAgent(name, opts: StartAgentOptions) {
      const args = [
        "run",
        "--bg",
        "--json",
        "--label",
        `issue=${opts.workspaceId}`,
        "--no-notify",
        "--outlive-parent",
        "--cwd",
        opts.cwd,
        "--",
        ...wrapArgvWithEnv(opts.argv, opts.env),
      ]
      const result = await runCommand(hcBin, args, opts.cwd, commandEnv)
      if (result.exitCode !== 0) {
        throw new Error(extractHcError(result, `hc run failed: ${name}`))
      }
      const parsed = parseRunResult(result.stdout)
      if (!parsed) {
        throw new Error(`failed to parse hc run response: ${result.stdout.slice(0, 200)}`)
      }
      return { name, state: "unknown", paneId: parsed.address, workspaceId: opts.workspaceId }
    },

    async waitAgent(paneId, status, timeoutMs) {
      const deadline = now() + timeoutMs
      for (;;) {
        const result = await runCommand(hcBin, ["get", paneId, "--json"], process.cwd(), commandEnv)
        if (result.exitCode === 0) {
          const info = parseTerminal(result.stdout)
          if (info && info.state === status) {
            return info
          }
        }
        if (now() >= deadline) {
          return null
        }
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
      }
    },

    async readAgent(target, lines = 200) {
      const result = await runCommand(
        hcBin,
        ["read", target, "--lines", String(lines)],
        process.cwd(),
        commandEnv,
      )
      if (result.exitCode !== 0) {
        return ""
      }
      return result.stdout
    },

    async getAgent(target) {
      const result = await runCommand(hcBin, ["get", target, "--json"], process.cwd(), commandEnv)
      if (result.exitCode !== 0) {
        return null
      }
      return parseTerminal(result.stdout)
    },

    async sendPrompt(target, text) {
      const result = await runCommand(hcBin, ["send", target, text], process.cwd(), commandEnv)
      if (result.exitCode !== 0) {
        throw new Error(extractHcError(result, `hc send failed: ${target}`))
      }
    },

    async sendInput(target, text) {
      await runCommand(hcBin, ["send", target, text], process.cwd(), commandEnv)
    },

    async sendKeys(target, ...keys) {
      await runCommand(hcBin, ["keys", target, ...keys], process.cwd(), commandEnv)
    },

    async closePane(paneId) {
      await runCommand(hcBin, ["kill", paneId], process.cwd(), commandEnv)
      await runCommand(hcBin, ["rm", paneId], process.cwd(), commandEnv)
    },
  }
}
