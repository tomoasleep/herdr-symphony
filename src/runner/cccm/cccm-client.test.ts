import { describe, expect, test } from "bun:test"
import { CccmClient, parseCccmEvent, parseCccmHubFromIdentifier } from "./cccm-client"

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

describe("parseCccmEvent", () => {
  test("launched イベントをパースする", () => {
    const line = JSON.stringify({
      type: "launched",
      session_id: "session_01",
      session_url: "https://claude.ai/code/session_01",
      hub: "github:owner/repo#123",
      comment_url: "https://github.com/owner/repo/issues/123#issuecomment-1",
    })

    const event = parseCccmEvent(line)

    expect(event).toEqual({
      type: "launched",
      sessionId: "session_01",
      sessionUrl: "https://claude.ai/code/session_01",
      hub: "github:owner/repo#123",
      commentUrl: "https://github.com/owner/repo/issues/123#issuecomment-1",
    })
  })

  test("done イベントをパースする", () => {
    const line = JSON.stringify({
      type: "done",
      summary: "作業を完了した",
      tasks: [{ subject: "a", done: true }],
      last_message: "last message",
      session_url: "https://claude.ai/code/session_01",
    })

    const event = parseCccmEvent(line)

    expect(event).toEqual({
      type: "done",
      summary: "作業を完了した",
      lastMessage: "last message",
      sessionUrl: "https://claude.ai/code/session_01",
    })
  })

  test("failed イベントをパースする", () => {
    const line = JSON.stringify({ type: "failed", reason: "reported", summary: "失敗した" })

    const event = parseCccmEvent(line)

    expect(event).toEqual({ type: "failed", reason: "reported", summary: "失敗した" })
  })

  test("pending イベントをパースする", () => {
    const event = parseCccmEvent(JSON.stringify({ type: "pending", summary: "待機中" }))

    expect(event).toEqual({ type: "pending", summary: "待機中" })
  })

  test("既知だが詳細のないイベントをパースする", () => {
    expect(parseCccmEvent(JSON.stringify({ type: "ack", at: "2026-01-01T00:00:00Z" }))).toEqual({
      type: "ack",
    })
    expect(parseCccmEvent(JSON.stringify({ type: "reminder", count: 1 }))).toEqual({
      type: "reminder",
    })
    expect(parseCccmEvent(JSON.stringify({ type: "turn_ended", turn: 1 }))).toEqual({
      type: "turn_ended",
    })
  })

  test("壊れた JSON 行は null を返す", () => {
    expect(parseCccmEvent("not json")).toBeNull()
  })

  test("type のない行は null を返す", () => {
    expect(parseCccmEvent(JSON.stringify({ foo: 1 }))).toBeNull()
  })
})

describe("parseCccmHubFromIdentifier", () => {
  test("owner/repo#number 形式から hub spec を作る", () => {
    expect(parseCccmHubFromIdentifier("owner/repo#123")).toBe("github:owner/repo#123")
  })

  test("draft: identifier は null を返す", () => {
    expect(parseCccmHubFromIdentifier("draft:123")).toBeNull()
  })

  test("owner/repo#number 形式でない identifier は null を返す", () => {
    expect(parseCccmHubFromIdentifier("schedule-abc-task")).toBeNull()
  })

  test("番号のない identifier は null を返す", () => {
    expect(parseCccmHubFromIdentifier("owner/repo#")).toBeNull()
  })
})

