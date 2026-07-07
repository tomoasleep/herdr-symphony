import { describe, expect, test } from "bun:test"
import type { AgmsgClient } from "../../agmsg/agmsg-client"
import { formatAgmsgMessage } from "../../agmsg/agmsg-message"
import type { Issue, ServiceConfig } from "../../domain/types"
import type { HerdrAgentInfo, HerdrClient, HerdrWorkspaceInfo } from "../../herdr/herdr-client"
import { buildAgentName, HerdrAgentRunner } from "./herdr-agent-runner"
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

function makeMockAgmsgClient(opts: {
  inboxReport?: { status: "done" | "pending" | "failed"; summary: string; issueId?: string } | null
  inboxResponses?: string[]
  noTaskAck?: boolean
  onSend?: (team: string, from: string, to: string, body: string) => void
}): AgmsgClient & {
  joinCalls: { team: string; agent: string; type: string; projectPath: string }[]
  deliveryCalls: { mode: string; type: string; projectPath: string }[]
  sendCalls: { team: string; from: string; to: string; body: string }[]
  setInboxResponse: (response: string | null) => void
} {
  const joinCalls: { team: string; agent: string; type: string; projectPath: string }[] = []
  const deliveryCalls: { mode: string; type: string; projectPath: string }[] = []
  const sendCalls: { team: string; from: string; to: string; body: string }[] = []
  let inboxResponse: string | null = null
  const taskAck = formatAgmsgMessage({
    kind: "herdr-symphony.ack",
    issueId: "issue-1",
    runId: "TEST-1-ly02lc00",
    toAgent: "herdr-symphony",
    ackOf: "task",
  })
  const inboxResponses = [...(opts.inboxResponses ?? [])]
  if (!opts.noTaskAck && opts.inboxResponses === undefined) {
    inboxResponses.push(`1 new message(s):\n\n [ts] AGENT: ${taskAck}`)
  }

  function buildInboxOutput(report: {
    status: "done" | "pending" | "failed"
    summary: string
    issueId?: string
  }): string {
    const body = formatAgmsgMessage({
      kind: "herdr-symphony.report",
      issueId: report.issueId ?? "issue-1",
      runId: "TEST-1-ly02lc00",
      toAgent: "herdr-symphony",
      status: report.status,
      summary: report.summary,
    })
    return `1 new message(s):\n\n [2026-07-03T12:00:00Z] AGENT: ${body}`
  }

  if (opts.inboxReport !== undefined && opts.inboxReport !== null) {
    if (opts.inboxResponses === undefined) {
      inboxResponses.push(buildInboxOutput(opts.inboxReport))
    } else {
      inboxResponse = buildInboxOutput(opts.inboxReport)
    }
  }

  return {
    async join(team, agent, type, projectPath) {
      joinCalls.push({ team, agent, type, projectPath })
    },
    async setDelivery(mode, type, projectPath) {
      deliveryCalls.push({ mode, type, projectPath })
    },
    async send(team, from, to, body) {
      sendCalls.push({ team, from, to, body })
      opts.onSend?.(team, from, to, body)
    },
    async inbox() {
      if (inboxResponses.length > 0) {
        return inboxResponses.shift() ?? "0 new message(s):\n"
      }
      return inboxResponse ?? "0 new message(s):\n"
    },
    get joinCalls() {
      return joinCalls
    },
    get deliveryCalls() {
      return deliveryCalls
    },
    get sendCalls() {
      return sendCalls
    },
    setInboxResponse(response: string | null) {
      inboxResponse = response
    },
  } as AgmsgClient & {
    joinCalls: { team: string; agent: string; type: string; projectPath: string }[]
    deliveryCalls: { mode: string; type: string; projectPath: string }[]
    sendCalls: { team: string; from: string; to: string; body: string }[]
    setInboxResponse: (response: string | null) => void
  }
}

