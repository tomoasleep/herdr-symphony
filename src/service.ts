import { rm } from "node:fs/promises"
import { join } from "node:path"
import type { Issue, ResolvedIssueRuntimeConfig, ServiceConfig } from "./domain/types"
import { createLogger } from "./logging/create-logger"
import type { Logger, LogLevel } from "./logging/types"
import { OrchestratorState } from "./orchestrator/orchestrator"
import { createRunner } from "./runner/create-runner"
import type { Runner, RunnerHandle, RunnerPollResult, RunnerResult } from "./runner/types"
import type { LogRecord, LogRepository, Storage } from "./storage/types"
import { createTrackerClient } from "./tracker/create-tracker-client"
import type { IssueTrackerClient } from "./tracker/types"
import { appendAgentLog as appendAgentLogImpl } from "./utils/append-agent-log"
import { appendAgentLogToDescription } from "./utils/append-agent-log-to-description"
import { formatError } from "./utils/error"
import { evaluateIfCondition, resolveIssueRuntimeConfig } from "./workflow/render-frontmatter"
import { renderPrompt } from "./workflow/render-prompt"
import type { WorkspaceResult } from "./workspace/workspace-manager"
import { ensureWorkspace, runHook } from "./workspace/workspace-manager"

const CLAUDE_REPORT_INSTRUCTION = [
  "",
  "## 完了報告",
  "",
  "ユーザーに依頼された作業が完了したら、以下のコマンドを実行してください。",
  "",
  '    herdr-symphony report --status done --summary "やった作業の要約"',
  "",
  "background task / subagent / task の完了待ちなら、以下のコマンドを実行してください。",
  "",
  '    herdr-symphony report --status pending --summary "待機中の内容"',
  "",
  "失敗した場合は、以下のコマンドを実行してください。",
  "",
  '    herdr-symphony report --status failed --summary "失敗理由"',
].join("\n")

type DispatchContext = {
  handle: RunnerHandle
  issue: Issue
  runtimeConfig: ResolvedIssueRuntimeConfig
  workspace: WorkspaceResult
  reportPath: string | undefined
}

type ServiceDependencies = {
  tracker?: IssueTrackerClient
  runner?: Runner
  logLevel?: LogLevel
  logger?: Logger
  claimIssue?: (issueId: string) => boolean
  releaseIssue?: (issueId: string) => void
  workflowId?: string
  workflowName?: string
  storage?: Storage
  ensureWorkspace?: (
    issue: Issue,
    config: ServiceConfig["work"]["workspace"],
  ) => Promise<WorkspaceResult>
  runHook?: (script: string, cwd: string, timeoutMs: number, failOnError: boolean) => Promise<void>
  resolveRuntimeConfig?: (
    issue: Issue,
    work: ServiceConfig["work"],
    attempt: number | null,
  ) => Promise<ResolvedIssueRuntimeConfig>
  renderPrompt?: (template: string, issue: Issue, attempt: number | null) => Promise<string>
  appendAgentLog?: (workspacePath: string, text: string) => Promise<void>
  updateItemDescription?: (issue: Issue, description: string) => Promise<void>
  fetchIssueDescription?: (issue: Issue) => Promise<string | null>
}

export class SymphonyService {
  private readonly state: OrchestratorState
  private tracker: IssueTrackerClient
  private runner: NonNullable<ServiceDependencies["runner"]>
  private readonly ensureWorkspaceFn: NonNullable<ServiceDependencies["ensureWorkspace"]>
  private readonly runHookFn: NonNullable<ServiceDependencies["runHook"]>
  private readonly resolveRuntimeConfigFn: NonNullable<ServiceDependencies["resolveRuntimeConfig"]>
  private readonly renderPromptFn: NonNullable<ServiceDependencies["renderPrompt"]>
  private readonly claimIssue: NonNullable<ServiceDependencies["claimIssue"]>
  private readonly releaseIssue: NonNullable<ServiceDependencies["releaseIssue"]>
  private readonly appendAgentLog: NonNullable<ServiceDependencies["appendAgentLog"]>
  private readonly updateItemDescription: NonNullable<ServiceDependencies["updateItemDescription"]>
  private readonly fetchIssueDescription: NonNullable<ServiceDependencies["fetchIssueDescription"]>
  private readonly workflowId: string
  private readonly workflowName: string
  private readonly logger: Logger
  private readonly logLevel: LogLevel
  private readonly logRepository: LogRepository | undefined
  private stopped = false
  private readonly pendingDispatches = new Set<Promise<void>>()
  private readonly dispatchContexts = new Map<string, DispatchContext>()

