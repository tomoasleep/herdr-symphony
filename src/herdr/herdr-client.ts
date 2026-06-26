import { spawn } from "node:child_process"

export type CommandResult = {
  exitCode: number
  stdout: string
  stderr: string
}

export type CommandRunner = (command: string, args: string[], cwd: string) => Promise<CommandResult>

export type RecordedCall = {
  command: string
  args: string[]
  cwd: string
}

export type HerdrAgentState = "working" | "blocked" | "done" | "idle" | "unknown"

export type HerdrWorkspaceInfo = {
  id: string
  label: string | null
  cwd: string | null
}

export type HerdrAgentInfo = {
  name: string | null
  state: HerdrAgentState
  paneId: string | null
  workspaceId: string | null
}

export type StartAgentOptions = {
  workspaceId: string
  cwd: string
  argv: string[]
  env?: Record<string, string>
}

export type HerdrClient = {
  ensureWorkspace(cwd: string, label: string): Promise<HerdrWorkspaceInfo>
  startAgent(name: string, opts: StartAgentOptions): Promise<HerdrAgentInfo>
  waitAgent(
    paneId: string,
    status: HerdrAgentState,
    timeoutMs: number,
  ): Promise<HerdrAgentInfo | null>
  readAgent(target: string, lines?: number): Promise<string>
  getAgent(target: string): Promise<HerdrAgentInfo | null>
  sendInput(target: string, text: string): Promise<void>
  sendKeys(target: string, ...keys: string[]): Promise<void>
  closePane(paneId: string): Promise<void>
}

export type HerdrClientDeps = {
  runCommand?: CommandRunner
  herdrBin?: string
}

type Envelope = {
  result?: Record<string, unknown>
  error?: { code?: string; message?: string }
}

function parseEnvelope(stdout: string): Envelope {
  try {
    return JSON.parse(stdout) as Envelope
  } catch {
    return {}
  }
}

function extractAgentState(value: unknown): HerdrAgentState {
  if (
    value === "working" ||
    value === "blocked" ||
    value === "done" ||
    value === "idle" ||
    value === "unknown"
  ) {
    return value
  }
  return "unknown"
}

function parseWorkspaceList(
  stdout: string,
): Array<{ workspace_id?: string; label?: string; cwd?: string }> {
  const env = parseEnvelope(stdout)
  const result = env.result
  if (!result) return []
  const workspaces = result.workspaces
  if (!Array.isArray(workspaces)) return []
  return workspaces.filter(
    (w): w is { workspace_id?: string; label?: string; cwd?: string } =>
      typeof w === "object" && w !== null,
  )
}

function parseWorkspaceCreate(stdout: string): HerdrWorkspaceInfo | null {
  const env = parseEnvelope(stdout)
  const workspace = env.result?.workspace as Record<string, unknown> | undefined
  if (!workspace) return null
  const id = workspace.workspace_id
  if (typeof id !== "string") return null
  return {
    id,
    label: typeof workspace.label === "string" ? workspace.label : null,
    cwd: typeof workspace.cwd === "string" ? workspace.cwd : null,
  }
}

function parseAgentStarted(stdout: string): HerdrAgentInfo | null {
  const env = parseEnvelope(stdout)
  const agent = env.result?.agent as Record<string, unknown> | undefined
  if (!agent) return null
  const paneId = agent.pane_id
  if (typeof paneId !== "string") return null
  return {
    name: typeof agent.name === "string" ? agent.name : null,
    state: extractAgentState(agent.agent_status),
    paneId,
    workspaceId: typeof agent.workspace_id === "string" ? agent.workspace_id : null,
  }
}

function parseAgentInfo(stdout: string): HerdrAgentInfo | null {
  const env = parseEnvelope(stdout)
  if (env.error) return null
  const result = env.result
  if (!result) return null
  const agent = result.agent as Record<string, unknown> | undefined
  const name = agent?.name ?? result.name
  const status = agent?.agent_status ?? result.agent_status
  const paneId = agent?.pane_id ?? result.pane_id
  const workspaceId = agent?.workspace_id ?? result.workspace_id
  return {
    name: typeof name === "string" ? name : null,
    state: extractAgentState(status),
    paneId: typeof paneId === "string" ? paneId : null,
    workspaceId: typeof workspaceId === "string" ? workspaceId : null,
  }
}

