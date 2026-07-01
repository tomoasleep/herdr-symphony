import { describe, expect, test } from "bun:test"
import { mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Issue, ServiceConfig } from "../../domain/types"
import type { HerdrAgentInfo, HerdrClient, HerdrWorkspaceInfo } from "../../herdr/herdr-client"
import { writeReport } from "../../report/write-report"
import { HerdrAgentRunner } from "./herdr-agent-runner"
import type { ReportContext, ReportResolver } from "./report"

function nullReportResolver(): ReportResolver {
  return { resolve: () => Promise.resolve(null) }
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    identifier: "TEST-1",
    title: "Test issue",
    description: null,
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

function makeConfig(overrides: Partial<ServiceConfig["work"]> = {}): ServiceConfig {
  return {
    tracker: { kind: "file", github_project: null, file: { baseDir: "/issues" }, schedule: null },
    polling: { intervalMs: 30_000 },
    hooks: { beforeRun: null, afterRun: null, timeoutMs: 60_000 },
    agent: { maxConcurrentAgents: 10, maxRetryBackoffMs: 300_000, maxConcurrentAgentsByState: {} },
    work: {
      activeStates: ["Ready"],
      terminalStates: ["Done"],
      runningState: null,
      successState: null,
      failureState: null,
      stoppedState: null,
      runner: "herdr_agent",
      herdrAgent: {
        agent: "opencode",
        opencode: { model: "openai/gpt-5.4", agent: "build" },
        claude: { model: null, permissionMode: null },
        workspaceLabel: null,
        turnTimeoutMs: 3_600_000,
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
      ...overrides,
    },
  }
}

function makeMockHerdrClient(opts: {
  workspace?: HerdrWorkspaceInfo
  agentStarted?: HerdrAgentInfo
  getAgentResult?: HerdrAgentInfo | null | (HerdrAgentInfo | null)[]
  readText?: string
  onSendKeys?: (target: string, keys: string[]) => void
}): HerdrClient & {
  startAgentArgs: { name: string; argv: string[] } | null
  sentInputs: { target: string; text: string }[]
  sentKeys: { target: string; keys: string[] }[]
  getAgentCallCount: number
} {
  let startAgentArgs: { name: string; argv: string[] } | null = null
  const sentInputs: { target: string; text: string }[] = []
  const sentKeys: { target: string; keys: string[] }[] = []
  let getAgentCallCount = 0
  return {
    async ensureWorkspace() {
      return opts.workspace ?? { id: "w1", label: "TEST-1", cwd: "/repo/worktree" }
    },
    async startAgent(name, startOpts) {
      startAgentArgs = { name, argv: startOpts.argv }
      return (
        opts.agentStarted ?? {
          name,
          state: "unknown",
          paneId: "w1:p1",
          workspaceId: "w1",
        }
      )
    },
    async waitAgent() {
      return { name: "TEST-1", state: "done", paneId: "w1:p1", workspaceId: "w1" }
    },
    async readAgent() {
      return opts.readText ?? "Task completed successfully."
    },
    async getAgent() {
      const seq: (HerdrAgentInfo | null)[] = Array.isArray(opts.getAgentResult)
        ? opts.getAgentResult
        : opts.getAgentResult !== undefined
          ? [opts.getAgentResult]
          : [
              { name: "TEST-1", state: "working", paneId: "w1:p1", workspaceId: "w1" },
              { name: "TEST-1", state: "done", paneId: "w1:p1", workspaceId: "w1" },
            ]
      const idx = Math.min(getAgentCallCount, seq.length - 1)
      getAgentCallCount++
      return seq[idx] ?? null
    },
    async sendInput(target, text) {
      sentInputs.push({ target, text })
    },
    async sendKeys(target, ...keys) {
      sentKeys.push({ target, keys })
      opts.onSendKeys?.(target, keys)
    },
    async closePane() {},
    get startAgentArgs() {
      return startAgentArgs
    },
    get sentInputs() {
      return sentInputs
    },
    get sentKeys() {
      return sentKeys
    },
    get getAgentCallCount() {
      return getAgentCallCount
    },
  } as HerdrClient & {
    startAgentArgs: { name: string; argv: string[] } | null
    sentInputs: { target: string; text: string }[]
    sentKeys: { target: string; keys: string[] }[]
    getAgentCallCount: number
  }
}

function makeReportPath(): { dir: string; path: string } {
  const dir = join(
    tmpdir(),
    `hs-runner-report-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  mkdirSync(dir, { recursive: true })
  return { dir, path: join(dir, "report.json") }
}

describe("HerdrAgentRunner", () => {
  test("正常系: workspace 作成 → agent 起動 → done 待機 → 出力取得", async () => {
    const client = makeMockHerdrClient({
      readText: "Implementation complete.",
    })
    const runner = new HerdrAgentRunner(makeConfig(), {
      herdrClient: client,
      pollIntervalMs: 10,
      reportResolver: nullReportResolver(),
    })
    const issue = makeIssue()

    const result = await runner.runIssue(issue, {
      content: "Fix the bug",
      agentKind: "opencode",
      attempt: null,
      workspacePath: "/repo/worktree",
    })

    expect(result.status).toBe("succeeded")
    expect(result.error).toBeNull()
    expect(result.responseText).toBe("Implementation complete.")
  })

  test("reportResolver が解決したテキストを responseText に使う", async () => {
    const client = makeMockHerdrClient({ readText: "pane fallback" })
    const resolver: ReportResolver = { resolve: () => Promise.resolve("Resolver report.") }
    const runner = new HerdrAgentRunner(makeConfig(), {
      herdrClient: client,
      pollIntervalMs: 10,
      reportResolver: resolver,
    })

    const result = await runner.runIssue(makeIssue(), {
      content: "Fix the bug",
      agentKind: "opencode",
      attempt: null,
      workspacePath: "/repo/worktree",
    })

    expect(result.status).toBe("succeeded")
    expect(result.responseText).toBe("Resolver report.")
  })

  test("reportResolver が null のときは pane read にフォールバックする", async () => {
    const client = makeMockHerdrClient({ readText: "Pane content." })
    const runner = new HerdrAgentRunner(makeConfig(), {
      herdrClient: client,
      pollIntervalMs: 10,
      reportResolver: nullReportResolver(),
    })

    const result = await runner.runIssue(makeIssue(), {
      content: "Fix the bug",
      agentKind: "opencode",
      attempt: null,
      workspacePath: "/repo/worktree",
    })

    expect(result.status).toBe("succeeded")
    expect(result.responseText).toBe("Pane content.")
  })

  test("reportResolver に workspacePath・startedAt・agentKind が渡る", async () => {
    const client = makeMockHerdrClient({})
    const captured: { ctx: ReportContext | null } = { ctx: null }
    const resolver: ReportResolver = {
      resolve: (ctx) => {
        captured.ctx = ctx
        return Promise.resolve("ok")
      },
    }
    const runner = new HerdrAgentRunner(makeConfig(), {
      herdrClient: client,
      pollIntervalMs: 10,
      reportResolver: resolver,
    })

    await runner.runIssue(makeIssue(), {
      content: "Fix the bug",
      agentKind: "claude",
      attempt: null,
      workspacePath: "/repo/claude-wt",
    })

    expect(captured.ctx).not.toBeNull()
    expect(captured.ctx?.agentKind).toBe("claude")
    expect(captured.ctx?.workspacePath).toBe("/repo/claude-wt")
    expect(typeof captured.ctx?.startedAt).toBe("string")
  })

  test("opencode argv に model と agent が含まれる", async () => {
    const client = makeMockHerdrClient({})
    const runner = new HerdrAgentRunner(makeConfig(), {
      herdrClient: client,
      pollIntervalMs: 10,
      reportResolver: nullReportResolver(),
    })

    await runner.runIssue(makeIssue(), {
      content: "Fix the bug",
      agentKind: "opencode",
      attempt: null,
      workspacePath: "/repo/worktree",
      model: "openai/gpt-5.4",
      agent: "build",
    })

    const args = client.startAgentArgs
    expect(args).not.toBeNull()
    expect(args?.argv[0]).toBe("opencode")
    expect(args?.argv[1]).toBe("run")
    expect(args?.argv).toContain("--model")
    expect(args?.argv).toContain("openai/gpt-5.4")
    expect(args?.argv).toContain("--agent")
    expect(args?.argv).toContain("build")
  })

  test("prompt が argv の最後に渡される", async () => {
    const client = makeMockHerdrClient({})
    const runner = new HerdrAgentRunner(makeConfig(), {
      herdrClient: client,
      pollIntervalMs: 10,
      reportResolver: nullReportResolver(),
    })

    await runner.runIssue(makeIssue(), {
      content: "Implement feature X",
      agentKind: "opencode",
      attempt: null,
      workspacePath: "/repo/worktree",
    })

    const args = client.startAgentArgs
    expect(args?.argv.includes("Implement feature X")).toBe(true)
  })

  test("agent name が identifier + timestamp から構成される", async () => {
    const client = makeMockHerdrClient({})
    const runner = new HerdrAgentRunner(makeConfig(), {
      herdrClient: client,
      pollIntervalMs: 10,
      reportResolver: nullReportResolver(),
      now: () => 1_719_662_400_000,
    })
    const issue = makeIssue({ identifier: "PROJ-42" })

    await runner.runIssue(issue, {
      content: "Do work",
      agentKind: "opencode",
      attempt: null,
      workspacePath: "/repo/worktree",
    })

    expect(client.startAgentArgs?.name).toBe("PROJ-42-ly02lc00")
  })

  test("workflowName を渡すと agent name に拡張子除外+sanitize した workflow 名が付く", async () => {
    const client = makeMockHerdrClient({})
    const runner = new HerdrAgentRunner(makeConfig(), {
      herdrClient: client,
      pollIntervalMs: 10,
      reportResolver: nullReportResolver(),
      now: () => 1_719_662_400_000,
    })
    const issue = makeIssue({ identifier: "PROJ-42" })

    await runner.runIssue(issue, {
      content: "Do work",
      agentKind: "opencode",
      attempt: null,
      workspacePath: "/repo/worktree",
      workflowName: "WORKFLOW.exec.md",
    })

    expect(client.startAgentArgs?.name).toBe("PROJ-42-WORKFLOW.exec-ly02lc00")
  })

  test("workflowName にスペースが含まれる場合は sanitize される", async () => {
    const client = makeMockHerdrClient({})
    const runner = new HerdrAgentRunner(makeConfig(), {
      herdrClient: client,
      pollIntervalMs: 10,
      reportResolver: nullReportResolver(),
      now: () => 1_719_662_400_000,
    })
    const issue = makeIssue({ identifier: "PROJ-42" })

    await runner.runIssue(issue, {
      content: "Do work",
      agentKind: "opencode",
      attempt: null,
      workspacePath: "/repo/worktree",
      workflowName: "my flow.md",
    })

    expect(client.startAgentArgs?.name).toBe("PROJ-42-my_flow-ly02lc00")
  })

  test("workspace label が解決される", async () => {
    let receivedLabel = ""
    let getAgentCallCount = 0
    const client: HerdrClient = {
      async ensureWorkspace(_cwd, label) {
        receivedLabel = label
        return { id: "w1", label, cwd: "/repo" }
      },
      async startAgent() {
        return { name: "TEST-1", state: "unknown", paneId: "w1:p1", workspaceId: "w1" }
      },
      async waitAgent() {
        return { name: "TEST-1", state: "done", paneId: "w1:p1", workspaceId: "w1" }
      },
      async readAgent() {
        return "done"
      },
      async getAgent() {
        getAgentCallCount++
        if (getAgentCallCount === 1) {
          return { name: "TEST-1", state: "working", paneId: "w1:p1", workspaceId: "w1" }
        }
        return { name: "TEST-1", state: "done", paneId: "w1:p1", workspaceId: "w1" }
      },
      async sendInput() {},
      async sendKeys() {},
      async closePane() {},
    }
    const runner = new HerdrAgentRunner(makeConfig(), {
      herdrClient: client,
      pollIntervalMs: 10,
      reportResolver: nullReportResolver(),
    })

    await runner.runIssue(makeIssue(), {
      content: "Fix the bug",
      agentKind: "opencode",
      attempt: null,
      workspacePath: "/repo/worktree",
    })

    expect(receivedLabel).toBe("TEST-1")
  })

  test("timeout 時は timeout status を返す", async () => {
    const client = makeMockHerdrClient({
      getAgentResult: { name: "TEST-1", state: "working", paneId: "w1:p1", workspaceId: "w1" },
    })
    const runner = new HerdrAgentRunner(makeConfig(), {
      herdrClient: client,
      pollIntervalMs: 10,
      reportResolver: nullReportResolver(),
    })

    const result = await runner.runIssue(makeIssue(), {
      content: "Fix the bug",
      agentKind: "opencode",
      attempt: null,
      workspacePath: "/repo/worktree",
      timeoutMs: 50,
    })

    expect(result.status).toBe("timeout")
  })

  test("on_blocked 未指定時は blocked でもポーリングを継続しタイムアウトする", async () => {
    const client = makeMockHerdrClient({
      getAgentResult: { name: "TEST-1", state: "blocked", paneId: "w1:p1", workspaceId: "w1" },
    })
    const runner = new HerdrAgentRunner(makeConfig(), {
      herdrClient: client,
      pollIntervalMs: 10,
      reportResolver: nullReportResolver(),
    })

    const result = await runner.runIssue(makeIssue(), {
      content: "Fix the bug",
      agentKind: "opencode",
      attempt: null,
      workspacePath: "/repo/worktree",
      timeoutMs: 50,
    })

    expect(result.status).toBe("timeout")
  })

  test("on_blocked: fail のときは blocked を即 failed にする", async () => {
    const client = makeMockHerdrClient({
      getAgentResult: { name: "TEST-1", state: "blocked", paneId: "w1:p1", workspaceId: "w1" },
    })
    const runner = new HerdrAgentRunner(makeConfig(), {
      herdrClient: client,
      pollIntervalMs: 10,
      reportResolver: nullReportResolver(),
    })

    const result = await runner.runIssue(makeIssue(), {
      content: "Fix the bug",
      agentKind: "opencode",
      attempt: null,
      workspacePath: "/repo/worktree",
      onBlocked: "fail",
      timeoutMs: 1_000,
    })

    expect(result.status).toBe("failed")
    expect(result.error).toContain("blocked")
  })

  test("on_blocked: continue のときは blocked を継続しタイムアウトする", async () => {
    const client = makeMockHerdrClient({
      getAgentResult: { name: "TEST-1", state: "blocked", paneId: "w1:p1", workspaceId: "w1" },
    })
    const runner = new HerdrAgentRunner(makeConfig(), {
      herdrClient: client,
      pollIntervalMs: 10,
      reportResolver: nullReportResolver(),
    })

    const result = await runner.runIssue(makeIssue(), {
      content: "Fix the bug",
      agentKind: "opencode",
      attempt: null,
      workspacePath: "/repo/worktree",
      onBlocked: "continue",
      timeoutMs: 50,
    })

    expect(result.status).toBe("timeout")
  })

  test("opencode agent が idle に戻った場合は succeeded になる", async () => {
    const client = makeMockHerdrClient({
      getAgentResult: [
        { name: "TEST-1", state: "working", paneId: "w1:p1", workspaceId: "w1" },
        { name: "TEST-1", state: "idle", paneId: "w1:p1", workspaceId: "w1" },
      ],
      readText: "Done.",
    })
    const runner = new HerdrAgentRunner(makeConfig(), {
      herdrClient: client,
      pollIntervalMs: 10,
      reportResolver: nullReportResolver(),
    })

    const result = await runner.runIssue(makeIssue(), {
      content: "Fix the bug",
      agentKind: "opencode",
      attempt: null,
      workspacePath: "/repo/worktree",
    })

    expect(result.status).toBe("succeeded")
    expect(result.responseText).toBe("Done.")
  })

  test("claude は done report がある場合に succeeded になる", async () => {
    const report = makeReportPath()
    try {
      writeReport(report.path, "done", "実装と検証が完了しました")
      const client = makeMockHerdrClient({
        getAgentResult: [
          { name: "TEST-1", state: "working", paneId: "w1:p1", workspaceId: "w1" },
          { name: "TEST-1", state: "idle", paneId: "w1:p1", workspaceId: "w1" },
        ],
      })
      const runner = new HerdrAgentRunner(makeConfig(), {
        herdrClient: client,
        pollIntervalMs: 10,
        reportResolver: nullReportResolver(),
      })

      const result = await runner.runIssue(makeIssue(), {
        content: "Fix the bug",
        agentKind: "claude",
        attempt: null,
        workspacePath: "/repo/worktree",
        reportPath: report.path,
      })

      expect(result.status).toBe("succeeded")
      expect(result.responseText).toBe("実装と検証が完了しました")
    } finally {
      rmSync(report.dir, { recursive: true, force: true })
    }
  })

  test("claude は failed report がある場合に failed になる", async () => {
    const report = makeReportPath()
    try {
      writeReport(report.path, "failed", "テストが失敗しました")
      const client = makeMockHerdrClient({
        getAgentResult: [
          { name: "TEST-1", state: "working", paneId: "w1:p1", workspaceId: "w1" },
          { name: "TEST-1", state: "idle", paneId: "w1:p1", workspaceId: "w1" },
        ],
      })
      const runner = new HerdrAgentRunner(makeConfig(), {
        herdrClient: client,
        pollIntervalMs: 10,
        reportResolver: nullReportResolver(),
      })

      const result = await runner.runIssue(makeIssue(), {
        content: "Fix the bug",
        agentKind: "claude",
        attempt: null,
        workspacePath: "/repo/worktree",
        reportPath: report.path,
      })

      expect(result.status).toBe("failed")
      expect(result.error).toBe("テストが失敗しました")
    } finally {
      rmSync(report.dir, { recursive: true, force: true })
    }
  })

  test("claude は pending report では完了しない", async () => {
    const report = makeReportPath()
    try {
      writeReport(report.path, "pending", "background task 待ち")
      const client = makeMockHerdrClient({
        getAgentResult: [
          { name: "TEST-1", state: "working", paneId: "w1:p1", workspaceId: "w1" },
          { name: "TEST-1", state: "idle", paneId: "w1:p1", workspaceId: "w1" },
        ],
      })
      const runner = new HerdrAgentRunner(makeConfig(), {
        herdrClient: client,
        pollIntervalMs: 10,
        reportResolver: nullReportResolver(),
      })

      const result = await runner.runIssue(makeIssue(), {
        content: "Fix the bug",
        agentKind: "claude",
        attempt: null,
        workspacePath: "/repo/worktree",
        timeoutMs: 50,
        reportPath: report.path,
      })

      expect(result.status).toBe("timeout")
      expect(client.sentInputs).toHaveLength(0)
    } finally {
      rmSync(report.dir, { recursive: true, force: true })
    }
  })

  test("claude は idle で report がない場合にリマインドして Enter を送る", async () => {
    const report = makeReportPath()
    try {
      const client = makeMockHerdrClient({
        getAgentResult: [
          { name: "TEST-1", state: "working", paneId: "w1:p1", workspaceId: "w1" },
          { name: "TEST-1", state: "idle", paneId: "w1:p1", workspaceId: "w1" },
          { name: "TEST-1", state: "working", paneId: "w1:p1", workspaceId: "w1" },
          { name: "TEST-1", state: "idle", paneId: "w1:p1", workspaceId: "w1" },
        ],
        onSendKeys: () => writeReport(report.path, "done", "リマインド後に完了"),
      })
      const runner = new HerdrAgentRunner(makeConfig(), {
        herdrClient: client,
        pollIntervalMs: 10,
        reportResolver: nullReportResolver(),
      })

      const result = await runner.runIssue(makeIssue(), {
        content: "Fix the bug",
        agentKind: "claude",
        attempt: null,
        workspacePath: "/repo/worktree",
        reportPath: report.path,
      })

      expect(result.status).toBe("succeeded")
      expect(client.sentInputs[0]?.text).toContain("herdr-symphony report --status done")
      expect(client.sentKeys[0]).toEqual({ target: "w1:p1", keys: ["Enter"] })
    } finally {
      rmSync(report.dir, { recursive: true, force: true })
    }
  })

  test("claude は agent が null でも report がない場合にリマインドして Enter を送る", async () => {
    const report = makeReportPath()
    try {
      const client = makeMockHerdrClient({
        getAgentResult: [
          { name: "TEST-1", state: "working", paneId: "w1:p1", workspaceId: "w1" },
          null,
          { name: "TEST-1", state: "working", paneId: "w1:p1", workspaceId: "w1" },
          { name: "TEST-1", state: "idle", paneId: "w1:p1", workspaceId: "w1" },
        ],
        onSendKeys: () => writeReport(report.path, "done", "null 後のリマインドで完了"),
      })
      const runner = new HerdrAgentRunner(makeConfig(), {
        herdrClient: client,
        pollIntervalMs: 10,
        reportResolver: nullReportResolver(),
      })

      const result = await runner.runIssue(makeIssue(), {
        content: "Fix the bug",
        agentKind: "claude",
        attempt: null,
        workspacePath: "/repo/worktree",
        reportPath: report.path,
      })

      expect(result.status).toBe("succeeded")
      expect(client.sentInputs[0]?.text).toContain("herdr-symphony report --status done")
      expect(client.sentKeys[0]).toEqual({ target: "w1:p1", keys: ["Enter"] })
    } finally {
      rmSync(report.dir, { recursive: true, force: true })
    }
  })

  test("model 未指定時は --model を付けない", async () => {
    const client = makeMockHerdrClient({})
    const runner = new HerdrAgentRunner(makeConfig(), {
      herdrClient: client,
      pollIntervalMs: 10,
      reportResolver: nullReportResolver(),
    })

    await runner.runIssue(makeIssue(), {
      content: "Fix the bug",
      agentKind: "opencode",
      attempt: null,
      workspacePath: "/repo/worktree",
      model: null,
      agent: null,
    })

    const args = client.startAgentArgs
    expect(args?.argv).not.toContain("--model")
    expect(args?.argv).not.toContain("--agent")
  })

  test("claude argv に --print が含まれない", async () => {
    const client = makeMockHerdrClient({})
    const runner = new HerdrAgentRunner(makeConfig(), {
      herdrClient: client,
      pollIntervalMs: 10,
      reportResolver: nullReportResolver(),
    })

    await runner.runIssue(makeIssue(), {
      content: "Fix the bug",
      agentKind: "claude",
      attempt: null,
      workspacePath: "/repo/worktree",
    })

    const args = client.startAgentArgs
    expect(args?.argv[0]).toBe("claude")
    expect(args?.argv).not.toContain("--print")
  })

  test("claude では prompt を argv の末尾に含める", async () => {
    const client = makeMockHerdrClient({})
    const runner = new HerdrAgentRunner(makeConfig(), {
      herdrClient: client,
      pollIntervalMs: 10,
      reportResolver: nullReportResolver(),
    })

    await runner.runIssue(makeIssue(), {
      content: "Fix the bug",
      agentKind: "claude",
      attempt: null,
      workspacePath: "/repo/worktree",
    })

    const args = client.startAgentArgs
    expect(args?.argv[args.argv.length - 1]).toBe("Fix the bug")
    expect(client.sentInputs).toHaveLength(0)
    expect(client.sentKeys).toHaveLength(0)
  })

  test("claude に model が渡される", async () => {
    const client = makeMockHerdrClient({})
    const runner = new HerdrAgentRunner(makeConfig(), {
      herdrClient: client,
      pollIntervalMs: 10,
      reportResolver: nullReportResolver(),
    })

    await runner.runIssue(makeIssue(), {
      content: "Fix the bug",
      agentKind: "claude",
      attempt: null,
      workspacePath: "/repo/worktree",
      model: "claude-sonnet-4-20250514",
    })

    const args = client.startAgentArgs
    expect(args?.argv).toContain("--model")
    expect(args?.argv).toContain("claude-sonnet-4-20250514")
  })

  test("claude に permission_mode が渡される", async () => {
    const client = makeMockHerdrClient({})
    const runner = new HerdrAgentRunner(makeConfig(), {
      herdrClient: client,
      pollIntervalMs: 10,
      reportResolver: nullReportResolver(),
    })

    await runner.runIssue(makeIssue(), {
      content: "Fix the bug",
      agentKind: "claude",
      attempt: null,
      workspacePath: "/repo/worktree",
      permissionMode: "acceptEdits",
    })

    const args = client.startAgentArgs
    expect(args?.argv).toContain("--permission-mode")
    expect(args?.argv).toContain("acceptEdits")
  })

  test("claude permission_mode が bypassPermissions の場合は --dangerously-skip-permissions も付ける", async () => {
    const client = makeMockHerdrClient({})
    const runner = new HerdrAgentRunner(makeConfig(), {
      herdrClient: client,
      pollIntervalMs: 10,
      reportResolver: nullReportResolver(),
    })

    await runner.runIssue(makeIssue(), {
      content: "Fix the bug",
      agentKind: "claude",
      attempt: null,
      workspacePath: "/repo/worktree",
      permissionMode: "bypassPermissions",
    })

    const args = client.startAgentArgs
    expect(args?.argv).toContain("--permission-mode")
    expect(args?.argv).toContain("bypassPermissions")
    expect(args?.argv).toContain("--dangerously-skip-permissions")
  })

  test("claude permission_mode 未指定時は --permission-mode を付けない", async () => {
    const client = makeMockHerdrClient({})
    const runner = new HerdrAgentRunner(makeConfig(), {
      herdrClient: client,
      pollIntervalMs: 10,
      reportResolver: nullReportResolver(),
    })

    await runner.runIssue(makeIssue(), {
      content: "Fix the bug",
      agentKind: "claude",
      attempt: null,
      workspacePath: "/repo/worktree",
    })

    const args = client.startAgentArgs
    expect(args?.argv).not.toContain("--permission-mode")
    expect(args?.argv).not.toContain("--dangerously-skip-permissions")
  })

  test("opencode では permission_mode を付けない", async () => {
    const client = makeMockHerdrClient({})
    const runner = new HerdrAgentRunner(makeConfig(), {
      herdrClient: client,
      pollIntervalMs: 10,
      reportResolver: nullReportResolver(),
    })

    await runner.runIssue(makeIssue(), {
      content: "Fix the bug",
      agentKind: "opencode",
      attempt: null,
      workspacePath: "/repo/worktree",
      permissionMode: "bypassPermissions",
    })

    const args = client.startAgentArgs
    expect(args?.argv).not.toContain("--permission-mode")
    expect(args?.argv).not.toContain("--dangerously-skip-permissions")
  })

  test("claude では --agent を付けない", async () => {
    const client = makeMockHerdrClient({})
    const runner = new HerdrAgentRunner(makeConfig(), {
      herdrClient: client,
      pollIntervalMs: 10,
      reportResolver: nullReportResolver(),
    })

    await runner.runIssue(makeIssue(), {
      content: "Fix the bug",
      agentKind: "claude",
      attempt: null,
      workspacePath: "/repo/worktree",
      agent: "build",
    })

    const args = client.startAgentArgs
    expect(args?.argv).not.toContain("--agent")
    expect(args?.argv).not.toContain("build")
  })

  test("working 前の idle は完了とみなさず、working 後の idle で完了する", async () => {
    const client = makeMockHerdrClient({
      getAgentResult: [
        { name: "TEST-1", state: "idle", paneId: "w1:p1", workspaceId: "w1" },
        { name: "TEST-1", state: "working", paneId: "w1:p1", workspaceId: "w1" },
        { name: "TEST-1", state: "idle", paneId: "w1:p1", workspaceId: "w1" },
      ],
      readText: "Done.",
    })
    const runner = new HerdrAgentRunner(makeConfig(), {
      herdrClient: client,
      pollIntervalMs: 10,
      reportResolver: nullReportResolver(),
    })

    const result = await runner.runIssue(makeIssue(), {
      content: "Fix the bug",
      agentKind: "claude",
      attempt: null,
      workspacePath: "/repo/worktree",
    })

    expect(result.status).toBe("succeeded")
    expect(result.responseText).toBe("Done.")
    expect(client.getAgentCallCount).toBeGreaterThanOrEqual(3)
  })

  test("working 前の null は完了とみなさず、working 後の null で完了する", async () => {
    const client = makeMockHerdrClient({
      getAgentResult: [
        null,
        { name: "TEST-1", state: "working", paneId: "w1:p1", workspaceId: "w1" },
        null,
      ],
      readText: "Done.",
    })
    const runner = new HerdrAgentRunner(makeConfig(), {
      herdrClient: client,
      pollIntervalMs: 10,
      reportResolver: nullReportResolver(),
    })

    const result = await runner.runIssue(makeIssue(), {
      content: "Fix the bug",
      agentKind: "claude",
      attempt: null,
      workspacePath: "/repo/worktree",
    })

    expect(result.status).toBe("succeeded")
    expect(result.responseText).toBe("Done.")
    expect(client.getAgentCallCount).toBeGreaterThanOrEqual(3)
  })

  test("working を一度も観測せず idle が続く場合はタイムアウトする", async () => {
    const client = makeMockHerdrClient({
      getAgentResult: { name: "TEST-1", state: "idle", paneId: "w1:p1", workspaceId: "w1" },
    })
    const runner = new HerdrAgentRunner(makeConfig(), {
      herdrClient: client,
      pollIntervalMs: 10,
      reportResolver: nullReportResolver(),
    })

    const result = await runner.runIssue(makeIssue(), {
      content: "Fix the bug",
      agentKind: "claude",
      attempt: null,
      workspacePath: "/repo/worktree",
      timeoutMs: 50,
    })

    expect(result.status).toBe("timeout")
  })

  test("cancelRun が pane を閉じる", async () => {
    const captured = { paneId: null as string | null }
    const client: HerdrClient = {
      async ensureWorkspace() {
        return { id: "w1", label: "TEST-1", cwd: "/repo" }
      },
      async startAgent() {
        return { name: "TEST-1", state: "working", paneId: "w1:p1", workspaceId: "w1" }
      },
      async waitAgent() {
        return null
      },
      async readAgent() {
        return ""
      },
      async getAgent() {
        return null
      },
      async sendInput() {},
      async sendKeys() {},
      async closePane(paneId: string) {
        captured.paneId = paneId
      },
    }
    const runner = new HerdrAgentRunner(makeConfig(), {
      herdrClient: client,
      reportResolver: nullReportResolver(),
    })

    await runner.cancelRun("w1:p1")

    expect(captured.paneId).toBe("w1:p1")
  })
})
