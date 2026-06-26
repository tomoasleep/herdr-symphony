import { execSync } from "node:child_process"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LLMock } from "@copilotkit/aimock"
import type { Issue, ResolvedIssueRuntimeConfig, ServiceConfig } from "../domain/types"
import type { HerdrAgentInfo, HerdrClient, StartAgentOptions } from "../herdr/herdr-client"
import { createHerdrClient } from "../herdr/herdr-client"
import { HerdrAgentRunner } from "../runner/herdr-agent/herdr-agent-runner"
import { SymphonyService } from "../service"
import type { WorkspaceResult } from "../workspace/workspace-manager"

async function main(): Promise<void> {
  const mock = new LLMock()
  mock.on({}, { content: "Task completed successfully." })
  await mock.start()

  const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const issueIdentifier = `test-claude-${runId}`

  const trackerDir = join(tmpdir(), `herdr-symphony-e2e-claude-tracker-${runId}`)
  await rm(trackerDir, { recursive: true, force: true })
  await mkdir(join(trackerDir, "Ready"), { recursive: true })
  await writeFile(
    join(trackerDir, "Ready", "test-issue-claude.md"),
    [
      "---",
      `identifier: ${issueIdentifier}`,
      "title: E2E Claude Test Issue",
      "---",
      "This is a test issue for herdr-symphony claude e2e.",
      "",
    ].join("\n"),
  )

  const workspacePath = join(tmpdir(), `herdr-symphony-e2e-claude-workspace-${runId}`)
  await rm(workspacePath, { recursive: true, force: true })
  await mkdir(workspacePath, { recursive: true })
  execSync("git init", { cwd: workspacePath, stdio: "pipe" })
  execSync('git config user.email "test@test.com"', { cwd: workspacePath, stdio: "pipe" })
  execSync('git config user.name "Test"', { cwd: workspacePath, stdio: "pipe" })

  const config = makeConfig(trackerDir)
  const baseClient = createHerdrClient()
  const envVars = {
    ANTHROPIC_BASE_URL: mock.url,
    ANTHROPIC_AUTH_TOKEN: "mock-token",
    CI: "true",
  }
  const herdrClient = wrapForTrustDialog(wrapHerdrClient(baseClient, envVars))
  const runner = new HerdrAgentRunner(config, {
    herdrClient,
    pollIntervalMs: 3_000,
  })

  const service = new SymphonyService(config, "Test prompt for {{ issue.identifier }}", {
    runner,
    workflowId: "e2e-test-claude",
    workflowName: "e2e-test-claude.md",
    ensureWorkspace: async (): Promise<WorkspaceResult> => ({
      key: "e2e-test-claude",
      branch: null,
      path: workspacePath,
      repositoryRoot: workspacePath,
      createdNow: false,
    }),
    resolveRuntimeConfig: async (issue: Issue): Promise<ResolvedIssueRuntimeConfig> => ({
      issue,
      workspace: config.work.workspace,
      runner: {
        kind: "herdr_agent",
        agent: "claude",
        opencode: { model: null, agent: null },
        claude: { model: null },
        workspaceLabel: null,
        turnTimeoutMs: 120_000,
      },
    }),
    renderPrompt: async () => `Test prompt for ${issueIdentifier}`,
  })

  try {
    await service.startupCleanup()
    await service.refresh()
    await service.waitForDispatches()
  } finally {
    service.shutdown()

    try {
      const agent = await herdrClient.getAgent(issueIdentifier)
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

function wrapForTrustDialog(client: HerdrClient): HerdrClient {
  return {
    ...client,
    startAgent: async (name: string, opts: StartAgentOptions): Promise<HerdrAgentInfo> => {
      const info = await client.startAgent(name, opts)
      const target = info.paneId ?? name
      await new Promise((resolve) => setTimeout(resolve, 8_000))
      await client.sendInput(target, "1")
      await client.sendKeys(target, "Enter")
      await new Promise((resolve) => setTimeout(resolve, 3_000))
      return info
    },
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
      runner: "herdr_agent",
      herdrAgent: {
        agent: "claude",
        opencode: { model: null, agent: null },
        claude: { model: null },
        workspaceLabel: null,
        turnTimeoutMs: 120_000,
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
