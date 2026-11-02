import { launchTerminal, type Session } from "tuistory"
import { parseOpencodeMajorVersion } from "../runner/herdr-agent/opencode-version"
import {
  containerCommand,
  createHerdrIsolation,
  dismissHerdrOnboarding,
  execInContainer,
  normalizeScreenOutput,
} from "../test-utils/e2e-helpers"
import { plainResponse, writeScenarioConfig } from "../test-utils/e2e-scenario-config"

export type OpencodeInteractiveTestOptions = {
  prefix: string
  image: string
  buildArgs: string[]
}

export function opencodeReportFileMockResponses(
  toolName: string,
): ReturnType<typeof plainResponse>[] {
  return [
    plainResponse("E2E Test"),
    {
      kind: "respond" as const,
      content: "Writing report file.",
      toolCalls: [
        {
          name: toolName,
          arguments: {
            command: "herdr-symphony report --status done --summary 'Task completed successfully.'",
          },
        },
      ],
    },
    plainResponse("Task completed successfully."),
  ]
}

async function resolveOpencodeToolName(containerId: string): Promise<string> {
  const result = await execInContainer(containerId, ["opencode", "--version"])
  const major = result.exitCode === 0 ? parseOpencodeMajorVersion(result.stdout) : null
  return major !== null && major >= 2 ? "shell" : "Bash"
}

async function captureAgentScreen(
  scenarioSession: Session,
  herdrSession: Session,
  containerId: string,
): Promise<string> {
  await scenarioSession.waitForText(/agent pane=\S+/, { timeout: 30_000 })
  const scenarioOutput = await scenarioSession.text({ trimEnd: true })
  const paneId = scenarioOutput.match(/agent pane=(\S+)/)?.[1]
  if (!paneId) throw new Error("agent pane id not found")

  await execInContainer(containerId, ["herdr", "agent", "focus", paneId], 10_000)
  await execInContainer(containerId, ["herdr", "pane", "zoom", paneId, "--on"], 10_000)
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

export async function runOpencodeInteractiveE2E(
  opts: OpencodeInteractiveTestOptions,
  register: (session: Session) => Session,
): Promise<string> {
  const projectRoot = process.cwd()

  const herdr = await createHerdrIsolation(opts.prefix, {
    image: opts.image,
    buildArgs: opts.buildArgs,
  })

  try {
    const herdrSession = register(
      await launchTerminal({
        ...containerCommand(herdr.containerId, ["herdr"], undefined, "/tmp"),
        cwd: projectRoot,
        cols: 160,
        rows: 40,
        env: {},
        waitForDataTimeout: 30_000,
      }),
    )

    await herdrSession.waitForText(/spaces|agents/i, { timeout: 15_000 })
    await dismissHerdrOnboarding(herdrSession)

    const identifier = `test/repo#${newRunId()}`
    const toolName = await resolveOpencodeToolName(herdr.containerId)
    const { containerPath } = await writeScenarioConfig(herdr.sharedDir, {
      kind: "opencode",
      interactive: true,
      issue: {
        id: "test-issue-opencode-interactive",
        identifier,
        title: "E2E Opencode Interactive Test Issue",
        body: "This is a test issue for herdr-symphony opencode interactive e2e.",
      },
      mockResponses: opencodeReportFileMockResponses(toolName),
    })

    const scenarioEnv: Record<string, string> = { SCENARIO_CONFIG_PATH: containerPath }
    if (process.env.HERDR_SYMPHONY_DEBUG) {
      scenarioEnv.HERDR_SYMPHONY_DEBUG = process.env.HERDR_SYMPHONY_DEBUG
    }

    const scenarioSession = register(
      await launchTerminal({
        ...containerCommand(
          herdr.containerId,
          ["bun", "run", "/workspace/src/test-utils/e2e-scenario.ts"],
          scenarioEnv,
        ),
        cwd: projectRoot,
        cols: 200,
        rows: 36,
        env: {},
      }),
    )

    try {
      await scenarioSession.waitForText(`done ${identifier} status=succeeded`, { timeout: 60_000 })
    } catch (e) {
      const scenarioOutput = await scenarioSession.text({ trimEnd: true })
      const paneId = scenarioOutput.match(/agent pane=(\S+)/)?.[1]
      if (paneId) {
        const agentScreen = await execInContainer(
          herdr.containerId,
          ["herdr", "pane", "read", paneId, "--lines", "100"],
          10_000,
        )
        console.error("AGENT PANE:\n", agentScreen.stdout.slice(-3000))
      }
      const logResult = await execInContainer(
        herdr.containerId,
        [
          "bash",
          "-c",
          "tail -200 ~/.local/share/opencode/log/opencode.log 2>/dev/null || echo 'no log file found'",
        ],
        10_000,
      )
      console.error("OPENCODE LOGS:\n", logResult.stdout.slice(-3000))
      throw e
    }

    return await captureAgentScreen(scenarioSession, herdrSession, herdr.containerId)
  } finally {
    await herdr.cleanup()
  }
}

function newRunId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}
