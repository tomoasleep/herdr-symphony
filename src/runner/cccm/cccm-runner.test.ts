import { describe, expect, test } from "bun:test"
import type { Issue, ServiceConfig } from "../../domain/types"
import type { RunnerOptions } from "../types"
import { CccmRunner } from "./cccm-runner"

class FakeStreamProcess {
  exitCode: number | null = null
  private listeners: ((chunk: string) => void)[] = []
  private closeListeners: ((code: number) => void)[] = []
  killed = false

  writeStdout(chunk: string): void {
    for (const listener of this.listeners) {
      listener(chunk)
    }
  }

  close(code: number): void {
    if (this.exitCode !== null) return
    this.exitCode = code
    for (const listener of this.closeListeners) {
      listener(code)
    }
  }

  kill(): void {
    this.killed = true
    this.close(137)
  }

  onData(listener: (chunk: string) => void): void {
    this.listeners.push(listener)
  }

  onClose(listener: (code: number) => void): void {
    this.closeListeners.push(listener)
  }
}

function launchedLine(hub: string): string {
  return JSON.stringify({
    type: "launched",
    session_id: "session_01",
    session_url: "https://claude.ai/code/session_01",
    hub,
    comment_url: "https://github.com/owner/repo/issues/123#issuecomment-1",
  })
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    identifier: "owner/repo#123",
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
      if: null,
      activeStates: ["Ready"],
      terminalStates: ["Done"],
      runningState: null,
      successState: null,
      failureState: null,
      stoppedState: null,
      runner: "cccm",
      herdrAgent: {
        agent: "opencode",
        opencode: {
          model: null,
          agent: null,
          thinkingEffort: null,
          interactive: false,
          env: {},
        },
        claude: {
          model: null,
          permissionMode: null,
          thinkingEffort: null,
          messenger: "report_file",
          pendingRemindIntervalMs: 900_000,
          reminderGracePeriodMs: 180_000,
          env: {},
        },
        workspaceLabel: null,
        turnTimeoutMs: null,
        closePaneAfterDoneMs: null,
        onBlocked: null,
      },
      cccm: {
        via: "cloud",
        routine: null,
        envId: null,
        hub: null,
        claudeOptions: [],
        ackTimeoutMs: 300_000,
        reminderGraceMs: 180_000,
        pendingRemindIntervalMs: 900_000,
      },
      workspace: {
        provider: "none",
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

function makeOptions(overrides: Partial<RunnerOptions> = {}): RunnerOptions {
  return {
    content: "Issue を解決してください",
    attempt: null,
    workspacePath: "/repo",
    agentKind: "claude",
    ...overrides,
  }
}

type SpawnRecord = {
  command: string
  args: string[]
  proc: FakeStreamProcess
}

function makeSpawn(): {
  records: SpawnRecord[]
  spawnProcess: (command: string, args: string[]) => FakeStreamProcess
} {
  const records: SpawnRecord[] = []
  return {
    records,
    spawnProcess(command: string, args: string[]): FakeStreamProcess {
      const proc = new FakeStreamProcess()
      records.push({ command, args: [...args], proc })
      return proc
    },
  }
}

async function startRunner(
  runner: CccmRunner,
  issue: Issue,
  options: RunnerOptions,
  records: SpawnRecord[],
  hub: string,
): Promise<ReturnType<CccmRunner["startIssue"]>> {
  const pending = runner.startIssue(issue, options)
  await waitForSpawn(records)
  records[0]!.proc.writeStdout(`${launchedLine(hub)}\n`)
  return await pending
}

async function waitForSpawn(records: SpawnRecord[]): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (records.length > 0) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error("no process spawned")
}

describe("CccmRunner", () => {
  test("startIssue が cccm launch を実行し session_id を handle に持つ", async () => {
    const { spawnProcess, records } = makeSpawn()
    const runner = new CccmRunner(makeConfig(), { spawnProcess })
    const issue = makeIssue()

    const handle = await startRunner(runner, issue, makeOptions(), records, "github:owner/repo#123")

    expect(records).toHaveLength(1)
    expect(records[0]!.command).toBe("cccm")
    expect(records[0]!.args).toContain("launch")
    expect(records[0]!.args).toContain("--hub")
    expect(records[0]!.args).toContain("github:owner/repo#123")
    expect(handle.sessionId).toBe("session_01")
    expect(handle.meta?.agentKind).toBe("claude")
    expect(handle.meta?.interactive).toBe(false)
  })

  test("hub 設定があれば tracker issue ではなくそちらを使う", async () => {
    const { spawnProcess, records } = makeSpawn()
    const config = makeConfig({
      cccm: {
        via: "cloud",
        routine: null,
        envId: null,
        hub: "github:other/repo#999",
        claudeOptions: [],
        ackTimeoutMs: 300_000,
        reminderGraceMs: 180_000,
        pendingRemindIntervalMs: 900_000,
      },
    })
    const runner = new CccmRunner(config, { spawnProcess })

    await startRunner(runner, makeIssue(), makeOptions(), records, "github:other/repo#999")

    expect(records[0]!.args).toContain("github:other/repo#999")
  })

  test("tracker issue に GitHub issue がない場合 startIssue が失敗する", async () => {
    const { spawnProcess } = makeSpawn()
    const runner = new CccmRunner(makeConfig(), { spawnProcess })

    expect(runner.startIssue(makeIssue({ identifier: "draft:1" }), makeOptions())).rejects.toThrow(
      "hub issue",
    )
  })

  test("routine 経由の設定で launch 引数を構築する", async () => {
    const { spawnProcess, records } = makeSpawn()
    const config = makeConfig({
      cccm: {
        via: "routine",
        routine: "my-hub",
        envId: null,
        hub: null,
        claudeOptions: [],
        ackTimeoutMs: 300_000,
        reminderGraceMs: 180_000,
        pendingRemindIntervalMs: 900_000,
      },
    })
    const runner = new CccmRunner(config, { spawnProcess })

    await startRunner(runner, makeIssue(), makeOptions(), records, "github:owner/repo#123")

    expect(records[0]!.args).toEqual([
      "launch",
      "--via",
      "routine",
      "--routine",
      "my-hub",
      "--ack-timeout",
      "300000ms",
      "--reminder-grace",
      "180000ms",
      "--pending-remind-interval",
      "900000ms",
      "--hub",
      "github:owner/repo#123",
      "--output-format",
      "stream-json",
      "Issue を解決してください",
    ])
  })

  test("cccm 設定の待ち時間と claude options を launch に渡す", async () => {
    const { spawnProcess, records } = makeSpawn()
    const config = makeConfig({
      cccm: {
        via: "cloud",
        routine: null,
        envId: "env_01",
        hub: null,
        claudeOptions: ["--model=opus"],
        ackTimeoutMs: 600_000,
        reminderGraceMs: 0,
        pendingRemindIntervalMs: 60_000,
      },
    })
    const runner = new CccmRunner(config, { spawnProcess })

    await startRunner(runner, makeIssue(), makeOptions(), records, "github:owner/repo#123")

    expect(records[0]!.args).toEqual([
      "launch",
      "--via",
      "cloud",
      "--env",
      "env_01",
      "--ack-timeout",
      "600000ms",
      "--reminder-grace",
      "0ms",
      "--pending-remind-interval",
      "60000ms",
      "--hub",
      "github:owner/repo#123",
      "--output-format",
      "stream-json",
      "--model=opus",
      "Issue を解決してください",
    ])
  })

  test("turnTimeoutMs があれば --timeout にミリ秒で渡す", async () => {
    const { spawnProcess, records } = makeSpawn()
    const config = makeConfig()
    config.work.herdrAgent.turnTimeoutMs = 7_200_000
    const runner = new CccmRunner(config, { spawnProcess })

    await startRunner(
      runner,
      makeIssue(),
      makeOptions({ timeoutMs: 7_200_000 }),
      records,
      "github:owner/repo#123",
    )

    expect(records[0]!.args).toContain("--timeout")
    expect(records[0]!.args).toContain("7200000ms")
  })

  test("done イベントで succeeded + summary を返す", async () => {
    const { spawnProcess, records } = makeSpawn()
    const runner = new CccmRunner(makeConfig(), { spawnProcess })

    const handle = await startRunner(
      runner,
      makeIssue(),
      makeOptions(),
      records,
      "github:owner/repo#123",
    )
    records[0]!.proc.writeStdout(`${JSON.stringify({ type: "done", summary: "完了した" })}\n`)
    records[0]!.proc.close(0)

    const poll = await runner.pollCompletion(handle)
    expect(poll.state).toBe("done")
    if (poll.state === "done") {
      expect(poll.result.status).toBe("succeeded")
      expect(poll.result.responseText).toBe("完了した")
      expect(poll.result.error).toBeNull()
    }
  })

  test("failed イベントで failed を返す", async () => {
    const { spawnProcess, records } = makeSpawn()
    const runner = new CccmRunner(makeConfig(), { spawnProcess })

    const handle = await startRunner(
      runner,
      makeIssue(),
      makeOptions(),
      records,
      "github:owner/repo#123",
    )
    records[0]!.proc.writeStdout(
      `${JSON.stringify({ type: "failed", reason: "reported", summary: "失敗した" })}\n`,
    )
    records[0]!.proc.close(1)

    const poll = await runner.pollCompletion(handle)
    expect(poll.state).toBe("done")
    if (poll.state === "done") {
      expect(poll.result.status).toBe("failed")
      expect(poll.result.error).toBe("失敗した")
    }
  })

  test("終了コード 3 (ack timeout) で failed を返す", async () => {
    const { spawnProcess, records } = makeSpawn()
    const runner = new CccmRunner(makeConfig(), { spawnProcess })

    const handle = await startRunner(
      runner,
      makeIssue(),
      makeOptions(),
      records,
      "github:owner/repo#123",
    )
    records[0]!.proc.close(3)

    const poll = await runner.pollCompletion(handle)
    expect(poll.state).toBe("done")
    if (poll.state === "done") {
      expect(poll.result.status).toBe("failed")
      expect(poll.result.error).toContain("ack")
    }
  })

  test("turn_timeout で deadline を超えると timeout を返す", async () => {
    const { spawnProcess, records } = makeSpawn()
    let currentTime = 1_000_000
    const runner = new CccmRunner(makeConfig(), {
      spawnProcess,
      now: () => currentTime,
    })

    const handle = await startRunner(
      runner,
      makeIssue(),
      makeOptions({ timeoutMs: 1_000 }),
      records,
      "github:owner/repo#123",
    )
    currentTime = 3_000_000

    const poll = await runner.pollCompletion(handle)
    expect(poll.state).toBe("done")
    if (poll.state === "done") {
      expect(poll.result.status).toBe("timeout")
    }
  })

  test("reattach が meta 付き handle で monitor を再開する", async () => {
    const { spawnProcess, records } = makeSpawn()
    const runner = new CccmRunner(makeConfig(), { spawnProcess })

    const handle = await startRunner(
      runner,
      makeIssue(),
      makeOptions(),
      records,
      "github:owner/repo#123",
    )
    records[0]!.proc.close(137)

    const pending = runner.reattach(handle)
    await waitForSpawn(records)
    records[1]!.proc.writeStdout(`${launchedLine("github:owner/repo#123")}\n`)
    const ok = await pending

    expect(ok).toBe(true)
    expect(records).toHaveLength(2)
    expect(records[1]!.args).toContain("monitor")
    expect(records[1]!.args).toContain("--session")
    expect(records[1]!.args).toContain("session_01")
    expect(records[1]!.args).toContain("github:owner/repo#123")
  })

  test("meta なしの handle は reattach できない", async () => {
    const { spawnProcess } = makeSpawn()
    const runner = new CccmRunner(makeConfig(), { spawnProcess })

    const ok = await runner.reattach({
      sessionId: "session_01",
      issueId: "issue-1",
      meta: undefined,
    })
    expect(ok).toBe(false)
  })

  test("cancelRun で monitor プロセスを kill する", async () => {
    const { spawnProcess, records } = makeSpawn()
    const runner = new CccmRunner(makeConfig(), { spawnProcess })

    const handle = await startRunner(
      runner,
      makeIssue(),
      makeOptions(),
      records,
      "github:owner/repo#123",
    )
    await runner.cancelRun(handle.sessionId)

    expect(records[0]!.proc.killed).toBe(true)
  })
})
