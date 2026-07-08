import type { AgmsgClient } from "../../agmsg/agmsg-client"
import { createAgmsgClient, getAgmsgScriptsDir, isAgmsgAvailable } from "../../agmsg/agmsg-client"
import type { AgentReportMessage } from "../../agmsg/agmsg-message"
import { formatAgmsgMessage, parseInboxForMessages } from "../../agmsg/agmsg-message"
import type { Issue, ServiceConfig } from "../../domain/types"
import type { HerdrAgentState, HerdrClient } from "../../herdr/herdr-client"
import { createHerdrClient } from "../../herdr/herdr-client"
import { readReport } from "../../report/write-report"
import { sanitizeAgentName, sanitizeWorkspaceKey } from "../../utils/normalize"
import type {
  Runner,
  RunnerEvent,
  RunnerHandle,
  RunnerOptions,
  RunnerPollResult,
  RunnerResult,
} from "../types"
import type { ReportResolver } from "./report"
import { createReportResolver } from "./report"

export type HerdrAgentRunnerDeps = {
  herdrClient?: HerdrClient
  agmsgClient?: AgmsgClient
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
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 180_000
const DEFAULT_ACK_RESEND_INTERVAL_MS = 5_000
const DEFAULT_REMINDER_ACK_DEADLINE_MS = 30_000

const CLAUDE_REPORT_REMINDER =
  'ユーザーに依頼された作業は完了しましたか？完了した場合は `herdr-symphony report --status done --summary "やった作業の要約"` を実行してください。まだ background task / subagent / task の完了待ちなら `herdr-symphony report --status pending --summary "待機中の内容"` を実行してください。失敗した場合は `herdr-symphony report --status failed --summary "失敗理由"` を実行してください。'

type AgmsgWaitContext = {
  client: AgmsgClient
  team: string
  orchestratorAgent: string
  agentName: string
  issueId: string
  runId: string
  reminderAckDeadlineMs: number
}

type AgentContext = {
  handle: RunnerHandle
  target: string
  agentName: string
  workspacePath: string
  startedAt: string
  agentKind: "opencode" | "claude"
  onBlocked: "continue" | "fail" | null
  reportPath: string | undefined
  pendingRemindIntervalMs: number
  agmsgContext: AgmsgWaitContext | null
  deadline: number
  sawActive: boolean
  sawAgent: boolean
  onEvent: ((event: RunnerEvent) => void) | undefined
}

function buildClaudeBootstrapPrompt(team: string, agentName: string, issueId: string): string {
  const scriptsDir = getAgmsgScriptsDir()
  const sendScript = `${scriptsDir}/send.sh`
  const actasScript = `${scriptsDir}/actas-claim.sh`
  const reportBody = (status: string, summary: string) =>
    JSON.stringify({
      kind: "herdr-symphony.report",
      runId: agentName,
      toAgent: "herdr-symphony",
      issueId,
      status,
      summary,
    })
  const ackBody = (ackOf: "task" | "reminder") =>
    JSON.stringify({
      kind: "herdr-symphony.ack",
      runId: agentName,
      toAgent: "herdr-symphony",
      issueId,
      ackOf,
    })
  return [
    "あなたは herdr-symphony の agent です。",
    "実タスクは agmsg で届きます。",
    `最初に ${actasScript} "$PWD" claude-code "${agentName}" "$CLAUDE_CODE_SESSION_ID" を実行して、この agent identity を claim してください。`,
    "claim に失敗した場合は task ack を返さず、作業を開始しないでください。",
    `team は ${team}、あなたの agent 名と runId は ${agentName}、issueId は ${issueId} です。`,
    "herdr-symphony.task を受け取ったら、runId と toAgent が自分宛てか確認してください。違う場合は無視してください。",
    `task を受け取ったら、まず ${sendScript} ${team} ${agentName} herdr-symphony '${ackBody("task")}' を実行し、その後 task.prompt を実行してください。`,
    `reminder を受け取ったら、まず ${sendScript} ${team} ${agentName} herdr-symphony '${ackBody("reminder")}' を実行してください。`,
    "完了時は、ユーザーへの完了報告と同等の内容を summary に入れて report してください。",
    `done: ${sendScript} ${team} ${agentName} herdr-symphony '${reportBody("done", "対応内容: ...。検証: ...。補足: ...。")}'`,
    `pending: ${sendScript} ${team} ${agentName} herdr-symphony '${reportBody("pending", "待機中の内容")}'`,
    `failed: ${sendScript} ${team} ${agentName} herdr-symphony '${reportBody("failed", "失敗理由")}'`,
  ].join("\n")
}

function formatReminderBody(issueId: string, runId: string, toAgent: string): string {
  return formatAgmsgMessage({
    kind: "herdr-symphony.reminder",
    issueId,
    runId,
    toAgent,
    message:
      "ユーザーに依頼された作業は完了しましたか？完了した場合は done、待機中なら pending、失敗なら failed を agmsg で報告してください。",
  })
}

function formatTaskBody(issueId: string, runId: string, toAgent: string, prompt: string): string {
  return formatAgmsgMessage({
    kind: "herdr-symphony.task",
    issueId,
    runId,
    toAgent,
    prompt,
  })
}

export class HerdrAgentRunner implements Runner {
  private readonly client: HerdrClient
  private readonly agmsgClient: AgmsgClient
  private readonly customAgmsgClient: boolean
  private readonly pollIntervalMs: number
  private readonly reportResolver: ReportResolver
  private readonly logger: (msg: string) => void
  private readonly now: () => number
  private readonly contexts = new Map<string, AgentContext>()

  constructor(
    private readonly config: ServiceConfig,
    deps: HerdrAgentRunnerDeps = {},
  ) {
    this.client = deps.herdrClient ?? createHerdrClient()
    this.customAgmsgClient = deps.agmsgClient !== undefined
    this.agmsgClient = deps.agmsgClient ?? createAgmsgClient()
    this.pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    this.logger = deps.logger ?? (() => {})
    this.reportResolver = deps.reportResolver ?? createReportResolver({ logger: deps.logger })
    this.now = deps.now ?? Date.now
  }

  async startIssue(issue: Issue, options: RunnerOptions): Promise<RunnerHandle> {
    const label = issue.identifier
    const timeoutMs =
      options.timeoutMs ?? this.config.work.herdrAgent.turnTimeoutMs ?? DEFAULT_TIMEOUT_MS

    const startedAt = new Date().toISOString()
    const workspace = await this.client.ensureWorkspace(options.workspacePath, label)

    const agentName = buildAgentName(issue.identifier, options.workflowName, this.now())

    let content = options.content
    let agmsgContext: AgmsgWaitContext | null = null
    let handshakeTimeoutMs = DEFAULT_HANDSHAKE_TIMEOUT_MS
    let ackResendIntervalMs = DEFAULT_ACK_RESEND_INTERVAL_MS

    if (options.agmsg && options.agentKind === "claude") {
      if (!this.customAgmsgClient && !isAgmsgAvailable()) {
        throw new Error(`agmsg is not installed: ${getAgmsgScriptsDir()}/send.sh not found`)
      }
      const agmsgAgentName = sanitizeAgentName(agentName)
      const agentTeamSuffix = sanitizeWorkspaceKey(agmsgAgentName)
      const team = options.agmsg.team.endsWith(agentTeamSuffix)
        ? options.agmsg.team
        : `${options.agmsg.team}-${agentTeamSuffix}`
      const orchestratorAgent = options.agmsg.orchestratorAgent
      await this.agmsgClient.join(team, orchestratorAgent, "opencode", options.workspacePath)
      await this.agmsgClient.join(team, agmsgAgentName, "claude-code", options.workspacePath)
      await this.agmsgClient.setDelivery("monitor", "claude-code", options.workspacePath)
      content = buildClaudeBootstrapPrompt(team, agmsgAgentName, issue.id)
      handshakeTimeoutMs = options.agmsg.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS
      ackResendIntervalMs = options.agmsg.ackResendIntervalMs ?? DEFAULT_ACK_RESEND_INTERVAL_MS
      agmsgContext = {
        client: this.agmsgClient,
        team,
        orchestratorAgent,
        agentName: agmsgAgentName,
        issueId: issue.id,
        runId: agmsgAgentName,
        reminderAckDeadlineMs:
          options.agmsg.reminderAckDeadlineMs ?? DEFAULT_REMINDER_ACK_DEADLINE_MS,
      }
    }

    const argv = this.buildAgentArgv({ ...options, content })

    const effectiveReportPath = options.agentKind === "claude" ? options.reportPath : undefined

    const agent = await this.client.startAgent(agentName, {
      workspaceId: workspace.id,
      cwd: options.workspacePath,
      argv,
      env: effectiveReportPath ? { HERDR_SYMPHONY_REPORT_PATH: effectiveReportPath } : undefined,
    })

    const target = agent.paneId ?? agentName

    this.emit(options, {
      event: "agent_started",
      timestamp: new Date().toISOString(),
      agentName,
      workspaceId: workspace.id,
    })

    const handle: RunnerHandle = { sessionId: target, issueId: issue.id }

    if (agmsgContext) {
      const handshake = await this.waitForTaskAck(
        agmsgContext,
        options.content,
        handshakeTimeoutMs,
        ackResendIntervalMs,
      )
      if (!handshake) {
        await this.client.closePane(target)
        throw new Error("agmsg delivery handshake timed out")
      }
    }

    this.contexts.set(target, {
      handle,
      target,
      agentName,
      workspacePath: options.workspacePath,
      startedAt,
      agentKind: options.agentKind,
      onBlocked: options.onBlocked ?? null,
      reportPath: effectiveReportPath,
      pendingRemindIntervalMs:
        options.pendingRemindIntervalMs ??
        this.config.work.herdrAgent.claude.pendingRemindIntervalMs,
      agmsgContext,
      deadline: this.now() + timeoutMs,
      sawActive: false,
      sawAgent: false,
      onEvent: options.onEvent,
    })

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
      return this.done(ctx, {
        status: "timeout",
        error: `agent timed out after`,
        responseText: null,
      })
    }

    const info = await this.client.getAgent(ctx.target)

    if (info === null) {
      if (ctx.sawActive) {
        if (ctx.agmsgContext) {
          const handled = await this.handleAgmsgIdle(ctx.agmsgContext)
          if (handled.state === "done") {
            return this.doneFromAgmsgReport(ctx, handled.report)
          }
          ctx.sawActive = false
          return { state: "running" }
        }
        if (ctx.reportPath) {
          if (
            this.handleReportFileIdle(ctx.target, ctx.reportPath, ctx.pendingRemindIntervalMs) ===
            "done"
          ) {
            return this.doneFromReportFile(ctx)
          }
          ctx.sawActive = false
          return { state: "running" }
        }
        return this.doneSucceeded(ctx)
      }
      if (ctx.sawAgent) {
        if (ctx.reportPath) {
          if (
            this.handleReportFileIdle(ctx.target, ctx.reportPath, ctx.pendingRemindIntervalMs) ===
            "done"
          ) {
            return this.doneFromReportFile(ctx)
          }
          return { state: "running" }
        }
        return this.doneSucceeded(ctx)
      }
      return { state: "running" }
    }

    ctx.sawAgent = true

    const state: HerdrAgentState = info.state
    if (state === "working" || state === "blocked") {
      ctx.sawActive = true
      if (state === "blocked" && ctx.onBlocked === "fail") {
        return this.done(ctx, {
          status: "failed",
          error: "agent is blocked, needs operator input",
          responseText: null,
        })
      }
      return { state: "running" }
    }

    if (state === "done") {
      if (ctx.reportPath) {
        if (
          this.handleReportFileIdle(ctx.target, ctx.reportPath, ctx.pendingRemindIntervalMs) ===
          "done"
        ) {
          return this.doneFromReportFile(ctx)
        }
        return { state: "running" }
      }
      return this.doneSucceeded(ctx)
    }

    if (state === "idle") {
      if (ctx.sawActive) {
        if (ctx.agmsgContext) {
          const handled = await this.handleAgmsgIdle(ctx.agmsgContext)
          if (handled.state === "done") {
            return this.doneFromAgmsgReport(ctx, handled.report)
          }
          ctx.sawActive = false
          return { state: "running" }
        }
        if (ctx.reportPath) {
          if (
            this.handleReportFileIdle(ctx.target, ctx.reportPath, ctx.pendingRemindIntervalMs) ===
            "done"
          ) {
            return this.doneFromReportFile(ctx)
          }
          ctx.sawActive = false
          return { state: "running" }
        }
        return this.doneSucceeded(ctx)
      }
      if (ctx.reportPath && ctx.sawAgent) {
        if (
          this.handleReportFileIdle(ctx.target, ctx.reportPath, ctx.pendingRemindIntervalMs) ===
          "done"
        ) {
          return this.doneFromReportFile(ctx)
        }
        return { state: "running" }
      }
    }

    return { state: "running" }
  }

  async cancelRun(target: string): Promise<void> {
    this.contexts.delete(target)
    await this.client.closePane(target)
  }

  private async waitForTaskAck(
    ctx: AgmsgWaitContext,
    prompt: string,
    timeoutMs: number,
    resendIntervalMs: number,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    let nextSendAt = 0
    while (Date.now() < deadline) {
      const now = Date.now()
      if (now >= nextSendAt) {
        await ctx.client.send(
          ctx.team,
          ctx.orchestratorAgent,
          ctx.agentName,
          formatTaskBody(ctx.issueId, ctx.runId, ctx.agentName, prompt),
        )
        nextSendAt = now + resendIntervalMs
      }

      const messages = parseInboxForMessages(
        await ctx.client.inbox(ctx.team, ctx.orchestratorAgent),
        {
          issueId: ctx.issueId,
          runId: ctx.runId,
          toAgent: ctx.orchestratorAgent,
        },
      )
      if (
        messages.some(
          (message) => message.kind === "herdr-symphony.ack" && message.ackOf === "task",
        )
      ) {
        return true
      }

      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs))
    }
    this.logger(`agmsg delivery handshake timed out agent=${ctx.agentName}`)
    return false
  }

  private async handleAgmsgIdle(
    ctx: AgmsgWaitContext,
  ): Promise<
    { state: "done"; report: AgentReportMessage } | { state: "pending" } | { state: "none" }
  > {
    const inbox = await ctx.client.inbox(ctx.team, ctx.orchestratorAgent)
    const messages = parseInboxForMessages(inbox, {
      issueId: ctx.issueId,
      runId: ctx.runId,
      toAgent: ctx.orchestratorAgent,
    })
    const report = messages.findLast((message) => message.kind === "herdr-symphony.report")
    if (report?.status === "done" || report?.status === "failed") {
      return { state: "done", report }
    }
    if (report?.status === "pending") {
      return { state: "pending" }
    }
    await ctx.client.send(
      ctx.team,
      ctx.orchestratorAgent,
      ctx.agentName,
      formatReminderBody(ctx.issueId, ctx.runId, ctx.agentName),
    )
    this.logger("agmsg reminder sent")
    return { state: "none" }
  }

  private handleReportFileIdle(
    target: string,
    reportPath: string,
    pendingRemindIntervalMs: number,
  ): "done" | "pending" | "none" {
    const report = readReport(reportPath)
    if (report?.status === "done" || report?.status === "failed") {
      return "done"
    }
    if (report?.status === "pending") {
      const reportedAt = Date.parse(report.timestamp)
      if (Number.isNaN(reportedAt) || this.now() - reportedAt >= pendingRemindIntervalMs) {
        void this.client.sendInput(target, CLAUDE_REPORT_REMINDER)
        void this.client.sendKeys(target, "Enter")
        this.logger("report-file pending reminder sent")
      }
      return "pending"
    }
    void this.client.sendInput(target, CLAUDE_REPORT_REMINDER)
    void this.client.sendKeys(target, "Enter")
    this.logger("report-file reminder sent")
    return "none"
  }

  private emitStatus(ctx: AgentContext, state: string): void {
    if (!ctx.onEvent) return
    ctx.onEvent({
      event: "agent_status",
      timestamp: new Date().toISOString(),
      state,
    })
  }

  private done(ctx: AgentContext, result: RunnerResult): RunnerPollResult {
    this.emitStatus(ctx, result.status === "timeout" ? "timeout" : result.status)
    this.contexts.delete(ctx.target)
    return { state: "done", result }
  }

  private async doneFromAgmsgReport(
    ctx: AgentContext,
    report: AgentReportMessage | undefined,
  ): Promise<RunnerPollResult> {
    if (report?.status === "failed") {
      return this.done(ctx, {
        status: "failed",
        error: report.summary || "reported as failed",
        responseText: null,
      })
    }
    if (report?.status === "done" && report.summary) {
      return this.done(ctx, {
        status: "succeeded",
        error: null,
        responseText: report.summary,
      })
    }
    return this.doneSucceeded(ctx)
  }

  private async doneFromReportFile(ctx: AgentContext): Promise<RunnerPollResult> {
    const report = ctx.reportPath ? readReport(ctx.reportPath) : null
    if (report?.status === "failed") {
      return this.done(ctx, {
        status: "failed",
        error: report.summary || "reported as failed",
        responseText: null,
      })
    }
    if (report?.status === "done" && report.summary) {
      return this.done(ctx, {
        status: "succeeded",
        error: null,
        responseText: report.summary,
      })
    }
    return this.doneSucceeded(ctx)
  }

  private async doneSucceeded(ctx: AgentContext): Promise<RunnerPollResult> {
    const resolved = await this.reportResolver.resolve({
      workspacePath: ctx.workspacePath,
      startedAt: ctx.startedAt,
      agentKind: ctx.agentKind,
    })
    if (resolved === null) {
      this.logger(`reportResolver returned null, falling back to pane read target=${ctx.target}`)
    }
    const responseText = resolved ?? (await this.client.readAgent(ctx.target))
    return this.done(ctx, {
      status: "succeeded",
      error: null,
      responseText: responseText?.trim() || null,
    })
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
