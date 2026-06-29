import type { Issue, ServiceConfig } from "../../domain/types"
import type { HerdrAgentState, HerdrClient } from "../../herdr/herdr-client"
import { createHerdrClient } from "../../herdr/herdr-client"
import { sanitizeWorkspaceKey } from "../../utils/normalize"
import type { Runner, RunnerEvent, RunnerOptions, RunnerResult } from "../types"
import type { ReportResolver } from "./report"
import { createReportResolver } from "./report"

export type HerdrAgentRunnerDeps = {
  herdrClient?: HerdrClient
  pollIntervalMs?: number
  reportResolver?: ReportResolver
  logger?: (msg: string) => void
  now?: () => number
}

export function buildAgentName(
  identifier: string,
  workflowName: string | undefined,
  now: number,
): string {
  const parts = [identifier]
  if (workflowName) {
    const stripped = workflowName.replace(/\.(md|markdown)$/i, "")
    parts.push(sanitizeWorkspaceKey(stripped))
  }
  parts.push(now.toString(36))
  return parts.join("-")
}

const DEFAULT_TIMEOUT_MS = 86_400_000
const DEFAULT_POLL_INTERVAL_MS = 2_000

export class HerdrAgentRunner implements Runner {
  private readonly client: HerdrClient
  private readonly pollIntervalMs: number
  private readonly reportResolver: ReportResolver
  private readonly logger: (msg: string) => void
  private readonly now: () => number

  constructor(
    private readonly config: ServiceConfig,
    deps: HerdrAgentRunnerDeps = {},
  ) {
    this.client = deps.herdrClient ?? createHerdrClient()
    this.pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    this.logger = deps.logger ?? (() => {})
    this.reportResolver = deps.reportResolver ?? createReportResolver({ logger: deps.logger })
    this.now = deps.now ?? Date.now
  }

  async runIssue(issue: Issue, options: RunnerOptions): Promise<RunnerResult> {
    const label = issue.identifier
    const timeoutMs =
      options.timeoutMs ?? this.config.work.herdrAgent.turnTimeoutMs ?? DEFAULT_TIMEOUT_MS

    try {
      const startedAt = new Date().toISOString()
      const workspace = await this.client.ensureWorkspace(options.workspacePath, label)

      const argv = this.buildAgentArgv(options)
      const agentName = buildAgentName(issue.identifier, options.workflowName, this.now())

      const agent = await this.client.startAgent(agentName, {
        workspaceId: workspace.id,
        cwd: options.workspacePath,
        argv,
      })

      const target = agent.paneId ?? agentName

      this.emit(options, {
        event: "agent_started",
        timestamp: new Date().toISOString(),
        agentName,
        workspaceId: workspace.id,
      })

      const waitState = await this.waitForAgentCompletion(
        target,
        timeoutMs,
        options.onBlocked ?? null,
      )

      if (waitState === null) {
        return {
          status: "timeout",
          error: `agent timed out after ${timeoutMs}ms`,
          responseText: null,
        }
      }

      if (waitState === "blocked") {
        return {
          status: "failed",
          error: "agent is blocked, needs operator input",
          responseText: null,
        }
      }

      this.emit(options, {
        event: "agent_status",
        timestamp: new Date().toISOString(),
        state: waitState,
      })

      const resolved = await this.reportResolver.resolve({
        workspacePath: options.workspacePath,
        startedAt,
        agentKind: options.agentKind,
      })
      if (resolved === null) {
        this.logger(`reportResolver returned null, falling back to pane read target=${target}`)
      }
      const responseText = resolved ?? (await this.client.readAgent(target))

      return {
        status: "succeeded",
        error: null,
        responseText: responseText?.trim() || null,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        status: "failed",
        error: message,
        responseText: null,
      }
    }
  }

  async cancelRun(target: string): Promise<void> {
    await this.client.closePane(target)
  }

  private async waitForAgentCompletion(
    target: string,
    timeoutMs: number,
    onBlocked: "continue" | "fail" | null,
  ): Promise<HerdrAgentState | null> {
    const deadline = Date.now() + timeoutMs
    let sawActive = false

    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs))
      const info = await this.client.getAgent(target)

      if (info === null) {
        if (sawActive) {
          return "done"
        }
        continue
      }

      if (info.state === "working" || info.state === "blocked") {
        sawActive = true
        if (info.state === "blocked" && onBlocked === "fail") {
          return "blocked"
        }
        continue
      }

      if (info.state === "done") {
        return "done"
      }

      if (info.state === "idle") {
        if (sawActive) {
          return "idle"
        }
      }
    }
    return null
  }

  private buildAgentArgv(options: RunnerOptions): string[] {
    if (options.agentKind === "claude") {
      const argv: string[] = ["claude"]

      if (options.model) {
        argv.push("--model", options.model)
      }

      if (options.permissionMode) {
        argv.push("--permission-mode", options.permissionMode)
        if (options.permissionMode === "bypassPermissions") {
          argv.push("--dangerously-skip-permissions")
        }
      }

      argv.push(options.content)
      return argv
    }

    const argv: string[] = ["opencode", "run"]

    if (options.model) {
      argv.push("--model", options.model)
    }
    if (options.agent) {
      argv.push("--agent", options.agent)
    }

    argv.push(options.content)
    return argv
  }

  private emit(options: RunnerOptions, event: RunnerEvent): void {
    options.onEvent?.(event)
  }
}
