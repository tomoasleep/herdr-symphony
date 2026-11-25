import { spawn } from "node:child_process"

export type CccmLaunchedEvent = {
  type: "launched"
  sessionId: string
  sessionUrl: string | null
  hub: string
  commentUrl: string | null
}

export type CccmDoneEvent = {
  type: "done"
  summary: string | null
  lastMessage: string | null
  sessionUrl: string | null
}

export type CccmFailedEvent = {
  type: "failed"
  reason: string
  summary: string | null
}

export type CccmPendingEvent = {
  type: "pending"
  summary: string | null
}

export type CccmOtherEvent = {
  type: "ack" | "reminder" | "turn_ended" | "progress" | "warning"
}

export type CccmEvent =
  | CccmLaunchedEvent
  | CccmDoneEvent
  | CccmFailedEvent
  | CccmPendingEvent
  | CccmOtherEvent

type RawCccmEvent = {
  type?: unknown
  session_id?: unknown
  session_url?: unknown
  hub?: unknown
  comment_url?: unknown
  summary?: unknown
  last_message?: unknown
  reason?: unknown
}

export function parseCccmEvent(line: string): CccmEvent | null {
  let raw: RawCccmEvent
  try {
    raw = JSON.parse(line) as RawCccmEvent
  } catch {
    return null
  }
  if (typeof raw.type !== "string") {
    return null
  }

  switch (raw.type) {
    case "launched": {
      if (typeof raw.session_id !== "string" || typeof raw.hub !== "string") {
        return null
      }
      return {
        type: "launched",
        sessionId: raw.session_id,
        sessionUrl: typeof raw.session_url === "string" ? raw.session_url : null,
        hub: raw.hub,
        commentUrl: typeof raw.comment_url === "string" ? raw.comment_url : null,
      }
    }
    case "done":
      return {
        type: "done",
        summary: typeof raw.summary === "string" ? raw.summary : null,
        lastMessage: typeof raw.last_message === "string" ? raw.last_message : null,
        sessionUrl: typeof raw.session_url === "string" ? raw.session_url : null,
      }
    case "failed":
      return {
        type: "failed",
        reason: typeof raw.reason === "string" ? raw.reason : "unknown",
        summary: typeof raw.summary === "string" ? raw.summary : null,
      }
    case "pending":
      return {
        type: "pending",
        summary: typeof raw.summary === "string" ? raw.summary : null,
      }
    case "ack":
    case "reminder":
    case "turn_ended":
    case "progress":
    case "warning":
      return { type: raw.type }
    default:
      return null
  }
}

