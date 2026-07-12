import { expect, test } from "bun:test"
import { resolveConfig } from "./resolve-config"

test("デフォルト値を解決できる (gwq provider, herdr_agent runner)", () => {
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
  expect(config.work.runner).toBe("herdr_agent")
  expect(config.work.herdrAgent.agent).toBe("opencode")
  expect(config.work.herdrAgent.opencode.model).toBeNull()
  expect(config.work.herdrAgent.opencode.agent).toBeNull()
  expect(config.work.herdrAgent.workspaceLabel).toBeNull()
  expect(config.work.herdrAgent.turnTimeoutMs).toBeNull()
  expect(config.work.herdrAgent.closePaneAfterDoneMs).toBeNull()
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
      runner: "herdr_agent",
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

  expect(config.work.runner).toBe("herdr_agent")
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

test("runner に herdr_agent 以外を指定するとエラー", () => {
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
        runner: "herdr_agent",
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

test("herdr_agent.claude.permission_mode を解決できる", () => {
  const config = resolveConfig({
    tracker: {
      kind: "file",
      file: { base_dir: "/issues" },
    },
    work: {
      runner: "herdr_agent",
      herdr_agent: {
        agent: "claude",
        claude: {
          model: "claude-sonnet-4-20250514",
          permission_mode: "bypassPermissions",
        },
      },
    },
  })

  expect(config.work.herdrAgent.agent).toBe("claude")
  expect(config.work.herdrAgent.claude.model).toBe("claude-sonnet-4-20250514")
  expect(config.work.herdrAgent.claude.permissionMode).toBe("bypassPermissions")
})

test("herdr_agent.claude.permission_mode 未指定時は null になる", () => {
  const config = resolveConfig({
    tracker: { kind: "file", file: { base_dir: "/issues" } },
  })

  expect(config.work.herdrAgent.claude.permissionMode).toBeNull()
})

test("herdr_agent.on_blocked: fail を解決できる", () => {
  const config = resolveConfig({
    tracker: {
      kind: "file",
      file: { base_dir: "/issues" },
    },
    work: {
      runner: "herdr_agent",
      herdr_agent: {
        agent: "claude",
        on_blocked: "fail",
      },
    },
  })

  expect(config.work.herdrAgent.onBlocked).toBe("fail")
})

test("herdr_agent.on_blocked: continue を解決できる", () => {
  const config = resolveConfig({
    tracker: { kind: "file", file: { base_dir: "/issues" } },
    work: {
      runner: "herdr_agent",
      herdr_agent: { agent: "opencode", on_blocked: "continue" },
    },
  })

  expect(config.work.herdrAgent.onBlocked).toBe("continue")
})

test("herdr_agent.on_blocked 未指定時は null になる", () => {
  const config = resolveConfig({
    tracker: { kind: "file", file: { base_dir: "/issues" } },
  })

  expect(config.work.herdrAgent.onBlocked).toBeNull()
})

test("claude.messenger: report_file を解決できる", () => {
  const config = resolveConfig({
    tracker: { kind: "file", file: { base_dir: "/issues" } },
    work: {
      runner: "herdr_agent",
      herdr_agent: {
        agent: "claude",
        claude: {
          messenger: "report_file",
        },
      },
    },
  })

  expect(config.work.herdrAgent.claude.messenger).toBe("report_file")
})

test("claude.messenger 未指定時は agmsg になる", () => {
  const config = resolveConfig({
    tracker: { kind: "file", file: { base_dir: "/issues" } },
  })

  expect(config.work.herdrAgent.claude.messenger).toBe("agmsg")
})

test("claude.pending_remind_interval_ms を解決できる", () => {
  const config = resolveConfig({
    tracker: { kind: "file", file: { base_dir: "/issues" } },
    work: {
      runner: "herdr_agent",
      herdr_agent: {
        agent: "claude",
        claude: {
          pending_remind_interval_ms: 60000,
        },
      },
    },
  })

  expect(config.work.herdrAgent.claude.pendingRemindIntervalMs).toBe(60_000)
})

test("claude.pending_remind_interval_ms 未指定時は 900_000 (15分) になる", () => {
  const config = resolveConfig({
    tracker: { kind: "file", file: { base_dir: "/issues" } },
  })

  expect(config.work.herdrAgent.claude.pendingRemindIntervalMs).toBe(900_000)
})

test("claude.reminder_grace_period_ms を解決できる", () => {
  const config = resolveConfig({
    tracker: { kind: "file", file: { base_dir: "/issues" } },
    work: {
      runner: "herdr_agent",
      herdr_agent: {
        agent: "claude",
        claude: {
          reminder_grace_period_ms: 30000,
        },
      },
    },
  })

  expect(config.work.herdrAgent.claude.reminderGracePeriodMs).toBe(30_000)
})

test("claude.reminder_grace_period_ms 未指定時は 180_000 になる", () => {
  const config = resolveConfig({
    tracker: { kind: "file", file: { base_dir: "/issues" } },
  })

  expect(config.work.herdrAgent.claude.reminderGracePeriodMs).toBe(180_000)
})

test("claude.messenger に不正値を指定するとエラー", () => {
  expect(() =>
    resolveConfig({
      tracker: { kind: "file", file: { base_dir: "/issues" } },
      work: {
        runner: "herdr_agent",
        herdr_agent: {
          agent: "claude",
          claude: {
            messenger: "unknown",
          },
        },
      },
    }),
  ).toThrow()
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

test("herdr_agent.close_pane_after_done_ms を解決できる", () => {
  const config = resolveConfig({
    tracker: { kind: "file", file: { base_dir: "/issues" } },
    work: {
      runner: "herdr_agent",
      herdr_agent: {
        agent: "opencode",
        close_pane_after_done_ms: 600000,
      },
    },
  })

  expect(config.work.herdrAgent.closePaneAfterDoneMs).toBe(600_000)
})

test("herdr_agent.close_pane_after_done_ms は文字列も受け付ける", () => {
  const config = resolveConfig({
    tracker: { kind: "file", file: { base_dir: "/issues" } },
    work: {
      runner: "herdr_agent",
      herdr_agent: {
        agent: "opencode",
        close_pane_after_done_ms: "120000",
      },
    },
  })

  expect(config.work.herdrAgent.closePaneAfterDoneMs).toBe(120_000)
})

test("herdr_agent.close_pane_after_done_ms に null を指定すると無効になる", () => {
  const config = resolveConfig({
    tracker: { kind: "file", file: { base_dir: "/issues" } },
    work: {
      runner: "herdr_agent",
      herdr_agent: {
        agent: "opencode",
        close_pane_after_done_ms: null,
      },
    },
  })

  expect(config.work.herdrAgent.closePaneAfterDoneMs).toBeNull()
})

test("opencode.interactive: true を解決できる", () => {
  const config = resolveConfig({
    tracker: { kind: "file", file: { base_dir: "/issues" } },
    work: {
      runner: "herdr_agent",
      herdr_agent: {
        agent: "opencode",
        opencode: {
          interactive: true,
        },
      },
    },
  })

  expect(config.work.herdrAgent.opencode.interactive).toBe(true)
})

test("opencode.interactive 未指定時は false になる", () => {
  const config = resolveConfig({
    tracker: { kind: "file", file: { base_dir: "/issues" } },
  })

  expect(config.work.herdrAgent.opencode.interactive).toBe(false)
})

test("work.if に Liquid テンプレート文字列を指定できる", () => {
  const config = resolveConfig({
    tracker: { kind: "file", file: { base_dir: "/issues" } },
    work: {
      if: '{{ issue.fields["Agent"] == "build" }}',
    },
  })

  expect(config.work.if).toBe('{{ issue.fields["Agent"] == "build" }}')
})

test("work.if 未指定時は null になる", () => {
  const config = resolveConfig({
    tracker: { kind: "file", file: { base_dir: "/issues" } },
  })

  expect(config.work.if).toBeNull()
})
