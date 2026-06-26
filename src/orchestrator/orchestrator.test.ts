import { describe, expect, test } from "bun:test"
import type { ServiceConfig } from "../domain/types"
import type { IssueTrackerClient } from "../tracker/types"
import { GlobalClaimRegistry } from "./global-claim-registry"
import { OrchestratorState } from "./orchestrator"
import { isActiveState } from "./scheduling"

function makeConfig(): ServiceConfig {
  return {
    tracker: {
      kind: "github_project",
      github_project: {
        owner: "@me",
        number: 4,
      },
      file: null,
      schedule: null,
    },
    polling: { intervalMs: 30_000 },
    hooks: { beforeRun: null, afterRun: null, timeoutMs: 60_000 },
    agent: {
      maxConcurrentAgents: 2,
      maxRetryBackoffMs: 300_000,
      maxConcurrentAgentsByState: { backlog: 1 },
    },
    work: {
      activeStates: ["Backlog", "Ready"],
      terminalStates: ["Done"],
      runningState: null,
      successState: null,
      failureState: null,
      stoppedState: null,
      runner: "herdr_agent",
      herdrAgent: {
        agent: "opencode",
        opencode: { model: null, agent: null },
        claude: { model: null },
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
        gwq: {
          command: "gwq",
          createBranch: true,
        },
      },
      reporter: ["file"],
    },
  }
}

function makeTrackerClient(): IssueTrackerClient {
  return {
    fetchCandidateIssues: async () => [],
    fetchIssuesByStates: async () => [],
    fetchIssueStatesByIds: async () => [],
    moveIssueToState: async () => {},
    shouldRun: (issue, activeStates) => isActiveState(issue.state, activeStates),
  }
}