  private config: ServiceConfig
  private template: string

  constructor(config: ServiceConfig, template: string, deps: ServiceDependencies = {}) {
    this.config = config
    this.template = template
    this.state = new OrchestratorState(config, deps.storage, deps.workflowId)
    this.logLevel = deps.logLevel ?? "info"
    this.logger =
      deps.logger ??
      createLogger({
        minLevel: this.logLevel,
        sink: (level, line) => {
          if (level === "error") console.error(line)
          else console.log(line)
        },
      })
    this.workflowId = deps.workflowId ?? "default"
    this.workflowName = deps.workflowName ?? "WORKFLOW.md"
    this.logRepository = deps.storage?.logs
    const subSystemLog = (line: string) => this.logger.debug(line)
    this.tracker = deps.tracker ?? createTrackerClient(config.tracker, template, subSystemLog)
    this.runner = deps.runner ?? createRunner(config)
    this.ensureWorkspaceFn =
      deps.ensureWorkspace ??
      ((issue, workspaceConfig) => ensureWorkspace(issue, workspaceConfig, { onLog: subSystemLog }))
    this.runHookFn =
      deps.runHook ??
      ((script, cwd, timeoutMs, failOnError) =>
        runHook(script, cwd, timeoutMs, failOnError, subSystemLog))
    this.resolveRuntimeConfigFn = deps.resolveRuntimeConfig ?? resolveIssueRuntimeConfig
    this.renderPromptFn = deps.renderPrompt ?? renderPrompt
    this.claimIssue = deps.claimIssue ?? (() => true)
    this.releaseIssue = deps.releaseIssue ?? (() => {})
    this.appendAgentLog = deps.appendAgentLog ?? appendAgentLogImpl
    this.updateItemDescription =
      deps.updateItemDescription ??
      ((issue, description) =>
        this.tracker.updateItemDescription?.(issue, description) ?? Promise.resolve())
    this.fetchIssueDescription =
      deps.fetchIssueDescription ??
      ((issue) => this.tracker.fetchIssueDescription?.(issue) ?? Promise.resolve(issue.description))
  }

  getState(): OrchestratorState {
    return this.state
  }

  getIssueLogs(issueId: string, limit = 100): LogRecord[] {
    if (!this.logRepository) return []
    return this.logRepository.loadRecent(this.workflowId, issueId, limit)
  }

  reloadConfig(config: ServiceConfig, template: string): void {
    this.config = config
    this.template = template
    this.state.updateConfig(config)
    this.tracker = createTrackerClient(config.tracker, template, (line) => this.logger.debug(line))
    this.runner = createRunner(config)
  }

  shutdown(): void {
    this.stopped = true
  }

  stopIssue(issueId: string): void {
    if (this.state.running.has(issueId)) {
      this.state.release(issueId)
    }
    this.state.markStopped(issueId)
  }

  async cancelIssue(issueId: string): Promise<void> {
    const entry = this.state.running.get(issueId)
    if (!entry) return

    await this.runner.cancelRun(entry.sessionId ?? issueId)

    await this.finalizeIssueState(entry.issue, {
      status: "failed",
      error: "cancelled",
      responseText: null,
    })

    this.state.release(issueId, {
      status: "failed",
      error: "cancelled",
      finishedAt: new Date().toISOString(),
    })
    this.releaseIssue(issueId)
  }

  async startupCleanup(): Promise<void> {
    this.state.restoreFromStorage()
  }

