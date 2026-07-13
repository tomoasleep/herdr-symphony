import { afterEach, describe, expect, test } from "bun:test"
import { rmSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Issue, ServiceConfig } from "./domain/types"
import { createLogger } from "./logging/create-logger"
import type { Logger, LogLevel } from "./logging/types"
import { isActiveState } from "./orchestrator/scheduling"
import type {
  Runner,
  RunnerHandle,
  RunnerOptions,
  RunnerPollResult,
  RunnerResult,
} from "./runner/types"
import { SymphonyService } from "./service"
import type { Storage } from "./storage/types"
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
      if: null,
      activeStates: ["Ready"],
      terminalStates: ["Done"],
      runningState: "In progress",
      successState: "Done",
      failureState: "Blocked",
      stoppedState: null,
      runner: "herdr_agent",
      herdrAgent: {
        agent: "opencode",
        opencode: { model: null, agent: null, interactive: false, env: {} },
        claude: {
          model: null,
          permissionMode: null,
          messenger: "agmsg",
          pendingRemindIntervalMs: 900_000,
          reminderGracePeriodMs: 180_000,
          env: {},
        },
        workspaceLabel: null,
        turnTimeoutMs: 3_600_000,
        closePaneAfterDoneMs: null,
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
    async startIssue(issue): Promise<RunnerHandle> {
      return { sessionId: "test-session", issueId: issue.id }
    },
    async pollCompletion(): Promise<RunnerPollResult> {
      return {
        state: "done",
        result: {
          status: "succeeded",
          error: null,
          responseText: "Task done",
          ...result,
        },
      }
    },
    async cancelRun() {},
    async sweep() {},
  }
}

