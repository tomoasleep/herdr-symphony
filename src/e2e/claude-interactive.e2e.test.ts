import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { launchTerminal, type Session } from "tuistory"
import {
  createHerdrIsolation,
  createSessionManager,
  execInContainer,
  normalizeScreenOutput,
} from "../test-utils/e2e-helpers"
import {
  buildClaudeAgmsgContext,
  claudeAckThenReportToolCall,
  claudeReportFileToolCall,
  type MockResponse,
  plainResponse,
  writeScenarioConfig,
} from "../test-utils/e2e-scenario-config"

const { register } = createSessionManager()

const HERDR_AVAILABLE = spawnSync("herdr", ["--version"], { stdio: "ignore" }).status === 0
const CLAUDE_AVAILABLE = spawnSync("claude", ["--version"], { stdio: "ignore" }).status === 0

function newRunId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

function claudeMockResponses(identifier: string): MockResponse[] {
  const ctx = buildClaudeAgmsgContext({ issueId: "test-issue-claude", identifier })
  return [
    claudeAckThenReportToolCall(ctx, {
      status: "done",
      summary: "Task completed successfully.",
      sleepMs: 10,
    }),
    plainResponse("Task completed successfully."),
  ]
}

function claudeReportFileMockResponses(): MockResponse[] {
  return [
    claudeReportFileToolCall({
      status: "done",
      summary: "Task completed successfully.",
    }),
    plainResponse("Task completed successfully."),
  ]
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
  const deadline = Date.now() + 30_000
  let screen = ""
  while (Date.now() < deadline) {
    screen = normalizeScreenOutput(await herdrSession.text({ immediate: true }))
    if (/WARNING: Claude Code running in Bypass Permissions mode/.test(screen)) {
      await execInContainer(containerId, ["herdr", "pane", "send-keys", paneId, "Down"], 10_000)
      await execInContainer(containerId, ["herdr", "pane", "send-keys", paneId, "Enter"], 10_000)
      await new Promise((resolve) => setTimeout(resolve, 500))
      continue
    }
    if (/あなたは herdr-symphony の agent です。|Task completed/.test(screen)) {
      return screen
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return screen
}

test("e2e: claude 対話モード — agent の画面全体を確認できる", async () => {
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

    const identifier = `test-claude-${newRunId()}`
    const { containerPath } = await writeScenarioConfig(herdr.sharedDir, {
      kind: "claude",
      issue: {
        id: "test-issue-claude",
        identifier,
        title: "E2E Claude Test Issue",
        body: "This is a test issue for herdr-symphony claude e2e.",
      },
      mockResponses: claudeMockResponses(identifier),
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

    const agentScreen = await captureAgentScreen(scenarioSession, herdrSession, herdr.containerId)

    expect(agentScreen).toMatchInlineSnapshot(`
      "
       spaces                  │ 1 Z     +
                               │┌▌ test-claude-ID-e2e-test-TS-TS ────────────────────────────────────────────────────────────────────────────────┐
       · workspace             ││❯ あなたは herdr-symphony の agent です。                                                                                          ▕│
         main                  ││  実タスクは agmsg で届きます。                                                                                                    ▕│
                               ││  最初に /opt/agmsg/scripts/actas-claim.sh "$PWD" claude-code "test-claude-ID-e2e-test-TS-TS"                  ▕│
       ○ test-claude-ID││  "$CLAUDE_CODE_SESSION_ID" を実行して、この agent identity を claim してください。                                                ▕│
         master                ││  claim に失敗した場合は task ack を返さず、作業を開始しないでください。                                                           ▕│
                               ││  team は herdr-symphony-test-claude-ID-e2e-test-TS-TS、あなたの agent 名と runId は                           ▕│
                               ││  test-claude-ID-e2e-test-TS-TS、issueId は test-issue-claude です。                                           ▕│
                               ││  herdr-symphony.task を受け取ったら、runId と toAgent が自分宛てか確認してください。違う場合は無視してください。                  ▕│
                               ││  task を受け取ったら、まず /opt/agmsg/scripts/send.sh herdr-symphony-test-claude-ID-e2e-test-TS-TS            ▕│
                               ││  test-claude-ID-e2e-test-TS-TS herdr-symphony '{"kind":"herdr-symphony.ack","runId":"test-claude-ID ▕│
                               ││  -e2e-test-TS-TS","toAgent":"herdr-symphony","issueId":"test-issue-claude","ackOf":"task"}' を実行し、その後            ▐│
                               ││  task.prompt を実行してください。                                                                                                 ▐│
                               ││  reminder を受け取ったら、まず /opt/agmsg/scripts/send.sh herdr-symphony-test-claude-ID-e2e-test-TS-TS        ▐│
                               ││  test-claude-ID-e2e-test-TS-TS herdr-symphony '{"kind":"herdr-symphony.ack","runId":"test-claude-ID ▐│
                               ││  -e2e-test-TS-TS","toAgent":"herdr-symphony","issueId":"test-issue-claude","ackOf":"reminder"}' を実行してください。    ▐│
                               ││  完了時は、ユーザーへの完了報告と同等の内容を summary に入れて report してください。                                              ▐│
                               ││  done: /opt/agmsg/scripts/send.sh herdr-symphony-test-claude-ID-e2e-test-TS-TS                                ▐│
       new               ● menu││  test-claude-ID-e2e-test-TS-TS herdr-symphony '{"kind":"herdr-symphony.report","runId":"test-claude-ID ▐│
      ─────────────────────────││  ID-e2e-test-TS-TS","toAgent":"herdr-symphony","issueId":"test-issue-claude","status":"done","summary":"対応内容:      ▐│
       agents           grouped││  ...。検証: ...。補足: ...。"}'                                                                                                   ▐│
                               ││  pending: /opt/agmsg/scripts/send.sh herdr-symphony-test-claude-ID-e2e-test-TS-TS                             ▐│
       ✓ test-claude-ID…││  test-claude-ID-e2e-test-TS-TS herdr-symphony                                                                 ▐│
         idle · test-claude-ID││  '{"kind":"herdr-symphony.report","runId":"test-claude-ID-e2e-test-TS-TS","toAgent":"herdr-symphony","issueId ▐│
                               ││  ":"test-issue-claude","status":"pending","summary":"待機中の内容"}'                                                              ▐│
                               ││  failed: /opt/agmsg/scripts/send.sh herdr-symphony-test-claude-ID-e2e-test-TS-TS                              ▐│
                               ││  test-claude-ID-e2e-test-TS-TS herdr-symphony '{"kind":"herdr-symphony.report","runId":"test-claude-ID ▐│
                               ││  ID-e2e-test-TS-TS","toAgent":"herdr-symphony","issueId":"test-issue-claude","status":"failed","summary":"失敗理由"}'  ▐│
                               ││                                                                                                                                   ▐│
                               ││● Task completed successfully.                                                                                                     ▐│
                               ││                                                                                                                                   ▐│
                               ││✻ Worked for 0s ▐│
                               ││                                                                                                                                   ▐│
                               ││───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────▐│
                               ││❯                                                                                                                                  ▐│
                               ││───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────▐│
                               ││  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents                                                   ● high · /effort  ▐│
                               ││                                                                                                                                   ▐│
                              «│└────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘"
    `)
  } finally {
    await execInContainer(herdr.containerId, ["herdr", "server", "stop"], 10_000)
    await herdr.cleanup()
  }
}, 120_000)

test("e2e: claude report 未送信の idle — agent の画面全体を確認できる", async () => {
  if (!HERDR_AVAILABLE) throw new Error("herdr binary not found on PATH")
  if (!CLAUDE_AVAILABLE) throw new Error("claude binary not found on PATH")
  const projectRoot = process.cwd()

  const herdr = await createHerdrIsolation("e2e-claude-reminder")

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

    const identifier = `test-claude-${newRunId()}`
    const { containerPath } = await writeScenarioConfig(herdr.sharedDir, {
      kind: "claude",
      issue: {
        id: "test-issue-claude",
        identifier,
        title: "E2E Claude Test Issue",
        body: "This is a test issue for herdr-symphony claude e2e.",
      },
      mockResponses: claudeMockResponses(identifier),
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

    const agentScreen = await captureAgentScreen(scenarioSession, herdrSession, herdr.containerId)

    expect(agentScreen).toMatchInlineSnapshot(`
      "
       spaces                  │ 1 Z     +
                               │┌▌ test-claude-ID-e2e-test-TS-TS ────────────────────────────────────────────────────────────────────────────────┐
       · workspace             ││❯ あなたは herdr-symphony の agent です。                                                                                          ▕│
         main                  ││  実タスクは agmsg で届きます。                                                                                                    ▕│
                               ││  最初に /opt/agmsg/scripts/actas-claim.sh "$PWD" claude-code "test-claude-ID-e2e-test-TS-TS"                  ▕│
       ○ test-claude-ID││  "$CLAUDE_CODE_SESSION_ID" を実行して、この agent identity を claim してください。                                                ▕│
         master                ││  claim に失敗した場合は task ack を返さず、作業を開始しないでください。                                                           ▕│
                               ││  team は herdr-symphony-test-claude-ID-e2e-test-TS-TS、あなたの agent 名と runId は                           ▕│
                               ││  test-claude-ID-e2e-test-TS-TS、issueId は test-issue-claude です。                                           ▕│
                               ││  herdr-symphony.task を受け取ったら、runId と toAgent が自分宛てか確認してください。違う場合は無視してください。                  ▕│
                               ││  task を受け取ったら、まず /opt/agmsg/scripts/send.sh herdr-symphony-test-claude-ID-e2e-test-TS-TS            ▕│
                               ││  test-claude-ID-e2e-test-TS-TS herdr-symphony '{"kind":"herdr-symphony.ack","runId":"test-claude-ID ▕│
                               ││  -e2e-test-TS-TS","toAgent":"herdr-symphony","issueId":"test-issue-claude","ackOf":"task"}' を実行し、その後            ▐│
                               ││  task.prompt を実行してください。                                                                                                 ▐│
                               ││  reminder を受け取ったら、まず /opt/agmsg/scripts/send.sh herdr-symphony-test-claude-ID-e2e-test-TS-TS        ▐│
                               ││  test-claude-ID-e2e-test-TS-TS herdr-symphony '{"kind":"herdr-symphony.ack","runId":"test-claude-ID ▐│
                               ││  -e2e-test-TS-TS","toAgent":"herdr-symphony","issueId":"test-issue-claude","ackOf":"reminder"}' を実行してください。    ▐│
                               ││  完了時は、ユーザーへの完了報告と同等の内容を summary に入れて report してください。                                              ▐│
                               ││  done: /opt/agmsg/scripts/send.sh herdr-symphony-test-claude-ID-e2e-test-TS-TS                                ▐│
       new               ● menu││  test-claude-ID-e2e-test-TS-TS herdr-symphony '{"kind":"herdr-symphony.report","runId":"test-claude-ID ▐│
      ─────────────────────────││  ID-e2e-test-TS-TS","toAgent":"herdr-symphony","issueId":"test-issue-claude","status":"done","summary":"対応内容:      ▐│
       agents           grouped││  ...。検証: ...。補足: ...。"}'                                                                                                   ▐│
                               ││  pending: /opt/agmsg/scripts/send.sh herdr-symphony-test-claude-ID-e2e-test-TS-TS                             ▐│
       ✓ test-claude-ID…││  test-claude-ID-e2e-test-TS-TS herdr-symphony                                                                 ▐│
         idle · test-claude-ID││  '{"kind":"herdr-symphony.report","runId":"test-claude-ID-e2e-test-TS-TS","toAgent":"herdr-symphony","issueId ▐│
                               ││  ":"test-issue-claude","status":"pending","summary":"待機中の内容"}'                                                              ▐│
                               ││  failed: /opt/agmsg/scripts/send.sh herdr-symphony-test-claude-ID-e2e-test-TS-TS                              ▐│
                               ││  test-claude-ID-e2e-test-TS-TS herdr-symphony '{"kind":"herdr-symphony.report","runId":"test-claude-ID ▐│
                               ││  ID-e2e-test-TS-TS","toAgent":"herdr-symphony","issueId":"test-issue-claude","status":"failed","summary":"失敗理由"}'  ▐│
                               ││                                                                                                                                   ▐│
                               ││● Task completed successfully.                                                                                                     ▐│
                               ││                                                                                                                                   ▐│
                               ││✻ Worked for 0s ▐│
                               ││                                                                                                                                   ▐│
                               ││───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────▐│
                               ││❯                                                                                                                                  ▐│
                               ││───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────▐│
                               ││  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents                                                   ● high · /effort  ▐│
                               ││                                                                                                                                   ▐│
                              «│└────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘"
    `)
  } finally {
    await execInContainer(herdr.containerId, ["herdr", "server", "stop"], 10_000)
    await herdr.cleanup()
  }
}, 150_000)

test("e2e: claude report_file モード — herdr-symphony report で完了報告する", async () => {
  if (!HERDR_AVAILABLE) throw new Error("herdr binary not found on PATH")
  if (!CLAUDE_AVAILABLE) throw new Error("claude binary not found on PATH")
  const projectRoot = process.cwd()

  const herdr = await createHerdrIsolation("e2e-claude-report-file")

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

    const identifier = `test-claude-${newRunId()}`
    const { containerPath } = await writeScenarioConfig(herdr.sharedDir, {
      kind: "claude",
      messenger: "report_file",
      issue: {
        id: "test-issue-claude",
        identifier,
        title: "E2E Claude Test Issue",
        body: "This is a test issue for herdr-symphony claude e2e.",
      },
      mockResponses: claudeReportFileMockResponses(),
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

    const agentScreen = await captureAgentScreen(scenarioSession, herdrSession, herdr.containerId)

    expect(agentScreen).toMatchInlineSnapshot(`
      "
       spaces                  │ 1 Z     +
                               │┌▌ test-claude-ID-e2e-test-TS-TS ────────────────────────────────────────────────────────────────────────────────┐
       · workspace             ││╭─── Claude Code VERSION ────────────────────────────────────────────────────────────────────────────────────────────────────────╮ │
         main                  │││                                                    │ What's new                                                                 │ │
                               │││                    Welcome back!                   │ Added directory path suggestions to \`/cd\`, matching \`/add-dir\` behavior    │ │
       ○ test-claude-ID│││                                                    │ Added a \`/doctor\` check that proposes trimming checked-in \`CLAUDE.md\` fil… │ │
         master                │││                       ▐▛███▜▌                      │ \`/commit-push-pr\` now auto-allows \`git push\` to the repo's configured pus… │ │
                               │││                      ▝▜█████▛▘                     │ /release-notes for more                                                    │ │
                               │││                        ▘▘ ▝▝                       │                                                                            │ │
                               │││                                                    │                                                                            │ │
                               │││      Opus 4.8 (1M context) · API Usage Billing     │                                                                            │ │
                               │││  TEMP_DIR │                                                                            │ │
                               ││╰─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯ │
                               ││                                                                                                                                    │
                               ││                                                                                                                                    │
                               ││❯ Test prompt for test-claude-ID                                                                                          │
                               ││  ## 完了報告                                                                                                                       │
                               ││                                                                                                                                    │
                               ││  ユーザーに依頼された作業が完了したら、以下のコマンドを実行してください。                                                          │
       new               ● menu││                                                                                                                                    │
      ─────────────────────────││      herdr-symphony report --status done --summary "やった作業の要約"                                                              │
       agents           grouped││                                                                                                                                    │
                               ││  background task / subagent / task の完了待ちなら、以下のコマンドを実行してください。                                              │
       ✓ test-claude-ID…││                                                                                                                                    │
         idle · test-claude-ID││      herdr-symphony report --status pending --summary "待機中の内容"                                                               │
                               ││                                                                                                                                    │
                               ││  失敗した場合は、以下のコマンドを実行してください。                                                                                │
                               ││                                                                                                                                    │
                               ││      herdr-symphony report --status failed --summary "失敗理由"                                                                    │
                               ││                                                                                                                                    │
                               ││● Task completed successfully.                                                                                                      │
                               ││                                                                                                                                    │
                               ││✻ Worked for 0s │
                               ││                                                                                                                                    │
                               ││─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────── │
                               ││❯                                                                                                                                   │
                               ││─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────── │
                               ││  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents                                                   ● high · /effort   │
                               ││                                                                                                                                    │
                              «│└────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘"
    `)
  } finally {
    await execInContainer(herdr.containerId, ["herdr", "server", "stop"], 10_000)
    await herdr.cleanup()
  }
}, 120_000)
