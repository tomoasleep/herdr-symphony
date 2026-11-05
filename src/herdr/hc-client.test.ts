import { describe, expect, test } from "bun:test"
import { createHcClient } from "./hc-client"
import type { CommandResult, CommandRunner, RecordedCall } from "./herdr-client"

type ResponseFactory = CommandResult | ((args: string[]) => CommandResult)

function makeCommandRunner(responses: Record<string, ResponseFactory>): {
  runner: CommandRunner
  calls: RecordedCall[]
} {
  const calls: RecordedCall[] = []
  const runner: CommandRunner = async (command, args, cwd, env) => {
    calls.push({ command, args: [...args], cwd, env })
    const key = args[0] ?? ""
    const factory = responses[key]
    if (factory === undefined) {
      return { exitCode: 1, stdout: "", stderr: `no mock for: ${key}` }
    }
    if (typeof factory === "function") {
      return factory(args)
    }
    return factory
  }
  return { runner, calls }
}

const RUN_RESPONSE: CommandResult = {
  exitCode: 0,
  stdout: JSON.stringify({
    address: "t7",
    agent: "opencode",
    cwd: "/repo/worktree",
    state: "live",
    turn: 0,
  }),
  stderr: "",
}

const GET_LIVE_RESPONSE: CommandResult = {
  exitCode: 0,
  stdout: JSON.stringify({
    address: "t7",
    argv: ["opencode", "run", "hello"],
    cwd: "/repo/worktree",
    labels: { issue: "SYM-41" },
    name: "SYM-41-xyz",
    state: "live",
    status: { state: "working", app: "opencode" },
    reported: true,
  }),
  stderr: "",
}

