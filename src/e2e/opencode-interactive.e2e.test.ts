import { afterEach, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { launchTerminal, type Session } from "tuistory"
import {
  createHerdrIsolation,
  createSessionManager,
  directCommand,
  execInContainer,
  normalizeScreenOutput,
} from "../test-utils/e2e-helpers"
import { plainResponse, writeScenarioConfig } from "../test-utils/e2e-scenario-config"

const { register } = createSessionManager()

afterEach(async () => {
  await execInContainer("", ["herdr", "server", "stop"], 10_000).catch(() => {})
  await new Promise((resolve) => setTimeout(resolve, 1000))
})

const HERDR_AVAILABLE = spawnSync("herdr", ["--version"], { stdio: "ignore" }).status === 0
const OPENCODE_AVAILABLE = spawnSync("opencode", ["--version"], { stdio: "ignore" }).status === 0

function newRunId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

function opencodeReportFileMockResponses(): ReturnType<typeof plainResponse>[] {
  return [
    {
      kind: "respond" as const,
      content: "Writing report file.",
      toolCalls: [
        {
          name: "Bash",
          arguments: {
            command: "herdr-symphony report --status done --summary 'Task completed successfully.'",
          },
        },
      ],
    },
    plainResponse("Task completed successfully."),
  ]
}

async function captureAgentScreen(
  scenarioSession: Session,
  herdrSession: Session,
): Promise<string> {
  await scenarioSession.waitForText(/agent pane=\S+/, { timeout: 30_000 })
  const scenarioOutput = await scenarioSession.text({ trimEnd: true })
  const paneId = scenarioOutput.match(/agent pane=(\S+)/)?.[1]
  if (!paneId) throw new Error("agent pane id not found")

  await execInContainer("", ["herdr", "agent", "focus", paneId], 10_000)
  await execInContainer("", ["herdr", "pane", "zoom", paneId, "--on"], 10_000)
  const deadline = Date.now() + 60_000
  let screen = ""
  while (Date.now() < deadline) {
    screen = normalizeScreenOutput(await herdrSession.text({ immediate: true }))
    if (/Test prompt for|Task completed/.test(screen)) {
      const stabilizeDeadline = Date.now() + 15_000
      while (Date.now() < stabilizeDeadline) {
        screen = normalizeScreenOutput(await herdrSession.text({ immediate: true }))
        if (/done test\/repo#1 status=succeeded/.test(screen)) {
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
      let prev = ""
      for (let i = 0; i < 10; i++) {
        screen = normalizeScreenOutput(await herdrSession.text({ immediate: true }))
        if (screen === prev) {
          break
        }
        prev = screen
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
      return screen
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return screen
}

test("e2e: opencode interactive — report file で完了報告する", async () => {
  if (!HERDR_AVAILABLE) throw new Error("herdr binary not found on PATH")
  if (!OPENCODE_AVAILABLE) throw new Error("opencode binary not found on PATH")
  const projectRoot = process.cwd()

  const herdr = await createHerdrIsolation("e2e-opencode-interactive")

  await execInContainer("", ["herdr", "server", "stop"], 10_000).catch(() => {})

  try {
    const herdrSession = register(
      await launchTerminal({
        ...directCommand(["herdr"]),
        cwd: projectRoot,
        cols: 160,
        rows: 40,
        env: {},
        waitForDataTimeout: 30_000,
      }),
    )

    await herdrSession.waitForText(/spaces|agents/i, { timeout: 15_000 })

    const identifier = `test/repo#${newRunId()}`
    const { containerPath } = await writeScenarioConfig(herdr.sharedDir, {
      kind: "opencode",
      interactive: true,
      issue: {
        id: "test-issue-opencode-interactive",
        identifier,
        title: "E2E Opencode Interactive Test Issue",
        body: "This is a test issue for herdr-symphony opencode interactive e2e.",
      },
      mockResponses: opencodeReportFileMockResponses(),
    })

    const scenarioSession = register(
      await launchTerminal({
        ...directCommand(["bun", "run", "/workspace/src/test-utils/e2e-scenario.ts"], {
          SCENARIO_CONFIG_PATH: containerPath,
        }),
        cwd: projectRoot,
        cols: 200,
        rows: 36,
        env: {},
      }),
    )

    await scenarioSession.waitForText("done test/repo#1 status=succeeded", { timeout: 60_000 })

    const agentScreen = await captureAgentScreen(scenarioSession, herdrSession)

    expect(agentScreen).toMatchInlineSnapshot()
  } finally {
    await herdr.cleanup()
  }
}, 120_000)
