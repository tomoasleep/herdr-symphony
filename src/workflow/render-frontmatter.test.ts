import { expect, test } from "bun:test"
import type { Issue, WorkConfig } from "../domain/types"
import { resolveIssueRuntimeConfig } from "./render-frontmatter"

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
    activeStates: ["Ready"],
    terminalStates: ["Done"],
    runningState: null,
    successState: null,
    failureState: null,
    stoppedState: null,
    runner: "herdr-agent",
    herdrAgent: {
      agent: "opencode",
      opencode: { model: null, agent: null },
      workspaceLabel: null,
      turnTimeoutMs: 3_600_000,
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

test("resolveIssueRuntimeConfig が herdr-agent runner を返す", async () => {
  const config = makeWorkConfig()
  const result = await resolveIssueRuntimeConfig(makeIssue(), config, null)

  expect(result.runner.kind).toBe("herdr-agent")
  expect(result.runner.agent).toBe("opencode")
})

test("opencode model/agent を Liquid で解決できる", async () => {
  const config = makeWorkConfig({
    herdrAgent: {
      agent: "opencode",
      opencode: {
        model: '{{ issue.fields["Model"] | default: "openai/gpt-5.4" }}',
        agent: '{{ issue.fields["Agent"] | default: "build" }}',
      },
      workspaceLabel: null,
      turnTimeoutMs: 3_600_000,
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
      opencode: { model: null, agent: null },
      workspaceLabel: '{{ issue.identifier | replace: "/", "_" }}',
      turnTimeoutMs: null,
    },
  })
  const result = await resolveIssueRuntimeConfig(makeIssue(), config, null)

  expect(result.runner.workspaceLabel).toBe("PROJ-77")
})

test("turnTimeoutMs が引き継がれる", async () => {
  const config = makeWorkConfig({
    herdrAgent: {
      agent: "opencode",
      opencode: { model: null, agent: null },
      workspaceLabel: null,
      turnTimeoutMs: 1_800_000,
    },
  })
  const result = await resolveIssueRuntimeConfig(makeIssue(), config, null)

  expect(result.runner.turnTimeoutMs).toBe(1_800_000)
})
