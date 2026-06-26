import { describe, expect, test } from "bun:test"
import type { CommandResult, CommandRunner } from "../../../herdr/herdr-client"
import { OpenCodeReportResolver } from "./opencode-resolver"
import type { ReportContext } from "./types"

const WORKSPACE = "/repo/worktree"

function ctx(overrides: Partial<ReportContext> = {}): ReportContext {
  return {
    workspacePath: WORKSPACE,
    startedAt: new Date("2026-06-26T00:00:00.000Z").toISOString(),
    agentKind: "opencode",
    ...overrides,
  }
}

type SessionEntry = {
  id: string
  title: string
  updated: number
  created: number
  projectId: string
  directory: string
}

function session(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    id: "ses_a",
    title: "A",
    updated: new Date("2026-06-26T10:00:00.000Z").getTime(),
    created: new Date("2026-06-26T09:00:00.000Z").getTime(),
    projectId: "p1",
    directory: WORKSPACE,
    ...overrides,
  }
}

type Part = { type: string; text?: string }
type ExportMessage = { info: { role: string }; parts: Part[] }

function exportPayload(messages: ExportMessage[], id = "ses_a"): string {
  return JSON.stringify({
    info: { id, directory: WORKSPACE, time: { created: 0, updated: 0 } },
    messages,
  })
}

function makeCommandRunner(opts: {
  list?: CommandResult | string
  exports?: Record<string, CommandResult | string>
  realpath?: (p: string) => string
}): { runner: CommandRunner; logs: string[] } {
  const logs: string[] = []
  const runner: CommandRunner = (_command, args) => {
    if (args[0] === "session" && args[1] === "list") {
      const raw = opts.list
      const res = typeof raw === "string" ? { exitCode: 0, stdout: raw, stderr: "" } : raw
      return Promise.resolve(res ?? { exitCode: 0, stdout: "[]", stderr: "" })
    }
    if (args[0] === "export") {
      const id = args[1] ?? ""
      const raw = opts.exports?.[id]
      const res = typeof raw === "string" ? { exitCode: 0, stdout: raw, stderr: "" } : raw
      return Promise.resolve(res ?? { exitCode: 0, stdout: "{}", stderr: "" })
    }
    return Promise.resolve({ exitCode: 1, stdout: "", stderr: "unknown" })
  }
  return { runner, logs }
}

describe("OpenCodeReportResolver", () => {
  test("directory 一致の最新セッションから最終 assistant の text を抽出する", async () => {
    const list = JSON.stringify([
      session({ id: "ses_old", updated: new Date("2026-06-26T09:30:00.000Z").getTime() }),
      session({ id: "ses_a", updated: new Date("2026-06-26T10:00:00.000Z").getTime() }),
    ])
    const payload = exportPayload([
      { info: { role: "user" }, parts: [{ type: "text", text: "Fix the bug" }] },
      {
        info: { role: "assistant" },
        parts: [
          { type: "reasoning", text: "thinking..." },
          { type: "text", text: "Implementation complete." },
        ],
      },
      {
        info: { role: "assistant" },
        parts: [{ type: "step-start" }, { type: "text", text: "All done. Ready for review." }],
      },
    ])
    const { runner } = makeCommandRunner({ list, exports: { ses_a: payload } })
    const resolver = new OpenCodeReportResolver({ commandRunner: runner })

    const result = await resolver.resolve(ctx())

    expect(result).toBe("All done. Ready for review.")
  })

  test("directory が不一致のセッションは候補から除外する", async () => {
    const list = JSON.stringify([session({ id: "ses_other", directory: "/other/path" })])
    const { runner } = makeCommandRunner({ list, exports: { ses_other: exportPayload([]) } })
    const resolver = new OpenCodeReportResolver({ commandRunner: runner })

    const result = await resolver.resolve(ctx())

    expect(result).toBeNull()
  })

  test("startedAt より前に更新されたセッションは候補から除外する", async () => {
    const list = JSON.stringify([
      session({ id: "ses_old", updated: new Date("2025-01-01T00:00:00.000Z").getTime() }),
    ])
    const { runner } = makeCommandRunner({ list, exports: { ses_old: exportPayload([]) } })
    const resolver = new OpenCodeReportResolver({ commandRunner: runner })

    const result = await resolver.resolve(ctx())

    expect(result).toBeNull()
  })

  test("最終 assistant に text part がなければ前の assistant メッセージを探す", async () => {
    const list = JSON.stringify([session()])
    const payload = exportPayload([
      { info: { role: "assistant" }, parts: [{ type: "text", text: "First answer." }] },
      {
        info: { role: "assistant" },
        parts: [{ type: "step-start" }, { type: "reasoning", text: "only reasoning" }],
      },
    ])
    const { runner } = makeCommandRunner({ list, exports: { ses_a: payload } })
    const resolver = new OpenCodeReportResolver({ commandRunner: runner })

    const result = await resolver.resolve(ctx())

    expect(result).toBe("First answer.")
  })

  test("候補セッションが存在しない場合は null を返す", async () => {
    const { runner } = makeCommandRunner({ list: "[]" })
    const resolver = new OpenCodeReportResolver({ commandRunner: runner })

    const result = await resolver.resolve(ctx())

    expect(result).toBeNull()
  })

  test("export が失敗した場合は stderr を logger に出力して null を返す", async () => {
    const list = JSON.stringify([session()])
    const logs: string[] = []
    const { runner } = makeCommandRunner({
      list,
      exports: { ses_a: { exitCode: 1, stdout: "", stderr: "export failed boom" } },
    })
    const resolver = new OpenCodeReportResolver({
      commandRunner: runner,
      logger: (m) => logs.push(m),
    })

    const result = await resolver.resolve(ctx())

    expect(result).toBeNull()
    expect(logs.some((m) => m.includes("export failed boom"))).toBe(true)
  })

  test("session list が失敗した場合は null を返す", async () => {
    const { runner } = makeCommandRunner({ list: { exitCode: 1, stdout: "", stderr: "list boom" } })
    const resolver = new OpenCodeReportResolver({ commandRunner: runner })

    const result = await resolver.resolve(ctx())

    expect(result).toBeNull()
  })

  test("realpath で正規化したパスを比較する（symlink 解決）", async () => {
    const list = JSON.stringify([session({ directory: "/real/worktree" })])
    const payload = exportPayload([
      { info: { role: "assistant" }, parts: [{ type: "text", text: "Resolved." }] },
    ])
    const { runner } = makeCommandRunner({ list, exports: { ses_a: payload } })
    const resolver = new OpenCodeReportResolver({
      commandRunner: runner,
      realpath: (p) => Promise.resolve(p === WORKSPACE ? "/real/worktree" : p),
    })

    const result = await resolver.resolve(ctx())

    expect(result).toBe("Resolved.")
  })

  test("複数の text part は改行結合される", async () => {
    const list = JSON.stringify([session()])
    const payload = exportPayload([
      {
        info: { role: "assistant" },
        parts: [
          { type: "text", text: "Line one." },
          { type: "text", text: "Line two." },
        ],
      },
    ])
    const { runner } = makeCommandRunner({ list, exports: { ses_a: payload } })
    const resolver = new OpenCodeReportResolver({ commandRunner: runner })

    const result = await resolver.resolve(ctx())

    expect(result).toBe("Line one.\nLine two.")
  })
})