describe("HerdrAgentRunner", () => {
  describe("buildAgentName", () => {
    test("identifier と workflowName と timestamp を結合する", () => {
      expect(buildAgentName("TEST-1", "e2e-test-claude.md", 1_719_662_400_000)).toBe(
        "TEST-1-e2e-test-claude-ly02lc00",
      )
    })

    test("workflowName が無い場合は identifier と timestamp だけ", () => {
      expect(buildAgentName("TEST-1", undefined, 1_719_662_400_000)).toBe("TEST-1-ly02lc00")
    })

    test("workflowName に拡張子がある場合は除外される", () => {
      expect(buildAgentName("PROJ-42", "WORKFLOW.exec.md", 1_719_662_400_000)).toBe(
        "PROJ-42-WORKFLOW.exec-ly02lc00",
      )
    })
  })

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
    const agmsg = makeMockAgmsgClient({
      inboxReport: { status: "done", summary: "実装と検証が完了しました" },
    })
    const client = makeMockHerdrClient({
      getAgentResult: [
        { name: "TEST-1", state: "working", paneId: "w1:p1", workspaceId: "w1" },
        { name: "TEST-1", state: "idle", paneId: "w1:p1", workspaceId: "w1" },
      ],
    })
    const runner = new HerdrAgentRunner(makeConfig(), {
      herdrClient: client,
      agmsgClient: agmsg,
      pollIntervalMs: 10,
      reportResolver: nullReportResolver(),
      now: () => 1_719_662_400_000,
    })

    const result = await runner.runIssue(makeIssue(), {
      content: "Fix the bug",
      agentKind: "claude",
      attempt: null,
      workspacePath: "/repo/worktree",
      agmsg: { team: "herdr-symphony", orchestratorAgent: "herdr-symphony" },
    })

    expect(result.status).toBe("succeeded")
    expect(result.responseText).toBe("実装と検証が完了しました")
  })

  test("claude は failed report がある場合に failed になる", async () => {
    const agmsg = makeMockAgmsgClient({
      inboxReport: { status: "failed", summary: "テストが失敗しました" },
    })
    const client = makeMockHerdrClient({
      getAgentResult: [
        { name: "TEST-1", state: "working", paneId: "w1:p1", workspaceId: "w1" },
        { name: "TEST-1", state: "idle", paneId: "w1:p1", workspaceId: "w1" },
      ],
    })
    const runner = new HerdrAgentRunner(makeConfig(), {
      herdrClient: client,
      agmsgClient: agmsg,
      pollIntervalMs: 10,
      reportResolver: nullReportResolver(),
      now: () => 1_719_662_400_000,
    })

    const result = await runner.runIssue(makeIssue(), {
      content: "Fix the bug",
      agentKind: "claude",
      attempt: null,
      workspacePath: "/repo/worktree",
      agmsg: { team: "herdr-symphony", orchestratorAgent: "herdr-symphony" },
    })

    expect(result.status).toBe("failed")
    expect(result.error).toBe("テストが失敗しました")
  })

  test("claude は pending report では完了しない", async () => {
    const ack = formatAgmsgMessage({
      kind: "herdr-symphony.ack",
      issueId: "issue-1",
      runId: "TEST-1-ly02lc00",
      toAgent: "herdr-symphony",
      ackOf: "task",
    })
    const pending = formatAgmsgMessage({
      kind: "herdr-symphony.report",
      issueId: "issue-1",
      runId: "TEST-1-ly02lc00",
      toAgent: "herdr-symphony",
      status: "pending",
      summary: "background task 待ち",
    })
    const done = formatAgmsgMessage({
      kind: "herdr-symphony.report",
      issueId: "issue-1",
      runId: "TEST-1-ly02lc00",
      toAgent: "herdr-symphony",
      status: "done",
      summary: "完了",
    })
    const agmsg = makeMockAgmsgClient({
      inboxResponses: [
        `1 new message(s):\n\n [ts] AGENT: ${ack}`,
        `2 new message(s):\n\n [ts] AGENT: ${pending}\n [ts] AGENT: ${done}`,
      ],
    })
    const client = makeMockHerdrClient({
      getAgentResult: [
        { name: "TEST-1", state: "working", paneId: "w1:p1", workspaceId: "w1" },
        { name: "TEST-1", state: "idle", paneId: "w1:p1", workspaceId: "w1" },
      ],
    })
    const runner = new HerdrAgentRunner(makeConfig(), {
      herdrClient: client,
      agmsgClient: agmsg,
      pollIntervalMs: 1,
      reportResolver: nullReportResolver(),
      now: () => 1_719_662_400_000,
    })

    const result = await runner.runIssue(makeIssue(), {
      content: "Fix the bug",
      agentKind: "claude",
      attempt: null,
      workspacePath: "/repo/worktree",
      timeoutMs: 200,
      agmsg: { team: "herdr-symphony", orchestratorAgent: "herdr-symphony" },
    })

    expect(result.status).toBe("succeeded")
    expect(result.responseText).toBe("完了")
    expect(agmsg.sendCalls).toHaveLength(1)
    expect(agmsg.sendCalls[0]?.body).toContain("herdr-symphony.task")
  })

  test("claude は idle で report がない場合に agmsg で reminder を送る", async () => {
    let reminderSent = false
    const agmsg = makeMockAgmsgClient({
      inboxReport: null,
      onSend: (_team, _from, _to, body) => {
        if (!reminderSent && body.includes("herdr-symphony.reminder")) {
          reminderSent = true
          agmsg.setInboxResponse(
            `1 new message(s):\n\n [ts] AGENT: ${formatAgmsgMessage({
              kind: "herdr-symphony.report",
              issueId: "issue-1",
              runId: "TEST-1-ly02lc00",
              toAgent: "herdr-symphony",
              status: "done",
              summary: "リマインド後に完了",
            })}`,
          )
        }
      },
    })
    const client = makeMockHerdrClient({
      getAgentResult: [
        { name: "TEST-1", state: "working", paneId: "w1:p1", workspaceId: "w1" },
        { name: "TEST-1", state: "idle", paneId: "w1:p1", workspaceId: "w1" },
        { name: "TEST-1", state: "working", paneId: "w1:p1", workspaceId: "w1" },
        { name: "TEST-1", state: "idle", paneId: "w1:p1", workspaceId: "w1" },
      ],
    })
    const runner = new HerdrAgentRunner(makeConfig(), {
      herdrClient: client,
      agmsgClient: agmsg,
      pollIntervalMs: 10,
      reportResolver: nullReportResolver(),
      now: () => 1_719_662_400_000,
    })

    const result = await runner.runIssue(makeIssue(), {
      content: "Fix the bug",
      agentKind: "claude",
      attempt: null,
      workspacePath: "/repo/worktree",
      agmsg: { team: "herdr-symphony", orchestratorAgent: "herdr-symphony" },
    })

    expect(result.status).toBe("succeeded")
    expect(agmsg.sendCalls.length).toBeGreaterThanOrEqual(1)
    expect(agmsg.sendCalls.some((call) => call.body.includes("herdr-symphony.reminder"))).toBe(true)
    expect(client.sentInputs).toHaveLength(0)
    expect(client.sentKeys).toHaveLength(0)
  })

  test("claude は agent が null でも sawActive 後なら inbox 確認と reminder 送信を行う", async () => {
    let reminderSent = false
    const agmsg = makeMockAgmsgClient({
      inboxReport: null,
      onSend: (_team, _from, _to, body) => {
        if (!reminderSent && body.includes("herdr-symphony.reminder")) {
          reminderSent = true
          agmsg.setInboxResponse(
            `1 new message(s):\n\n [ts] AGENT: ${formatAgmsgMessage({
              kind: "herdr-symphony.report",
              issueId: "issue-1",
              runId: "TEST-1-ly02lc00",
              toAgent: "herdr-symphony",
              status: "done",
              summary: "null 後のリマインドで完了",
            })}`,
          )
        }
      },
    })
    const client = makeMockHerdrClient({
      getAgentResult: [
        { name: "TEST-1", state: "working", paneId: "w1:p1", workspaceId: "w1" },
        null,
        { name: "TEST-1", state: "working", paneId: "w1:p1", workspaceId: "w1" },
        { name: "TEST-1", state: "idle", paneId: "w1:p1", workspaceId: "w1" },
      ],
    })
    const runner = new HerdrAgentRunner(makeConfig(), {
      herdrClient: client,
      agmsgClient: agmsg,
      pollIntervalMs: 10,
      reportResolver: nullReportResolver(),
      now: () => 1_719_662_400_000,
    })

    const result = await runner.runIssue(makeIssue(), {
      content: "Fix the bug",
      agentKind: "claude",
      attempt: null,
      workspacePath: "/repo/worktree",
      agmsg: { team: "herdr-symphony", orchestratorAgent: "herdr-symphony" },
    })

    expect(result.status).toBe("succeeded")
    expect(agmsg.sendCalls.length).toBeGreaterThanOrEqual(1)
  })

  test("claude 起動前に orchestrator と Claude agent が join される", async () => {
    const agmsg = makeMockAgmsgClient({ inboxReport: null })
    const client = makeMockHerdrClient({})
    const runner = new HerdrAgentRunner(makeConfig(), {
      herdrClient: client,
      agmsgClient: agmsg,
      pollIntervalMs: 10,
      reportResolver: nullReportResolver(),
      now: () => 1_719_662_400_000,
    })

    await runner.runIssue(makeIssue(), {
      content: "Fix the bug",
      agentKind: "claude",
      attempt: null,
      workspacePath: "/repo/worktree",
      timeoutMs: 50,
      agmsg: { team: "herdr-symphony", orchestratorAgent: "herdr-symphony" },
    })

    const agents = agmsg.joinCalls.map((c) => c.agent)
    expect(agents).toContain("herdr-symphony")
    expect(agents).toContain("TEST-1-ly02lc00")
    expect(agmsg.joinCalls.every((c) => c.team === "herdr-symphony-TEST-1-ly02lc00")).toBe(true)
  })

  test("agmsg に渡す agentName は agmsg が弾く文字を sanitize する", async () => {
    const runId = "tomoasleep_herdr-symphony#1-e2e_test_claude-ly02lc00"
    const ack = formatAgmsgMessage({
      kind: "herdr-symphony.ack",
      issueId: "issue-1",
      runId,
      toAgent: "herdr-symphony",
      ackOf: "task",
    })
    const report = formatAgmsgMessage({
      kind: "herdr-symphony.report",
      issueId: "issue-1",
      runId,
      toAgent: "herdr-symphony",
      status: "done",
      summary: "完了しました",
    })
    const agmsg = makeMockAgmsgClient({
      inboxResponses: [
        `1 new message(s):\n\n [ts] AGENT: ${ack}`,
        `1 new message(s):\n\n [2026-07-03T12:00:00Z] AGENT: ${report}`,
      ],
    })
    const client = makeMockHerdrClient({
      getAgentResult: {
        name: "tomoasleep/herdr-symphony#1",
        state: "done",
        paneId: "w1:p1",
        workspaceId: "w1",
      },
    })
    const runner = new HerdrAgentRunner(makeConfig(), {
      herdrClient: client,
      agmsgClient: agmsg,
      pollIntervalMs: 10,
      reportResolver: nullReportResolver(),
      now: () => 1_719_662_400_000,
    })
    const issue = makeIssue({ identifier: "tomoasleep/herdr-symphony#1" })

    await runner.runIssue(issue, {
      content: "Fix the bug",
      agentKind: "claude",
      attempt: null,
      workspacePath: "/repo/worktree",
      workflowName: "e2e.test.claude.md",
      timeoutMs: 50,
      agmsg: { team: "herdr-symphony", orchestratorAgent: "herdr-symphony" },
    })

    const claudeJoin = agmsg.joinCalls.find((c) => c.type === "claude-code")
    expect(claudeJoin?.agent).toBe(runId)
    expect(claudeJoin?.team).toBe(
      `herdr-symphony-tomoasleep_herdr-symphony_1-e2e_test_claude-ly02lc00`,
    )
    expect(client.startAgentArgs?.name).toBe("tomoasleep/herdr-symphony#1-e2e.test.claude-ly02lc00")
  })

  test("Claude delivery が monitor に設定される", async () => {
    const agmsg = makeMockAgmsgClient({ inboxReport: null })
    const client = makeMockHerdrClient({})
    const runner = new HerdrAgentRunner(makeConfig(), {
      herdrClient: client,
      agmsgClient: agmsg,
      pollIntervalMs: 10,
      reportResolver: nullReportResolver(),
      now: () => 1_719_662_400_000,
    })

    await runner.runIssue(makeIssue(), {
      content: "Fix the bug",
      agentKind: "claude",
      attempt: null,
      workspacePath: "/repo/worktree",
      timeoutMs: 50,
      agmsg: { team: "herdr-symphony", orchestratorAgent: "herdr-symphony" },
    })

    expect(agmsg.deliveryCalls).toHaveLength(1)
    expect(agmsg.deliveryCalls[0]?.mode).toBe("monitor")
    expect(agmsg.deliveryCalls[0]?.type).toBe("claude-code")
  })

  test("Claude の argv には bootstrap prompt が渡り実タスクは agmsg task で送られる", async () => {
    const ack = formatAgmsgMessage({
      kind: "herdr-symphony.ack",
      issueId: "issue-1",
      runId: "TEST-1-ly02lc00",
      toAgent: "herdr-symphony",
      ackOf: "task",
    })
    const agmsg = makeMockAgmsgClient({
      inboxResponses: [`1 new message(s):\n\n [ts] AGENT: ${ack}`],
    })
    const client = makeMockHerdrClient({})
    const runner = new HerdrAgentRunner(makeConfig(), {
      herdrClient: client,
      agmsgClient: agmsg,
      pollIntervalMs: 10,
      reportResolver: nullReportResolver(),
      now: () => 1_719_662_400_000,
    })

    await runner.runIssue(makeIssue({ id: "issue-1" }), {
      content: "Fix the bug",
      agentKind: "claude",
      attempt: null,
      workspacePath: "/repo/worktree",
      timeoutMs: 50,
      agmsg: {
        team: "herdr-symphony-TEST-1-ly02lc00",
        orchestratorAgent: "herdr-symphony",
      },
    })

    const args = client.startAgentArgs
    expect(args?.argv[args.argv.length - 1]).toContain("実タスクは agmsg で届きます")
    expect(args?.argv[args.argv.length - 1]).toContain("actas-claim.sh")
    expect(args?.argv[args.argv.length - 1]).not.toBe("Fix the bug")
    expect(agmsg.sendCalls[0]?.team).toBe("herdr-symphony-TEST-1-ly02lc00")
    expect(agmsg.sendCalls[0]?.to).toBe("TEST-1-ly02lc00")
    expect(JSON.parse(agmsg.sendCalls[0]?.body ?? "{}")).toMatchObject({
      kind: "herdr-symphony.task",
      runId: "TEST-1-ly02lc00",
      toAgent: "TEST-1-ly02lc00",
      issueId: "issue-1",
      prompt: "Fix the bug",
    })
  })

  test("Claude は task ack が返らない場合に task を再送し handshake timeout で failed になる", async () => {
    const agmsg = makeMockAgmsgClient({ inboxResponses: [], noTaskAck: true })
    const client = makeMockHerdrClient({})
    const runner = new HerdrAgentRunner(makeConfig(), {
      herdrClient: client,
      agmsgClient: agmsg,
      pollIntervalMs: 10,
      reportResolver: nullReportResolver(),
      now: () => 1_719_662_400_000,
    })

    const result = await runner.runIssue(makeIssue({ id: "issue-1" }), {
      content: "Fix the bug",
      agentKind: "claude",
      attempt: null,
      workspacePath: "/repo/worktree",
      timeoutMs: 500,
      agmsg: {
        team: "herdr-symphony-TEST-1-ly02lc00",
        orchestratorAgent: "herdr-symphony",
        handshakeTimeoutMs: 30,
        ackResendIntervalMs: 10,
      },
    })

    expect(result.status).toBe("failed")
    expect(result.error).toContain("agmsg delivery handshake timed out")
    expect(agmsg.sendCalls.length).toBeGreaterThanOrEqual(2)
  })

  test("opencode は agmsg を使わず従来通り", async () => {
    const agmsg = makeMockAgmsgClient({ inboxReport: null })
    const client = makeMockHerdrClient({
      getAgentResult: [
        { name: "TEST-1", state: "working", paneId: "w1:p1", workspaceId: "w1" },
        { name: "TEST-1", state: "idle", paneId: "w1:p1", workspaceId: "w1" },
      ],
      readText: "Done.",
    })
    const runner = new HerdrAgentRunner(makeConfig(), {
      herdrClient: client,
      agmsgClient: agmsg,
      pollIntervalMs: 10,
      reportResolver: nullReportResolver(),
    })

    const result = await runner.runIssue(makeIssue(), {
      content: "Fix the bug",
      agentKind: "opencode",
      attempt: null,
      workspacePath: "/repo/worktree",
      agmsg: { team: "herdr-symphony", orchestratorAgent: "herdr-symphony" },
    })

    expect(result.status).toBe("succeeded")
    expect(agmsg.joinCalls).toHaveLength(0)
    expect(agmsg.deliveryCalls).toHaveLength(0)
    expect(agmsg.sendCalls).toHaveLength(0)
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

  test("working を観測しなくても agent を検出後に null になれば完了とみなす", async () => {
    const client = makeMockHerdrClient({
      getAgentResult: [{ name: "TEST-1", state: "idle", paneId: "w1:p1", workspaceId: "w1" }, null],
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
