import { describe, expect, test } from "bun:test"
import type { WorkspaceConfig } from "../domain/types"
import { buildWorktreePlan, ensureWorkspace } from "./workspace-manager"

function makeWorkspaceConfig(overrides: Partial<WorkspaceConfig> = {}): WorkspaceConfig {
  return {
    provider: "git",
    reuseExisting: true,
    createIfMissing: true,
    branch: null,
    path: null,
    baseDir: null,
    repository: null,
    gwq: {
      command: "gwq",
      createBranch: true,
    },
    ...overrides,
  }
}

describe("buildWorktreePlan", () => {
  test("worktree plan を issue 情報から組み立てる", () => {
    const result = buildWorktreePlan(
      {
        id: "1",
        identifier: "ABC/123",
        title: "task",
        description: null,
        priority: 1,
        state: "Backlog",
        repository: null,
        fields: {
          Worktree: "feature/abc-123",
        },
        url: null,
        labels: [],
        blockedBy: [],
        createdAt: null,
        updatedAt: null,
      },
      "/repos/fairy",
    )

    expect(result.key).toBe("feature_abc-123")
    expect(result.branch).toBe("herdr/feature_abc-123")
    expect(result.path).toContain("feature/abc-123")
  })
})

describe("ensureWorkspace", () => {
  describe("git provider", () => {
    test("既存 worktree があれば再利用する", async () => {
      const calls: Array<{ command: string; args: string[]; cwd: string }> = []
      const issue = {
        id: "1",
        identifier: "ABC/123",
        title: "task",
        description: null,
        priority: 1,
        state: "Backlog",
        repository: "/repos/fairy",
        fields: {
          Worktree: "feature/abc-123",
        },
        url: null,
        labels: [],
        blockedBy: [],
        createdAt: null,
        updatedAt: null,
      }
      const runner = async (command: string, args: string[], cwd: string) => {
        calls.push({ command, args, cwd })
        if (args[0] === "rev-parse") {
          return { exitCode: 0, stdout: "/repos/fairy\n", stderr: "" }
        }
        if (args[0] === "worktree" && args[1] === "list") {
          return {
            exitCode: 0,
            stdout:
              "worktree /repos/fairy.worktrees/feature/abc-123\nHEAD abcdef\nbranch refs/heads/herdr/feature_abc-123\n\n",
            stderr: "",
          }
        }
        throw new Error(`unexpected command: ${command} ${args.join(" ")}`)
      }
      const result = await ensureWorkspace(issue, makeWorkspaceConfig(), { runGit: runner })

      expect(result.createdNow).toBeFalse()
      expect(result.path).toBe("/repos/fairy.worktrees/feature/abc-123")
      expect(calls).toHaveLength(2)
    })

    test("worktree がなければ git worktree add で作成する", async () => {
      const calls: Array<{ command: string; args: string[]; cwd: string }> = []
      const issue = {
        id: "1",
        identifier: "ABC/123",
        title: "task",
        description: null,
        priority: 1,
        state: "Backlog",
        repository: "/repos/fairy",
        fields: {
          Worktree: "feature/abc-123",
        },
        url: null,
        labels: [],
        blockedBy: [],
        createdAt: null,
        updatedAt: null,
      }
      const runner = async (command: string, args: string[], cwd: string) => {
        calls.push({ command, args, cwd })
        if (args[0] === "rev-parse") {
          return { exitCode: 0, stdout: "/repos/fairy\n", stderr: "" }
        }
        if (args[0] === "worktree" && args[1] === "list") {
          return { exitCode: 0, stdout: "", stderr: "" }
        }
        if (args[0] === "show-ref") {
          return { exitCode: 1, stdout: "", stderr: "" }
        }
        if (args[0] === "worktree" && args[1] === "add") {
          return { exitCode: 0, stdout: "", stderr: "" }
        }
        throw new Error(`unexpected command: ${command} ${args.join(" ")}`)
      }
      const result = await ensureWorkspace(issue, makeWorkspaceConfig(), { runGit: runner })

      expect(result.createdNow).toBeTrue()
      expect(calls.at(-1)).toEqual({
        command: "git",
        args: [
          "worktree",
          "add",
          "-b",
          "herdr/feature_abc-123",
          "/repos/fairy.worktrees/feature/abc-123",
        ],
        cwd: "/repos/fairy",
      })
    })

    test("workspace 作成時は noTui ログに実行コマンドを出す", async () => {
      const writes: string[] = []
      const issue = {
        id: "1",
        identifier: "ABC/123",
        title: "task",
        description: null,
        priority: 1,
        state: "Backlog",
        repository: "/repos/fairy",
        fields: {
          Worktree: "feature/abc-123",
        },
        url: null,
        labels: [],
        blockedBy: [],
        createdAt: null,
        updatedAt: null,
      }
      const runner = async (_command: string, args: string[]) => {
        if (args[0] === "rev-parse") {
          return { exitCode: 0, stdout: "/repos/fairy\n", stderr: "" }
        }
        if (args[0] === "worktree" && args[1] === "list") {
          return { exitCode: 0, stdout: "", stderr: "" }
        }
        if (args[0] === "show-ref") {
          return { exitCode: 1, stdout: "", stderr: "" }
        }
        if (args[0] === "worktree" && args[1] === "add") {
          return { exitCode: 0, stdout: "created\n", stderr: "" }
        }
        throw new Error(`unexpected command: ${args.join(" ")}`)
      }

      await ensureWorkspace(issue, makeWorkspaceConfig(), {
        runGit: runner,
        onLog: (line: string) => {
          writes.push(line)
        },
      })

      expect(writes.join("\n")).toContain(
        "workspace git command=git args=rev-parse --show-toplevel cwd=/repos/fairy",
      )
      expect(writes.join("\n")).toContain(
        "workspace git command=git args=worktree add -b herdr/feature_abc-123 /repos/fairy.worktrees/feature/abc-123 cwd=/repos/fairy",
      )
      expect(writes.join("\n")).toContain(
        "workspace ready key=feature_abc-123 created=true path=/repos/fairy.worktrees/feature/abc-123 branch=herdr/feature_abc-123",
      )
    })
  })

  describe("gwq provider", () => {
    test("gwq provider で既存 workspace を再利用する", async () => {
      const calls: Array<{ command: string; args: string[]; cwd: string }> = []
      const issue = {
        id: "1",
        identifier: "ABC/123",
        title: "task",
        description: null,
        priority: 1,
        state: "Backlog",
        repository: "/repos/fairy",
        fields: {
          Worktree: "feature/abc-123",
        },
        url: null,
        labels: [],
        blockedBy: [],
        createdAt: null,
        updatedAt: null,
      }
      const runCommand = async (command: string, args: string[], cwd: string) => {
        calls.push({ command, args, cwd })
        if (command === "git" && args[0] === "rev-parse") {
          return { exitCode: 0, stdout: "/repos/fairy\n", stderr: "" }
        }
        if (command === "gwq" && args[0] === "list") {
          return {
            exitCode: 0,
            stdout:
              '[{"path":"/repos/fairy.worktrees/feature/abc-123","branch":"herdr/feature_abc-123","is_main":false}]',
            stderr: "",
          }
        }
        throw new Error(`unexpected command: ${command} ${args.join(" ")}`)
      }

      const result = await ensureWorkspace(issue, makeWorkspaceConfig({ provider: "gwq" }), {
        runCommand,
      })

      expect(result.createdNow).toBeFalse()
      expect(result.path).toBe("/repos/fairy.worktrees/feature/abc-123")
      expect(calls).toEqual([
        {
          command: "git",
          args: ["rev-parse", "--show-toplevel"],
          cwd: "/repos/fairy",
        },
        {
          command: "gwq",
          args: ["list", "--json"],
          cwd: "/repos/fairy",
        },
      ])
    })

    test("gwq provider で workspace を作成する", async () => {
      const calls: Array<{ command: string; args: string[]; cwd: string }> = []
      const issue = {
        id: "1",
        identifier: "ABC/123",
        title: "task",
        description: null,
        priority: 1,
        state: "Backlog",
        repository: "/repos/fairy",
        fields: {
          Worktree: "feature/abc-123",
        },
        url: null,
        labels: [],
        blockedBy: [],
        createdAt: null,
        updatedAt: null,
      }
      const runCommand = async (command: string, args: string[], cwd: string) => {
        calls.push({ command, args, cwd })
        if (command === "git" && args[0] === "rev-parse") {
          return { exitCode: 0, stdout: "/repos/fairy\n", stderr: "" }
        }
        if (
          command === "gwq" &&
          args[0] === "list" &&
          calls.filter((entry) => entry.command === "gwq" && entry.args[0] === "list").length === 1
        ) {
          return { exitCode: 0, stdout: "[]", stderr: "" }
        }
        if (command === "gwq" && args[0] === "add") {
          return { exitCode: 0, stdout: "", stderr: "" }
        }
        if (command === "gwq" && args[0] === "list") {
          return {
            exitCode: 0,
            stdout:
              '[{"path":"/repos/fairy.worktrees/feature/abc-123","branch":"herdr/feature_abc-123","is_main":false}]',
            stderr: "",
          }
        }
        throw new Error(`unexpected command: ${command} ${args.join(" ")}`)
      }

      const result = await ensureWorkspace(issue, makeWorkspaceConfig({ provider: "gwq" }), {
        runCommand,
      })

      expect(result.createdNow).toBeTrue()
      expect(result.path).toBe("/repos/fairy.worktrees/feature/abc-123")
      expect(calls.at(2)).toEqual({
        command: "gwq",
        args: ["add", "-b", "herdr/feature_abc-123"],
        cwd: "/repos/fairy",
      })
    })

    test("gwq provider で作成後に workspace が見つからないと失敗する", async () => {
      const issue = {
        id: "1",
        identifier: "ABC/123",
        title: "task",
        description: null,
        priority: 1,
        state: "Backlog",
        repository: "/repos/fairy",
        fields: {
          Worktree: "feature/abc-123",
        },
        url: null,
        labels: [],
        blockedBy: [],
        createdAt: null,
        updatedAt: null,
      }
      let listCount = 0
      const runCommand = async (command: string, args: string[], _cwd: string) => {
        if (command === "git" && args[0] === "rev-parse") {
          return { exitCode: 0, stdout: "/repos/fairy\n", stderr: "" }
        }
        if (command === "gwq" && args[0] === "list") {
          listCount += 1
          return { exitCode: 0, stdout: "[]", stderr: "" }
        }
        if (command === "gwq" && args[0] === "add") {
          return { exitCode: 0, stdout: "", stderr: "" }
        }
        throw new Error(`unexpected command: ${command} ${args.join(" ")}`)
      }

      await expect(
        ensureWorkspace(issue, makeWorkspaceConfig({ provider: "gwq" }), { runCommand }),
      ).rejects.toThrow("gwq workspace not found after add: herdr/feature_abc-123")
      expect(listCount).toBe(2)
    })

    test("gwq provider で path と baseDir 指定は deprecated warning を出して無視する", async () => {
      const writes: string[] = []
      const issue = {
        id: "1",
        identifier: "ABC/123",
        title: "task",
        description: null,
        priority: 1,
        state: "Backlog",
        repository: "/repos/fairy",
        fields: {
          Worktree: "feature/abc-123",
        },
        url: null,
        labels: [],
        blockedBy: [],
        createdAt: null,
        updatedAt: null,
      }
      const runCommand = async (command: string, args: string[], cwd: string) => {
        if (command === "git" && args[0] === "rev-parse") {
          return { exitCode: 0, stdout: "/repos/fairy\n", stderr: "" }
        }
        if (command === "gwq" && args[0] === "list") {
          return {
            exitCode: 0,
            stdout:
              '[{"path":"/gwq-managed/fairy/feature-abc-123","branch":"herdr/feature_abc-123","is_main":false}]',
            stderr: "",
          }
        }
        throw new Error(`unexpected command: ${command} ${args.join(" ")} cwd=${cwd}`)
      }

      const result = await ensureWorkspace(
        issue,
        makeWorkspaceConfig({ provider: "gwq", path: "/custom/path", baseDir: "/custom/base" }),
        {
          runCommand,
          onLog: (line: string) => {
            writes.push(line)
          },
        },
      )

      expect(result.createdNow).toBeFalse()
      expect(result.path).toBe("/gwq-managed/fairy/feature-abc-123")
      expect(writes.join("\n")).toContain(
        "workspace warning gwq provider ignores deprecated work.workspace.path/work.workspace.base_dir",
      )
    })

    test("gwq provider で owner/repo を ghq から解決して既存 workspace を再利用する", async () => {
      const calls: Array<{ command: string; args: string[]; cwd: string }> = []
      const issue = {
        id: "1",
        identifier: "ABC/123",
        title: "task",
        description: null,
        priority: 1,
        state: "Backlog",
        repository: "tomoasleep/fairy",
        fields: {
          Worktree: "feature/abc-123",
        },
        url: null,
        labels: [],
        blockedBy: [],
        createdAt: null,
        updatedAt: null,
      }
      const runCommand = async (command: string, args: string[], cwd: string) => {
        calls.push({ command, args, cwd })
        if (command === "ghq") {
          return { exitCode: 0, stdout: "/repos/fairy\n", stderr: "" }
        }
        if (command === "git" && args[0] === "rev-parse") {
          return { exitCode: 0, stdout: "/repos/fairy\n", stderr: "" }
        }
        if (command === "gwq" && args[0] === "list") {
          return {
            exitCode: 0,
            stdout:
              '[{"path":"/repos/fairy.worktrees/feature/abc-123","branch":"herdr/feature_abc-123","is_main":false}]',
            stderr: "",
          }
        }
        throw new Error(`unexpected command: ${command} ${args.join(" ")}`)
      }

      const result = await ensureWorkspace(issue, makeWorkspaceConfig({ provider: "gwq" }), {
        runCommand,
      })

      expect(result.createdNow).toBeFalse()
      expect(result.path).toBe("/repos/fairy.worktrees/feature/abc-123")
      expect(calls).toEqual([
        {
          command: "ghq",
          args: ["list", "-p", "-e", "tomoasleep/fairy"],
          cwd: process.cwd(),
        },
        {
          command: "git",
          args: ["rev-parse", "--show-toplevel"],
          cwd: "/repos/fairy",
        },
        {
          command: "gwq",
          args: ["list", "--json"],
          cwd: "/repos/fairy",
        },
      ])
    })

    test("gwq provider で owner/repo が ghq に見つからないと失敗する", async () => {
      const issue = {
        id: "1",
        identifier: "ABC/123",
        title: "task",
        description: null,
        priority: 1,
        state: "Backlog",
        repository: "tomoasleep/fairy",
        fields: {
          Worktree: "feature/abc-123",
        },
        url: null,
        labels: [],
        blockedBy: [],
        createdAt: null,
        updatedAt: null,
      }
      const runCommand = async (command: string, args: string[], _cwd: string) => {
        if (command === "ghq") {
          return { exitCode: 0, stdout: "", stderr: "" }
        }
        throw new Error(`unexpected command: ${command} ${args.join(" ")}`)
      }

      await expect(
        ensureWorkspace(issue, makeWorkspaceConfig({ provider: "gwq" }), { runCommand }),
      ).rejects.toThrow("ghq repository not found: tomoasleep/fairy")
    })
  })
})