  async refresh(): Promise<void> {
    if (this.stopped) {
      return
    }

    this.state.processDueRetries()

    await this.reconcileRunning()
    if (this.stopped) {
      return
    }

    await this.runner.sweep()
    if (this.stopped) {
      return
    }

    this.logger.debug("tracker fetchCandidateIssues start")
    const rawCandidates = await this.tracker.fetchCandidateIssues(this.config.work.activeStates)
    if (this.stopped) {
      return
    }

    this.logger.debug(`tracker fetchCandidateIssues done count=${rawCandidates.length}`)

    const ifTemplate = this.config.work.if
    const candidates: Issue[] = []
    for (const issue of rawCandidates) {
      const ok = await evaluateIfCondition(ifTemplate, issue, null)
      if (ok) {
        candidates.push(issue)
      } else {
        this.logger.debug(`dispatch skipped issue=${issue.identifier} reason=if_condition`)
      }
    }

    const dispatchable = this.state.dispatchable(candidates, this.tracker)
    this.logger.debug(
      `refresh candidates=${candidates.length} dispatchable=${dispatchable.length} running=${this.state.running.size} retrying=${this.state.retryAttempts.size}`,
    )
    if (dispatchable.length === 0) {
      this.logger.debug("idle no dispatchable issues")
    }
    for (const issue of dispatchable) {
      if (this.stopped) {
        break
      }
      if (!this.claimIssue(issue.id)) {
        this.logger.debug(`dispatch skipped issue=${issue.identifier} reason=claimed_elsewhere`)
        continue
      }
      const promise = this.dispatch(issue)
      this.pendingDispatches.add(promise)
      void promise
        .catch((error) => {
          this.logger.debug(
            `dispatch unhandled error issue=${issue.identifier} error=${formatError(error)}`,
          )
        })
        .finally(() => this.pendingDispatches.delete(promise))
    }
  }

  async waitForDispatches(): Promise<void> {
    while (this.pendingDispatches.size > 0) {
      await Promise.allSettled([...this.pendingDispatches])
    }
  }

  async reconcileRunning(): Promise<void> {
    if (this.stopped) {
      return
    }

    const ids = [...this.state.running.keys()]
    if (ids.length === 0) {
      this.logger.debug("reconcile running=0")
      await this.pollDispatches()
      return
    }
    const refreshed = await this.tracker.fetchIssueStatesByIds(ids)
    const stopped = this.state.reconcileRunning(refreshed)
    for (const issueId of stopped) {
      this.releaseIssue(issueId)
      this.dispatchContexts.delete(issueId)
    }
    this.logger.info(`reconcile running=${ids.length} refreshed=${refreshed.length}`)

    await this.pollDispatches()
  }

  private async pollDispatches(): Promise<void> {
    const entries = [...this.dispatchContexts.entries()]
    for (const [issueId, ctx] of entries) {
      if (!this.state.running.has(issueId)) {
        this.dispatchContexts.delete(issueId)
        continue
      }
      let pollResult: RunnerPollResult
      try {
        pollResult = await this.runner.pollCompletion(ctx.handle)
      } catch (error) {
        pollResult = {
          state: "done" as const,
          result: {
            status: "failed" as const,
            error: formatError(error),
            responseText: null,
          },
        }
      }
      if (pollResult.state === "running") {
        continue
      }
      this.dispatchContexts.delete(issueId)
      await this.finalizeCompletion(issueId, ctx, pollResult.result)
    }
  }

  private async finalizeCompletion(
    issueId: string,
    ctx: DispatchContext,
    result: RunnerResult,
  ): Promise<void> {
    if (!this.state.running.has(issueId)) {
      return
    }

    const { issue, runtimeConfig, workspace } = ctx
    const finalizedIssue = await this.finalizeIssueState(runtimeConfig.issue, result)

    if (result.status === "succeeded" && result.responseText) {
      const reporters = this.config.work.reporter ?? ["file"]

      if (reporters.includes("file")) {
        try {
          await this.appendAgentLog(workspace.path, result.responseText)
        } catch (e) {
          this.logger.warn(
            `appendAgentLog failed issue=${issue.identifier} error=${formatError(e)}`,
          )
        }
      }

      if (reporters.includes("tracker")) {
        try {
          const freshDescription = await this.fetchIssueDescription(finalizedIssue)
          const timestamp = new Date().toISOString()
          const updatedDescription = appendAgentLogToDescription(
            freshDescription,
            this.workflowName,
            timestamp,
            result.responseText,
          )
          await this.updateItemDescription(finalizedIssue, updatedDescription)
        } catch (e) {
          this.logger.warn(
            `updateItemDescription failed issue=${issue.identifier} error=${formatError(e)}`,
          )
        }
      }
    }

    this.state.release(issueId, {
      status: result.status,
      error: result.error,
      finishedAt: new Date().toISOString(),
    })
    this.releaseIssue(issueId)

    this.logger.debug(
      `runner done issue=${issue.identifier} status=${result.status} error=${result.error ?? "none"}`,
    )
    this.persistLog(
      finalizedIssue.id,
      finalizedIssue.identifier,
      "done",
      `status=${result.status}${result.error ? ` error=${result.error}` : ""}`,
    )
    this.logger.info(`done ${finalizedIssue.identifier} status=${result.status}`)

    if (this.config.hooks.afterRun) {
      this.logger.debug(`hook after_run start cwd=${workspace.path}`)
      await this.runHookFn(
        this.config.hooks.afterRun,
        workspace.path,
        this.config.hooks.timeoutMs,
        false,
      )
      this.logger.debug(`hook after_run done cwd=${workspace.path}`)
    }
  }

