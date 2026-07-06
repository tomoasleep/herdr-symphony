import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { launchTerminal } from "tuistory"
import {
  captureOutput,
  createHerdrIsolation,
  createSessionManager,
  execInContainer,
} from "../test-utils/e2e-helpers"

const { register } = createSessionManager()

const HERDR_AVAILABLE = spawnSync("herdr", ["--version"], { stdio: "ignore" }).status === 0
const CLAUDE_AVAILABLE = spawnSync("claude", ["--version"], { stdio: "ignore" }).status === 0

test("e2e: claude 対話モード — herdr agent send で prompt が送られ succeeded になる", async () => {
  if (!HERDR_AVAILABLE) throw new Error("herdr binary not found on PATH")
  if (!CLAUDE_AVAILABLE) throw new Error("claude binary not found on PATH")
  const projectRoot = process.cwd()

  const herdr = await createHerdrIsolation("e2e-claude")

  await execInContainer(herdr.containerId, ["herdr", "server", "stop"], 10_000).catch(() => {})

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

    const scenarioSession = register(
      await launchTerminal({
        command: "docker",
        args: [
          "exec",
          "-it",
          herdr.containerId,
          "bun",
          "run",
          "/workspace/src/test-utils/e2e-scenario-claude.ts",
        ],
        cwd: projectRoot,
        cols: 200,
        rows: 36,
        env: {},
      }),
    )

    await scenarioSession.waitForText("status=succeeded", { timeout: 90_000 })

    expect(await captureOutput(herdrSession)).toMatchInlineSnapshot(`
      "
       spaces                  │ 1       +
                               │$
       · workspace             │
         main ↑1               │
                               │
       · test-claude-ID│
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
       new                 menu│
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
      reconcile running=0
      tracker fetchCandidateIssues start
      tracker fetchCandidateIssues start
      tracker scanStateDirectories start
      tracker scanStateDirectories done count=1
      tracker fetchCandidateIssues done count=1
      tracker fetchCandidateIssues done count=1
      refresh candidates=1 dispatchable=1 running=0 retrying=0
      start test-claude-ID state=Ready
      runtime resolved issue=test-claude-ID runner=herdr_agent workspaceProvider=git
      workspace ready path=TEMP_DIR createdNow=false branch=none
      runner start kind=herdr_agent workspace=TEMP_DIR
      [test-claude-ID] [agent_started] agent_started
      [test-claude-ID] [agent_status] agent_status
      tracker moveIssueToState start issue=test-issue-claude state=Done
      tracker moveIssueToState issue=test-issue-claude state=Done
      tracker fetchCandidateIssues start
      tracker scanStateDirectories start
      tracker scanStateDirectories done count=1
      tracker fetchCandidateIssues done count=1
      tracker moveIssueToState done issue=test-issue-claude from=Ready to=Done
      tracker moveIssueToState done issue=test-issue-claude state=Done
      runner done issue=test-claude-ID status=succeeded error=none
      done test-claude-ID status=succeeded"
    `)
  } finally {
    await execInContainer(herdr.containerId, ["herdr", "server", "stop"], 10_000)
    await herdr.cleanup()
  }
}, 120_000)

test("e2e: claude report 未送信の idle でリマインドされ、report 後に succeeded になる", async () => {
  if (!HERDR_AVAILABLE) throw new Error("herdr binary not found on PATH")
  if (!CLAUDE_AVAILABLE) throw new Error("claude binary not found on PATH")
  const projectRoot = process.cwd()

  const herdr = await createHerdrIsolation("e2e-claude-reminder")

  await execInContainer(herdr.containerId, ["herdr", "server", "stop"], 10_000).catch(() => {})

  try {
    const herdrSession = register(
      await launchTerminal({
        command: "docker",
        args: ["exec", "-it", "-e", "HERDR_SYMPHONY_E2E_REMINDER=1", herdr.containerId, "herdr"],
        cwd: projectRoot,
        cols: 160,
        rows: 40,
        env: {},
        waitForDataTimeout: 30_000,
      }),
    )

    await herdrSession.waitForText(/spaces|agents/i, { timeout: 15_000 })

    const scenarioSession = register(
      await launchTerminal({
        command: "docker",
        args: [
          "exec",
          "-it",
          "-e",
          "HERDR_SYMPHONY_E2E_REMINDER=1",
          herdr.containerId,
          "bun",
          "run",
          "/workspace/src/test-utils/e2e-scenario-claude.ts",
        ],
        cwd: projectRoot,
        cols: 200,
        rows: 36,
        env: {},
      }),
    )

    await scenarioSession.waitForText("status=succeeded", { timeout: 120_000 })

    expect(await captureOutput(herdrSession)).toMatchInlineSnapshot(`
      "
       spaces                  │ 1       +
                               │$
       · workspace             │
         main ↑1               │
                               │
       · test-claude-ID│
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
       new                 menu│
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
      reconcile running=0
      tracker fetchCandidateIssues start
      tracker fetchCandidateIssues start
      tracker scanStateDirectories start
      tracker scanStateDirectories done count=1
      tracker fetchCandidateIssues done count=1
      tracker fetchCandidateIssues done count=1
      refresh candidates=1 dispatchable=1 running=0 retrying=0
      start test-claude-ID state=Ready
      runtime resolved issue=test-claude-ID runner=herdr_agent workspaceProvider=git
      workspace ready path=TEMP_DIR createdNow=false branch=none
      runner start kind=herdr_agent workspace=TEMP_DIR
      [test-claude-ID] [agent_started] agent_started
      [test-claude-ID] [agent_status] agent_status
      tracker moveIssueToState start issue=test-issue-claude state=Done
      tracker moveIssueToState issue=test-issue-claude state=Done
      tracker fetchCandidateIssues start
      tracker scanStateDirectories start
      tracker scanStateDirectories done count=1
      tracker fetchCandidateIssues done count=1
      tracker moveIssueToState done issue=test-issue-claude from=Ready to=Done
      tracker moveIssueToState done issue=test-issue-claude state=Done
      runner done issue=test-claude-ID status=succeeded error=none
      done test-claude-ID status=succeeded"
    `)
  } finally {
    await execInContainer(herdr.containerId, ["herdr", "server", "stop"], 10_000)
    await herdr.cleanup()
  }
}, 150_000)
