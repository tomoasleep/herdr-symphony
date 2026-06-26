export type BlockerRef = {
  id: string | null
  identifier: string | null
  state: string | null
}

export type Issue = {
  id: string
  identifier: string
  title: string
  description: string | null
  priority: number | null
  state: string
  repository: string | null
  fields: Record<string, string | null>
  url: string | null
  labels: string[]
  blockedBy: BlockerRef[]
  createdAt: string | null
  updatedAt: string | null
  issueNodeId?: string | null
  scheduledAt?: string | null
}

export type WorkflowDefinition = {
  config: Record<string, unknown>
  promptTemplate: string
}

export type GitHubProjectTrackerConfig = {
  owner: string
  number: number
}

export type FileTrackerConfig = {
  baseDir: string
}

export type ScheduleTrackerConfig = {
  cron: string
}

export type TrackerConfig = {
  kind: string
  github_project: GitHubProjectTrackerConfig | null
  file: FileTrackerConfig | null
  schedule: ScheduleTrackerConfig | null
}

export type PollingConfig = {
  intervalMs: number
}

export type HookConfig = {
  beforeRun: string | null
  afterRun: string | null
  timeoutMs: number
}

export type AgentConfig = {
  maxConcurrentAgents: number
  maxRetryBackoffMs: number
  maxConcurrentAgentsByState: Record<string, number>
}

export type HerdrAgentOpencodeConfig = {
  model: string | null
  agent: string | null
}

export type HerdrAgentClaudeConfig = {
  model: string | null
}

export type HerdrAgentConfig = {
  agent: "opencode" | "claude"
  opencode: HerdrAgentOpencodeConfig
  claude: HerdrAgentClaudeConfig
  workspaceLabel: string | null
  turnTimeoutMs: number | null
}

export type GwqWorkspaceConfig = {
  command: string
  createBranch: boolean
}

export type WorkspaceConfig = {
  provider: "git" | "gwq"
  reuseExisting: boolean
  createIfMissing: boolean
  branch: string | null
  path: string | null
  baseDir: string | null
  repository: string | null
  gwq: GwqWorkspaceConfig
}

export type ResolvedHerdrAgentRunnerConfig = {
  kind: "herdr_agent"
  agent: "opencode" | "claude"
  opencode: { model: string | null; agent: string | null }
  claude: { model: string | null }
  workspaceLabel: string | null
  turnTimeoutMs: number | null
}

export type ResolvedRunnerConfig = ResolvedHerdrAgentRunnerConfig

export type ResolvedIssueRuntimeConfig = {
  issue: Issue
  workspace: WorkspaceConfig
  runner: ResolvedRunnerConfig
}

export type WorkConfig = {
  activeStates: string[]
  terminalStates: string[]
  runningState: string | null
  successState: string | null
  failureState: string | null
  stoppedState: string | null
  runner: string | null
  herdrAgent: HerdrAgentConfig
  workspace: WorkspaceConfig
  reporter?: ("file" | "tracker")[]
}

export type ServiceConfig = {
  tracker: TrackerConfig
  polling: PollingConfig
  hooks: HookConfig
  agent: AgentConfig
  work: WorkConfig
}

export type RetryEntry = {
  issueId: string
  identifier: string
  attempt: number
  dueAtMs: number
  error: string | null
}
