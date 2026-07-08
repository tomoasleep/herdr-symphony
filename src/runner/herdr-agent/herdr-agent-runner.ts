import type { AgmsgClient } from "../../agmsg/agmsg-client"
import { createAgmsgClient, getAgmsgScriptsDir, isAgmsgAvailable } from "../../agmsg/agmsg-client"
import type { AgentReportMessage } from "../../agmsg/agmsg-message"
import { formatAgmsgMessage, parseInboxForMessages } from "../../agmsg/agmsg-message"
import type { Issue, ServiceConfig } from "../../domain/types"
import type { HerdrAgentState, HerdrClient } from "../../herdr/herdr-client"
import { createHerdrClient } from "../../herdr/herdr-client"
import { readReport } from "../../report/write-report"
import { sanitizeAgentName, sanitizeWorkspaceKey } from "../../utils/normalize"
import type { Runner, RunnerEvent, RunnerOptions, RunnerResult } from "../types"
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

type WaitResult = {
  state: HerdrAgentState | null
  report: AgentReportMessage | null
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

  async runIssue(issue: Issue, options: RunnerOptions): Promise<RunnerResult> {
    const label = issue.identifier
    const timeoutMs =
      options.timeoutMs ?? this.config.work.herdrAgent.turnTimeoutMs ?? DEFAULT_TIMEOUT_MS

    try {
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

      if (agmsgContext) {
        const handshake = await this.waitForTaskAck(
          agmsgContext,
          options.content,
          handshakeTimeoutMs,
          ackResendIntervalMs,
        )
        if (!handshake) {
          return {
            status: "failed",
            error: "agmsg delivery handshake timed out",
            responseText: null,
          }
        }
      }

      const waitResult = await this.waitForAgentCompletion(
        target,
        timeoutMs,
        options.onBlocked ?? null,
        agmsgContext,
        effectiveReportPath,
        options.pendingRemindIntervalMs ??
          this.config.work.herdrAgent.claude.pendingRemindIntervalMs,
      )

      if (waitResult.state === null) {
        return {
          status: "timeout",
          error: `agent timed out after ${timeoutMs}ms`,
          responseText: null,
        }
      }

      if (waitResult.state === "blocked") {
        return {
          status: "failed",
          error: "agent is blocked, needs operator input",
          responseText: null,
        }
      }

      this.emit(options, {
        event: "agent_status",
        timestamp: new Date().toISOString(),
        state: waitResult.state,
      })

      if (waitResult.report?.status === "failed") {
        return {
          status: "failed",
          error: waitResult.report.summary || "reported as failed",
          responseText: null,
        }
      }
      if (waitResult.report?.status === "done" && waitResult.report.summary) {
        return {
          status: "succeeded",
          error: null,
          responseText: waitResult.report.summary,
        }
      }

      if (effectiveReportPath) {
        const report = readReport(effectiveReportPath)
        if (report?.status === "failed") {
          return {
            status: "failed",
            error: report.summary || "reported as failed",
            responseText: null,
          }
        }
        if (report?.status === "done" && report.summary) {
          return {
            status: "succeeded",
            error: null,
            responseText: report.summary,
          }
        }
      }

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

  private async waitForAgentCompletion(
    target: string,
    timeoutMs: number,
    onBlocked: "continue" | "fail" | null,
    agmsgContext: AgmsgWaitContext | null,
    reportPath: string | undefined,
    pendingRemindIntervalMs: number,
  ): Promise<WaitResult> {
    const deadline = this.now() + timeoutMs
    let sawActive = false
    let sawAgent = false

    const handleReportFileResult = (
      target: string,
      reportPath: string,
    ): "done" | "pending" | "none" => {
      return this.handleReportFileIdle(target, reportPath, pendingRemindIntervalMs)
    }

    while (this.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs))
      const info = await this.client.getAgent(target)

      if (info === null) {
        if (sawActive) {
          if (agmsgContext) {
            const handled = await this.handleAgmsgIdle(agmsgContext)
            if (handled.state === "done") return { state: "done", report: handled.report }
            sawActive = false
            continue
          }
          if (reportPath) {
            if (handleReportFileResult(target, reportPath) === "done")
              return { state: "done", report: null }
            sawActive = false
            continue
          }
          return { state: "done", report: null }
        }
        if (sawAgent) {
          if (reportPath) {
            if (handleReportFileResult(target, reportPath) === "done")
              return { state: "done", report: null }
            continue
          }
          return { state: "done", report: null }
        }
        continue
      }

      sawAgent = true

      if (info.state === "working" || info.state === "blocked") {
        sawActive = true
        if (info.state === "blocked" && onBlocked === "fail") {
          return { state: "blocked", report: null }
        }
        continue
      }

      if (info.state === "done") {
        if (reportPath) {
          if (handleReportFileResult(target, reportPath) === "done")
            return { state: "done", report: null }
          continue
        }
        return { state: "done", report: null }
      }

      if (info.state === "idle") {
        if (sawActive) {
          if (agmsgContext) {
            const handled = await this.handleAgmsgIdle(agmsgContext)
            if (handled.state === "done") return { state: "done", report: handled.report }
            sawActive = false
            continue
          }
          if (reportPath) {
            if (handleReportFileResult(target, reportPath) === "done")
              return { state: "done", report: null }
            sawActive = false
            continue
          }
          return { state: "idle", report: null }
        }
        if (reportPath && sawAgent) {
          if (handleReportFileResult(target, reportPath) === "done")
            return { state: "done", report: null }
        }
      }
    }
    return { state: null, report: null }
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