describe("CccmClient", () => {
  function launchedLine(): string {
    return JSON.stringify({
      type: "launched",
      session_id: "session_01",
      session_url: "https://claude.ai/code/session_01",
      hub: "github:owner/repo#123",
      comment_url: "https://github.com/owner/repo/issues/123#issuecomment-1",
    })
  }

  test("startMonitor で cccm monitor を spawn し launched まで待つ", async () => {
    const proc = new FakeStreamProcess()
    const spawned: { command: string; args: string[] }[] = []
    const client = new CccmClient({
      spawnProcess: (command, args) => {
        spawned.push({ command, args: [...args] })
        return proc as unknown as CccmStreamProcess
      },
    })

    const pending = client.startMonitor({
      hub: "github:owner/repo#123",
      sessionId: "session_01",
    })
    proc.writeStdout(`${launchedLine()}\n`)
    const handle = await pending

    expect(spawned).toEqual([
      {
        command: "cccm",
        args: [
          "monitor",
          "--hub",
          "github:owner/repo#123",
          "--session",
          "session_01",
          "--output-format",
          "stream-json",
        ],
      },
    ])
    expect(handle.sessionId).toBe("session_01")
    expect(handle.hub).toBe("github:owner/repo#123")
    expect(handle.commentUrl).toBe("https://github.com/owner/repo/issues/123#issuecomment-1")
  })

  test("startLaunch で cccm launch --no-wait を spawn する", async () => {
    const proc = new FakeStreamProcess()
    const spawned: { command: string; args: string[] }[] = []
    const client = new CccmClient({
      spawnProcess: (command, args) => {
        spawned.push({ command, args: [...args] })
        return proc as unknown as CccmStreamProcess
      },
    })

    const pending = client.startLaunch({
      via: "cloud",
      hub: "github:owner/repo#123",
      prompt: "Issue を解決してください",
    })
    proc.writeStdout(`${launchedLine()}\n`)
    await pending

    expect(spawned).toEqual([
      {
        command: "cccm",
        args: [
          "launch",
          "--via",
          "cloud",
          "--hub",
          "github:owner/repo#123",
          "--output-format",
          "stream-json",
          "--no-wait",
          "Issue を解決してください",
        ],
      },
    ])
  })

  test("launch は routine 経由のオプションを渡す", async () => {
    const proc = new FakeStreamProcess()
    const spawned: { command: string; args: string[] }[] = []
    const client = new CccmClient({
      spawnProcess: (command, args) => {
        spawned.push({ command, args: [...args] })
        return proc as unknown as CccmStreamProcess
      },
    })

    const pending = client.startLaunch({
      via: "routine",
      routine: "my-hub",
      hub: "github:owner/repo#123",
      prompt: "hello",
    })
    proc.writeStdout(`${launchedLine()}\n`)
    await pending

    expect(spawned[0]?.args).toEqual([
      "launch",
      "--via",
      "routine",
      "--routine",
      "my-hub",
      "--hub",
      "github:owner/repo#123",
      "--output-format",
      "stream-json",
      "--no-wait",
      "hello",
    ])
  })

  test("pollMonitor は done イベントで succeeded を返す", async () => {
    const proc = new FakeStreamProcess()
    const client = new CccmClient({
      spawnProcess: () => proc as unknown as CccmStreamProcess,
    })

    const handle = await startAndLaunch(client, proc, launchedLine())
    proc.writeStdout(`${JSON.stringify({ type: "done", summary: "完了した" })}\n`)
    proc.close(0)
    await waitForClose(handle)

    const result = client.pollMonitor(handle)
    expect(result.state).toBe("done")
    if (result.state === "done") {
      expect(result.result.status).toBe("succeeded")
      expect(result.result.responseText).toBe("完了した")
      expect(result.result.error).toBeNull()
    }
  })

  test("pollMonitor は failed イベントで failed を返す", async () => {
    const proc = new FakeStreamProcess()
    const client = new CccmClient({
      spawnProcess: () => proc as unknown as CccmStreamProcess,
    })

    const handle = await startAndLaunch(client, proc, launchedLine())
    proc.writeStdout(`${JSON.stringify({ type: "failed", reason: "reported", summary: "失敗" })}\n`)
    proc.close(1)
    await waitForClose(handle)

    const result = client.pollMonitor(handle)
    expect(result.state).toBe("done")
    if (result.state === "done") {
      expect(result.result.status).toBe("failed")
      expect(result.result.error).toBe("失敗")
    }
  })

  test("pollMonitor は exit 3 (ack timeout) で failed を返す", async () => {
    const proc = new FakeStreamProcess()
    const client = new CccmClient({
      spawnProcess: () => proc as unknown as CccmStreamProcess,
    })

    const handle = await startAndLaunch(client, proc, launchedLine())
    proc.close(3)
    await waitForClose(handle)

    const result = client.pollMonitor(handle)
    expect(result.state).toBe("done")
    if (result.state === "done") {
      expect(result.result.status).toBe("failed")
      expect(result.result.error).toContain("ack")
    }
  })

  test("pollMonitor は exit 4 (timeout) で failed を返す", async () => {
    const proc = new FakeStreamProcess()
    const client = new CccmClient({
      spawnProcess: () => proc as unknown as CccmStreamProcess,
    })

    const handle = await startAndLaunch(client, proc, launchedLine())
    proc.close(4)
    await waitForClose(handle)

    const result = client.pollMonitor(handle)
    expect(result.state).toBe("done")
    if (result.state === "done") {
      expect(result.result.status).toBe("failed")
      expect(result.result.error).toContain("timed out")
    }
  })

  test("pollMonitor は exit 5 (起動失敗) で failed を返す", async () => {
    const proc = new FakeStreamProcess()
    const client = new CccmClient({
      spawnProcess: () => proc as unknown as CccmStreamProcess,
    })

    const handle = await startAndLaunch(client, proc, launchedLine())
    proc.close(5)
    await waitForClose(handle)

    const result = client.pollMonitor(handle)
    expect(result.state).toBe("done")
    if (result.state === "done") {
      expect(result.result.status).toBe("failed")
      expect(result.result.error).toContain("launch failed")
    }
  })

  test("pollMonitor はまだ終了していなければ running を返す", async () => {
    const proc = new FakeStreamProcess()
    const client = new CccmClient({
      spawnProcess: () => proc as unknown as CccmStreamProcess,
    })

    const handle = await startAndLaunch(client, proc, launchedLine())
    proc.writeStdout(`${JSON.stringify({ type: "turn_ended", turn: 1 })}\n`)

    const result = client.pollMonitor(handle)
    expect(result.state).toBe("running")
  })

  test("pollMonitor は done イベント後もプロセス終了前なら running を返す", async () => {
    const proc = new FakeStreamProcess()
    const client = new CccmClient({
      spawnProcess: () => proc as unknown as CccmStreamProcess,
    })

    const handle = await startAndLaunch(client, proc, launchedLine())
    proc.writeStdout(`${JSON.stringify({ type: "done", summary: "完了した" })}\n`)

    const result = client.pollMonitor(handle)
    expect(result.state).toBe("running")
  })

  test("cancel はプロセスを kill する", async () => {
    const proc = new FakeStreamProcess()
    const client = new CccmClient({
      spawnProcess: () => proc as unknown as CccmStreamProcess,
    })

    const handle = await startAndLaunch(client, proc, launchedLine())
    client.cancel(handle)

    expect(proc.killed).toBe(true)
  })
})

async function startAndLaunch(
  client: CccmClient,
  proc: FakeStreamProcess,
  launchedLine: string,
): Promise<CccmMonitorHandle> {
  const pending = client.startMonitor({ hub: "github:owner/repo#123", sessionId: "session_01" })
  proc.writeStdout(`${launchedLine}\n`)
  return await pending
}

async function waitForClose(handle: CccmMonitorHandle): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (handle.hasExited()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error("process did not exit")
}

type CccmStreamProcessLike = {
  onData(listener: (chunk: string) => void): void
  onClose(listener: (code: number) => void): void
  kill(): void
}

type CccmStreamProcess = CccmStreamProcessLike

type CccmMonitorHandle = {
  sessionId: string
  hub: string
  commentUrl: string | null
  hasExited(): boolean
}
