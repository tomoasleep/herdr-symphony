import { expect, test } from "bun:test"
import { launchTerminal, type Session } from "tuistory"
import {
  containerCommand,
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
  const deadline = Date.now() + 60_000
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
      const stabilizeDeadline = Date.now() + 15_000
      while (Date.now() < stabilizeDeadline) {
        screen = normalizeScreenOutput(await herdrSession.text({ immediate: true }))
        if (/✓ test-claude-ID/.test(screen)) {
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

test("e2e: claude 対話モード — agent の画面全体を確認できる", async () => {
  const projectRoot = process.cwd()

  const herdr = await createHerdrIsolation("e2e-claude")

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

    const identifier = `test-claude-${newRunId()}`
    const { containerPath } = await writeScenarioConfig(herdr.sharedDir, {
      kind: "claude",
      messenger: "agmsg",
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

    const agentScreen = await captureAgentScreen(scenarioSession, herdrSession, herdr.containerId)

    expect(agentScreen).toMatchInlineSnapshot(`
      "
      │ 1       +
      │╰─╯▐
      │                                                                                                                                     ▐
      │                                                                                                                                     ▐
      │❯ あなたは herdr-symphony の agent です。                                                                                            ▐
      │  実タスクは agmsg で届きます。                                                                                                      ▐
      │  最初に /opt/agmsg/scripts/actas-claim.sh "$PWD" claude-code "test-claude-ID-e2e-test-TS-TS"                    ▐
      │  "$CLAUDE_CODE_SESSION_ID" を実行して、この agent identity を claim してください。                                                  ▐
      │  claim に失敗した場合は task ack を返さず、作業を開始しないでください。                                                             ▐
      │  team は herdr-symphony-test-claude-ID-e2e-test-TS-TS、あなたの agent 名と runId は                             ▐
      │  test-claude-ID-e2e-test-TS-TS、issueId は test-issue-claude です。                                             ▐
      │  herdr-symphony.task を受け取ったら、runId と toAgent が自分宛てか確認してください。違う場合は無視してください。                    ▐
      │  task を受け取ったら、まず /opt/agmsg/scripts/send.sh herdr-symphony-test-claude-ID-e2e-test-TS-TS              ▐
      │  test-claude-ID-e2e-test-TS-TS herdr-symphony '{"kind":"herdr-symphony.ack","runId":"test-claude-ID-e ▐
      │  2e-test-claude-ID","toAgent":"herdr-symphony","issueId":"test-issue-claude","ackOf":"task"}' を実行し、その後 task.prompt    ▐
      │  を実行してください。                                                                                                               ▐
      │  reminder を受け取ったら、まず /opt/agmsg/scripts/send.sh herdr-symphony-test-claude-ID-e2e-test-TS-TS          ▐
      │  test-claude-ID-e2e-test-TS-TS herdr-symphony '{"kind":"herdr-symphony.ack","runId":"test-claude-ID-e ▐
      │  2e-test-claude-ID","toAgent":"herdr-symphony","issueId":"test-issue-claude","ackOf":"reminder"}' を実行してください。        ▐
      │  完了時は、ユーザーへの完了報告と同等の内容を summary に入れて report してください。                                                ▐
      │  done: /opt/agmsg/scripts/send.sh herdr-symphony-test-claude-ID-e2e-test-TS-TS                                  ▐
      │  test-claude-ID-e2e-test-TS-TS herdr-symphony '{"kind":"herdr-symphony.report","runId":"test-claude-ID ▐
      │  ID-e2e-test-TS-TS","toAgent":"herdr-symphony","issueId":"test-issue-claude","status":"done","summary":"対応内容:          ▐
      │  ...。検証: ...。補足: ...。"}'                                                                                                     ▐
      │  pending: /opt/agmsg/scripts/send.sh herdr-symphony-test-claude-ID-e2e-test-TS-TS                               ▐
      │  test-claude-ID-e2e-test-TS-TS herdr-symphony '{"kind":"herdr-symphony.report","runId":"test-claude-ID ▐
      │  ID-e2e-test-TS-TS","toAgent":"herdr-symphony","issueId":"test-issue-claude","status":"pending","summary":"待機中の内容"}' ▐
      │  failed: /opt/agmsg/scripts/send.sh herdr-symphony-test-claude-ID-e2e-test-TS-TS                                ▐
      │  test-claude-ID-e2e-test-TS-TS herdr-symphony '{"kind":"herdr-symphony.report","runId":"test-claude-ID ▐
      │  ID-e2e-test-TS-TS","toAgent":"herdr-symphony","issueId":"test-issue-claude","status":"failed","summary":"失敗理由"}'      ▐
      │                                                                                                                                     ▐
      │● Task completed successfully.                                                                                                       ▐
      │                                                                                                                                     ▐
      │✻ Worked for 0s ▐
      │                                                                                                                                     ▐
      │─▐
      │❯                                                                                                                                    ▐
      │─▐
      │  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents                                                                       ▐
      │                                                                                                                                     ▐"
    `)
  } finally {
    await herdr.cleanup()
  }
}, 120_000)

test("e2e: claude report 未送信の idle — agent の画面全体を確認できる", async () => {
  const projectRoot = process.cwd()

  const herdr = await createHerdrIsolation("e2e-claude-reminder")

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

    const identifier = `test-claude-${newRunId()}`
    const { containerPath } = await writeScenarioConfig(herdr.sharedDir, {
      kind: "claude",
      messenger: "agmsg",
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

    const agentScreen = await captureAgentScreen(scenarioSession, herdrSession, herdr.containerId)

    expect(agentScreen).toMatchInlineSnapshot(`
      "
      │ 1       +
      │╰─╯▐
      │                                                                                                                                     ▐
      │                                                                                                                                     ▐
      │❯ あなたは herdr-symphony の agent です。                                                                                            ▐
      │  実タスクは agmsg で届きます。                                                                                                      ▐
      │  最初に /opt/agmsg/scripts/actas-claim.sh "$PWD" claude-code "test-claude-ID-e2e-test-TS-TS"                    ▐
      │  "$CLAUDE_CODE_SESSION_ID" を実行して、この agent identity を claim してください。                                                  ▐
      │  claim に失敗した場合は task ack を返さず、作業を開始しないでください。                                                             ▐
      │  team は herdr-symphony-test-claude-ID-e2e-test-TS-TS、あなたの agent 名と runId は                             ▐
      │  test-claude-ID-e2e-test-TS-TS、issueId は test-issue-claude です。                                             ▐
      │  herdr-symphony.task を受け取ったら、runId と toAgent が自分宛てか確認してください。違う場合は無視してください。                    ▐
      │  task を受け取ったら、まず /opt/agmsg/scripts/send.sh herdr-symphony-test-claude-ID-e2e-test-TS-TS              ▐
      │  test-claude-ID-e2e-test-TS-TS herdr-symphony '{"kind":"herdr-symphony.ack","runId":"test-claude-ID-e ▐
      │  2e-test-claude-ID","toAgent":"herdr-symphony","issueId":"test-issue-claude","ackOf":"task"}' を実行し、その後 task.prompt    ▐
      │  を実行してください。                                                                                                               ▐
      │  reminder を受け取ったら、まず /opt/agmsg/scripts/send.sh herdr-symphony-test-claude-ID-e2e-test-TS-TS          ▐
      │  test-claude-ID-e2e-test-TS-TS herdr-symphony '{"kind":"herdr-symphony.ack","runId":"test-claude-ID-e ▐
      │  2e-test-claude-ID","toAgent":"herdr-symphony","issueId":"test-issue-claude","ackOf":"reminder"}' を実行してください。        ▐
      │  完了時は、ユーザーへの完了報告と同等の内容を summary に入れて report してください。                                                ▐
      │  done: /opt/agmsg/scripts/send.sh herdr-symphony-test-claude-ID-e2e-test-TS-TS                                  ▐
      │  test-claude-ID-e2e-test-TS-TS herdr-symphony '{"kind":"herdr-symphony.report","runId":"test-claude-ID ▐
      │  ID-e2e-test-TS-TS","toAgent":"herdr-symphony","issueId":"test-issue-claude","status":"done","summary":"対応内容:          ▐
      │  ...。検証: ...。補足: ...。"}'                                                                                                     ▐
      │  pending: /opt/agmsg/scripts/send.sh herdr-symphony-test-claude-ID-e2e-test-TS-TS                               ▐
      │  test-claude-ID-e2e-test-TS-TS herdr-symphony '{"kind":"herdr-symphony.report","runId":"test-claude-ID ▐
      │  ID-e2e-test-TS-TS","toAgent":"herdr-symphony","issueId":"test-issue-claude","status":"pending","summary":"待機中の内容"}' ▐
      │  failed: /opt/agmsg/scripts/send.sh herdr-symphony-test-claude-ID-e2e-test-TS-TS                                ▐
      │  test-claude-ID-e2e-test-TS-TS herdr-symphony '{"kind":"herdr-symphony.report","runId":"test-claude-ID ▐
      │  ID-e2e-test-TS-TS","toAgent":"herdr-symphony","issueId":"test-issue-claude","status":"failed","summary":"失敗理由"}'      ▐
      │                                                                                                                                     ▐
      │● Task completed successfully.                                                                                                       ▐
      │                                                                                                                                     ▐
      │✻ Worked for 0s ▐
      │                                                                                                                                     ▐
      │─▐
      │❯                                                                                                                                    ▐
      │─▐
      │  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents                                                                       ▐
      │                                                                                                                                     ▐"
    `)
  } finally {
    await herdr.cleanup()
  }
}, 150_000)

test("e2e: claude report_file モード — herdr-symphony report で完了報告する", async () => {
  const projectRoot = process.cwd()

  const herdr = await createHerdrIsolation("e2e-claude-report-file")

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

    const agentScreen = await captureAgentScreen(scenarioSession, herdrSession, herdr.containerId)

    expect(agentScreen).toMatchInlineSnapshot(`
      "
      │ 1       +
      │╭─ Claude Code VERSION ─╮
      ││                                                    │ WHAT_NEW │
      ││                    Welcome back!                   │ Auto mode is now available without \`CLAUDE_CODE_ENABLE_AUTO_MODE\` opt-in on… │
      ││                                                    │ Fixed the terminal freezing and keystrokes lagging while streaming response… │
      ││                       ▐▛███▜▌                      │ CLAUDE_WHATS_NEW_LINE ││                      ▝▜█████▛▘                     │ CLAUDE_WHATS_NEW_LINE ││                        ▘▘ ▝▝                       │                                                                              │
      ││                                                    │                                                                              │
      ││      Opus 4.8 (1M context) · API Usage Billing     │                                                                              │
      ││  TEMP_DIR │                                                                              │
      │╰─╯
      │
      │
      │❯ Test prompt for test-claude-ID
      │  ## 完了報告
      │
      │  ユーザーに依頼された作業が完了したら、以下のコマンドを実行してください。
      │
      │      herdr-symphony report --status done --summary "やった作業の要約"
      │
      │  background task / subagent / task の完了待ちなら、以下のコマンドを実行してください。
      │
      │      herdr-symphony report --status pending --summary "待機中の内容"
      │
      │  失敗した場合は、以下のコマンドを実行してください。
      │
      │      herdr-symphony report --status failed --summary "失敗理由"
      │
      │● Task completed successfully.
      │
      │✻ Worked for 0s │
      │─
      │❯
      │─
      │  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents
      │
      │
      │"
    `)
  } finally {
    await herdr.cleanup()
  }
}, 120_000)