describe("OrchestratorState", () => {
  describe("dispatchable", () => {
    test("state別並列数を尊重する", () => {
      const orchestrator = new OrchestratorState(makeConfig())
      const issue1 = {
        id: "1",
        identifier: "A-1",
        title: "a",
        description: null,
        priority: 1,
        state: "Backlog",
        repository: null,
        fields: {},
        url: null,
        labels: [],
        blockedBy: [],
        createdAt: null,
        updatedAt: null,
      }
      const issue2 = {
        ...issue1,
        id: "2",
        identifier: "A-2",
      }

      const selected = orchestrator.dispatchable([issue1, issue2], makeTrackerClient())
      expect(selected.length).toBe(1)
      expect(selected[0]?.identifier).toBe("A-1")
    })
  })

  describe("reconcileRunning", () => {
    test("running_state が active_states 外でも維持する", () => {
      const config = makeConfig()
      config.work.activeStates = ["Ready"]
      config.work.runningState = "In progress"
      const orchestrator = new OrchestratorState(config)
      const issue = {
        id: "1",
        identifier: "A-1",
        title: "a",
        description: null,
        priority: 1,
        state: "In progress",
        repository: null,
        fields: {},
        url: null,
        labels: [],
        blockedBy: [],
        createdAt: null,
        updatedAt: null,
      }

      orchestrator.markRunning(issue, null)

      const stopped = orchestrator.reconcileRunning([issue])

      expect(stopped).toEqual([])
      expect(orchestrator.running.get("1")?.issue.state).toBe("In progress")
    })

    test("tracking 対象外になっても running に残す", () => {
      const config = makeConfig()
      config.work.activeStates = ["Ready"]
      config.work.runningState = "In progress"
      const orchestrator = new OrchestratorState(config)
      const issue = {
        id: "1",
        identifier: "A-1",
        title: "a",
        description: null,
        priority: 1,
        state: "In progress",
        repository: null,
        fields: {},
        url: null,
        labels: [],
        blockedBy: [],
        createdAt: null,
        updatedAt: null,
      }

      orchestrator.markRunning(issue, null)

      const stopped = orchestrator.reconcileRunning([{ ...issue, state: "Blocked" }])

      expect(stopped).toEqual([])
      expect(orchestrator.running.get("1")?.issue.state).toBe("Blocked")
    })

    test("Project から消えた issue は解放する", () => {
      const config = makeConfig()
      config.work.activeStates = ["Ready"]
      config.work.runningState = "In progress"
      const orchestrator = new OrchestratorState(config)
      const issue = {
        id: "1",
        identifier: "A-1",
        title: "a",
        description: null,
        priority: 1,
        state: "In progress",
        repository: null,
        fields: {},
        url: null,
        labels: [],
        blockedBy: [],
        createdAt: null,
        updatedAt: null,
      }

      orchestrator.markRunning(issue, null)

      const stopped = orchestrator.reconcileRunning([])

      expect(stopped).toEqual(["1"])
      expect(orchestrator.running.has("1")).toBeFalse()
    })
  })

  describe("markRunning", () => {
    test("workspacePath を記録する", () => {
      const orchestrator = new OrchestratorState(makeConfig())
      const issue = {
        id: "1",
        identifier: "A-1",
        title: "a",
        description: null,
        priority: 1,
        state: "In progress",
        repository: null,
        fields: {},
        url: null,
        labels: [],
        blockedBy: [],
        createdAt: null,
        updatedAt: null,
      }

      orchestrator.markRunning(issue, "session-123", "/path/to/workspace")

      const running = orchestrator.running.get("1")
      expect(running?.sessionId).toBe("session-123")
      expect(running?.workspacePath).toBe("/path/to/workspace")

      const snapshot = orchestrator.snapshot()
      expect(snapshot.running[0]?.sessionId).toBe("session-123")
      expect(snapshot.running[0]?.workspacePath).toBe("/path/to/workspace")
    })
  })

  describe("updateConfig", () => {
    test("config を差し替えると dispatchable が新しい maxConcurrentAgents を使う", () => {
      const config = makeConfig()
      config.agent.maxConcurrentAgents = 1
      const orchestrator = new OrchestratorState(config)

      const issue1 = {
        id: "1",
        identifier: "A-1",
        title: "a",
        description: null,
        priority: 1,
        state: "Ready",
        repository: null,
        fields: {},
        url: null,
        labels: [],
        blockedBy: [],
        createdAt: null,
        updatedAt: null,
      }
      const issue2 = { ...issue1, id: "2", identifier: "A-2" }

      expect(orchestrator.dispatchable([issue1, issue2], makeTrackerClient())).toHaveLength(1)

      const updatedConfig = { ...config, agent: { ...config.agent, maxConcurrentAgents: 5 } }
      orchestrator.updateConfig(updatedConfig)

      expect(orchestrator.dispatchable([issue1, issue2], makeTrackerClient())).toHaveLength(2)
    })
  })

  describe("completed entry limit", () => {
    test("completed のサイズが上限を超えないこと", () => {
      const orchestrator = new OrchestratorState(makeConfig())
      for (let i = 0; i < 110; i++) {
        const issue = {
          id: `issue-${i}`,
          identifier: `A-${i}`,
          title: `issue ${i}`,
          description: null,
          priority: 1,
          state: "In progress",
          repository: null,
          fields: {},
          url: null,
          labels: [],
          blockedBy: [],
          createdAt: null,
          updatedAt: null,
        }
        orchestrator.markRunning(issue, null)
        orchestrator.release(`issue-${i}`, {
          status: "succeeded",
          error: null,
          finishedAt: `2026-01-01T${String(i).padStart(2, "0")}:00:00.000Z`,
        })
      }
      expect(orchestrator.completed.size).toBe(100)
    })

    test("古いエントリから削除されること", () => {
      const orchestrator = new OrchestratorState(makeConfig())
      for (let i = 0; i < 110; i++) {
        const issue = {
          id: `issue-${i}`,
          identifier: `A-${i}`,
          title: `issue ${i}`,
          description: null,
          priority: 1,
          state: "In progress",
          repository: null,
          fields: {},
          url: null,
          labels: [],
          blockedBy: [],
          createdAt: null,
          updatedAt: null,
        }
        orchestrator.markRunning(issue, null)
        orchestrator.release(`issue-${i}`, {
          status: "succeeded",
          error: null,
          finishedAt: `2026-01-01T${String(i).padStart(2, "0")}:00:00.000Z`,
        })
      }
      expect(orchestrator.completed.has("issue-0")).toBeFalse()
      expect(orchestrator.completed.has("issue-9")).toBeFalse()
      expect(orchestrator.completed.has("issue-10")).toBeTrue()
      expect(orchestrator.completed.has("issue-109")).toBeTrue()
    })

    test("running/retrying は影響を受けないこと", () => {
      const orchestrator = new OrchestratorState(makeConfig())
      for (let i = 0; i < 110; i++) {
        const issue = {
          id: `issue-${i}`,
          identifier: `A-${i}`,
          title: `issue ${i}`,
          description: null,
          priority: 1,
          state: "In progress",
          repository: null,
          fields: {},
          url: null,
          labels: [],
          blockedBy: [],
          createdAt: null,
          updatedAt: null,
        }
        orchestrator.markRunning(issue, null)
        orchestrator.release(`issue-${i}`, {
          status: "succeeded",
          error: null,
          finishedAt: `2026-01-01T${String(i).padStart(2, "0")}:00:00.000Z`,
        })
      }
      expect(orchestrator.running.size).toBe(0)
      expect(orchestrator.retryAttempts.size).toBe(0)
    })
  })

  describe("release", () => {
    test("完了時に completed task を snapshot へ残す", () => {
      const orchestrator = new OrchestratorState(makeConfig())
      const issue = {
        id: "1",
        identifier: "A-1",
        title: "a",
        description: null,
        priority: 1,
        state: "In progress",
        repository: null,
        fields: {},
        url: null,
        labels: [],
        blockedBy: [],
        createdAt: null,
        updatedAt: null,
      }

      orchestrator.markRunning(issue, null, null)
      orchestrator.release("1", {
        status: "succeeded",
        error: null,
        finishedAt: "2026-03-16T00:00:00.000Z",
      })

      expect(orchestrator.snapshot().completed).toEqual([
        {
          issueId: "1",
          issueIdentifier: "A-1",
          issueUrl: null,
          state: "In progress",
          status: "succeeded",
          error: null,
          finishedAt: "2026-03-16T00:00:00.000Z",
          sessionId: null,
          workspacePath: null,
        },
      ])
    })

    test("完了時に workspacePath を completed entry へ残す", () => {
      const orchestrator = new OrchestratorState(makeConfig())
      const issue = {
        id: "1",
        identifier: "A-1",
        title: "a",
        description: null,
        priority: 1,
        state: "In progress",
        repository: null,
        fields: {},
        url: null,
        labels: [],
        blockedBy: [],
        createdAt: null,
        updatedAt: null,
      }

      orchestrator.markRunning(issue, "session-123", "/path/to/workspace")
      orchestrator.release("1", {
        status: "succeeded",
        error: null,
        finishedAt: "2026-03-16T00:00:00.000Z",
      })

      const snapshot = orchestrator.snapshot()
      expect(snapshot.completed[0]?.sessionId).toBe("session-123")
      expect(snapshot.completed[0]?.workspacePath).toBe("/path/to/workspace")
    })
  })

  describe("stopped", () => {
    test("markStopped で stopped に追加され、isStopped が true を返す", () => {
      const orchestrator = new OrchestratorState(makeConfig())
      orchestrator.markStopped("1")
      expect(orchestrator.isStopped("1")).toBeTrue()
      expect(orchestrator.isStopped("2")).toBeFalse()
    })

    test("clearStopped で stopped から除外される", () => {
      const orchestrator = new OrchestratorState(makeConfig())
      orchestrator.markStopped("1")
      orchestrator.clearStopped("1")
      expect(orchestrator.isStopped("1")).toBeFalse()
    })

    test("dispatchable は stopped に含まれる issue を除外する", () => {
      const orchestrator = new OrchestratorState(makeConfig())
      const issue = {
        id: "1",
        identifier: "A-1",
        title: "a",
        description: null,
        priority: 1,
        state: "Backlog",
        repository: null,
        fields: {},
        url: null,
        labels: [],
        blockedBy: [],
        createdAt: null,
        updatedAt: null,
      }

      orchestrator.markStopped("1")

      const selected = orchestrator.dispatchable([issue], makeTrackerClient())
      expect(selected).toHaveLength(0)
    })

    test("stopped に含まれない issue は通常通り dispatchable", () => {
      const orchestrator = new OrchestratorState(makeConfig())
      const issue = {
        id: "1",
        identifier: "A-1",
        title: "a",
        description: null,
        priority: 1,
        state: "Backlog",
        repository: null,
        fields: {},
        url: null,
        labels: [],
        blockedBy: [],
        createdAt: null,
        updatedAt: null,
      }

      const selected = orchestrator.dispatchable([issue], makeTrackerClient())
      expect(selected).toHaveLength(1)
    })

    test("clearStopped 後は再び dispatchable になる", () => {
      const orchestrator = new OrchestratorState(makeConfig())
      const issue = {
        id: "1",
        identifier: "A-1",
        title: "a",
        description: null,
        priority: 1,
        state: "Backlog",
        repository: null,
        fields: {},
        url: null,
        labels: [],
        blockedBy: [],
        createdAt: null,
        updatedAt: null,
      }

      orchestrator.markStopped("1")
      expect(orchestrator.dispatchable([issue], makeTrackerClient())).toHaveLength(0)

      orchestrator.clearStopped("1")
      expect(orchestrator.dispatchable([issue], makeTrackerClient())).toHaveLength(1)
    })
  })
})

describe("GlobalClaimRegistry", () => {
  test("他 owner の二重 claim を拒否する", () => {
    const registry = new GlobalClaimRegistry()

    expect(registry.claim("1", "workflow-a")).toBeTrue()
    expect(registry.claim("1", "workflow-b")).toBeFalse()
    expect(registry.isClaimedBy("1", "workflow-a")).toBeTrue()

    registry.release("1", "workflow-b")
    expect(registry.isClaimedBy("1", "workflow-a")).toBeTrue()

    registry.release("1", "workflow-a")
    expect(registry.claim("1", "workflow-b")).toBeTrue()
  })
})
