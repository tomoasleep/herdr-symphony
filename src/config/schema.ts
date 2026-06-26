import { z } from "zod"
import { ErrorCode, WorkflowError } from "../domain/errors"
import type { ServiceConfig } from "../domain/types"
import { normalizeState, parseList, toInt } from "../utils/normalize"

function normalizePerState(input: unknown): Record<string, number> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return {}
  }

  const entries = Object.entries(input)
  const output: Record<string, number> = {}

  for (const [state, value] of entries) {
    const parsed = toInt(value, -1)
    if (parsed > 0) {
      output[normalizeState(state)] = parsed
    }
  }

  return output
}

function normalizeOptionalString(input: unknown): string | null {
  if (typeof input !== "string") {
    return null
  }

  const value = input.trim()
  return value.length > 0 ? value : null
}

function normalizeReporter(input: unknown): ("file" | "tracker")[] {
  if (!Array.isArray(input)) {
    return ["file"]
  }

  const validValues: ("file" | "tracker")[] = []
  for (const item of input) {
    if (item === "file" || item === "tracker") {
      if (!validValues.includes(item)) {
        validValues.push(item)
      }
    }
  }

  return validValues.length > 0 ? validValues : ["file"]
}

const GitHubProjectTrackerSchema = z.object({
  owner: z.string().transform((v) => v.trim()),
  number: z.union([z.number(), z.string()]).transform((v) => Math.trunc(Number(v))),
})

const FileTrackerSchema = z.object({
  base_dir: z.string(),
})

const ScheduleTrackerSchema = z.object({
  cron: z.string(),
})

const TrackerSchema = z.object({
  kind: z.string().transform((v) => v.trim()),
  github_project: GitHubProjectTrackerSchema.optional(),
  file: FileTrackerSchema.optional(),
  schedule: ScheduleTrackerSchema.optional(),
})

const PollingSchema = z
  .object({
    interval_ms: z.union([z.number(), z.string()]).optional(),
  })
  .optional()

const HooksSchema = z
  .object({
    before_run: z.string().optional(),
    after_run: z.string().optional(),
    timeout_ms: z.union([z.number(), z.string()]).optional(),
  })
  .optional()

const AgentSchema = z
  .object({
    max_concurrent_agents: z.union([z.number(), z.string()]).optional(),
    max_retry_backoff_ms: z.union([z.number(), z.string()]).optional(),
    max_concurrent_agents_by_state: z.record(z.string(), z.unknown()).optional(),
  })
  .optional()

const GwqWorkspaceConfigSchema = z.object({
  command: z.union([z.string(), z.undefined()]).transform((v) => (v ? v.trim() : "gwq") || "gwq"),
  create_branch: z.boolean().optional(),
})

const WorkspaceSchema = z.object({
  provider: z.string().optional(),
  reuse_existing: z.boolean().optional(),
  create_if_missing: z.boolean().optional(),
  branch: z.string().optional().nullable(),
  path: z.string().optional().nullable(),
  base_dir: z.string().optional().nullable(),
  repository: z.string().optional().nullable(),
  gwq: GwqWorkspaceConfigSchema.optional(),
})

const HerdrAgentOpencodeSchema = z.object({
  model: z.string().optional().nullable(),
  agent: z.string().optional().nullable(),
})

const HerdrAgentClaudeSchema = z.object({
  model: z.string().optional().nullable(),
})

const HerdrAgentSchema = z.object({
  agent: z.enum(["opencode", "claude"]),
  opencode: HerdrAgentOpencodeSchema.optional(),
  claude: HerdrAgentClaudeSchema.optional(),
  workspace_label: z.string().optional().nullable(),
  turn_timeout_ms: z.union([z.number(), z.string(), z.null()]).optional().nullable(),
})

const WorkSchema = z.object({
  active_states: z.union([z.string(), z.array(z.string())]).optional(),
  terminal_states: z.union([z.string(), z.array(z.string())]).optional(),
  running_state: z.string().optional().nullable(),
  success_state: z.string().optional().nullable(),
  failure_state: z.string().optional().nullable(),
  stopped_state: z.string().optional().nullable(),
  runner: z.string().optional(),
  herdr_agent: HerdrAgentSchema.optional(),
  workspace: WorkspaceSchema.optional(),
  reporter: z.array(z.unknown()).optional(),
})

export const WorkflowConfigSchema = z.object({
  tracker: TrackerSchema,
  polling: PollingSchema,
  hooks: HooksSchema,
  agent: AgentSchema,
  work: WorkSchema.optional(),
})

export type RawWorkflowConfig = z.infer<typeof WorkflowConfigSchema>

