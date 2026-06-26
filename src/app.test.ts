import { afterEach, describe, expect, test } from "bun:test"
import { rmSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startHerdrSymphony } from "./app"
import type { Issue, ServiceConfig } from "./domain/types"
import { isActiveState } from "./orchestrator/scheduling"
import type { Runner, RunnerResult } from "./runner/types"
import { SymphonyService } from "./service"
import type { IssueTrackerClient } from "./tracker/types"

function makeIssue(): Issue {
  return {
    id: "issue-1",
    identifier: "TEST-1",
    title: "Test issue",
    description: "Do something",
    priority: null,
    state: "Ready",
    repository: null,
    fields: {},
    url: null,
    labels: [],
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
  }
}

function _makeConfig(baseDir: string): ServiceConfig {
  return {
    tracker: {
      kind: "file",
      github_project: null,
      file: { baseDir },
      schedule: null,
    },
    polling: { intervalMs: 30_000 },
    hooks: { beforeRun: null, afterRun: null, timeoutMs: 60_000 },
    agent: { maxConcurrentAgents: 2, maxRetryBackoffMs: 300_000, maxConcurrentAgentsByState: {} },
    work: {
      activeStates: ["Ready"],
      terminalStates: ["Done"],
      runningState: "In progress",
      successState: "Done",
      failureState: "Blocked",
      stoppedState: null,
      runner: "herdr_agent",
      herdrAgent: {
        agent: "opencode",
        opencode: { model: null, agent: null },
        claude: { model: null, permissionMode: null },
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
    },
  }
}

function makeMockRunner(): Runner {
  return {
    async runIssue(): Promise<RunnerResult> {
      return { status: "succeeded", error: null, responseText: "Done" }
    },
    async cancelRun() {},
  }
}

function makeMockTracker(issues: Issue[]): IssueTrackerClient {
  return {
    fetchCandidateIssues: async () => issues,
    fetchIssuesByStates: async () => issues,
    fetchIssueStatesByIds: async () => issues,
    moveIssueToState: async () => {},
    shouldRun: (issue, activeStates) => isActiveState(issue.state, activeStates),
  }
}

describe("startHerdrSymphony", () => {
  const tmpDirs: string[] = []

  afterEach(() => {
    for (const dir of tmpDirs) {
      rmSync(dir, { recursive: true, force: true })
    }
    tmpDirs.length = 0
  })

  test("workflow を読み込んで refresh を実行する", async () => {
    const tmpDir = join(tmpdir(), `hs-app-${Date.now()}`)
    tmpDirs.push(tmpDir)
    await mkdir(join(tmpDir, "Ready"), { recursive: true })
    await writeFile(
      join(tmpDir, "Ready", "TEST-1.md"),
      "---\ntitle: Test issue\n---\nDo something\n",
    )
    await writeFile(
      join(tmpDir, "WORKFLOW.md"),
      `---\ntracker:\n  kind: file\n  file:\n    base_dir: ${tmpDir}\nwork:\n  active_states: [Ready]\n  running_state: "In progress"\n  success_state: "Done"\n---\nFix the issue\n`,
    )

    const logs: string[] = []
    let _refreshCount = 0

    await startHerdrSymphony(
      join(tmpDir, "WORKFLOW.md"),
      {
        writeLog: (line) => logs.push(line),
        storageConfig: { databasePath: join(tmpDir, "test.db") },
      },
      {
        createService: (config, template, options, input) => {
          return new SymphonyService(config, template, {
            ...options,
            ...input,
            storage: input.storage ?? undefined,
            tracker: makeMockTracker([makeIssue()]),
            runner: makeMockRunner(),
            ensureWorkspace: async () => ({
              key: "test-1",
              branch: null,
              path: tmpDir,
              repositoryRoot: tmpDir,
              createdNow: true,
            }),
            claimIssue: () => true,
            releaseIssue: () => {},
            writeLog: (line) => {
              logs.push(line)
              if (line.includes("done TEST-1")) _refreshCount++
            },
          })
        },
        schedule: (_callback, _intervalMs) => {
          return () => {}
        },
      },
    )

    expect(logs.some((l) => l.includes("start TEST-1"))).toBe(true)
    expect(logs.some((l) => l.includes("done TEST-1"))).toBe(true)
  })
})
