import { afterEach, describe, expect, test } from "bun:test"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Issue, ServiceConfig } from "./domain/types"
import { isActiveState } from "./orchestrator/scheduling"
import type { Runner, RunnerOptions, RunnerResult } from "./runner/types"
import { SymphonyService } from "./service"
import type { IssueTrackerClient } from "./tracker/types"
import type { WorkspaceResult } from "./workspace/workspace-manager"

function makeConfig(overrides: Partial<ServiceConfig["work"]> = {}): ServiceConfig {
  return {
    tracker: {
      kind: "file",
      github_project: null,
      file: { baseDir: "/tmp/issues" },
      schedule: null,
    },
    polling: { intervalMs: 30_000 },
    hooks: { beforeRun: null, afterRun: null, timeoutMs: 60_000 },
    agent: { maxConcurrentAgents: 2, maxRetryBackoffMs: 300_000, maxConcurrentAgentsByState: {} },
    work: {
      activeStates: ["Ready"],
      terminalStates: ["Done"],
      runningState: "In progress",
      successState: "Done",
      failureState: "Blocked",
      stoppedState: null,
      runner: "herdr_agent",
      herdrAgent: {
        agent: "opencode",
        opencode: { model: null, agent: null },
        claude: { model: null, permissionMode: null },
        workspaceLabel: null,
        turnTimeoutMs: 3_600_000,
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
      ...overrides,
    },
  }
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    identifier: "TEST-1",
    title: "Test issue",
    description: "Do something",
    priority: null,
    state: "Ready",
    repository: null,
    fields: {},
    url: null,
    labels: [],
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
    ...overrides,
  }
}

function makeMockRunner(result: Partial<RunnerResult> = {}): Runner {
  return {
    async runIssue(_issue, _options: RunnerOptions): Promise<RunnerResult> {
      return {
        status: "succeeded",
        error: null,
        responseText: "Task done",
        ...result,
      }
    },
    async cancelRun() {},
  }
}

function makeMockTrackerClient(issues: Issue[] = []): IssueTrackerClient {
  const stateMap = new Map<string, string>()
  for (const issue of issues) {
    stateMap.set(issue.id, issue.state)
  }
  return {
    fetchCandidateIssues: async () =>
      issues.map((i) => ({ ...i, state: stateMap.get(i.id) ?? i.state })),
    fetchIssuesByStates: async () => issues,
    fetchIssueStatesByIds: async (ids: string[]) => issues.filter((i) => ids.includes(i.id)),
    moveIssueToState: async (id: string, state: string) => {
      stateMap.set(id, state)
    },
    shouldRun: (issue, activeStates) => isActiveState(issue.state, activeStates),
  }
}

function makeMockWorkspace(
  path: string,
): (issue: Issue, config: ServiceConfig["work"]["workspace"]) => Promise<WorkspaceResult> {
  return async () => ({
    key: "test-1",
    branch: null,
    path,
    repositoryRoot: path,
    createdNow: true,
  })
}

describe("SymphonyService", () => {
  const tmpDirs: string[] = []

  afterEach(() => {
    for (const dir of tmpDirs) {
      rmSync(dir, { recursive: true, force: true })
    }
    tmpDirs.length = 0
  })

  test("dispatch が成功時に success_state へ遷移する", async () => {
    const issue = makeIssue()
    const tracker = makeMockTrackerClient([issue])
    const runner = makeMockRunner()
    const config = makeConfig()

    const logs: string[] = []
    const service = new SymphonyService(config, "Fix the bug.", {
      tracker,
      runner,
      writeLog: (line) => logs.push(line),
      ensureWorkspace: makeMockWorkspace("/tmp/ws-test-1"),
      claimIssue: () => true,
      releaseIssue: () => {},
    })

    await service.refresh()
    await service.waitForDispatches()

    expect(logs.some((l) => l.includes("done TEST-1"))).toBe(true)
    service.shutdown()
  })

  test("dispatch 失敗時に failure_state へ遷移する", async () => {
    const issue = makeIssue()
    const tracker = makeMockTrackerClient([issue])
    const runner = makeMockRunner({ status: "failed", error: "agent error" })
    const config = makeConfig({ failureState: "Blocked" })

    const logs: string[] = []
    const service = new SymphonyService(config, "Fix the bug.", {
      tracker,
      runner,
      writeLog: (line) => logs.push(line),
      ensureWorkspace: makeMockWorkspace("/tmp/ws-test-2"),
      claimIssue: () => true,
      releaseIssue: () => {},
    })

    await service.refresh()
    await service.waitForDispatches()

    expect(logs.some((l) => l.includes("done TEST-1 status=failed"))).toBe(true)
    service.shutdown()
  })

  test("running_state が設定されている場合は dispatch 開始時に状態を更新する", async () => {
    const issue = makeIssue({ state: "Ready" })
    const stateLog: { id: string; state: string }[] = []
    const tracker: IssueTrackerClient = {
      fetchCandidateIssues: async () => [issue],
      fetchIssuesByStates: async () => [issue],
      fetchIssueStatesByIds: async () => [issue],
      moveIssueToState: async (id, state) => {
        stateLog.push({ id, state })
      },
      shouldRun: (i, activeStates) => isActiveState(i.state, activeStates),
    }
    const config = makeConfig({ runningState: "In progress", successState: "Done" })

    const service = new SymphonyService(config, "prompt", {
      tracker,
      runner: makeMockRunner(),
      writeLog: () => {},
      ensureWorkspace: makeMockWorkspace("/tmp/ws-test-3"),
      claimIssue: () => true,
      releaseIssue: () => {},
    })

    await service.refresh()
    await service.waitForDispatches()

    const states = stateLog.map((s) => s.state)
    expect(states).toContain("In progress")
    expect(states).toContain("Done")
    service.shutdown()
  })

  test("reporter file で AGENTLOGS.local.md に追記する", async () => {
    const tmpDir = join(tmpdir(), `hs-test-${Date.now()}`)
    tmpDirs.push(tmpDir)
    const { mkdirSync } = await import("node:fs")
    mkdirSync(tmpDir, { recursive: true })

    const issue = makeIssue()
    const tracker = makeMockTrackerClient([issue])
    const runner = makeMockRunner({ responseText: "Implementation complete." })
    const config = makeConfig({ reporter: ["file"] })

    const service = new SymphonyService(config, "prompt", {
      tracker,
      runner,
      writeLog: () => {},
      ensureWorkspace: makeMockWorkspace(tmpDir),
      claimIssue: () => true,
      releaseIssue: () => {},
    })

    await service.refresh()
    await service.waitForDispatches()

    const { existsSync, readFileSync } = await import("node:fs")
    const logPath = join(tmpDir, "AGENTLOGS.local.md")
    expect(existsSync(logPath)).toBe(true)
    const content = readFileSync(logPath, "utf8")
    expect(content).toContain("Implementation complete.")
    service.shutdown()
  })

  test("候補がない場合は何もしない", async () => {
    const tracker = makeMockTrackerClient([])
    const config = makeConfig()
    const logs: string[] = []

    const service = new SymphonyService(config, "prompt", {
      tracker,
      runner: makeMockRunner(),
      writeLog: (line) => logs.push(line),
      ensureWorkspace: makeMockWorkspace("/tmp/ws-test-5"),
      claimIssue: () => true,
      releaseIssue: () => {},
    })

    await service.refresh()
    await service.waitForDispatches()

    expect(logs.some((l) => l.includes("idle"))).toBe(true)
    service.shutdown()
  })
})
