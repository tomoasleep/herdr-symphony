import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { launchTerminal } from "tuistory"
import {
  captureOutput,
  createHerdrIsolation,
  createSessionManager,
  execInContainer,
} from "../test-utils/e2e-helpers"
import { plainResponse, writeScenarioConfig } from "../test-utils/e2e-scenario-config"

const { register } = createSessionManager()

const HERDR_AVAILABLE = spawnSync("herdr", ["--version"], { stdio: "ignore" }).status === 0

test("e2e: herdr TUI + service log — agent が herdr 上で実行されて succeeded になる", async () => {
  if (!HERDR_AVAILABLE) throw new Error("herdr binary not found on PATH")
  const projectRoot = process.cwd()

  const herdr = await createHerdrIsolation("e2e-orchestration")

  try {
    const herdrSession = register(
      await launchTerminal({
        command: "docker",
        args: ["exec", "-it", herdr.containerId, "herdr"],
        cwd: projectRoot,
        cols: 160,
        rows: 40,
        env: {},
        waitForDataTimeout: 30_000,
      }),
    )

    await herdrSession.waitForText(/spaces|agents/i, { timeout: 15_000 })

    const { containerPath } = await writeScenarioConfig(herdr.sharedDir, {
      kind: "opencode",
      issue: {
        id: "test-issue-1",
        identifier: "test/repo#1",
        title: "E2E Test Issue",
        body: "This is a test issue for herdr-symphony e2e.",
      },
      mockResponses: [plainResponse("Task completed successfully.")],
    })

    const scenarioSession = register(
      await launchTerminal({
        command: "docker",
        args: [
          "exec",
          "-it",
          "-e",
          `SCENARIO_CONFIG_PATH=${containerPath}`,
          herdr.containerId,
          "bun",
          "run",
          "/workspace/src/test-utils/e2e-scenario.ts",
        ],
        cwd: projectRoot,
        cols: 200,
        rows: 36,
        env: {},
      }),
    )

    await scenarioSession.waitForText("done test/repo#1 status=succeeded", { timeout: 60_000 })

    expect(await captureOutput(herdrSession)).toMatchInlineSnapshot(`
      "
       spaces                  │ 1       +
                               │$
       · workspace             │
         main                  │
                               │
       · test/repo#1           │
         master                │
                               │
                               │
                               │
                               │
                               │
                               │
                               │
                               │
                               │
                               │
                               │
                               │
       new               menu│
      ─────────────────────────│
       agents           grouped│
                               │
                               │
                               │
                               │
                               │
                               │
                               │
                               │
                               │
                               │
                               │
                               │
                               │
                               │
                               │
                               │
                               │
                              «│"
    `)
    expect(await captureOutput(scenarioSession)).toMatchInlineSnapshot(`
      "
      MOCK_URL=http://MOCK_URL
      reconcile running=0
      tracker fetchCandidateIssues start
      tracker fetchCandidateIssues start
      tracker scanStateDirectories start
      tracker scanStateDirectories done count=1
      tracker fetchCandidateIssues done count=1
      tracker fetchCandidateIssues done count=1
      refresh candidates=1 dispatchable=1 running=0 retrying=0
      start test/repo#1 state=Ready
      runtime resolved issue=test/repo#1 runner=herdr_agent workspaceProvider=git
      workspace ready path=TEMP_DIR createdNow=false branch=none
      runner start kind=herdr_agent workspace=TEMP_DIR model=mock/agent-model
      [test/repo#1] [agent_started] agent_started
      dispatch started issue=test/repo#1 sessionId=PANE_ID
      tracker fetchIssueStatesByIds start ids=1
      tracker fetchCandidateIssues start
      tracker scanStateDirectories start
      tracker scanStateDirectories done count=1
      tracker fetchCandidateIssues done count=1
      reconcile running=1 refreshed=1
      tracker fetchIssueStatesByIds start ids=1
      tracker fetchCandidateIssues start
      tracker scanStateDirectories start
      tracker scanStateDirectories done count=1
      tracker fetchCandidateIssues done count=1
      reconcile running=1 refreshed=1
      [test/repo#1] [agent_status] agent_status
      tracker moveIssueToState start issue=test-issue-1 state=Done
      tracker moveIssueToState issue=test-issue-1 state=Done
      tracker fetchCandidateIssues start
      tracker scanStateDirectories start
      tracker scanStateDirectories done count=1
      tracker fetchCandidateIssues done count=1
      tracker moveIssueToState done issue=test-issue-1 from=Ready to=Done
      tracker moveIssueToState done issue=test-issue-1 state=Done
      runner done issue=test/repo#1 status=succeeded error=none
      done test/repo#1 status=succeeded"
    `)
  } finally {
    await execInContainer(herdr.containerId, ["herdr", "server", "stop"], 10_000)
    await herdr.cleanup()
  }
}, 90_000)
