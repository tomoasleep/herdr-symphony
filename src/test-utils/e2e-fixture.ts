import { execSync } from "node:child_process"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LLMock } from "@copilotkit/aimock"
import type { Issue, ResolvedIssueRuntimeConfig, ServiceConfig } from "../domain/types"
import type { HerdrClient } from "../herdr/herdr-client"
import { createHerdrClient } from "../herdr/herdr-client"
import { HerdrAgentRunner } from "../runner/herdr-agent/herdr-agent-runner"
import { SymphonyService } from "../service"
import type { WorkspaceResult } from "../workspace/workspace-manager"
import { createOpencodeTestConfig } from "./e2e-opencode-config"

async function main(): Promise<void> {
  const mock = new LLMock()
  mock.on({}, { content: "Task completed successfully." })
  await mock.start()

  const opencodeConfig = createOpencodeTestConfig({ mockServerUrl: mock.url })
  process.env.OPENCODE_CONFIG_CONTENT = opencodeConfig

  const trackerDir = join(tmpdir(), "herdr-symphony-e2e-tracker")
  await rm(trackerDir, { recursive: true, force: true })
  await mkdir(join(trackerDir, "Ready"), { recursive: true })
  await writeFile(
    join(trackerDir, "Ready", "test-issue-1.md"),
    [
      "---",
      "identifier: test/repo#1",
      "title: E2E Test Issue",
      "---",
      "This is a test issue for herdr-symphony e2e.",
      "",
    ].join("\n"),
  )

  const workspacePath = join(tmpdir(), "herdr-symphony-e2e-workspace")
  await rm(workspacePath, { recursive: true, force: true })
  await mkdir(workspacePath, { recursive: true })
  execSync("git init", { cwd: workspacePath, stdio: "pipe" })
  execSync('git config user.email "test@test.com"', { cwd: workspacePath, stdio: "pipe" })
  execSync('git config user.name "Test"', { cwd: workspacePath, stdio: "pipe" })

  const config = makeConfig(trackerDir)
  const herdrClient = wrapHerdrClient(createHerdrClient(), {
    OPENCODE_CONFIG_CONTENT: opencodeConfig,
  })
  const runner = new HerdrAgentRunner(config, { herdrClient })

  const service = new SymphonyService(config, "Test prompt for {{ issue.identifier }}", {
    runner,
    workflowId: "e2e-test",
    workflowName: "e2e-test.md",
    ensureWorkspace: async (): Promise<WorkspaceResult> => ({
      key: "e2e-test",
      branch: null,
      path: workspacePath,
      repositoryRoot: workspacePath,
      createdNow: false,
    }),
    resolveRuntimeConfig: async (issue: Issue): Promise<ResolvedIssueRuntimeConfig> => ({
      issue,
      workspace: config.work.workspace,
      runner: {
        kind: "herdr-agent",
        agent: "opencode",
        opencode: { model: "mock/agent-model", agent: null },
        workspaceLabel: null,
        turnTimeoutMs: 60_000,
      },
    }),
    renderPrompt: async () => "Test prompt for test/repo#1",
  })

  try {
    await service.startupCleanup()
    await service.refresh()
    await service.waitForDispatches()
  } finally {
    service.shutdown()

    try {
      const agent = await herdrClient.getAgent("test/repo#1")
      if (agent?.paneId) {
        await herdrClient.closePane(agent.paneId)
      }
    } catch {}

    await mock.stop()
  }
}

function wrapHerdrClient(client: HerdrClient, env: Record<string, string>): HerdrClient {
  return {
    ...client,
    startAgent: (name, opts) => client.startAgent(name, { ...opts, env: { ...opts.env, ...env } }),
  }
}

function makeConfig(trackerDir: string): ServiceConfig {
  return {
    tracker: {
      kind: "file",
      github_project: null,
      file: { baseDir: trackerDir },
      schedule: null,
    },
    polling: { intervalMs: 30_000 },
    hooks: { beforeRun: null, afterRun: null, timeoutMs: 60_000 },
    agent: {
      maxConcurrentAgents: 1,
      maxRetryBackoffMs: 300_000,
      maxConcurrentAgentsByState: {},
    },
    work: {
      activeStates: ["Ready"],
      terminalStates: ["Done"],
      runningState: null,
      successState: "Done",
      failureState: null,
      stoppedState: null,
      runner: "herdr-agent",
      herdrAgent: {
        agent: "opencode",
        opencode: { model: "mock/agent-model", agent: null },
        workspaceLabel: null,
        turnTimeoutMs: 60_000,
      },
      workspace: {
        provider: "git",
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

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