const HUB_IDENTIFIER_PATTERN = /^([^#\s]+\/[^#\s]+)#(\d+)$/

export function parseCccmHubFromIdentifier(identifier: string): string | null {
  if (identifier.startsWith("draft:")) {
    return null
  }
  const match = identifier.match(HUB_IDENTIFIER_PATTERN)
  if (!match?.[2]) {
    return null
  }
  return `github:${match[1]}#${match[2]}`
}

export type CccmStreamProcess = {
  onData(listener: (chunk: string) => void): void
  onClose(listener: (code: number) => void): void
  kill(): void
}

export type CccmSpawnProcess = (command: string, args: string[]) => CccmStreamProcess

export type CccmClientDeps = {
  spawnProcess?: CccmSpawnProcess
}

export type CccmLaunchOptions = {
  via: "cloud" | "routine"
  routine?: string | null
  envId?: string | null
  hub: string
  prompt: string
  timeoutMs?: number | null
}

export type CccmMonitorOptions = {
  hub: string
  sessionId?: string | null
}

export type CccmMonitorHandle = {
  readonly sessionId: string
  readonly hub: string
  readonly commentUrl: string | null
  hasExited(): boolean
}

export type CccmPollResult =
  | { state: "running" }
  | {
      state: "done"
      result: { status: "succeeded" | "failed"; error: string | null; responseText: string | null }
    }

export function createCccmClient(deps: CccmClientDeps = {}): CccmClient {
  return new CccmClient(deps)
}

export class CccmClient {
  private readonly spawnProcess: CccmSpawnProcess

  constructor(deps: CccmClientDeps = {}) {
    this.spawnProcess =
      deps.spawnProcess ??
      ((command, args) => {
        const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] })
        child.stdout.on("data", () => {})
        child.stderr.on("data", () => {})
        return {
          onData: (listener) => child.stdout.on("data", (chunk) => listener(String(chunk))),
          onClose: (listener) => child.on("close", (code) => listener(code ?? 1)),
          kill: () => child.kill(),
        }
      })
  }

  startLaunch(options: CccmLaunchOptions): Promise<CccmMonitorHandle> {
    const args = this.buildLaunchArgs(options)
    return this.startProcess(args, options.hub)
  }

  startMonitor(options: CccmMonitorOptions): Promise<CccmMonitorHandle> {
    const args = this.buildMonitorArgs(options)
    return this.startProcess(args, options.hub, options.sessionId ?? null)
  }

  pollMonitor(handle: CccmMonitorHandle): CccmPollResult {
    const state = this.states.get(handle)
    if (!state?.exited) {
      return { state: "running" }
    }
    return { state: "done", result: this.buildResult(state) }
  }

  cancel(handle: CccmMonitorHandle): void {
    const state = this.states.get(handle)
    if (state && !state.exited) {
      state.process.kill()
    }
  }

  private states = new Map<
    CccmMonitorHandle,
    {
      process: CccmStreamProcess
      exited: boolean
      exitCode: number
      lastEvent: CccmEvent | null
      sessionId: string
      hub: string
      commentUrl: string | null
    }
  >()

  private buildLaunchArgs(options: CccmLaunchOptions): string[] {
    const args = ["launch", "--via", options.via]
    if (options.via === "routine" && options.routine) {
      args.push("--routine", options.routine)
    }
    if (options.via === "cloud" && options.envId) {
      args.push("--env", options.envId)
    }
    if (options.timeoutMs !== null && options.timeoutMs !== undefined) {
      args.push("--timeout", `${options.timeoutMs}ms`)
    }
    args.push("--hub", options.hub, "--output-format", "stream-json", "--no-wait", options.prompt)
    return args
  }

  private buildMonitorArgs(options: CccmMonitorOptions): string[] {
    const args = ["monitor", "--hub", options.hub]
    if (options.sessionId) {
      args.push("--session", options.sessionId)
    }
    args.push("--output-format", "stream-json")
    return args
  }

  private startProcess(
    args: string[],
    hub: string,
    knownSessionId?: string | null,
  ): Promise<CccmMonitorHandle> {
    return new Promise((resolve, reject) => {
      const process = this.spawnProcess("cccm", args)
      let buffer = ""
      let resolved = false
      let sessionId = knownSessionId ?? ""
      let commentUrl: string | null = null
      let lastEvent: CccmEvent | null = null
      let exitCode = 0
      let exited = false

      const handle: CccmMonitorHandle = {
        get sessionId() {
          return sessionId
        },
        get hub() {
          return hub
        },
        get commentUrl() {
          return commentUrl
        },
        hasExited() {
          return exited
        },
      }

      process.onData((chunk) => {
        buffer += chunk
        const lines = buffer.split("\n")
        buffer = lines.pop() ?? ""
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          const event = parseCccmEvent(trimmed)
          if (!event) continue
          lastEvent = event
          if (event.type === "launched") {
            sessionId = event.sessionId
            commentUrl = event.commentUrl
            if (!resolved) {
              resolved = true
              resolve(handle)
            }
          }
        }
      })

      process.onClose((code) => {
        exited = true
        exitCode = code
        this.states.set(handle, {
          process,
          exited,
          exitCode,
          lastEvent,
          sessionId,
          hub,
          commentUrl,
        })
        if (!resolved) {
          resolved = true
          reject(new Error(`cccm exited with code ${code} before launching`))
        }
      })

      this.states.set(handle, {
        process,
        exited,
        exitCode,
        lastEvent,
        sessionId,
        hub,
        commentUrl,
      })
    })
  }

  private buildResult(state: {
    exitCode: number
    lastEvent: CccmEvent | null
    sessionId: string
  }): { status: "succeeded" | "failed"; error: string | null; responseText: string | null } {
    const event = state.lastEvent
    if (event?.type === "done") {
      return {
        status: "succeeded",
        error: null,
        responseText: event.summary ?? event.lastMessage,
      }
    }
    if (event?.type === "failed") {
      return {
        status: "failed",
        error: event.summary || event.reason,
        responseText: null,
      }
    }
    return {
      status: "failed",
      error: this.describeExitCode(state.exitCode),
      responseText: null,
    }
  }

  private describeExitCode(code: number): string {
    switch (code) {
      case 3:
        return "cccm: agent did not acknowledge (report init) within ack-timeout"
      case 4:
        return "cccm: timed out"
      case 5:
        return "cccm: launch failed"
      case 1:
        return "cccm: agent reported failure"
      default:
        return `cccm: exited with code ${code}`
    }
  }
}
