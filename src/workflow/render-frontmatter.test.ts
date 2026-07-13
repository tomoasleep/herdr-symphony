import { expect, test } from "bun:test"
import type { Issue, WorkConfig } from "../domain/types"
import { evaluateIfCondition, resolveIssueRuntimeConfig } from "./render-frontmatter"

function makeIssue(): Issue {
  return {
    id: "1",
    identifier: "PROJ-77",
    title: "Implement feature",
    description: "desc",
    priority: 1,
    state: "Ready",
    repository: "owner/repo",
    fields: {
      Repository: "/repos/from-project",
      Model: "openai/gpt-5.4",
      Agent: "build",
      PermissionMode: "acceptEdits",
    },
    url: null,
    labels: ["bug"],
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
  }
}

function makeWorkConfig(overrides: Partial<WorkConfig> = {}): WorkConfig {
  return {
    if: null,
    activeStates: ["Ready"],
    terminalStates: ["Done"],
    runningState: null,
    successState: null,
    failureState: null,
    stoppedState: null,
    runner: "herdr_agent",
    herdrAgent: {
      agent: "opencode",
      opencode: { model: null, agent: null, interactive: false, env: {} },
      claude: {
        model: null,
        permissionMode: null,
        messenger: "agmsg",
        pendingRemindIntervalMs: 900_000,
        reminderGracePeriodMs: 180_000,
        env: {},
      },
      workspaceLabel: null,
      turnTimeoutMs: 3_600_000,
      closePaneAfterDoneMs: null,
      onBlocked: null,
    },
    workspace: {
      provider: "gwq",
      reuseExisting: true,
      createIfMissing: true,
      branch: null,
      path: null,
      baseDir: null,
      repository: null,
      gwq: { command: "gwq", createBranch: true },
    },
    reporter: ["file"],
    ...overrides,
  }
}

test("resolveIssueRuntimeConfig が herdr_agent runner を返す", async () => {
  const config = makeWorkConfig()
  const result = await resolveIssueRuntimeConfig(makeIssue(), config, null)

  expect(result.runner.kind).toBe("herdr_agent")
  expect(result.runner.agent).toBe("opencode")
})

test("opencode model/agent を Liquid で解決できる", async () => {
  const config = makeWorkConfig({
    herdrAgent: {
      agent: "opencode",
      opencode: {
        model: '{{ issue.fields["Model"] | default: "openai/gpt-5.4" }}',
        agent: '{{ issue.fields["Agent"] | default: "build" }}',
        env: {},
        interactive: false,
      },
      claude: {
        model: null,
        permissionMode: null,
        messenger: "agmsg",
        pendingRemindIntervalMs: 900_000,
        reminderGracePeriodMs: 180_000,
        env: {},
      },
      workspaceLabel: null,
      turnTimeoutMs: 3_600_000,
      closePaneAfterDoneMs: null,
      onBlocked: null,
    },
  })
  const result = await resolveIssueRuntimeConfig(makeIssue(), config, null)

  expect(result.runner.opencode.model).toBe("openai/gpt-5.4")
  expect(result.runner.opencode.agent).toBe("build")
})

test("workspace branch を Liquid で解決できる", async () => {
  const config = makeWorkConfig({
    workspace: {
      provider: "gwq",
      reuseExisting: true,
      createIfMissing: true,
      branch: "herdr/{{ issue.identifier }}",
      path: null,
      baseDir: null,
      repository: null,
      gwq: { command: "gwq", createBranch: true },
    },
  })
  const result = await resolveIssueRuntimeConfig(makeIssue(), config, null)

  expect(result.workspace.branch).toBe("herdr/PROJ-77")
})

test("repository を Liquid で解決できる", async () => {
  const config = makeWorkConfig({
    workspace: {
      provider: "gwq",
      reuseExisting: true,
      createIfMissing: true,
      branch: null,
      path: null,
      baseDir: null,
      repository: '{{ issue.fields["Repository"] }}',
      gwq: { command: "gwq", createBranch: true },
    },
  })
  const result = await resolveIssueRuntimeConfig(makeIssue(), config, null)

  expect(result.issue.repository).toBe("/repos/from-project")
})

