import { describe, expect, test } from "bun:test"
import {
  type CommandResult,
  type CommandRunner,
  createHerdrClient,
  type RecordedCall,
} from "./herdr-client"

function makeCommandRunner(
  responses: Record<string, CommandResult | ((args: string[]) => CommandResult)>,
): { runner: CommandRunner; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const runner: CommandRunner = async (command, args, cwd) => {
    calls.push({ command, args: [...args], cwd })
    const key = args.slice(0, 2).join(" ")
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

const WORKSPACE_LIST_RESPONSE: CommandResult = {
  exitCode: 0,
  stdout: JSON.stringify({
    id: "cli:workspace:list",
    result: {
      type: "workspace_list",
      workspaces: [
        {
          workspace_id: "w1",
          label: "existing-ws",
          cwd: "/repo",
          pane_count: 1,
          tab_count: 1,
        },
      ],
    },
  }),
  stderr: "",
}

const WORKSPACE_CREATE_RESPONSE: CommandResult = {
  exitCode: 0,
  stdout: JSON.stringify({
    id: "cli:workspace:create",
    result: {
      type: "workspace_created",
      workspace: {
        workspace_id: "w2",
        label: "new-ws",
        cwd: "/repo/worktree",
        pane_count: 1,
        tab_count: 1,
      },
      root_pane: { pane_id: "w2:p1", cwd: "/repo/worktree" },
      tab: { tab_id: "w2:t1", workspace_id: "w2" },
    },
  }),
  stderr: "",
}

const AGENT_START_RESPONSE: CommandResult = {
  exitCode: 0,
  stdout: JSON.stringify({
    id: "cli:agent:start",
    result: {
      type: "agent_started",
      agent: {
        name: "ISSUE-1",
        pane_id: "w2:p2",
        workspace_id: "w2",
        agent_status: "unknown",
        cwd: "/repo/worktree",
      },
      argv: ["opencode", "run", "hello"],
    },
  }),
  stderr: "",
}

describe("HerdrClient", () => {
  test("ensureWorkspace reuses existing workspace by label", async () => {
    const { runner, calls } = makeCommandRunner({
      "workspace list": WORKSPACE_LIST_RESPONSE,
    })
    const client = createHerdrClient({ runCommand: runner })

    const ws = await client.ensureWorkspace("/repo", "existing-ws")

    expect(ws.id).toBe("w1")
    expect(ws.label).toBe("existing-ws")
    expect(calls).toHaveLength(1)
    expect(calls[0]?.args).toContain("workspace")
    expect(calls[0]?.args).toContain("list")
  })

  test("ensureWorkspace creates new workspace when label not found", async () => {
    const { runner, calls } = makeCommandRunner({
      "workspace list": WORKSPACE_LIST_RESPONSE,
      "workspace create": WORKSPACE_CREATE_RESPONSE,
    })
    const client = createHerdrClient({ runCommand: runner })

    const ws = await client.ensureWorkspace("/repo/worktree", "new-ws")

    expect(ws.id).toBe("w2")
    expect(ws.label).toBe("new-ws")
    expect(calls).toHaveLength(2)
    expect(calls[1]?.args).toContain("create")
    expect(calls[1]?.args).toContain("--cwd")
    expect(calls[1]?.args).toContain("/repo/worktree")
    expect(calls[1]?.args).toContain("--label")
    expect(calls[1]?.args).toContain("new-ws")
    expect(calls[1]?.args).toContain("--no-focus")
  })

  test("startAgent calls herdr agent start with correct args", async () => {
    const { runner, calls } = makeCommandRunner({
      "agent start": AGENT_START_RESPONSE,
    })
    const client = createHerdrClient({ runCommand: runner })

    const agent = await client.startAgent("ISSUE-1", {
      workspaceId: "w2",
      cwd: "/repo/worktree",
      argv: ["opencode", "run", "hello"],
    })

    expect(agent.name).toBe("ISSUE-1")
    expect(agent.paneId).toBe("w2:p2")
    expect(agent.workspaceId).toBe("w2")
    expect(agent.state).toBe("unknown")

    const call = calls[0]
    expect(call?.args).toContain("agent")
    expect(call?.args).toContain("start")
    expect(call?.args).toContain("ISSUE-1")
    expect(call?.args).toContain("--workspace")
    expect(call?.args).toContain("w2")
    expect(call?.args).toContain("--cwd")
    expect(call?.args).toContain("/repo/worktree")
    expect(call?.args).toContain("--no-focus")
    expect(call?.args).toContain("--")
    expect(call?.args).toContain("opencode")
  })

  test("startAgent passes env vars", async () => {
    const { runner, calls } = makeCommandRunner({
      "agent start": AGENT_START_RESPONSE,
    })
    const client = createHerdrClient({ runCommand: runner })

    await client.startAgent("ISSUE-1", {
      workspaceId: "w2",
      cwd: "/repo/worktree",
      argv: ["opencode", "run"],
      env: { FOO: "bar", BAZ: "qux" },
    })

    const args = calls[0]?.args ?? []
    expect(args).toContain("--env")
    const envValues = args.filter((_, i) => args[i - 1] === "--env")
    expect(envValues).toContain("FOO=bar")
    expect(envValues).toContain("BAZ=qux")
  })

  test("waitAgent returns agent info when status reached", async () => {
    const waitResponse: CommandResult = {
      exitCode: 0,
      stdout: JSON.stringify({
        id: "cli:wait:agent-status",
        result: {
          type: "agent_status_reached",
          pane_id: "w2:p2",
          agent_status: "done",
        },
      }),
      stderr: "",
    }
    const { runner, calls } = makeCommandRunner({
      "wait agent-status": waitResponse,
    })
    const client = createHerdrClient({ runCommand: runner })

    const result = await client.waitAgent("w2:p2", "done", 60_000)

    expect(result).not.toBeNull()
    expect(result?.state).toBe("done")
    expect(result?.paneId).toBe("w2:p2")

    const args = calls[0]?.args ?? []
    expect(args).toContain("wait")
    expect(args).toContain("agent-status")
    expect(args).toContain("w2:p2")
    expect(args).toContain("--status")
    expect(args).toContain("done")
    expect(args).toContain("--timeout")
    expect(args).toContain("60000")
  })

  test("waitAgent returns null on timeout", async () => {
    const { runner } = makeCommandRunner({
      "wait agent-status": {
        exitCode: 1,
        stdout: "",
        stderr: "timed out waiting for agent status change",
      },
    })
    const client = createHerdrClient({ runCommand: runner })

    const result = await client.waitAgent("w2:p2", "done", 5_000)

    expect(result).toBeNull()
  })

  test("readAgent returns text output", async () => {
    const { runner, calls } = makeCommandRunner({
      "agent read": {
        exitCode: 0,
        stdout: "Agent completed the task.\nDone.",
        stderr: "",
      },
    })
    const client = createHerdrClient({ runCommand: runner })

    const text = await client.readAgent("ISSUE-1", 200)

    expect(text).toBe("Agent completed the task.\nDone.")
    const args = calls[0]?.args ?? []
    expect(args).toContain("read")
    expect(args).toContain("ISSUE-1")
    expect(args).toContain("--source")
    expect(args).toContain("recent")
    expect(args).toContain("--lines")
    expect(args).toContain("200")
  })

  test("getAgent returns agent info on success", async () => {
    const { runner } = makeCommandRunner({
      "agent get": {
        exitCode: 0,
        stdout: JSON.stringify({
          id: "cli:agent:get",
          result: {
            agent: {
              name: "ISSUE-1",
              pane_id: "w2:p2",
              workspace_id: "w2",
              agent_status: "working",
            },
          },
        }),
        stderr: "",
      },
    })
    const client = createHerdrClient({ runCommand: runner })

    const info = await client.getAgent("ISSUE-1")

    expect(info).not.toBeNull()
    expect(info?.name).toBe("ISSUE-1")
    expect(info?.state).toBe("working")
    expect(info?.paneId).toBe("w2:p2")
  })

  test("getAgent parses legacy flat result format", async () => {
    const { runner } = makeCommandRunner({
      "agent get": {
        exitCode: 0,
        stdout: JSON.stringify({
          id: "cli:agent:get",
          result: {
            name: "ISSUE-1",
            pane_id: "w2:p2",
            workspace_id: "w2",
            agent_status: "idle",
          },
        }),
        stderr: "",
      },
    })
    const client = createHerdrClient({ runCommand: runner })

    const info = await client.getAgent("ISSUE-1")

    expect(info).not.toBeNull()
    expect(info?.state).toBe("idle")
  })

  test("getAgent returns null when agent not found", async () => {
    const { runner } = makeCommandRunner({
      "agent get": {
        exitCode: 1,
        stdout: JSON.stringify({
          error: { code: "agent_not_found", message: "agent target ISSUE-1 not found" },
          id: "cli:agent:get",
        }),
        stderr: "",
      },
    })
    const client = createHerdrClient({ runCommand: runner })

    const info = await client.getAgent("ISSUE-1")

    expect(info).toBeNull()
  })

  test("sendInput calls herdr agent send with target and text", async () => {
    const { runner, calls } = makeCommandRunner({
      "agent send": {
        exitCode: 0,
        stdout: JSON.stringify({ id: "cli:agent:send", result: { type: "ok" } }),
        stderr: "",
      },
    })
    const client = createHerdrClient({ runCommand: runner })

    await client.sendInput("w2:p2", "Fix the bug")

    const args = calls[0]?.args ?? []
    expect(args).toContain("agent")
    expect(args).toContain("send")
    expect(args).toContain("w2:p2")
    expect(args).toContain("Fix the bug")
  })

  test("sendKeys calls herdr pane send-keys with target and keys", async () => {
    const { runner, calls } = makeCommandRunner({
      "pane send-keys": {
        exitCode: 0,
        stdout: JSON.stringify({ id: "cli:pane:send-keys", result: { type: "ok" } }),
        stderr: "",
      },
    })
    const client = createHerdrClient({ runCommand: runner })

    await client.sendKeys("w2:p2", "Enter")

    const args = calls[0]?.args ?? []
    expect(args).toContain("pane")
    expect(args).toContain("send-keys")
    expect(args).toContain("w2:p2")
    expect(args).toContain("Enter")
  })

  test("closePane calls herdr pane close", async () => {
    const { runner, calls } = makeCommandRunner({
      "pane close": {
        exitCode: 0,
        stdout: JSON.stringify({ id: "cli:pane:close", result: { type: "ok" } }),
        stderr: "",
      },
    })
    const client = createHerdrClient({ runCommand: runner })

    await client.closePane("w2:p2")

    const args = calls[0]?.args ?? []
    expect(args).toContain("pane")
    expect(args).toContain("close")
    expect(args).toContain("w2:p2")
  })
})
