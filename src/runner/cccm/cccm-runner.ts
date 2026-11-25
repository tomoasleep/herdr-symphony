import type { Issue, ServiceConfig } from "../../domain/types"
import { formatError } from "../../utils/error"
import type {
  Runner,
  RunnerEvent,
  RunnerHandle,
  RunnerHandleMeta,
  RunnerOptions,
  RunnerPollResult,
  RunnerResult,
} from "../types"
import {
  type CccmClient,
  type CccmMonitorHandle,
  type CccmSpawnProcess,
  createCccmClient,
  parseCccmHubFromIdentifier,
} from "./cccm-client"

export type CccmRunnerDeps = {
  client?: CccmClient
  spawnProcess?: CccmSpawnProcess
  logger?: (msg: string) => void
  now?: () => number
}

type CccmContext = {
  handle: RunnerHandle
  monitor: CccmMonitorHandle
  deadline: number
  onEvent: ((event: RunnerEvent) => void) | undefined
}

export class CccmRunner implements Runner {
  private readonly client: CccmClient
  private readonly logger: (msg: string) => void
  private readonly now: () => number
  private readonly contexts = new Map<string, CccmContext>()

  constructor(
    private readonly config: ServiceConfig,
    deps: CccmRunnerDeps = {},
  ) {
    this.client = deps.client ?? createCccmClient({ spawnProcess: deps.spawnProcess })
    this.logger = deps.logger ?? (() => {})
    this.now = deps.now ?? Date.now
  }

  async startIssue(issue: Issue, options: RunnerOptions): Promise<RunnerHandle> {
    const hub = this.resolveHub(null, issue)
    if (!hub) {
      throw new Error(
        `hub issue not resolvable from identifier=${issue.identifier}: specify work.cccm.hub or use a tracker issue with a GitHub issue`,
      )
    }

    const launchOptions = this.buildLaunchOptions(hub, options)
    this.logger(`cccm launch hub=${hub} via=${launchOptions.via}`)

    let monitor: CccmMonitorHandle
    try {
      monitor = await this.client.startLaunch(launchOptions)
    } catch (error) {
      throw new Error(`cccm launch failed: ${formatError(error)}`)
    }

    this.emit(options, {
      event: "agent_started",
      timestamp: new Date().toISOString(),
      agentName: monitor.sessionId,
      workspaceId: options.workspacePath,
    })

    const timeoutMs = options.timeoutMs ?? this.config.work.herdrAgent.turnTimeoutMs ?? null
    const deadline = timeoutMs === null ? Number.MAX_SAFE_INTEGER : this.now() + timeoutMs

    const meta: RunnerHandleMeta = {
      agentName: monitor.sessionId,
      workspacePath: options.workspacePath,
      agentKind: "claude",
      interactive: false,
      reportPath: null,
      resultPath: null,
      startedAt: new Date().toISOString(),
      deadlineMs: deadline,
      onBlocked: null,
      agmsg: null,
      closePaneAfterDoneMs: null,
      cccm: {
        hub,
        sessionId: monitor.sessionId,
        commentUrl: monitor.commentUrl,
      },
    }

    const handle: RunnerHandle = { sessionId: monitor.sessionId, issueId: issue.id, meta }
    this.contexts.set(handle.sessionId, { handle, monitor, deadline, onEvent: options.onEvent })
    return handle
  }

  async pollCompletion(handle: RunnerHandle): Promise<RunnerPollResult> {
    const ctx = this.contexts.get(handle.sessionId)
    if (!ctx) {
      return {
        state: "done",
        result: {
          status: "failed",
          error: `unknown handle: ${handle.sessionId}`,
          responseText: null,
        },
      }
    }

    if (this.now() >= ctx.deadline) {
      return this.finish(ctx, {
        status: "timeout",
        error: "agent timed out after",
        responseText: null,
      })
    }

    const poll = this.client.pollMonitor(ctx.monitor)
    if (poll.state === "running") {
      return { state: "running" }
    }
    return this.finish(ctx, poll.result)
  }

  async cancelRun(target: string): Promise<void> {
    const ctx = this.contexts.get(target)
    if (!ctx) {
      return
    }
    this.contexts.delete(target)
    this.client.cancel(ctx.monitor)
  }

  async sweep(): Promise<void> {}

  async reattach(handle: RunnerHandle): Promise<boolean> {
    const meta = handle.meta
    if (!meta?.cccm) {
      return false
    }

    let monitor: CccmMonitorHandle
    try {
      monitor = await this.client.startMonitor({
        hub: meta.cccm.hub,
        sessionId: meta.cccm.sessionId,
      })
    } catch (error) {
      this.logger(`cccm monitor reattach failed error=${formatError(error)}`)
      return false
    }

    this.contexts.set(handle.sessionId, {
      handle,
      monitor,
      deadline: meta.deadlineMs,
      onEvent: undefined,
    })
    return true
  }

  private resolveHub(_hubOverride: string | null, issue: Issue): string | null {
    const configHub = this.config.work.cccm.hub
    if (configHub) {
      return configHub
    }
    return parseCccmHubFromIdentifier(issue.identifier)
  }

  private buildLaunchOptions(hub: string, options: RunnerOptions) {
    const cccm = this.config.work.cccm
    return {
      via: cccm.via,
      routine: cccm.routine,
      envId: cccm.envId,
      hub,
      prompt: options.content,
      timeoutMs: options.timeoutMs ?? this.config.work.herdrAgent.turnTimeoutMs ?? null,
      ackTimeoutMs: cccm.ackTimeoutMs,
      reminderGraceMs: cccm.reminderGraceMs,
      pendingRemindIntervalMs: cccm.pendingRemindIntervalMs,
      claudeOptions: cccm.claudeOptions,
    }
  }

  private finish(ctx: CccmContext, result: RunnerResult): RunnerPollResult {
    if (ctx.onEvent) {
      ctx.onEvent({
        event: "agent_status",
        timestamp: new Date().toISOString(),
        state: result.status,
      })
    }
    this.contexts.delete(ctx.handle.sessionId)
    return { state: "done", result }
  }

  private emit(options: RunnerOptions, event: RunnerEvent): void {
    options.onEvent?.(event)
  }
}
