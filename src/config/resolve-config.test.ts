import { expect, test } from "bun:test"
import { resolveConfig } from "./resolve-config"

test("デフォルト値を解決できる (gwq provider, herdr-agent runner)", () => {
  const config = resolveConfig({
    tracker: {
      kind: "github_project",
      github_project: {
        owner: "@me",
        number: 4,
      },
    },
  })

  expect(config.polling.intervalMs).toBe(30_000)
  expect(config.tracker.github_project?.owner).toBe("@me")
  expect(config.tracker.github_project?.number).toBe(4)
  expect(config.work.activeStates).toEqual(["Backlog", "Ready", "In progress", "In review"])
  expect(config.work.terminalStates).toEqual(["Done"])
  expect(config.work.runningState).toBeNull()
  expect(config.work.successState).toBeNull()
  expect(config.work.failureState).toBeNull()
  expect(config.agent.maxConcurrentAgents).toBe(10)
  expect(config.work.runner).toBe("herdr-agent")
  expect(config.work.herdrAgent.agent).toBe("opencode")
  expect(config.work.herdrAgent.opencode.model).toBeNull()
  expect(config.work.herdrAgent.opencode.agent).toBeNull()
  expect(config.work.herdrAgent.workspaceLabel).toBeNull()
  expect(config.work.herdrAgent.turnTimeoutMs).toBeNull()
  expect(config.work.workspace).toEqual({
    provider: "gwq",
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
  })
  expect(config.hooks.beforeRun).toBeNull()
  expect(config.hooks.afterRun).toBeNull()
})

test("file tracker の設定を解決できる", () => {
  const config = resolveConfig({
    tracker: {
      kind: "file",
      file: {
        base_dir: "/path/to/issues",
      },
    },
  })

  expect(config.tracker.kind).toBe("file")
  expect(config.tracker.file?.baseDir).toBe("/path/to/issues")
})

test("herdr_agent.opencode の設定を解決できる", () => {
  const config = resolveConfig({
    tracker: {
      kind: "file",
      file: { base_dir: "/issues" },
    },
    work: {
      runner: "herdr-agent",
      herdr_agent: {
        agent: "opencode",
        opencode: {
          model: "openai/gpt-5.4",
          agent: "build",
        },
        workspace_label: "{{ issue.identifier }}",
        turn_timeout_ms: 1800000,
      },
    },
  })

  expect(config.work.runner).toBe("herdr-agent")
  expect(config.work.herdrAgent.agent).toBe("opencode")
  expect(config.work.herdrAgent.opencode.model).toBe("openai/gpt-5.4")
  expect(config.work.herdrAgent.opencode.agent).toBe("build")
  expect(config.work.herdrAgent.workspaceLabel).toBe("{{ issue.identifier }}")
  expect(config.work.herdrAgent.turnTimeoutMs).toBe(1_800_000)
})

test("gwq workspace の設定を解決できる", () => {
  const config = resolveConfig({
    tracker: {
      kind: "file",
      file: { base_dir: "/issues" },
    },
    work: {
      workspace: {
        provider: "gwq",
        branch: "herdr/{{ issue.identifier }}",
        gwq: {
          command: "bunx gwq",
          create_branch: false,
        },
      },
    },
  })

  expect(config.work.workspace.provider).toBe("gwq")
  expect(config.work.workspace.branch).toBe("herdr/{{ issue.identifier }}")
  expect(config.work.workspace.gwq.command).toBe("bunx gwq")
  expect(config.work.workspace.gwq.createBranch).toBe(false)
})

test("runner に herdr-agent 以外を指定するとエラー", () => {
  expect(() =>
    resolveConfig({
      tracker: { kind: "file", file: { base_dir: "/issues" } },
      work: { runner: "opencode" },
    }),
  ).toThrow()
})

test("herdr_agent.agent に opencode 以外を指定するとエラー", () => {
  expect(() =>
    resolveConfig({
      tracker: { kind: "file", file: { base_dir: "/issues" } },
      work: {
        runner: "herdr-agent",
        herdr_agent: { agent: "codex" },
      },
    }),
  ).toThrow()
})

test("reporter を解決できる", () => {
  const config = resolveConfig({
    tracker: { kind: "file", file: { base_dir: "/issues" } },
    work: {
      reporter: ["file", "tracker"],
    },
  })

  expect(config.work.reporter).toEqual(["file", "tracker"])
})

test("agent 同時実行数と backoff を解決できる", () => {
  const config = resolveConfig({
    tracker: { kind: "file", file: { base_dir: "/issues" } },
    agent: {
      max_concurrent_agents: 5,
      max_retry_backoff_ms: 60000,
    },
  })

  expect(config.agent.maxConcurrentAgents).toBe(5)
  expect(config.agent.maxRetryBackoffMs).toBe(60_000)
})
