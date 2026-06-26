import type { Issue, ResolvedIssueRuntimeConfig, ServiceConfig } from "./domain/types"
import { OrchestratorState } from "./orchestrator/orchestrator"
import { createRunner } from "./runner/create-runner"
import type { Runner, RunnerResult } from "./runner/types"
import type { LogRecord, LogRepository, Storage } from "./storage/types"
import { createTrackerClient } from "./tracker/create-tracker-client"
import type { IssueTrackerClient } from "./tracker/types"
import { appendAgentLog as appendAgentLogImpl } from "./utils/append-agent-log"
import { appendAgentLogToDescription } from "./utils/append-agent-log-to-description"
import { formatError } from "./utils/error"
import { resolveIssueRuntimeConfig } from "./workflow/render-frontmatter"
import { renderPrompt } from "./workflow/render-prompt"
import type { WorkspaceResult } from "./workspace/workspace-manager"
import { ensureWorkspace, runHook } from "./workspace/workspace-manager"

type ServiceDependencies = {
  tracker?: IssueTrackerClient
  runner?: Runner
  writeLog?: (line: string) => void
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
  private readonly writeLog: (line: string) => void
  private readonly logRepository: LogRepository | undefined
  private stopped = false
  private readonly pendingDispatches = new Set<Promise<void>>()

  private config: ServiceConfig
  private template: string

  constructor(config: ServiceConfig, template: string, deps: ServiceDependencies = {}) {
    this.config = config
    this.template = template
    this.state = new OrchestratorState(config, deps.storage, deps.workflowId)
    this.writeLog = deps.writeLog ?? ((line: string) => console.log(line))
    this.workflowId = deps.workflowId ?? "default"
    this.workflowName = deps.workflowName ?? "WORKFLOW.md"
    this.logRepository = deps.storage?.logs
    this.tracker = deps.tracker ?? createTrackerClient(config.tracker, template, this.writeLog)
    this.runner = deps.runner ?? createRunner(config)
    this.ensureWorkspaceFn =
      deps.ensureWorkspace ??
      ((issue, workspaceConfig) =>
        ensureWorkspace(issue, workspaceConfig, { onLog: this.writeLog }))
    this.runHookFn =
      deps.runHook ??
      ((script, cwd, timeoutMs, failOnError) =>
        runHook(script, cwd, timeoutMs, failOnError, this.writeLog))
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
    this.tracker = createTrackerClient(config.tracker, template, this.writeLog)
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

    this.debugLog("tracker fetchCandidateIssues start")
    const candidates = await this.tracker.fetchCandidateIssues()
    if (this.stopped) {
      return
    }

    this.debugLog(`tracker fetchCandidateIssues done count=${candidates.length}`)
    const dispatchable = this.state.dispatchable(candidates, this.tracker)
    this.debugLog(
      `refresh candidates=${candidates.length} dispatchable=${dispatchable.length} running=${this.state.running.size} retrying=${this.state.retryAttempts.size}`,
    )
    if (dispatchable.length === 0) {
      this.debugLog("idle no dispatchable issues")
    }
    for (const issue of dispatchable) {
      if (this.stopped) {
        break
      }
      if (!this.claimIssue(issue.id)) {
        this.debugLog(`dispatch skipped issue=${issue.identifier} reason=claimed_elsewhere`)
        continue
      }
      const promise = this.dispatch(issue)
      this.pendingDispatches.add(promise)
      void promise.finally(() => this.pendingDispatches.delete(promise))
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
      this.debugLog("reconcile running=0")
      return
    }
    const refreshed = await this.tracker.fetchIssueStatesByIds(ids)
    const stopped = this.state.reconcileRunning(refreshed)
    for (const issueId of stopped) {
      this.releaseIssue(issueId)
    }
    this.debugLog(`reconcile running=${ids.length} refreshed=${refreshed.length}`)
  }

  private async dispatch(issue: Issue): Promise<void> {
    if (this.stopped) {
      return
    }

    let runningIssue = issue
    try {
      runningIssue = await this.moveToRunningState(issue)
      this.state.markRunning(runningIssue, null, null)
      this.writeLog(`start ${runningIssue.identifier} state=${runningIssue.state}`)
      this.persistLog(
        runningIssue.id,
        runningIssue.identifier,
        "start",
        `state=${runningIssue.state}`,
      )

      const runtimeConfig = await this.resolveRuntimeConfigFn(runningIssue, this.config.work, null)
      this.debugLog(
        `runtime resolved issue=${runtimeConfig.issue.identifier} runner=${runtimeConfig.runner.kind} workspaceProvider=${runtimeConfig.workspace.provider}`,
      )
      const workspace = await this.ensureWorkspaceFn(runtimeConfig.issue, runtimeConfig.workspace)
      this.state.setWorkspacePath(issue.id, workspace.path)
      this.debugLog(
        `workspace ready path=${workspace.path} createdNow=${workspace.createdNow} branch=${workspace.branch ?? "none"}`,
      )
      if (this.config.hooks.beforeRun) {
        this.debugLog(`hook before_run start cwd=${workspace.path}`)
        await this.runHookFn(
          this.config.hooks.beforeRun,
          workspace.path,
          this.config.hooks.timeoutMs,
          true,
        )
        this.debugLog(`hook before_run done cwd=${workspace.path}`)
      }

      try {
        const content = await this.renderPromptFn(this.template, runtimeConfig.issue, null)
        const runnerTimeoutMs = runtimeConfig.runner.turnTimeoutMs
        const runnerAgent = runtimeConfig.runner.opencode.agent
        const runnerModel =
          runtimeConfig.runner.agent === "claude"
            ? runtimeConfig.runner.claude.model
            : runtimeConfig.runner.opencode.model
        const runnerPermissionMode =
          runtimeConfig.runner.agent === "claude"
            ? runtimeConfig.runner.claude.permissionMode
            : null
        this.debugLog(
          `runner start kind=${runtimeConfig.runner.kind} workspace=${workspace.path}` +
            (runnerAgent ? ` agent=${runnerAgent}` : "") +
            (runnerModel ? ` model=${runnerModel}` : ""),
        )
        const result = await this.runner.runIssue(runtimeConfig.issue, {
          content,
          attempt: null,
          workspacePath: workspace.path,
          agentKind: runtimeConfig.runner.agent,
          agent: runnerAgent,
          model: runnerModel,
          permissionMode: runnerPermissionMode,
          timeoutMs: runnerTimeoutMs,
          onEvent: (event) => {
            this.state.markEvent(issue.id)
            const message = "message" in event ? event.message : event.event
            this.writeLog(this.formatEventLog(runningIssue.identifier, event.event, message))
          },
        })

        if (!this.state.running.has(issue.id)) {
          return
        }

        const finalizedIssue = await this.finalizeIssueState(runtimeConfig.issue, result)

        if (result.status === "succeeded" && result.responseText) {
          const reporters = this.config.work.reporter ?? ["file"]

          if (reporters.includes("file")) {
            try {
              await this.appendAgentLog(workspace.path, result.responseText)
            } catch (e) {
              this.debugLog(
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
              this.debugLog(
                `updateItemDescription failed issue=${issue.identifier} error=${formatError(e)}`,
              )
            }
          }
        }

        this.state.release(issue.id, {
          status: result.status,
          error: result.error,
          finishedAt: new Date().toISOString(),
        })
        this.releaseIssue(issue.id)

        this.debugLog(
          `runner done issue=${issue.identifier} status=${result.status} error=${result.error ?? "none"}`,
        )
        this.persistLog(
          finalizedIssue.id,
          finalizedIssue.identifier,
          "done",
          `status=${result.status}${result.error ? ` error=${result.error}` : ""}`,
        )
        this.writeLog(`done ${finalizedIssue.identifier} status=${result.status}`)
      } finally {
        if (this.config.hooks.afterRun) {
          this.debugLog(`hook after_run start cwd=${workspace.path}`)
          await this.runHookFn(
            this.config.hooks.afterRun,
            workspace.path,
            this.config.hooks.timeoutMs,
            false,
          )
          this.debugLog(`hook after_run done cwd=${workspace.path}`)
        }
      }
    } catch (error) {
      const errorMessage = formatError(error)
      this.debugLog(`dispatch error issue=${issue.identifier} error=${errorMessage}`)
      this.persistLog(runningIssue.id, runningIssue.identifier, "retry", `error=${errorMessage}`)
      const retry = this.state.scheduleFailureRetry(runningIssue, 1, errorMessage)
      this.releaseIssue(retry.issueId)
    }
  }

  private async moveToRunningState(issue: Issue): Promise<Issue> {
    if (!this.config.work.runningState) {
      return issue
    }

    this.debugLog(
      `tracker moveIssueToState start issue=${issue.id} state=${this.config.work.runningState}`,
    )
    await this.tracker.moveIssueToState(issue.id, this.config.work.runningState)
    this.debugLog(
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
      this.debugLog(`tracker moveIssueToState start issue=${issue.id} state=${targetState}`)
      await this.tracker.moveIssueToState(issue.id, targetState)
      this.debugLog(`tracker moveIssueToState done issue=${issue.id} state=${targetState}`)
      return {
        ...issue,
        state: targetState,
        fields: {
          ...issue.fields,
          Status: targetState,
        },
      }
    } catch (error) {
      this.debugLog(
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

  private debugLog(line: string): void {
    this.writeLog(line)
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
