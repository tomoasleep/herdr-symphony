import { mkdirSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { LLMock } from "@copilotkit/aimock"
import type { Issue, ResolvedIssueRuntimeConfig } from "../domain/types"
import { createHerdrClient } from "../herdr/herdr-client"
import { HerdrAgentRunner } from "../runner/herdr-agent/herdr-agent-runner"
import { SymphonyService } from "../service"
import type { WorkspaceResult } from "../workspace/workspace-manager"
import { wrapHerdrClientWithEnv } from "./e2e-herdr-client"
import { createOpencodeTestConfig } from "./e2e-opencode-config"
import { makeOpencodeServiceConfig, prepareTrackerDir, prepareWorkspace } from "./e2e-setup"

async function main(): Promise<void> {
  const mock = new LLMock()
  mock.on({}, { content: "Task completed successfully." })
  await mock.start()

  const mockUrl = mock.url
  console.log(`MOCK_URL=${mockUrl}`)
  const opencodeConfig = createOpencodeTestConfig({ mockServerUrl: mockUrl })
  const opencodeConfigDir = join(homedir(), ".config", "opencode")
  mkdirSync(opencodeConfigDir, { recursive: true })
  writeFileSync(join(opencodeConfigDir, "opencode.json"), opencodeConfig)

  const trackerDir = await prepareTrackerDir(tmpdir(), {
    id: "test-issue-1",
    identifier: "test/repo#1",
    title: "E2E Test Issue",
    body: "This is a test issue for herdr-symphony e2e.",
  })
  const workspacePath = await prepareWorkspace(tmpdir(), "opencode")

  const config = makeOpencodeServiceConfig(trackerDir)
  const herdrClient = wrapHerdrClientWithEnv(createHerdrClient(), {})
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
        kind: "herdr_agent",
        agent: "opencode",
        opencode: { model: "mock/agent-model", agent: null },
        claude: { model: null, permissionMode: null },
        workspaceLabel: null,
        turnTimeoutMs: 60_000,
        onBlocked: null,
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
      if (herdrClient.startedPaneId) {
        await herdrClient.closePane(herdrClient.startedPaneId)
      }
    } catch {}
    await mock.stop()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
