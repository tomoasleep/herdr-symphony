import { describe, expect, test } from "bun:test"
import { basename, dirname } from "node:path"
import { ClaudeReportResolver } from "./claude-resolver"
import type { ReportContext } from "./types"

const HOME = "/home/test"
const PROJECTS = `${HOME}/.claude/projects`
const WORKSPACE = "/repo/worktree"
const PROJ_A = `${PROJECTS}/proj-a`
const PROJ_B = `${PROJECTS}/proj-b`

function ctx(overrides: Partial<ReportContext> = {}): ReportContext {
  return {
    workspacePath: WORKSPACE,
    startedAt: new Date("2026-06-26T00:00:00.000Z").toISOString(),
    agentKind: "claude",
    ...overrides,
  }
}

type Line = Record<string, unknown>
function assistantLine(opts: {
  cwd?: string
  timestamp?: string
  text?: string | string[]
  type?: string
}): string {
  const content = Array.isArray(opts.text)
    ? opts.text.map((t) => ({ type: "text", text: t }))
    : [{ type: "text", text: opts.text ?? "Task completed successfully." }]
  const obj: Line = {
    type: opts.type ?? "assistant",
    cwd: opts.cwd ?? WORKSPACE,
    timestamp: opts.timestamp ?? "2026-06-26T10:00:00.000Z",
    message: { role: "assistant", content },
  }
  return JSON.stringify(obj)
}

function userLine(): string {
  return JSON.stringify({
    type: "user",
    cwd: WORKSPACE,
    timestamp: "2026-06-26T09:00:00.000Z",
    message: { role: "user", content: "go" },
  })
}

type FileMap = Record<string, string>
type StatMap = Record<string, number>

function makeDeps(opts: {
  files?: FileMap
  stats?: StatMap
  noProjects?: boolean
  realpath?: (p: string) => string
  logs?: string[]
}) {
  const files = opts.files ?? {}
  const stats = opts.stats ?? {}
  return {
    homeDir: () => HOME,
    readDir: (p: string): Promise<string[]> => {
      if (opts.noProjects && p === PROJECTS) {
        return Promise.reject(new Error(`ENOENT ${p}`))
      }
      if (p === PROJECTS) {
        const names = new Set<string>()
        for (const f of Object.keys(files)) {
          if (!f.startsWith(`${PROJECTS}/`)) continue
          const name = f.slice(PROJECTS.length + 1).split("/")[0]
          if (name) names.add(name)
        }
        return Promise.resolve([...names])
      }
      const entries = Object.keys(files)
        .filter((f) => dirname(f) === p)
        .map((f) => basename(f))
      if (entries.length === 0) return Promise.reject(new Error(`ENOENT ${p}`))
      return Promise.resolve(entries)
    },
    readFile: (p: string) => {
      const content = files[p]
      if (content === undefined) return Promise.reject(new Error(`ENOENT ${p}`))
      return Promise.resolve(content)
    },
    stat: (p: string) => Promise.resolve({ mtimeMs: stats[p] ?? 0 }),
    realpath: (p: string) => Promise.resolve(opts.realpath ? opts.realpath(p) : p),
  }
}

describe("ClaudeReportResolver", () => {
  test("cwd 一致の最新 jsonl から最新 assistant 行の text を抽出する", async () => {
    const deps = makeDeps({
      files: {
        [`${PROJ_A}/s1.jsonl`]: [
          userLine(),
          assistantLine({ text: "First." }),
          assistantLine({ text: "All done. Ready for review." }),
        ].join("\n"),
      },
      stats: { [`${PROJ_A}/s1.jsonl`]: 2000 },
    })
    const resolver = new ClaudeReportResolver(deps)

    const result = await resolver.resolve(ctx())

    expect(result).toBe("All done. Ready for review.")
  })

  test("最新のファイルから優先して探索する（mtime 降順）", async () => {
    const deps = makeDeps({
      files: {
        [`${PROJ_A}/old.jsonl`]: assistantLine({ text: "Old answer." }),
        [`${PROJ_A}/new.jsonl`]: assistantLine({ text: "New answer." }),
      },
      stats: { [`${PROJ_A}/old.jsonl`]: 1000, [`${PROJ_A}/new.jsonl`]: 3000 },
    })
    const resolver = new ClaudeReportResolver(deps)

    const result = await resolver.resolve(ctx())

    expect(result).toBe("New answer.")
  })

  test("cwd が不一致の行はスキップする", async () => {
    const deps = makeDeps({
      files: {
        [`${PROJ_A}/s1.jsonl`]: [assistantLine({ cwd: "/other/path", text: "Other." })].join("\n"),
      },
      stats: { [`${PROJ_A}/s1.jsonl`]: 2000 },
    })
    const resolver = new ClaudeReportResolver(deps)

    const result = await resolver.resolve(ctx())

    expect(result).toBeNull()
  })

  test("startedAt より前の assistant 行はスキップする", async () => {
    const deps = makeDeps({
      files: {
        [`${PROJ_A}/s1.jsonl`]: assistantLine({
          timestamp: "2025-01-01T00:00:00.000Z",
          text: "Stale.",
        }),
      },
      stats: { [`${PROJ_A}/s1.jsonl`]: 2000 },
    })
    const resolver = new ClaudeReportResolver(deps)

    const result = await resolver.resolve(ctx())

    expect(result).toBeNull()
  })

  test("assistant 行がない場合は null を返す", async () => {
    const deps = makeDeps({
      files: { [`${PROJ_A}/s1.jsonl`]: userLine() },
      stats: { [`${PROJ_A}/s1.jsonl`]: 2000 },
    })
    const resolver = new ClaudeReportResolver(deps)

    const result = await resolver.resolve(ctx())

    expect(result).toBeNull()
  })

  test("projects ディレクトリが存在しない場合は null を返す", async () => {
    const deps = makeDeps({ noProjects: true })
    const resolver = new ClaudeReportResolver(deps)

    const result = await resolver.resolve(ctx())

    expect(result).toBeNull()
  })

  test("realpath で正規化したパスを比較する（symlink 解決）", async () => {
    const deps = makeDeps({
      files: {
        [`${PROJ_B}/s1.jsonl`]: assistantLine({ cwd: "/real/worktree", text: "Resolved." }),
      },
      stats: { [`${PROJ_B}/s1.jsonl`]: 2000 },
      realpath: (p) => (p === WORKSPACE ? "/real/worktree" : p),
    })
    const resolver = new ClaudeReportResolver(deps)

    const result = await resolver.resolve(ctx())

    expect(result).toBe("Resolved.")
  })

  test("複数の text content は改行結合される", async () => {
    const deps = makeDeps({
      files: {
        [`${PROJ_A}/s1.jsonl`]: assistantLine({ text: ["Line one.", "Line two."] }),
      },
      stats: { [`${PROJ_A}/s1.jsonl`]: 2000 },
    })
    const resolver = new ClaudeReportResolver(deps)

    const result = await resolver.resolve(ctx())

    expect(result).toBe("Line one.\nLine two.")
  })

  test("jsonl に JSON でない行が混ざっていても無視して処理する", async () => {
    const deps = makeDeps({
      files: {
        [`${PROJ_A}/s1.jsonl`]: ["not json", "", assistantLine({ text: "Survived." })].join("\n"),
      },
      stats: { [`${PROJ_A}/s1.jsonl`]: 2000 },
    })
    const resolver = new ClaudeReportResolver(deps)

    const result = await resolver.resolve(ctx())

    expect(result).toBe("Survived.")
  })
})
