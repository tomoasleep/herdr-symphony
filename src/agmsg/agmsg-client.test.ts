import { describe, expect, test } from "bun:test"
import type { CommandResult, CommandRunner } from "../herdr/herdr-client"
import { createAgmsgClient, type RecordedCall } from "./agmsg-client"

function makeCommandRunner(
  responses: Record<string, CommandResult | ((args: string[]) => CommandResult)>,
): { runner: CommandRunner; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const runner: CommandRunner = async (command, args, cwd) => {
    calls.push({ command, args: [...args], cwd })
    const scriptName = command.replace(/.*\//, "").replace(/\.sh$/, "")
    const factory = responses[scriptName]
    if (factory === undefined) {
      return { exitCode: 0, stdout: "", stderr: "" }
    }
    if (typeof factory === "function") {
      return factory(args)
    }
    return factory
  }
  return { runner, calls }
}

describe("AgmsgClient", () => {
  test("join() が join.sh を呼ぶ", async () => {
    const { runner, calls } = makeCommandRunner({})
    const client = createAgmsgClient({ runCommand: runner })

    await client.join("herdr-symphony", "my-agent", "claude-code", "/workspace")

    expect(calls).toHaveLength(1)
    expect(calls[0]?.command).toContain("join.sh")
    expect(calls[0]?.args).toContain("herdr-symphony")
    expect(calls[0]?.args).toContain("my-agent")
    expect(calls[0]?.args).toContain("claude-code")
    expect(calls[0]?.args).toContain("/workspace")
  })

  test("setDelivery() が delivery.sh set を呼ぶ", async () => {
    const { runner, calls } = makeCommandRunner({})
    const client = createAgmsgClient({ runCommand: runner })

    await client.setDelivery("monitor", "claude-code", "/workspace")

    expect(calls).toHaveLength(1)
    expect(calls[0]?.command).toContain("delivery.sh")
    expect(calls[0]?.args).toContain("set")
    expect(calls[0]?.args).toContain("monitor")
    expect(calls[0]?.args).toContain("claude-code")
    expect(calls[0]?.args).toContain("/workspace")
  })

  test("send() が send.sh を呼ぶ", async () => {
    const { runner, calls } = makeCommandRunner({})
    const client = createAgmsgClient({ runCommand: runner })

    await client.send("herdr-symphony", "from-agent", "to-agent", '{"status":"done"}')

    expect(calls).toHaveLength(1)
    expect(calls[0]?.command).toContain("send.sh")
    expect(calls[0]?.args).toContain("herdr-symphony")
    expect(calls[0]?.args).toContain("from-agent")
    expect(calls[0]?.args).toContain("to-agent")
    expect(calls[0]?.args).toContain('{"status":"done"}')
  })

  test("inbox() が inbox.sh <team> <agent> --quiet を呼び stdout を返す", async () => {
    const { runner, calls } = makeCommandRunner({
      inbox: {
        exitCode: 0,
        stdout: '1 new message(s):\n\n [ts] agent: {"kind":"herdr-symphony.report"}',
        stderr: "",
      },
    })
    const client = createAgmsgClient({ runCommand: runner })

    const result = await client.inbox("herdr-symphony", "my-agent")

    expect(result).toContain("herdr-symphony.report")
    expect(calls).toHaveLength(1)
    expect(calls[0]?.command).toContain("inbox.sh")
    expect(calls[0]?.args).toContain("herdr-symphony")
    expect(calls[0]?.args).toContain("my-agent")
    expect(calls[0]?.args).toContain("--quiet")
  })

  test("exit code 非 0 で Error", async () => {
    const { runner } = makeCommandRunner({
      send: { exitCode: 1, stdout: "", stderr: "agmsg send failed" },
    })
    const client = createAgmsgClient({ runCommand: runner })

    await expect(client.send("t", "f", "to", "body")).rejects.toThrow()
  })

  test("join() の exit code 非 0 で Error", async () => {
    const { runner } = makeCommandRunner({
      join: { exitCode: 1, stdout: "", stderr: "join failed" },
    })
    const client = createAgmsgClient({ runCommand: runner })

    await expect(client.join("team", "agent", "claude-code", "/ws")).rejects.toThrow()
  })

  test("setDelivery() の exit code 非 0 で Error", async () => {
    const { runner } = makeCommandRunner({
      delivery: { exitCode: 1, stdout: "", stderr: "delivery failed" },
    })
    const client = createAgmsgClient({ runCommand: runner })

    await expect(client.setDelivery("monitor", "claude-code", "/ws")).rejects.toThrow()
  })
})
