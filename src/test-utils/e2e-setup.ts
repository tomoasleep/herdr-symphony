import { execSync } from "node:child_process"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { ServiceConfig } from "../domain/types"

export type TrackerIssue = {
  id: string
  identifier: string
  title: string
  body: string
}

export async function prepareTrackerDir(baseDir: string, issue: TrackerIssue): Promise<string> {
  const trackerDir = join(baseDir, `herdr-symphony-e2e-tracker-${issue.id}`)
  await rm(trackerDir, { recursive: true, force: true })
  await mkdir(join(trackerDir, "Ready"), { recursive: true })
  await writeFile(
    join(trackerDir, "Ready", `${issue.id}.md`),
    ["---", `identifier: ${issue.identifier}`, `title: ${issue.title}`, "---", issue.body, ""].join(
      "\n",
    ),
  )
  return trackerDir
}

export async function prepareWorkspace(baseDir: string, key: string): Promise<string> {
  const workspacePath = join(baseDir, `herdr-symphony-e2e-workspace-${key}`)
  await rm(workspacePath, { recursive: true, force: true })
  await mkdir(workspacePath, { recursive: true })
  execSync("git init", { cwd: workspacePath, stdio: "pipe" })
  execSync('git config user.email "test@test.com"', { cwd: workspacePath, stdio: "pipe" })
  execSync('git config user.name "Test"', { cwd: workspacePath, stdio: "pipe" })
  return workspacePath
}

export function makeOpencodeServiceConfig(trackerDir: string): ServiceConfig {
  return {
    tracker: {
      kind: "file",
      github_project: null,
      file: { baseDir: trackerDir },
      schedule: null,
    },
    polling: { intervalMs: 30_000 },
    hooks: { beforeRun: null, afterRun: null, timeoutMs: 60_000 },
    agent: {
      maxConcurrentAgents: 1,
      maxRetryBackoffMs: 300_000,
      maxConcurrentAgentsByState: {},
    },
    work: {
      activeStates: ["Ready"],
      terminalStates: ["Done"],
      runningState: null,
      successState: "Done",
      failureState: null,
      stoppedState: null,
      runner: "herdr_agent",
      herdrAgent: {
        agent: "opencode",
        opencode: { model: "mock/agent-model", agent: null },
        claude: {
          model: null,
          permissionMode: null,
          messenger: "agmsg",
          pendingRemindIntervalMs: 900_000,
          reminderGracePeriodMs: 180_000,
        },
        workspaceLabel: null,
        turnTimeoutMs: 60_000,
        onBlocked: null,
      },
      workspace: {
        provider: "git",
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
  }
}

export function makeClaudeServiceConfig(
  trackerDir: string,
  opts: { messenger?: "agmsg" | "report_file" } = {},
): ServiceConfig {
  const messenger = opts.messenger ?? "agmsg"
  return {
    tracker: {
      kind: "file",
      github_project: null,
      file: { baseDir: trackerDir },
      schedule: null,
    },
    polling: { intervalMs: 30_000 },
    hooks: { beforeRun: null, afterRun: null, timeoutMs: 60_000 },
    agent: {
      maxConcurrentAgents: 1,
      maxRetryBackoffMs: 300_000,
      maxConcurrentAgentsByState: {},
    },
    work: {
      activeStates: ["Ready"],
      terminalStates: ["Done"],
      runningState: null,
      successState: "Done",
      failureState: null,
      stoppedState: null,
      runner: "herdr_agent",
      herdrAgent: {
        agent: "claude",
        opencode: { model: null, agent: null },
        claude: {
          model: null,
          permissionMode: null,
          messenger,
          pendingRemindIntervalMs: 900_000,
          reminderGracePeriodMs: 180_000,
        },
        workspaceLabel: null,
        turnTimeoutMs: 120_000,
        onBlocked: null,
      },
      workspace: {
        provider: "git",
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
  }
}