export function resolveConfigFromSchema(input: unknown): ServiceConfig {
  const parsed = WorkflowConfigSchema.parse(input)

  const tracker = parsed.tracker
  const polling = parsed.polling ?? {}
  const hooks = parsed.hooks ?? {}
  const agent = parsed.agent ?? {}
  const work = parsed.work ?? {}

  const trackerKind = normalizeOptionalString(tracker.kind) ?? ""
  const githubProject = tracker.github_project
  const fileTracker = tracker.file
  const scheduleTracker = tracker.schedule

  const herdrAgentRaw = work.herdr_agent
  const turnTimeoutMs =
    herdrAgentRaw?.turn_timeout_ms === undefined || herdrAgentRaw?.turn_timeout_ms === null
      ? null
      : Math.max(toInt(herdrAgentRaw.turn_timeout_ms, 3_600_000), 1_000)

  const config: ServiceConfig = {
    tracker: {
      kind: trackerKind,
      github_project:
        trackerKind === "github_project" && githubProject
          ? {
              owner: githubProject.owner,
              number: githubProject.number,
            }
          : null,
      file:
        trackerKind === "file" && fileTracker
          ? {
              baseDir: fileTracker.base_dir,
            }
          : null,
      schedule:
        trackerKind === "schedule" && scheduleTracker
          ? {
              cron: scheduleTracker.cron,
            }
          : null,
    },
    polling: {
      intervalMs: toInt(polling.interval_ms, 30_000),
    },
    hooks: {
      beforeRun: typeof hooks.before_run === "string" ? hooks.before_run : null,
      afterRun: typeof hooks.after_run === "string" ? hooks.after_run : null,
      timeoutMs: Math.max(toInt(hooks.timeout_ms, 60_000), 1),
    },
    agent: {
      maxConcurrentAgents: Math.max(toInt(agent.max_concurrent_agents, 10), 1),
      maxRetryBackoffMs: Math.max(toInt(agent.max_retry_backoff_ms, 300_000), 1_000),
      maxConcurrentAgentsByState: normalizePerState(agent.max_concurrent_agents_by_state),
    },
    work: {
      activeStates: parseList(work.active_states, ["Backlog", "Ready", "In progress", "In review"]),
      terminalStates: parseList(work.terminal_states, ["Done"]),
      runningState: normalizeOptionalString(work.running_state),
      successState: normalizeOptionalString(work.success_state),
      failureState: normalizeOptionalString(work.failure_state),
      stoppedState: normalizeOptionalString(work.stopped_state),
      runner: normalizeOptionalString(work.runner) ?? "herdr_agent",
      herdrAgent: {
        agent: herdrAgentRaw?.agent ?? "opencode",
        opencode: {
          model:
            typeof herdrAgentRaw?.opencode?.model === "string"
              ? herdrAgentRaw.opencode.model
              : null,
          agent:
            typeof herdrAgentRaw?.opencode?.agent === "string"
              ? herdrAgentRaw.opencode.agent
              : null,
        },
        claude: {
          model:
            typeof herdrAgentRaw?.claude?.model === "string" ? herdrAgentRaw.claude.model : null,
        },
        workspaceLabel: normalizeOptionalString(herdrAgentRaw?.workspace_label),
        turnTimeoutMs,
      },
      workspace: {
        provider:
          typeof work.workspace?.provider === "string"
            ? (work.workspace.provider.trim() as "git" | "gwq")
            : "gwq",
        reuseExisting: work.workspace?.reuse_existing !== false,
        createIfMissing: work.workspace?.create_if_missing !== false,
        branch: typeof work.workspace?.branch === "string" ? work.workspace?.branch : null,
        path: typeof work.workspace?.path === "string" ? work.workspace?.path : null,
        baseDir: typeof work.workspace?.base_dir === "string" ? work.workspace?.base_dir : null,
        repository:
          typeof work.workspace?.repository === "string" ? work.workspace?.repository : null,
        gwq: {
          command: work.workspace?.gwq?.command ?? "gwq",
          createBranch: work.workspace?.gwq?.create_branch !== false,
        },
      },
      reporter: normalizeReporter(work.reporter),
    },
  }

  validateDispatchConfig(config)
  return config
}

export function validateDispatchConfig(config: ServiceConfig): void {
  if (!config.tracker.kind) {
    throw new WorkflowError(ErrorCode.MISSING_TRACKER_KIND, "tracker.kind is required")
  }

  if (config.tracker.kind === "github_project") {
    if (!config.tracker.github_project?.owner) {
      throw new WorkflowError(
        ErrorCode.MISSING_TRACKER_OWNER,
        "tracker.github_project.owner is required",
      )
    }

    if (
      !Number.isInteger(config.tracker.github_project?.number) ||
      (config.tracker.github_project?.number ?? 0) <= 0
    ) {
      throw new WorkflowError(
        ErrorCode.MISSING_TRACKER_NUMBER,
        "tracker.github_project.number is required",
      )
    }
  } else if (config.tracker.kind === "file") {
    if (!config.tracker.file?.baseDir) {
      throw new WorkflowError(
        ErrorCode.MISSING_TRACKER_BASE_DIR,
        "tracker.file.base_dir is required",
      )
    }
  } else if (config.tracker.kind === "schedule") {
    if (!config.tracker.schedule?.cron) {
      throw new WorkflowError(ErrorCode.MISSING_TRACKER_CRON, "tracker.schedule.cron is required")
    }
  } else {
    throw new WorkflowError(
      ErrorCode.UNSUPPORTED_TRACKER_KIND,
      `unsupported tracker: ${config.tracker.kind}`,
    )
  }

  if (config.work.workspace.provider !== "git" && config.work.workspace.provider !== "gwq") {
    throw new WorkflowError(
      ErrorCode.UNSUPPORTED_WORKSPACE_PROVIDER,
      `unsupported workspace provider: ${config.work.workspace.provider}`,
    )
  }

  if (config.work.runner && config.work.runner !== "herdr_agent") {
    throw new WorkflowError(
      ErrorCode.INVALID_FRONT_MATTER,
      `unsupported runner: ${config.work.runner}`,
    )
  }

  if (config.work.herdrAgent.agent !== "opencode" && config.work.herdrAgent.agent !== "claude") {
    throw new WorkflowError(
      ErrorCode.INVALID_FRONT_MATTER,
      `unsupported herdr_agent.agent: ${config.work.herdrAgent.agent}`,
    )
  }
}
