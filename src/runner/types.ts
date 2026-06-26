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
  onEvent?: (event: RunnerEvent) => void
}

export type Runner = {
  runIssue(issue: Issue, options: RunnerOptions): Promise<RunnerResult>
  cancelRun(target: string): Promise<void>
}