test("repository が null のときは issue.repository に fallback する", async () => {
  const config = makeWorkConfig()
  const result = await resolveIssueRuntimeConfig(makeIssue(), config, null)

  expect(result.issue.repository).toBe("owner/repo")
})

test("workspaceLabel を Liquid で解決できる", async () => {
  const config = makeWorkConfig({
    herdrAgent: {
      agent: "opencode",
      opencode: { model: null, agent: null, interactive: false, env: {} },
      claude: {
        model: null,
        permissionMode: null,
        messenger: "agmsg",
        pendingRemindIntervalMs: 900_000,
        reminderGracePeriodMs: 180_000,
        env: {},
      },
      workspaceLabel: '{{ issue.identifier | replace: "/", "_" }}',
      turnTimeoutMs: null,
      closePaneAfterDoneMs: null,
      onBlocked: null,
    },
  })
  const result = await resolveIssueRuntimeConfig(makeIssue(), config, null)

  expect(result.runner.workspaceLabel).toBe("PROJ-77")
})

test("claude permissionMode を Liquid で解決できる", async () => {
  const config = makeWorkConfig({
    herdrAgent: {
      agent: "claude",
      opencode: { model: null, agent: null, interactive: false, env: {} },
      claude: {
        model: null,
        permissionMode: '{{ issue.fields["PermissionMode"] | default: "acceptEdits" }}',
        messenger: "agmsg",
        pendingRemindIntervalMs: 900_000,
        reminderGracePeriodMs: 180_000,
        env: {},
      },
      workspaceLabel: null,
      turnTimeoutMs: null,
      closePaneAfterDoneMs: null,
      onBlocked: null,
    },
  })
  const result = await resolveIssueRuntimeConfig(makeIssue(), config, null)

  expect(result.runner.claude.permissionMode).toBe("acceptEdits")
})

test("claude permissionMode が null のときは null になる", async () => {
  const config = makeWorkConfig({
    herdrAgent: {
      agent: "claude",
      opencode: { model: null, agent: null, interactive: false, env: {} },
      claude: {
        model: null,
        permissionMode: null,
        messenger: "agmsg",
        pendingRemindIntervalMs: 900_000,
        reminderGracePeriodMs: 180_000,
        env: {},
      },
      workspaceLabel: null,
      turnTimeoutMs: null,
      closePaneAfterDoneMs: null,
      onBlocked: null,
    },
  })
  const result = await resolveIssueRuntimeConfig(makeIssue(), config, null)

  expect(result.runner.claude.permissionMode).toBeNull()
})