  private async dispatch(issue: Issue): Promise<void> {
    if (this.stopped) {
      return
    }

    let runningIssue = issue
    try {
      runningIssue = await this.moveToRunningState(issue)
      this.state.markRunning(runningIssue, null, null)
      this.logger.info(`start ${runningIssue.identifier} state=${runningIssue.state}`)
      this.persistLog(
        runningIssue.id,
        runningIssue.identifier,
        "start",
        `state=${runningIssue.state}`,
      )

      const runtimeConfig = await this.resolveRuntimeConfigFn(runningIssue, this.config.work, null)
      this.logger.debug(
        `runtime resolved issue=${runtimeConfig.issue.identifier} runner=${runtimeConfig.runner.kind} workspaceProvider=${runtimeConfig.workspace.provider}`,
      )
      const workspace = await this.ensureWorkspaceFn(runtimeConfig.issue, runtimeConfig.workspace)
      this.state.setWorkspacePath(issue.id, workspace.path)
      this.logger.debug(
        `workspace ready path=${workspace.path} createdNow=${workspace.createdNow} branch=${workspace.branch ?? "none"}`,
      )
      if (this.config.hooks.beforeRun) {
        this.logger.debug(`hook before_run start cwd=${workspace.path}`)
        await this.runHookFn(
          this.config.hooks.beforeRun,
          workspace.path,
          this.config.hooks.timeoutMs,
          true,
        )
        this.logger.debug(`hook before_run done cwd=${workspace.path}`)
      }

      const content = await this.renderPromptFn(this.template, runtimeConfig.issue, null)
      let agmsg:
        | {
            team: string
            orchestratorAgent: string
          }
        | undefined
      let reportPath: string | undefined
      let finalContent = content

      if (runtimeConfig.runner.agent === "claude") {
        const messenger = runtimeConfig.runner.claude.messenger
        if (messenger === "report_file") {
          reportPath = join(workspace.path, ".herdr-symphony-report.json")
          await rm(reportPath, { force: true })
          finalContent = `${content}${CLAUDE_REPORT_INSTRUCTION}`
        } else {
          agmsg = { team: "herdr-symphony", orchestratorAgent: "herdr-symphony" }
        }
      } else if (runtimeConfig.runner.opencode.interactive) {
        reportPath = join(workspace.path, ".herdr-symphony-report.json")
        await rm(reportPath, { force: true })
        finalContent = `${content}${CLAUDE_REPORT_INSTRUCTION}`
      }

      const runnerTimeoutMs = runtimeConfig.runner.turnTimeoutMs
      const runnerAgent = runtimeConfig.runner.opencode.agent
      const runnerModel =
        runtimeConfig.runner.agent === "claude"
          ? runtimeConfig.runner.claude.model
          : runtimeConfig.runner.opencode.model
      const runnerPermissionMode =
        runtimeConfig.runner.agent === "claude" ? runtimeConfig.runner.claude.permissionMode : null
      const runnerOnBlocked = runtimeConfig.runner.onBlocked
      this.logger.info(
        `runner start kind=${runtimeConfig.runner.kind} workspace=${workspace.path}` +
          (runnerAgent ? ` agent=${runnerAgent}` : "") +
          (runnerModel ? ` model=${runnerModel}` : ""),
      )
      const handle = await this.runner.startIssue(runtimeConfig.issue, {
        content: finalContent,
        attempt: null,
        workspacePath: workspace.path,
        agentKind: runtimeConfig.runner.agent,
        agent: runnerAgent,
        model: runnerModel,
        permissionMode: runnerPermissionMode,
        onBlocked: runnerOnBlocked,
        timeoutMs: runnerTimeoutMs,
        closePaneAfterDoneMs: runtimeConfig.runner.closePaneAfterDoneMs,
        workflowName: this.workflowName,
        interactive: runtimeConfig.runner.opencode.interactive,
        agmsg,
        reportPath,
        reminderGracePeriodMs: runtimeConfig.runner.claude.reminderGracePeriodMs,
        onEvent: (event) => {
          this.state.markEvent(issue.id)
          const message = "message" in event ? event.message : event.event
          this.logger.info(this.formatEventLog(runningIssue.identifier, event.event, message))
        },
      })

      this.state.setSessionId(issue.id, handle.sessionId)
      this.dispatchContexts.set(issue.id, {
        handle,
        issue: runningIssue,
        runtimeConfig,
        workspace,
        reportPath,
      })

      this.logger.debug(
        `dispatch started issue=${runningIssue.identifier} sessionId=${handle.sessionId}`,
      )
    } catch (error) {
      const errorMessage = formatError(error)
      this.logger.warn(`dispatch error issue=${issue.identifier} error=${errorMessage}`)
      this.persistLog(runningIssue.id, runningIssue.identifier, "retry", `error=${errorMessage}`)
      const retry = this.state.scheduleFailureRetry(runningIssue, 1, errorMessage)
      this.releaseIssue(retry.issueId)
    }
  }

