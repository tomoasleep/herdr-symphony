import { describe, expect, test } from "bun:test"
import type { Issue, ServiceConfig } from "../../domain/types"
import type { HerdrAgentInfo, HerdrClient, HerdrWorkspaceInfo } from "../../herdr/herdr-client"
import { HerdrAgentRunner } from "./herdr-agent-runner"

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
        claude: { model: null },
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
      ...overrides,
    },
  }
}

function makeMockHerdrClient(opts: {
  workspace?: HerdrWorkspaceInfo
  agentStarted?: HerdrAgentInfo
  getAgentResult?: HerdrAgentInfo | null
  readText?: string
}): HerdrClient & { startAgentArgs: { name: string; argv: string[] } | null } {
  let startAgentArgs: { name: string; argv: string[] } | null = null
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
      return opts.getAgentResult !== undefined ? opts.getAgentResult : null
    },
    async closePane() {},
    get startAgentArgs() {
      return startAgentArgs
    },
  } as HerdrClient & { startAgentArgs: { name: string; argv: string[] } | null }
}

describe("HerdrAgentRunner", () => {
  test("正常系: workspace 作成 → agent 起動 → done 待機 → 出力取得", async () => {
    const client = makeMockHerdrClient({
      readText: "Implementation complete.",
    })
    const runner = new HerdrAgentRunner(makeConfig(), { herdrClient: client, pollIntervalMs: 10 })
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

  test("opencode argv に model と agent が含まれる", async () => {
    const client = makeMockHerdrClient({})
    const runner = new HerdrAgentRunner(makeConfig(), { herdrClient: client, pollIntervalMs: 10 })

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
    const runner = new HerdrAgentRunner(makeConfig(), { herdrClient: client, pollIntervalMs: 10 })

    await runner.runIssue(makeIssue(), {
      content: "Implement feature X",
      agentKind: "opencode",
      attempt: null,
      workspacePath: "/repo/worktree",
    })

    const args = client.startAgentArgs
    expect(args?.argv.includes("Implement feature X")).toBe(true)
  })

  test("agent name に issue identifier が使われる", async () => {
    const client = makeMockHerdrClient({})
    const runner = new HerdrAgentRunner(makeConfig(), { herdrClient: client, pollIntervalMs: 10 })
    const issue = makeIssue({ identifier: "PROJ-42" })

    await runner.runIssue(issue, {
      content: "Do work",
      agentKind: "opencode",
      attempt: null,
      workspacePath: "/repo/worktree",
    })

    expect(client.startAgentArgs?.name).toBe("PROJ-42")
  })

  test("workspace label が解決される", async () => {
    let receivedLabel = ""
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
        return null
      },
      async closePane() {},
    }
    const runner = new HerdrAgentRunner(makeConfig(), { herdrClient: client, pollIntervalMs: 10 })

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
    const runner = new HerdrAgentRunner(makeConfig(), { herdrClient: client, pollIntervalMs: 10 })

    const result = await runner.runIssue(makeIssue(), {
      content: "Fix the bug",
      agentKind: "opencode",
      attempt: null,
      workspacePath: "/repo/worktree",
      timeoutMs: 50,
    })

    expect(result.status).toBe("timeout")
  })

  test("agent が blocked の場合は timeout 扱い", async () => {
    const client = makeMockHerdrClient({
      getAgentResult: { name: "TEST-1", state: "blocked", paneId: "w1:p1", workspaceId: "w1" },
    })
    const runner = new HerdrAgentRunner(makeConfig(), { herdrClient: client, pollIntervalMs: 10 })

    const result = await runner.runIssue(makeIssue(), {
      content: "Fix the bug",
      agentKind: "opencode",
      attempt: null,
      workspacePath: "/repo/worktree",
    })

    expect(result.status).toBe("timeout")
  })

  test("model 未指定時は --model を付けない", async () => {
    const client = makeMockHerdrClient({})
    const runner = new HerdrAgentRunner(makeConfig(), { herdrClient: client, pollIntervalMs: 10 })

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

  test("claude argv に claude --print が含まれる", async () => {
    const client = makeMockHerdrClient({})
    const runner = new HerdrAgentRunner(makeConfig(), { herdrClient: client, pollIntervalMs: 10 })

    await runner.runIssue(makeIssue(), {
      content: "Fix the bug",
      agentKind: "claude",
      attempt: null,
      workspacePath: "/repo/worktree",
    })

    const args = client.startAgentArgs
    expect(args?.argv[0]).toBe("claude")
    expect(args?.argv[1]).toBe("--print")
    expect(args?.argv.includes("Fix the bug")).toBe(true)
  })

  test("claude に model が渡される", async () => {
    const client = makeMockHerdrClient({})
    const runner = new HerdrAgentRunner(makeConfig(), { herdrClient: client, pollIntervalMs: 10 })

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

  test("claude では --agent を付けない", async () => {
    const client = makeMockHerdrClient({})
    const runner = new HerdrAgentRunner(makeConfig(), { herdrClient: client, pollIntervalMs: 10 })

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
      async closePane(paneId: string) {
        captured.paneId = paneId
      },
    }
    const runner = new HerdrAgentRunner(makeConfig(), { herdrClient: client })

    await runner.cancelRun("w1:p1")

    expect(captured.paneId).toBe("w1:p1")
  })
})
