import { tmpdir } from "node:os"
import { LLMock } from "@copilotkit/aimock"
import { formatAgmsgMessage } from "../agmsg/agmsg-message"
import type { Issue, ResolvedIssueRuntimeConfig } from "../domain/types"
import { createHerdrClient } from "../herdr/herdr-client"
import { buildAgentName, HerdrAgentRunner } from "../runner/herdr-agent/herdr-agent-runner"
import { SymphonyService } from "../service"
import { sanitizeWorkspaceKey } from "../utils/normalize"
import type { WorkspaceResult } from "../workspace/workspace-manager"
import { wrapHerdrClientWithEnv } from "./e2e-herdr-client"
import {
  makeClaudeServiceConfig,
  prepareTrackerDir,
  prepareWorkspace,
  type TrackerIssue,
} from "./e2e-setup"

const ISSUE_ID = "test-issue-claude"
const FIXED_NOW = 1_719_662_400_000

function buildClaudeMockResponse(
  issueId: string,
  issueIdentifier: string,
  reminderMode: boolean,
): (req: unknown) => Record<string, unknown> {
  const agentName = buildAgentName(issueIdentifier, "e2e-test-claude.md", FIXED_NOW)
  const agentTeamSuffix = sanitizeWorkspaceKey(agentName)
  const team = `herdr-symphony-${agentTeamSuffix}`
  const scriptsDir = process.env.AGMSG_SCRIPTS_DIR ?? "/opt/agmsg/scripts"

  const ackBody = formatAgmsgMessage({
    kind: "herdr-symphony.ack",
    issueId,
    runId: agentName,
    toAgent: "herdr-symphony",
    ackOf: "task",
  })

  const reportBody = formatAgmsgMessage({
    kind: "herdr-symphony.report",
    issueId,
    runId: agentName,
    toAgent: "herdr-symphony",
    status: "done",
    summary: "Task completed successfully.",
  })

  const sendAck = `${scriptsDir}/send.sh ${team} ${agentName} herdr-symphony '${ackBody}'`
  const sendReport = `${scriptsDir}/send.sh ${team} ${agentName} herdr-symphony '${reportBody}'`

  let callCount = 0
  return () => {
    callCount++
    if (reminderMode) {
      if (callCount === 1) {
        return {
          content: "Sending task acknowledgement and report.",
          toolCalls: [
            { name: "Bash", arguments: { command: `${sendAck} && ${sendReport} && sleep 10` } },
          ],
        }
      }
    } else {
      if (callCount === 1) {
        return {
          content: "Sending task acknowledgement and report.",
          toolCalls: [
            { name: "Bash", arguments: { command: `${sendAck} && ${sendReport} && sleep 10` } },
          ],
        }
      }
    }
    return { content: "Task completed successfully." }
  }
}

async function main(): Promise<void> {
  const reminderMode = process.env.HERDR_SYMPHONY_E2E_REMINDER === "1"
  const mock = new LLMock()
  const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const issueIdentifier = `test-claude-${runId}`

  mock.on({}, buildClaudeMockResponse(ISSUE_ID, issueIdentifier, reminderMode))
  await mock.start()

  const issue: TrackerIssue = {
    id: ISSUE_ID,
    identifier: issueIdentifier,
    title: "E2E Claude Test Issue",
    body: "This is a test issue for herdr-symphony claude e2e.",
  }
  const trackerDir = await prepareTrackerDir(tmpdir(), issue)
  const workspacePath = await prepareWorkspace(tmpdir(), `claude-${runId}`)

  const config = makeClaudeServiceConfig(trackerDir)
  const mockUrl = mock.url
  const envVars = {
    ANTHROPIC_BASE_URL: mockUrl,
    ANTHROPIC_AUTH_TOKEN: "mock-token",
    CI: "true",
  }
  const herdrClient = wrapHerdrClientWithEnv(createHerdrClient(), envVars)
  const runner = new HerdrAgentRunner(config, {
    herdrClient,
    pollIntervalMs: 3_000,
    now: () => FIXED_NOW,
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
        claude: { model: null, permissionMode: "bypassPermissions" },
        workspaceLabel: null,
        turnTimeoutMs: 120_000,
        onBlocked: null,
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