function makeCapturingRunner(result: Partial<RunnerResult> = {}): Runner & {
  options: RunnerOptions | null
} {
  let options: RunnerOptions | null = null
  return {
    async startIssue(issue, receivedOptions: RunnerOptions): Promise<RunnerHandle> {
      options = receivedOptions
      return { sessionId: "test-session", issueId: issue.id }
    },
    async pollCompletion(): Promise<RunnerPollResult> {
      return {
        state: "done",
        result: {
          status: "succeeded",
          error: null,
          responseText: "Task done",
          ...result,
        },
      }
    },
    async cancelRun() {},
    async sweep() {},
    get options() {
      return options
    },
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

function makeTestLogger(minLevel: LogLevel = "debug"): {
  logger: Logger
  lines: string[]
  entries: { level: LogLevel; line: string }[]
} {
  const entries: { level: LogLevel; line: string }[] = []
  return {
    logger: createLogger({ minLevel, sink: (level, line) => entries.push({ level, line }) }),
    get lines() {
      return entries.map((e) => e.line)
    },
    entries,
  }
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

    const testLogger = makeTestLogger()
    const service = new SymphonyService(config, "Fix the bug.", {
      tracker,
      runner,
      logger: testLogger.logger,
      ensureWorkspace: makeMockWorkspace("/tmp/ws-test-1"),
      claimIssue: () => true,
      releaseIssue: () => {},
    })

    await service.refresh()
    await service.waitForDispatches()
    await service.reconcileRunning()

    expect(testLogger.lines.some((l) => l.includes("done TEST-1"))).toBe(true)
    service.shutdown()
  })

  test("dispatch 失敗時に failure_state へ遷移する", async () => {
    const issue = makeIssue()
    const tracker = makeMockTrackerClient([issue])
    const runner = makeMockRunner({ status: "failed", error: "agent error" })
    const config = makeConfig({ failureState: "Blocked" })

    const testLogger = makeTestLogger()
    const service = new SymphonyService(config, "Fix the bug.", {
      tracker,
      runner,
      logger: testLogger.logger,
      ensureWorkspace: makeMockWorkspace("/tmp/ws-test-2"),
      claimIssue: () => true,
      releaseIssue: () => {},
    })

    await service.refresh()
    await service.waitForDispatches()
    await service.reconcileRunning()

    expect(testLogger.lines.some((l) => l.includes("done TEST-1 status=failed"))).toBe(true)
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
      logger: makeTestLogger().logger,
      ensureWorkspace: makeMockWorkspace("/tmp/ws-test-3"),
      claimIssue: () => true,
      releaseIssue: () => {},
    })

    await service.refresh()
    await service.waitForDispatches()
    await service.reconcileRunning()

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
      logger: makeTestLogger().logger,
      ensureWorkspace: makeMockWorkspace(tmpDir),
      claimIssue: () => true,
      releaseIssue: () => {},
    })

    await service.refresh()
    await service.waitForDispatches()
    await service.reconcileRunning()

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

    const testLogger = makeTestLogger()

    const service = new SymphonyService(config, "prompt", {
      tracker,
      runner: makeMockRunner(),
      logger: testLogger.logger,
      ensureWorkspace: makeMockWorkspace("/tmp/ws-test-5"),
      claimIssue: () => true,
      releaseIssue: () => {},
    })

    await service.refresh()
    await service.waitForDispatches()
    await service.reconcileRunning()

    expect(testLogger.lines.some((l) => l.includes("idle"))).toBe(true)
    service.shutdown()
  })

  test("claude の場合は agmsg option を runner に渡す", async () => {
    const tmpDir = join(tmpdir(), `hs-service-claude-${Date.now()}`)
    tmpDirs.push(tmpDir)
    await mkdir(tmpDir, { recursive: true })
    const issue = makeIssue()
    const tracker = makeMockTrackerClient([issue])
    const runner = makeCapturingRunner()
    const config = makeConfig({
      herdrAgent: {
        ...makeConfig().work.herdrAgent,
        agent: "claude",
      },
    })

    const service = new SymphonyService(config, "prompt", {
      tracker,
      runner,
      logger: makeTestLogger().logger,
      ensureWorkspace: makeMockWorkspace(tmpDir),
      claimIssue: () => true,
      releaseIssue: () => {},
    })

    await service.refresh()
    await service.waitForDispatches()
    await service.reconcileRunning()

    expect(runner.options?.agmsg).toEqual({
      team: "herdr-symphony",
      orchestratorAgent: "herdr-symphony",
    })
    service.shutdown()
  })

  test("opencode の場合は agmsg option を渡さない", async () => {
    const tmpDir = join(tmpdir(), `hs-service-opencode-${Date.now()}`)
    tmpDirs.push(tmpDir)
    await mkdir(tmpDir, { recursive: true })
    const issue = makeIssue()
    const tracker = makeMockTrackerClient([issue])
    const runner = makeCapturingRunner()
    const config = makeConfig()

    const service = new SymphonyService(config, "prompt", {
      tracker,
      runner,
      logger: makeTestLogger().logger,
      ensureWorkspace: makeMockWorkspace(tmpDir),
      claimIssue: () => true,
      releaseIssue: () => {},
    })

    await service.refresh()
    await service.waitForDispatches()
    await service.reconcileRunning()

    expect(runner.options?.agmsg).toBeUndefined()
    expect(runner.options?.content).toBe("prompt")
    service.shutdown()
  })

  test("claude.messenger: report_file の場合は reportPath を渡し agmsg を渡さない", async () => {
    const tmpDir = join(tmpdir(), `hs-service-report-${Date.now()}`)
    tmpDirs.push(tmpDir)
    await mkdir(tmpDir, { recursive: true })
    const issue = makeIssue()
    const tracker = makeMockTrackerClient([issue])
    const runner = makeCapturingRunner()
    const config = makeConfig({
      herdrAgent: {
        ...makeConfig().work.herdrAgent,
        agent: "claude",
        claude: {
          model: null,
          permissionMode: null,
          messenger: "report_file",
          pendingRemindIntervalMs: 900_000,
          reminderGracePeriodMs: 180_000,
          env: {},
        },
      },
    })

    const service = new SymphonyService(config, "Fix the bug.", {
      tracker,
      runner,
      logger: makeTestLogger().logger,
      ensureWorkspace: makeMockWorkspace(tmpDir),
      claimIssue: () => true,
      releaseIssue: () => {},
    })

    await service.refresh()
    await service.waitForDispatches()
    await service.reconcileRunning()

    expect(runner.options?.agmsg).toBeUndefined()
    expect(runner.options?.reportPath).toBe(join(tmpDir, ".herdr-symphony-report.json"))
    expect(runner.options?.content).toContain("herdr-symphony report --status done")
    service.shutdown()
  })

  test("claude.messenger: agmsg の場合は agmsg を渡し reportPath を渡さない", async () => {
    const tmpDir = join(tmpdir(), `hs-service-agmsg-${Date.now()}`)
    tmpDirs.push(tmpDir)
    await mkdir(tmpDir, { recursive: true })
    const issue = makeIssue()
    const tracker = makeMockTrackerClient([issue])
    const runner = makeCapturingRunner()
    const config = makeConfig({
      herdrAgent: {
        ...makeConfig().work.herdrAgent,
        agent: "claude",
      },
    })

    const service = new SymphonyService(config, "Fix the bug.", {
      tracker,
      runner,
      logger: makeTestLogger().logger,
      ensureWorkspace: makeMockWorkspace(tmpDir),
      claimIssue: () => true,
      releaseIssue: () => {},
    })

    await service.refresh()
    await service.waitForDispatches()
    await service.reconcileRunning()

    expect(runner.options?.agmsg).toEqual({
      team: "herdr-symphony",
      orchestratorAgent: "herdr-symphony",
    })
    expect(runner.options?.reportPath).toBeUndefined()
    expect(runner.options?.content).toBe("Fix the bug.")
    service.shutdown()
  })

  test("dispatch の catch ブロックで二次エラーが起きても unhandled rejection にならない", async () => {
    const issue = makeIssue()
    const tracker = makeMockTrackerClient([issue])
    const runner = makeMockRunner()
    const config = makeConfig()

    const testLogger = makeTestLogger()
    const storage: Storage = {
      completed: {
        save() {},
        loadRecent() {
          return []
        },
        loadCount() {
          return 0
        },
        deleteOlderThan() {},
      },
      logs: {
        append() {
          throw new Error("log storage failure")
        },
        loadRecent() {
          return []
        },
        loadGlobalRecent() {
          return []
        },
        pruneOlderThan() {},
      },
      state: {
        save() {},
        delete() {},
        loadByCategory() {
          return []
        },
        deleteAllInCategory() {},
      },
      close() {},
    }

    const service = new SymphonyService(config, "Fix the bug.", {
      tracker,
      runner,
      storage,
      logger: testLogger.logger,
      ensureWorkspace: async () => {
        throw new Error("workspace creation failed")
      },
      claimIssue: () => true,
      releaseIssue: () => {},
    })

    await service.refresh()
    await service.waitForDispatches()
    await service.reconcileRunning()
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(testLogger.lines.some((l) => l.includes("dispatch unhandled error"))).toBe(true)
    service.shutdown()
  })

  test("info レベルで start/done が出力される", async () => {
    const issue = makeIssue()
    const tracker = makeMockTrackerClient([issue])
    const runner = makeMockRunner()
    const config = makeConfig()

    const testLogger = makeTestLogger("info")
    const service = new SymphonyService(config, "Fix the bug.", {
      tracker,
      runner,
      logger: testLogger.logger,
      ensureWorkspace: makeMockWorkspace("/tmp/ws-test-info"),
      claimIssue: () => true,
      releaseIssue: () => {},
    })

    await service.refresh()
    await service.waitForDispatches()
    await service.reconcileRunning()

    expect(testLogger.lines.some((l) => l.includes("start TEST-1"))).toBe(true)
    expect(testLogger.lines.some((l) => l.includes("done TEST-1"))).toBe(true)
    service.shutdown()
  })

  test("minLevel=info で debug ログがフィルタされる", async () => {
    const issue = makeIssue()
    const tracker = makeMockTrackerClient([issue])
    const runner = makeMockRunner()
    const config = makeConfig()

    const testLogger = makeTestLogger("info")
    const service = new SymphonyService(config, "Fix the bug.", {
      tracker,
      runner,
      logger: testLogger.logger,
      ensureWorkspace: makeMockWorkspace("/tmp/ws-test-filter"),
      claimIssue: () => true,
      releaseIssue: () => {},
    })

    await service.refresh()
    await service.waitForDispatches()
    await service.reconcileRunning()

    expect(testLogger.entries.some((e) => e.level === "debug")).toBe(false)
    expect(testLogger.entries.some((e) => e.level === "info")).toBe(true)
    service.shutdown()
  })

  test("minLevel=debug で debug ログが出力される", async () => {
    const issue = makeIssue()
    const tracker = makeMockTrackerClient([issue])
    const runner = makeMockRunner()
    const config = makeConfig()

    const testLogger = makeTestLogger("debug")
    const service = new SymphonyService(config, "Fix the bug.", {
      tracker,
      runner,
      logger: testLogger.logger,
      ensureWorkspace: makeMockWorkspace("/tmp/ws-test-debug"),
      claimIssue: () => true,
      releaseIssue: () => {},
    })

    await service.refresh()
    await service.waitForDispatches()
    await service.reconcileRunning()

    expect(testLogger.entries.some((e) => e.level === "debug")).toBe(true)
    expect(testLogger.lines.some((l) => l.includes("tracker fetchCandidateIssues"))).toBe(true)
    service.shutdown()
  })

  test("dispatch error が warn レベルで出力される", async () => {
    const issue = makeIssue()
    const tracker = makeMockTrackerClient([issue])
    const runner = makeMockRunner()
    const config = makeConfig()

    const testLogger = makeTestLogger("debug")
    const service = new SymphonyService(config, "Fix the bug.", {
      tracker,
      runner,
      logger: testLogger.logger,
      ensureWorkspace: async () => {
        throw new Error("workspace creation failed")
      },
      claimIssue: () => true,
      releaseIssue: () => {},
    })

    await service.refresh()
    await service.waitForDispatches()
    await service.reconcileRunning()
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(
      testLogger.entries.some((e) => e.level === "warn" && e.line.includes("dispatch error")),
    ).toBe(true)
    service.shutdown()
  })

  test("opencode.interactive: true の場合は reportPath を渡し interactive を渡す", async () => {
    const tmpDir = join(tmpdir(), `hs-service-opencode-interactive-${Date.now()}`)
    tmpDirs.push(tmpDir)
    await mkdir(tmpDir, { recursive: true })
    const issue = makeIssue()
    const tracker = makeMockTrackerClient([issue])
    const runner = makeCapturingRunner()
    const baseConfig = makeConfig()
    const config = makeConfig({
      herdrAgent: {
        ...baseConfig.work.herdrAgent,
        opencode: { model: null, agent: null, interactive: true, env: {} },
      },
    })

    const service = new SymphonyService(config, "Fix the bug.", {
      tracker,
      runner,
      logger: makeTestLogger().logger,
      ensureWorkspace: makeMockWorkspace(tmpDir),
      claimIssue: () => true,
      releaseIssue: () => {},
    })

    await service.refresh()
    await service.waitForDispatches()
    await service.reconcileRunning()

    expect(runner.options?.reportPath).toBe(join(tmpDir, ".herdr-symphony-report.json"))
    expect(runner.options?.interactive).toBe(true)
    expect(runner.options?.content).toContain("herdr-symphony report --status done")
    service.shutdown()
  })

  test("opencode.interactive: false (default) の場合は reportPath を渡さない", async () => {
    const tmpDir = join(tmpdir(), `hs-service-opencode-default-${Date.now()}`)
    tmpDirs.push(tmpDir)
    await mkdir(tmpDir, { recursive: true })
    const issue = makeIssue()
    const tracker = makeMockTrackerClient([issue])
    const runner = makeCapturingRunner()
    const config = makeConfig()

    const service = new SymphonyService(config, "Fix the bug.", {
      tracker,
      runner,
      logger: makeTestLogger().logger,
      ensureWorkspace: makeMockWorkspace(tmpDir),
      claimIssue: () => true,
      releaseIssue: () => {},
    })

    await service.refresh()
    await service.waitForDispatches()
    await service.reconcileRunning()

    expect(runner.options?.reportPath).toBeUndefined()
    expect(runner.options?.interactive).toBeFalsy()
    expect(runner.options?.content).toBe("Fix the bug.")
    service.shutdown()
  })

  test("work.if が未設定ならすべての Issue が dispatch される", async () => {
    const issue = makeIssue({ fields: { Agent: "build" } })
    const tracker = makeMockTrackerClient([issue])
    const runner = makeMockRunner()
    const config = makeConfig()

    const testLogger = makeTestLogger()
    const service = new SymphonyService(config, "Fix the bug.", {
      tracker,
      runner,
      logger: testLogger.logger,
      ensureWorkspace: makeMockWorkspace("/tmp/ws-if-null"),
      claimIssue: () => true,
      releaseIssue: () => {},
    })

    await service.refresh()
    await service.waitForDispatches()
    await service.reconcileRunning()

    expect(testLogger.lines.some((l) => l.includes("done TEST-1"))).toBe(true)
    service.shutdown()
  })

  test("work.if が条件を満たす Issue のみ dispatch される", async () => {
    const buildIssue = makeIssue({
      id: "build-1",
      identifier: "BUILD-1",
      fields: { Agent: "build" },
    })
    const planIssue = makeIssue({ id: "plan-1", identifier: "PLAN-1", fields: { Agent: "plan" } })
    const tracker = makeMockTrackerClient([buildIssue, planIssue])
    const runner = makeMockRunner()
    const config = makeConfig({
      if: '{{ issue.fields["Agent"] == "build" }}',
    })

    const testLogger = makeTestLogger()
    const service = new SymphonyService(config, "Fix the bug.", {
      tracker,
      runner,
      logger: testLogger.logger,
      ensureWorkspace: makeMockWorkspace("/tmp/ws-if-filter"),
      claimIssue: () => true,
      releaseIssue: () => {},
    })

    await service.refresh()
    await service.waitForDispatches()
    await service.reconcileRunning()

    expect(testLogger.lines.some((l) => l.includes("done BUILD-1"))).toBe(true)
    expect(testLogger.lines.some((l) => l.includes("done PLAN-1"))).toBe(false)
    service.shutdown()
  })
})
