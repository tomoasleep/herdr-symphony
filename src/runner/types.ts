import type { Issue } from "../domain/types"

export type RunnerEvent =
  | { event: "stdout"; timestamp: string; message: string }
  | { event: "agent_started"; timestamp: string; agentName: string; workspaceId: string }
  | { event: "agent_status"; timestamp: string; state: string }

export type RunnerResult = {
  status: "succeeded" | "failed" | "timeout"
  error: string | null
  responseText: string | null
}

export type RunnerOptions = {
  content: string
  attempt: number | null
  workspacePath: string
  agentKind: "opencode" | "claude"
  agent?: string | null
  model?: string | null
  permissionMode?: string | null
  onBlocked?: "continue" | "fail" | null
  timeoutMs?: number | null
  closePaneAfterDoneMs?: number | null
  workflowName?: string
  interactive?: boolean
  agmsg?: {
    team: string
    orchestratorAgent: string
    handshakeTimeoutMs?: number
    ackResendIntervalMs?: number
    reminderAckDeadlineMs?: number
  }
  reportPath?: string
  pendingRemindIntervalMs?: number
  reminderGracePeriodMs?: number
  env?: Record<string, string>
  onEvent?: (event: RunnerEvent) => void
}

export type RunnerHandle = {
  sessionId: string
  issueId: string
}

export type RunnerPollResult = { state: "running" } | { state: "done"; result: RunnerResult }

export type Runner = {
  startIssue(issue: Issue, options: RunnerOptions): Promise<RunnerHandle>
  pollCompletion(handle: RunnerHandle): Promise<RunnerPollResult>
  cancelRun(target: string): Promise<void>
  sweep(): Promise<void>
}
