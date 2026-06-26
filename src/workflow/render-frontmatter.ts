import { Liquid } from "liquidjs"
import { ErrorCode, WorkflowError } from "../domain/errors"
import type { Issue, ResolvedIssueRuntimeConfig, WorkConfig } from "../domain/types"
import { formatError } from "../utils/error"

const engine = new Liquid({
  strictFilters: true,
  strictVariables: true,
})

export async function renderFrontmatter(
  value: unknown,
  issue: Issue,
  attempt: number | null,
): Promise<unknown> {
  if (typeof value === "string") {
    try {
      return await engine.parseAndRender(value, {
        issue,
        attempt,
        env: process.env,
      })
    } catch (error) {
      throw new WorkflowError(ErrorCode.TEMPLATE_RENDER_ERROR, formatError(error))
    }
  }

  if (Array.isArray(value)) {
    return Promise.all(value.map((entry) => renderFrontmatter(entry, issue, attempt)))
  }

  if (value !== null && typeof value === "object") {
    const entries = await Promise.all(
      Object.entries(value).map(
        async ([key, entry]) => [key, await renderFrontmatter(entry, issue, attempt)] as const,
      ),
    )
    return Object.fromEntries(entries)
  }

  return value
}

export async function resolveIssueConfig(issue: Issue, attempt: number | null): Promise<Issue> {
  const resolved = await resolveIssueRuntimeConfig(
    issue,
    {
      activeStates: [],
      terminalStates: [],
      runningState: null,
      successState: null,
      failureState: null,
      stoppedState: null,
      runner: null,
      herdrAgent: {
        agent: "opencode",
        opencode: { model: null, agent: null },
        claude: { model: null, permissionMode: null },
        workspaceLabel: null,
        turnTimeoutMs: null,
        onBlocked: null,
      },
      workspace: {
        provider: "gwq",
        reuseExisting: true,
        createIfMissing: true,
        branch: null,
        path: null,
        baseDir: null,
        repository: null,
        gwq: { command: "gwq", createBranch: true },
      },
      reporter: ["file"],
    },
    attempt,
  )

  return resolved.issue
}

export async function resolveIssueRuntimeConfig(
  issue: Issue,
  work: WorkConfig,
  attempt: number | null,
): Promise<ResolvedIssueRuntimeConfig> {
  const rendered = (await renderFrontmatter(
    {
      repository: work.workspace.repository,
      opencode: {
        agent: work.herdrAgent.opencode.agent,
        model: work.herdrAgent.opencode.model,
      },
      claude: {
        model: work.herdrAgent.claude.model,
        permissionMode: work.herdrAgent.claude.permissionMode,
      },
      workspaceLabel: work.herdrAgent.workspaceLabel,
      workspace: {
        provider: work.workspace.provider,
        reuseExisting: work.workspace.reuseExisting,
        createIfMissing: work.workspace.createIfMissing,
        branch: work.workspace.branch,
        path: work.workspace.path,
        baseDir: work.workspace.baseDir,
        gwq: {
          command: work.workspace.gwq.command,
          createBranch: work.workspace.gwq.createBranch,
        },
      },
    },
    issue,
    attempt,
  )) as {
    repository: string | null
    opencode: { agent: string | null; model: string | null }
    claude: { model: string | null; permissionMode: string | null }
    workspaceLabel: string | null
    workspace: WorkConfig["workspace"]
  }

  const repository = normalizeOverride(rendered.repository) ?? issue.repository

  return {
    issue: {
      ...issue,
      repository,
    },
    workspace: normalizeWorkspaceConfig(rendered.workspace, work.workspace),
    runner: {
      kind: "herdr_agent",
      agent: work.herdrAgent.agent,
      opencode: {
        agent: normalizeOverride(rendered.opencode.agent),
        model: normalizeOverride(rendered.opencode.model),
      },
      claude: {
        model: normalizeOverride(rendered.claude.model),
        permissionMode: normalizeOverride(rendered.claude.permissionMode),
      },
      workspaceLabel: normalizeOverride(rendered.workspaceLabel),
      turnTimeoutMs: work.herdrAgent.turnTimeoutMs,
      onBlocked: work.herdrAgent.onBlocked,
    },
  }
}

function normalizeOverride(value: string | null | undefined): string | null {
  if (value == null) {
    return null
  }

  const normalized = value.trim()
  return normalized.length > 0 ? normalized : null
}

function normalizeWorkspaceConfig(
  rendered: WorkConfig["workspace"],
  fallback: WorkConfig["workspace"],
): WorkConfig["workspace"] {
  return {
    provider: rendered.provider === "gwq" ? "gwq" : "git",
    reuseExisting: rendered.reuseExisting,
    createIfMissing: rendered.createIfMissing,
    branch: normalizeOverride(rendered.branch),
    path: normalizeOverride(rendered.path),
    baseDir: normalizeOverride(rendered.baseDir),
    repository: normalizeOverride(rendered.repository),
    gwq: {
      command: normalizeOverride(rendered.gwq.command) ?? fallback.gwq.command ?? "gwq",
      createBranch: rendered.gwq.createBranch,
    },
  }
}