describe("HcClient", () => {
  test("ensureWorkspace は hc コマンドを実行せずダミー workspace を返す", async () => {
    const { runner, calls } = makeCommandRunner({})
    const client = createHcClient({ runCommand: runner })

    const ws = await client.ensureWorkspace("/repo/worktree", "SYM-41")

    expect(ws).toEqual({
      id: "SYM-41",
      label: "SYM-41",
      cwd: "/repo/worktree",
      createdNow: false,
      rootPaneId: null,
    })
    expect(calls).toHaveLength(0)
  })

  test("startAgent は hc run --bg --json で agent を起動する", async () => {
    const { runner, calls } = makeCommandRunner({ run: RUN_RESPONSE })
    const client = createHcClient({ runCommand: runner })

    const agent = await client.startAgent("SYM-41-xyz", {
      workspaceId: "SYM-41",
      cwd: "/repo/worktree",
      argv: ["opencode", "run", "hello"],
    })

    expect(agent).toEqual({
      name: "SYM-41-xyz",
      state: "unknown",
      paneId: "t7",
      workspaceId: "SYM-41",
    })
    expect(calls).toHaveLength(1)
    const args = calls[0]!.args
    expect(args[0]).toBe("run")
    expect(args).toContain("--bg")
    expect(args).toContain("--json")
    expect(args).toContain("--no-notify")
    expect(args).toContain("--outlive-parent")
    expect(args).toContain("--label")
    expect(args).toContain("issue=SYM-41")
    expect(args).toContain("--cwd")
    expect(args).toContain("/repo/worktree")
    const dashDash = args.indexOf("--")
    expect(args.slice(dashDash + 1)).toEqual(["opencode", "run", "hello"])
  })

  test("startAgent は env を env K=V ラップ argv で伝える", async () => {
    const { runner, calls } = makeCommandRunner({ run: RUN_RESPONSE })
    const client = createHcClient({ runCommand: runner })

    await client.startAgent("SYM-41-xyz", {
      workspaceId: "SYM-41",
      cwd: "/repo/worktree",
      argv: ["opencode", "run", "hello"],
      env: { HERDR_SYMPHONY_REPORT_PATH: "/repo/report.json", FOO: "bar" },
    })

    const args = calls[0]!.args
    const dashDash = args.indexOf("--")
    expect(args.slice(dashDash + 1)).toEqual([
      "env",
      "HERDR_SYMPHONY_REPORT_PATH=/repo/report.json",
      "FOO=bar",
      "opencode",
      "run",
      "hello",
    ])
  })

  test("startAgent は env 未指定時に env をラップしない", async () => {
    const { runner, calls } = makeCommandRunner({ run: RUN_RESPONSE })
    const client = createHcClient({ runCommand: runner })

    await client.startAgent("SYM-41-xyz", {
      workspaceId: "SYM-41",
      cwd: "/repo/worktree",
      argv: ["opencode", "run", "hello"],
    })

    const args = calls[0]!.args
    const dashDash = args.indexOf("--")
    expect(args.slice(dashDash + 1)).toEqual(["opencode", "run", "hello"])
  })

  test("startAgent は hc run 失敗時にエラーメッセージを投げる", async () => {
    const { runner } = makeCommandRunner({
      run: {
        exitCode: 3,
        stdout: JSON.stringify({ error: { kind: "usage", message: "name already in use" } }),
        stderr: "",
      },
    })
    const client = createHcClient({ runCommand: runner })

    await expect(
      client.startAgent("SYM-41-xyz", {
        workspaceId: "SYM-41",
        cwd: "/repo/worktree",
        argv: ["opencode", "run", "hello"],
      }),
    ).rejects.toThrow("name already in use")
  })

  test("getAgent は hc get --json の Terminal レコードを変換する", async () => {
    const { runner, calls } = makeCommandRunner({ get: GET_LIVE_RESPONSE })
    const client = createHcClient({ runCommand: runner })

    const agent = await client.getAgent("t7")

    expect(agent).toEqual({
      name: "SYM-41-xyz",
      state: "working",
      paneId: "t7",
      workspaceId: "SYM-41",
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.command).toBe("hc")
    expect(calls[0]!.args).toEqual(["get", "t7", "--json"])
  })

  test("getAgent は status 未報告を unknown にする", async () => {
    const { runner } = makeCommandRunner({
      get: {
        exitCode: 0,
        stdout: JSON.stringify({
          address: "t7",
          name: null,
          state: "live",
          labels: {},
          status: null,
          reported: false,
        }),
        stderr: "",
      },
    })
    const client = createHcClient({ runCommand: runner })

    const agent = await client.getAgent("t7")

    expect(agent).toEqual({ name: null, state: "unknown", paneId: "t7", workspaceId: null })
  })

  test("getAgent は finished terminal を null にする", async () => {
    const { runner } = makeCommandRunner({
      get: {
        exitCode: 0,
        stdout: JSON.stringify({
          address: "t7",
          name: null,
          state: "finished",
          labels: {},
          status: null,
          exit_code: 0,
          reason: "exited",
        }),
        stderr: "",
      },
    })
    const client = createHcClient({ runCommand: runner })

    expect(await client.getAgent("t7")).toBeNull()
  })

  test("getAgent は not-found で null を返す", async () => {
    const { runner } = makeCommandRunner({
      get: {
        exitCode: 3,
        stdout: JSON.stringify({ error: { kind: "not_found", message: 'no terminal "t7"' } }),
        stderr: "",
      },
    })
    const client = createHcClient({ runCommand: runner })

    expect(await client.getAgent("t7")).toBeNull()
  })

  test("waitAgent は hc get をポーリングして status 一致で返す", async () => {
    let callCount = 0
    const { runner, calls } = makeCommandRunner({
      get: () => {
        callCount++
        if (callCount < 3) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              address: "t7",
              name: null,
              state: "live",
              labels: {},
              status: { state: "working" },
            }),
            stderr: "",
          }
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            address: "t7",
            name: null,
            state: "live",
            labels: {},
            status: { state: "idle" },
          }),
          stderr: "",
        }
      },
    })
    const client = createHcClient({ runCommand: runner, pollIntervalMs: 1 })

    const agent = await client.waitAgent("t7", "idle", 5_000)

    expect(agent?.state).toBe("idle")
    expect(agent?.paneId).toBe("t7")
    expect(calls).toHaveLength(3)
  })

  test("waitAgent はタイムアウトで null を返す", async () => {
    const { runner, calls } = makeCommandRunner({
      get: {
        exitCode: 0,
        stdout: JSON.stringify({
          address: "t7",
          name: null,
          state: "live",
          labels: {},
          status: { state: "working" },
        }),
        stderr: "",
      },
    })
    const client = createHcClient({ runCommand: runner, pollIntervalMs: 1 })

    const agent = await client.waitAgent("t7", "idle", 5)

    expect(agent).toBeNull()
    expect(calls.length).toBeGreaterThan(1)
  })

  test("readAgent は hc read の生テキストを返す", async () => {
    const { runner, calls } = makeCommandRunner({
      read: { exitCode: 0, stdout: "smoke-out\n", stderr: "" },
    })
    const client = createHcClient({ runCommand: runner })

    const text = await client.readAgent("t7", 50)

    expect(text).toBe("smoke-out\n")
    expect(calls[0]!.args).toEqual(["read", "t7", "--lines", "50"])
  })

  test("sendPrompt は hc send を呼ぶ", async () => {
    const { runner, calls } = makeCommandRunner({ send: { exitCode: 0, stdout: "{}", stderr: "" } })
    const client = createHcClient({ runCommand: runner })

    await client.sendPrompt("t7", "Fix the bug")

    expect(calls[0]!.args).toEqual(["send", "t7", "Fix the bug"])
  })

  test("sendInput は hc send を呼ぶ", async () => {
    const { runner, calls } = makeCommandRunner({ send: { exitCode: 0, stdout: "{}", stderr: "" } })
    const client = createHcClient({ runCommand: runner })

    await client.sendInput("t7", "Fix the bug")

    expect(calls[0]!.args).toEqual(["send", "t7", "Fix the bug"])
  })

  test("sendKeys は hc keys を呼ぶ", async () => {
    const { runner, calls } = makeCommandRunner({ keys: { exitCode: 0, stdout: "{}", stderr: "" } })
    const client = createHcClient({ runCommand: runner })

    await client.sendKeys("t7", "Enter", "ctrl+c")

    expect(calls[0]!.args).toEqual(["keys", "t7", "Enter", "ctrl+c"])
  })

  test("closePane は hc kill → hc rm の順に呼ぶ", async () => {
    const { runner, calls } = makeCommandRunner({
      kill: { exitCode: 0, stdout: "{}", stderr: "" },
      rm: { exitCode: 0, stdout: JSON.stringify({ removed: "t7" }), stderr: "" },
    })
    const client = createHcClient({ runCommand: runner })

    await client.closePane("t7")

    expect(calls.map((call) => call.args[0])).toEqual(["kill", "rm"])
    expect(calls.map((call) => call.args[1])).toEqual(["t7", "t7"])
  })

  test("session を指定すると HC_SESSION が runCommand に渡される", async () => {
    const { runner, calls } = makeCommandRunner({ get: GET_LIVE_RESPONSE })
    const client = createHcClient({ runCommand: runner, session: "t1" })

    await client.getAgent("t7")

    expect(calls[0]!.env).toEqual({ HC_SESSION: "t1" })
  })

  test("session 未指定時は env を渡さない", async () => {
    const { runner, calls } = makeCommandRunner({ get: GET_LIVE_RESPONSE })
    const client = createHcClient({ runCommand: runner })

    await client.getAgent("t7")

    expect(calls[0]!.env).toBeUndefined()
  })
})
