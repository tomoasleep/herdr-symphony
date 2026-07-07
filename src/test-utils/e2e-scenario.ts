import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
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
import {
  type MockResponse,
  SCENARIO_NOW,
  type ScenarioConfig,
  scenarioConfigSchema,
} from "./e2e-scenario-config"
import {
  makeClaudeServiceConfig,
  makeOpencodeServiceConfig,
  prepareTrackerDir,
  prepareWorkspace,
} from "./e2e-setup"

const CLAUDE_WORKFLOW_NAME = "e2e-test-claude.md"
const OPENCODE_WORKFLOW_NAME = "e2e-test.md"

function trustClaudeWorkspace(workspacePath: string): void {
  const configPath = `${homedir()}/.claude.json`
  const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>
  const projects =
    typeof config.projects === "object" && config.projects !== null
      ? (config.projects as Record<string, unknown>)
      : {}
  projects[workspacePath] = {
    hasTrustDialogAccepted: true,
    hasTrustDialogHooksAccepted: true,
    hasCompletedProjectOnboarding: true,
  }
  config.projects = projects
  writeFileSync(configPath, `${JSON.stringify(config)}\n`)
}

async function executeRule(
  rule: MockResponse,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  if (rule.kind === "respond") {
    if (rule.toolCalls) {
      return { content: rule.content, toolCalls: rule.toolCalls }
    }
    return { content: rule.content }
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, rule.ms)
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        reject(new Error("scenario aborted"))
      },
      { once: true },
    )
  })
  return executeRule(rule.next as MockResponse, signal)
}

async function consumeMockResponses(
  mock: LLMock,
  responses: ScenarioConfig["mockResponses"],
  signal: AbortSignal,
): Promise<void> {
  let i = 0
  mock.on({}, async () => {
    const idx = Math.min(i, responses.length - 1)
    const rule = responses[idx]
    if (!rule) throw new Error("mockResponses became empty unexpectedly")
    i++
    return executeRule(rule, signal)
  })
}

function loadConfig(): ScenarioConfig {
  const path = process.env.SCENARIO_CONFIG_PATH
  if (!path) throw new Error("SCENARIO_CONFIG_PATH is not set")
  const text = readFileSync(path, "utf8")
  return scenarioConfigSchema.parse(JSON.parse(text))
}

async function runOpencode(config: ScenarioConfig, controller: AbortController): Promise<void> {
  const mock = new LLMock()
  await consumeMockResponses(mock, config.mockResponses, controller.signal)
  await mock.start()
  const mockUrl = mock.url
  console.log(`MOCK_URL=${mockUrl}`)

  const opencodeConfig = createOpencodeTestConfig({ mockServerUrl: mockUrl })
  const opencodeConfigDir = join(homedir(), ".config", "opencode")
  mkdirSync(opencodeConfigDir, { recursive: true })
  writeFileSync(join(opencodeConfigDir, "opencode.json"), opencodeConfig)

  const trackerDir = await prepareTrackerDir(tmpdir(), config.issue)
  const workspacePath = await prepareWorkspace(tmpdir(), "opencode")

  const serviceConfig = makeOpencodeServiceConfig(trackerDir)
  const herdrClient = wrapHerdrClientWithEnv(createHerdrClient(), {})
  const runner = new HerdrAgentRunner(serviceConfig, { herdrClient })
  const service = new SymphonyService(serviceConfig, "Test prompt for {{ issue.identifier }}", {
    runner,
    workflowId: "e2e-test",
    workflowName: OPENCODE_WORKFLOW_NAME,
    ensureWorkspace: async (): Promise<WorkspaceResult> => ({
      key: "e2e-test",
      branch: null,
      path: workspacePath,
      repositoryRoot: workspacePath,
      createdNow: false,
    }),
    resolveRuntimeConfig: async (issue: Issue): Promise<ResolvedIssueRuntimeConfig> => ({
      issue,
      workspace: serviceConfig.work.workspace,
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
    renderPrompt: async () => `Test prompt for ${config.issue.identifier}`,
  })

  try {
    await service.startupCleanup()
    await service.refresh()
    await service.waitForDispatches()
  } finally {
    service.shutdown()
    await mock.stop()
  }
}

async function runClaude(config: ScenarioConfig, controller: AbortController): Promise<void> {
  const mock = new LLMock()
  await consumeMockResponses(mock, config.mockResponses, controller.signal)
  await mock.start()

  const trackerDir = await prepareTrackerDir(tmpdir(), config.issue)
  const workspacePath = await prepareWorkspace(tmpdir(), `claude-${SCENARIO_NOW.toString(36)}`)
  trustClaudeWorkspace(workspacePath)

  const serviceConfig = makeClaudeServiceConfig(trackerDir)
  const envVars = {
    ANTHROPIC_BASE_URL: mock.url,
    ANTHROPIC_AUTH_TOKEN: "mock-token",
  }
  const herdrClient = wrapHerdrClientWithEnv(createHerdrClient(), envVars, (info) => {
    if (info.name) console.log(`agent name=${info.name}`)
    if (info.paneId) console.log(`agent pane=${info.paneId}`)
  })
  const runner = new HerdrAgentRunner(serviceConfig, {
    herdrClient,
    pollIntervalMs: 3_000,
    now: () => SCENARIO_NOW,
  })
  const service = new SymphonyService(serviceConfig, "Test prompt for {{ issue.identifier }}", {
    runner,
    workflowId: "e2e-test-claude",
    workflowName: CLAUDE_WORKFLOW_NAME,
    ensureWorkspace: async (): Promise<WorkspaceResult> => ({
      key: "e2e-test-claude",
      branch: null,
      path: workspacePath,
      repositoryRoot: workspacePath,
      createdNow: false,
    }),
    resolveRuntimeConfig: async (issue: Issue): Promise<ResolvedIssueRuntimeConfig> => ({
      issue,
      workspace: serviceConfig.work.workspace,
      runner: {
        kind: "herdr_agent",
        agent: "claude",
        opencode: { model: null, agent: null },
        claude: { model: null, permissionMode: "bypassPermissions" },
        workspaceLabel: null,
        turnTimeoutMs: 120_000,
        onBlocked: null,
      },
    }),
    renderPrompt: async () => `Test prompt for ${config.issue.identifier}`,
  })

  try {
    await service.startupCleanup()
    await service.refresh()
    await service.waitForDispatches()
  } finally {
    service.shutdown()
    try {
      await mock.stop()
    } catch {}
  }
}

async function main(): Promise<void> {
  const config = loadConfig()
  const controller = new AbortController()
  try {
    if (config.kind === "opencode") {
      await runOpencode(config, controller)
    } else {
      await runClaude(config, controller)
    }
  } finally {
    controller.abort()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