  private async moveToRunningState(issue: Issue): Promise<Issue> {
    if (!this.config.work.runningState) {
      return issue
    }

    this.logger.debug(
      `tracker moveIssueToState start issue=${issue.id} state=${this.config.work.runningState}`,
    )
    await this.tracker.moveIssueToState(issue.id, this.config.work.runningState)
    this.logger.debug(
      `tracker moveIssueToState done issue=${issue.id} state=${this.config.work.runningState}`,
    )
    return {
      ...issue,
      state: this.config.work.runningState,
      fields: {
        ...issue.fields,
        Status: this.config.work.runningState,
      },
    }
  }

  private async finalizeIssueState(issue: Issue, result: RunnerResult): Promise<Issue> {
    const targetState =
      result.status === "succeeded" ? this.config.work.successState : this.config.work.failureState
    if (!targetState) {
      return issue
    }

    try {
      this.logger.debug(`tracker moveIssueToState start issue=${issue.id} state=${targetState}`)
      await this.tracker.moveIssueToState(issue.id, targetState)
      this.logger.debug(`tracker moveIssueToState done issue=${issue.id} state=${targetState}`)
      return {
        ...issue,
        state: targetState,
        fields: {
          ...issue.fields,
          Status: targetState,
        },
      }
    } catch (error) {
      this.logger.debug(
        `tracker moveIssueToState failed issue=${issue.id} state=${targetState} error=${formatError(error)}`,
      )
      return issue
    }
  }

  private formatEventLog(identifier: string, event: string, message?: string): string {
    if (!message) {
      return `${identifier}: ${event}`
    }
    return this.prefixMultiline(identifier, `[${event}] ${message}`)
  }

  private prefixMultiline(identifier: string, message: string): string {
    const prefix = `[${identifier}] `
    const lines = message.split("\n")
    if (lines.length === 1) {
      return `${prefix}${message}`
    }
    const continuation = " ".repeat(prefix.length)
    return lines.map((line, i) => (i === 0 ? prefix : continuation) + line).join("\n")
  }

  private persistLog(
    issueId: string,
    issueIdentifier: string,
    kind: string,
    message: string,
  ): void {
    if (!this.logRepository) return
    this.logRepository.append({
      workflowKey: this.workflowId,
      issueId,
      issueIdentifier,
      kind,
      message,
      timestamp: new Date().toISOString(),
    })
  }
}