function parseWaitResult(stdout: string): HerdrAgentInfo | null {
  const env = parseEnvelope(stdout)
  const result = env.result
  if (!result) return null
  const paneId = typeof result.pane_id === "string" ? result.pane_id : null
  if (!paneId) return null
  return {
    name: typeof result.name === "string" ? result.name : null,
    state: extractAgentState(result.agent_status),
    paneId,
    workspaceId: typeof result.workspace_id === "string" ? result.workspace_id : null,
  }
}

export function createHerdrClient(deps: HerdrClientDeps = {}): HerdrClient {
  const herdrBin = deps.herdrBin ?? "herdr"
  const runCommand = deps.runCommand ?? defaultCommandRunner

  return {
    async ensureWorkspace(cwd, label) {
      const listResult = await runCommand(herdrBin, ["workspace", "list"], cwd)
      const workspaces = parseWorkspaceList(listResult.stdout)
      const existing = workspaces.find((w) => w.label === label)
      if (existing?.workspace_id) {
        return {
          id: existing.workspace_id,
          label: existing.label ?? label,
          cwd: existing.cwd ?? cwd,
        }
      }

      const createResult = await runCommand(
        herdrBin,
        ["workspace", "create", "--cwd", cwd, "--label", label, "--no-focus"],
        cwd,
      )
      if (createResult.exitCode !== 0) {
        throw new Error(createResult.stderr.trim() || `herdr workspace create failed: ${label}`)
      }
      const created = parseWorkspaceCreate(createResult.stdout)
      if (!created) {
        throw new Error(
          `failed to parse workspace create response: ${createResult.stdout.slice(0, 200)}`,
        )
      }
      return created
    },

    async startAgent(name, opts) {
      const args = [
        "agent",
        "start",
        name,
        "--workspace",
        opts.workspaceId,
        "--cwd",
        opts.cwd,
        "--no-focus",
      ]
      if (opts.env) {
        for (const [key, value] of Object.entries(opts.env)) {
          args.push("--env", `${key}=${value}`)
        }
      }
      args.push("--", ...opts.argv)
      const result = await runCommand(herdrBin, args, opts.cwd)
      if (result.exitCode !== 0) {
        throw new Error(result.stderr.trim() || `herdr agent start failed: ${name}`)
      }
      const info = parseAgentStarted(result.stdout)
      if (!info) {
        throw new Error(`failed to parse agent start response: ${result.stdout.slice(0, 200)}`)
      }
      return info
    },

    async waitAgent(paneId, status, timeoutMs) {
      const result = await runCommand(
        herdrBin,
        ["wait", "agent-status", paneId, "--status", status, "--timeout", String(timeoutMs)],
        process.cwd(),
      )
      if (result.exitCode !== 0) {
        return null
      }
      return parseWaitResult(result.stdout)
    },

    async readAgent(target, lines = 200) {
      const result = await runCommand(
        herdrBin,
        [
          "agent",
          "read",
          target,
          "--source",
          "recent",
          "--lines",
          String(lines),
          "--format",
          "text",
        ],
        process.cwd(),
      )
      if (result.exitCode !== 0) {
        return ""
      }
      return result.stdout
    },

    async getAgent(target) {
      const result = await runCommand(herdrBin, ["agent", "get", target], process.cwd())
      if (result.exitCode !== 0) {
        return null
      }
      return parseAgentInfo(result.stdout)
    },

    async sendInput(target, text) {
      await runCommand(herdrBin, ["agent", "send", target, text], process.cwd())
    },

    async sendKeys(target, ...keys) {
      await runCommand(herdrBin, ["pane", "send-keys", target, ...keys], process.cwd())
    },

    async closePane(paneId) {
      await runCommand(herdrBin, ["pane", "close", paneId], process.cwd())
    },
  }
}

function defaultCommandRunner(
  command: string,
  args: string[],
  cwd: string,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk)
    })
    child.on("close", (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr })
    })
    child.on("error", reject)
  })
}