test("claude messenger が runner に引き継がれる", async () => {
  const config = makeWorkConfig({
    herdrAgent: {
      agent: "claude",
      opencode: { model: null, agent: null, interactive: false, env: {} },
      claude: {
        model: null,
        permissionMode: null,
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
  })
  const result = await resolveIssueRuntimeConfig(makeIssue(), config, null)

  expect(result.runner.claude.messenger).toBe("report_file")
})

test("turnTimeoutMs が引き継がれる", async () => {
  const config = makeWorkConfig({
    herdrAgent: {
      agent: "opencode",
      opencode: { model: null, agent: null, interactive: false, env: {} },
      claude: {
        model: null,
        permissionMode: null,
        messenger: "agmsg",
        pendingRemindIntervalMs: 900_000,
        reminderGracePeriodMs: 180_000,
        env: {},
      },
      workspaceLabel: null,
      turnTimeoutMs: 1_800_000,
      closePaneAfterDoneMs: null,
      onBlocked: null,
    },
  })
  const result = await resolveIssueRuntimeConfig(makeIssue(), config, null)

  expect(result.runner.turnTimeoutMs).toBe(1_800_000)
})

test("closePaneAfterDoneMs が引き継がれる", async () => {
  const config = makeWorkConfig({
    herdrAgent: {
      agent: "opencode",
      opencode: { model: null, agent: null, interactive: false, env: {} },
      claude: {
        model: null,
        permissionMode: null,
        messenger: "agmsg",
        pendingRemindIntervalMs: 900_000,
        reminderGracePeriodMs: 180_000,
        env: {},
      },
      workspaceLabel: null,
      turnTimeoutMs: null,
      closePaneAfterDoneMs: 600_000,
      onBlocked: null,
    },
  })
  const result = await resolveIssueRuntimeConfig(makeIssue(), config, null)

  expect(result.runner.closePaneAfterDoneMs).toBe(600_000)
})

test("onBlocked が runner に引き継がれる", async () => {
  const config = makeWorkConfig({
    herdrAgent: {
      agent: "opencode",
      opencode: { model: null, agent: null, interactive: false, env: {} },
      claude: {
        model: null,
        permissionMode: null,
        messenger: "agmsg",
        pendingRemindIntervalMs: 900_000,
        reminderGracePeriodMs: 180_000,
        env: {},
      },
      workspaceLabel: null,
      turnTimeoutMs: 3_600_000,
      closePaneAfterDoneMs: null,
      onBlocked: "fail",
    },
  })
  const result = await resolveIssueRuntimeConfig(makeIssue(), config, null)

  expect(result.runner.onBlocked).toBe("fail")
})

test("evaluateIfCondition: ifTemplate が null なら常に true", async () => {
  const result = await evaluateIfCondition(null, makeIssue(), null)
  expect(result).toBe(true)
})

test("evaluateIfCondition: 条件が一致すれば true", async () => {
  const issue = makeIssue()
  const result = await evaluateIfCondition('{{ issue.fields["Agent"] == "build" }}', issue, null)
  expect(result).toBe(true)
})

test("evaluateIfCondition: 条件が不一致なら false", async () => {
  const issue = makeIssue()
  const result = await evaluateIfCondition('{{ issue.fields["Agent"] == "plan" }}', issue, null)
  expect(result).toBe(false)
})

test("evaluateIfCondition: 空文字列レンダリングなら false", async () => {
  const issue = { ...makeIssue(), fields: { ...makeIssue().fields, Agent: null } }
  const result = await evaluateIfCondition("{{ issue.fields.Agent }}", issue, null)
  expect(result).toBe(false)
})

test("evaluateIfCondition: true/false 以外の非空文字列は true", async () => {
  const issue = { ...makeIssue(), fields: { ...makeIssue().fields, Agent: "review" } }
  const result = await evaluateIfCondition("{{ issue.fields.Agent }}", issue, null)
  expect(result).toBe(true)
})

test("opencode.env の値が Liquid で解決される", async () => {
  const config = makeWorkConfig({
    herdrAgent: {
      agent: "opencode",
      opencode: {
        model: null,
        agent: null,
        interactive: false,
        env: { SOME_ENV: '{{ issue.fields["Model"] }}' },
      },
      claude: {
        model: null,
        permissionMode: null,
        messenger: "agmsg",
        pendingRemindIntervalMs: 900_000,
        reminderGracePeriodMs: 180_000,
        env: {},
      },
      workspaceLabel: null,
      turnTimeoutMs: null,
      closePaneAfterDoneMs: null,
      onBlocked: null,
    },
  })
  const result = await resolveIssueRuntimeConfig(makeIssue(), config, null)

  expect(result.runner.opencode.env).toEqual({ SOME_ENV: "openai/gpt-5.4" })
})

test("claude.env の値が Liquid で解決される", async () => {
  const config = makeWorkConfig({
    herdrAgent: {
      agent: "claude",
      opencode: { model: null, agent: null, interactive: false, env: {} },
      claude: {
        model: null,
        permissionMode: null,
        messenger: "agmsg",
        pendingRemindIntervalMs: 900_000,
        reminderGracePeriodMs: 180_000,
        env: { PERM_MODE: '{{ issue.fields["PermissionMode"] }}' },
      },
      workspaceLabel: null,
      turnTimeoutMs: null,
      closePaneAfterDoneMs: null,
      onBlocked: null,
    },
  })
  const result = await resolveIssueRuntimeConfig(makeIssue(), config, null)

  expect(result.runner.claude.env).toEqual({ PERM_MODE: "acceptEdits" })
})

test("env 未指定時は空オブジェクトで runner に渡される", async () => {
  const config = makeWorkConfig()
  const result = await resolveIssueRuntimeConfig(makeIssue(), config, null)

  expect(result.runner.opencode.env).toEqual({})
  expect(result.runner.claude.env).toEqual({})
})
