import { expect, test } from "bun:test"
import { launchTerminal } from "tuistory"
import {
  captureOutput,
  containerCommand,
  createHerdrIsolation,
  createSessionManager,
  normalizeLogOutput,
} from "../test-utils/e2e-helpers"
import { plainResponse, writeScenarioConfig } from "../test-utils/e2e-scenario-config"

const { register } = createSessionManager()

test("e2e: herdr TUI + service log — agent が herdr 上で実行されて succeeded になる", async () => {
  const projectRoot = process.cwd()

  const herdr = await createHerdrIsolation("e2e-orchestration")

  try {
    const herdrSession = register(
      await launchTerminal({
        ...containerCommand(herdr.containerId, ["herdr"]),
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
        ...containerCommand(
          herdr.containerId,
          ["bun", "run", "/workspace/src/test-utils/e2e-scenario.ts"],
          {
            SCENARIO_CONFIG_PATH: containerPath,
          },
        ),
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
                               │
       new menu│
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
    expect(
      normalizeLogOutput(await scenarioSession.text({ trimEnd: true })),
    ).toMatchInlineSnapshot(`
      "
      MOCK_URL=http://MOCK_URL
      start test/repo#1 state=Ready
      runner start kind=herdr_agent workspace=TEMP_DIR model=mock/agent-model
      [test/repo#1] [agent_started] agent_started
      reconcile running=1 refreshed=1
      [test/repo#1] [agent_status] agent_status
      done test/repo#1 status=succeeded"
    `)
  } finally {
    await herdr.cleanup()
  }
}, 90_000)
