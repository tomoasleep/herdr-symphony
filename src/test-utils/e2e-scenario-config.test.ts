import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  claudeAckThenReportToolCall,
  claudeAckToolCall,
  claudeReportToolCall,
  plainResponse,
  scenarioConfigSchema,
  shellQuote,
  writeScenarioConfig,
} from "./e2e-scenario-config"

const CTX = {
  issueId: "test-issue-1",
  agentName: "agent-run-abc",
  team: "herdr-symphony-agent-run-abc",
  scriptsDir: "/opt/agmsg/scripts",
}

test("scenarioConfigSchema は空配列の mockResponses を reject する", () => {
  expect(() =>
    scenarioConfigSchema.parse({
      kind: "opencode",
      issue: { id: "i", identifier: "r#1", title: "t", body: "b" },
      mockResponses: [],
    }),
  ).toThrow(/mockResponses/)
})

test("scenarioConfigSchema は不正な kind を reject する", () => {
  expect(() =>
    scenarioConfigSchema.parse({
      kind: "invalid",
      issue: { id: "i", identifier: "r#1", title: "t", body: "b" },
      mockResponses: [{ kind: "respond", content: "x" }],
    }),
  ).toThrow()
})

test("scenarioConfigSchema は toolCalls[].name が文字列でない場合を reject する", () => {
  expect(() =>
    scenarioConfigSchema.parse({
      kind: "opencode",
      issue: { id: "i", identifier: "r#1", title: "t", body: "b" },
      mockResponses: [
        {
          kind: "respond",
          content: "x",
          toolCalls: [{ name: 42, arguments: {} }],
        },
      ],
    }),
  ).toThrow()
})

test("scenarioConfigSchema は wait を受け付ける", () => {
  const parsed = scenarioConfigSchema.parse({
    kind: "opencode",
    issue: { id: "i", identifier: "r#1", title: "t", body: "b" },
    mockResponses: [{ kind: "wait", ms: 100, next: { kind: "respond", content: "x" } }],
  })
  expect(parsed.mockResponses[0]?.kind).toBe("wait")
})

test("scenarioConfigSchema は respond と wait の expectedUserMessage を受け付ける", () => {
  const parsed = scenarioConfigSchema.parse({
    kind: "opencode",
    issue: { id: "i", identifier: "r#1", title: "t", body: "b" },
    mockResponses: [
      { kind: "respond", content: "x", expectedUserMessage: "first prompt" },
      {
        kind: "wait",
        ms: 100,
        expectedUserMessage: "reminder",
        next: { kind: "respond", content: "y" },
      },
    ],
  })
  expect(parsed.mockResponses[0]?.expectedUserMessage).toBe("first prompt")
  expect(parsed.mockResponses[1]?.expectedUserMessage).toBe("reminder")
})

test("scenarioConfigSchema は wait.next が無い場合を reject する", () => {
  expect(() =>
    scenarioConfigSchema.parse({
      kind: "opencode",
      issue: { id: "i", identifier: "r#1", title: "t", body: "b" },
      mockResponses: [{ kind: "wait", ms: 100 }],
    }),
  ).toThrow()
})

test("scenarioConfigSchema は wait.ms が 0 以下の場合を reject する", () => {
  expect(() =>
    scenarioConfigSchema.parse({
      kind: "opencode",
      issue: { id: "i", identifier: "r#1", title: "t", body: "b" },
      mockResponses: [{ kind: "wait", ms: 0, next: { kind: "respond", content: "x" } }],
    }),
  ).toThrow()
  expect(() =>
    scenarioConfigSchema.parse({
      kind: "opencode",
      issue: { id: "i", identifier: "r#1", title: "t", body: "b" },
      mockResponses: [{ kind: "wait", ms: -10, next: { kind: "respond", content: "x" } }],
    }),
  ).toThrow()
})

test("plainResponse は kind=respond で content だけの応答を返す", () => {
  expect(plainResponse("hello")).toEqual({ kind: "respond", content: "hello" })
})

test("claudeAckToolCall は Bash toolCall を持ち send.sh で ack body を送る", () => {
  const got = claudeAckToolCall(CTX)
  expect(got.kind).toBe("respond")
  if (got.kind !== "respond") return
  expect(got.toolCalls).toHaveLength(1)
  const command = String(got.toolCalls?.[0]?.arguments?.command ?? "")
  expect(command).toContain("/opt/agmsg/scripts/send.sh")
  expect(command).toContain("herdr-symphony-agent-run-abc")
  expect(command).toContain("agent-run-abc")
  expect(command).toContain("herdr-symphony")
  expect(command).toContain('"kind":"herdr-symphony.ack"')
  expect(command).toContain('"ackOf":"task"')
})

test("claudeReportToolCall は report body に status と summary を含む", () => {
  const got = claudeReportToolCall(CTX, { status: "done", summary: "Task completed." })
  expect(got.kind).toBe("respond")
  if (got.kind !== "respond") return
  const command = String(got.toolCalls?.[0]?.arguments?.command ?? "")
  expect(command).toContain('"kind":"herdr-symphony.report"')
  expect(command).toContain('"status":"done"')
  expect(command).toContain("Task completed.")
})

test("claudeReportToolCall は pending / failed も反映する", () => {
  const pending = claudeReportToolCall(CTX, { status: "pending", summary: "waiting subtask" })
  if (pending.kind !== "respond") return
  expect(String(pending.toolCalls?.[0]?.arguments?.command ?? "")).toContain('"status":"pending"')

  const failed = claudeReportToolCall(CTX, { status: "failed", summary: "boom" })
  if (failed.kind !== "respond") return
  expect(String(failed.toolCalls?.[0]?.arguments?.command ?? "")).toContain('"status":"failed"')
  expect(String(failed.toolCalls?.[0]?.arguments?.command ?? "")).toContain("boom")
})

test("claudeAckThenReportToolCall は ack と report を && で繋ぐ", () => {
  const got = claudeAckThenReportToolCall(CTX, {
    status: "done",
    summary: "Task completed.",
    sleepMs: 10,
  })
  if (got.kind !== "respond") return
  const command = String(got.toolCalls?.[0]?.arguments?.command ?? "")
  expect(command).toContain("&&")
  expect(command).toContain('"kind":"herdr-symphony.ack"')
  expect(command).toContain('"kind":"herdr-symphony.report"')
  expect(command).toContain("sleep 10")
})

test("shellQuote は apostrophe を \\'\\'\\' にエスケープする", () => {
  expect(shellQuote("hello")).toBe("'hello'")
  expect(shellQuote("it's a problem")).toBe("'it'\\''s a problem'")
})

test("shellQuote は実際の sh 実行で元の文字列に戻る", async () => {
  const cases = ["hello", "it's a problem", "back`tick", 'double"quote', "$VAR", "; rm -rf /"]
  for (const original of cases) {
    const quoted = shellQuote(original)
    const proc = Bun.spawn({
      cmd: ["sh", "-c", `printf %s ${quoted}`],
      stdout: "pipe",
      stderr: "pipe",
    })
    const text = await new Response(proc.stdout).text()
    const exitCode = await proc.exited
    expect(exitCode).toBe(0)
    expect(text).toBe(original)
  }
})

function extractBodyQuoted(command: string): string {
  const marker = "herdr-symphony "
  const idx = command.lastIndexOf(marker)
  if (idx === -1) throw new Error("toAgent herdr-symphony not found in command")
  return command.slice(idx + marker.length).trim()
}

function unshellQuote(quoted: string): string {
  if (!quoted.startsWith("'") || !quoted.endsWith("'")) {
    throw new Error(`not a shell-quoted string: ${quoted}`)
  }
  return quoted.slice(1, -1).replace(/'\\''/g, "'")
}

test("claudeReportToolCall の command は apostrophe を含む summary でも sh で元に戻る", async () => {
  const summary = "it's a problem; and $VAR"
  const got = claudeReportToolCall(CTX, { status: "failed", summary })
  if (got.kind !== "respond") return
  const command = String(got.toolCalls?.[0]?.arguments?.command ?? "")
  const bodyQuoted = extractBodyQuoted(command)
  const body = JSON.parse(unshellQuote(bodyQuoted))
  expect(body.summary).toBe(summary)
  const proc = Bun.spawn({
    cmd: ["sh", "-c", `printf %s ${bodyQuoted}`],
    stdout: "pipe",
    stderr: "pipe",
  })
  const text = await new Response(proc.stdout).text()
  const exitCode = await proc.exited
  expect(exitCode).toBe(0)
  expect(JSON.parse(text).summary).toBe(summary)
})

test("writeScenarioConfig は sharedDir/scenario-*.json に書き hostPath/containerPath を返す", async () => {
  const dir = await mkdtemp(join(tmpdir(), "herdr-e2e-test-"))
  try {
    const { hostPath, containerPath } = await writeScenarioConfig(dir, {
      kind: "opencode",
      issue: { id: "test-issue-1", identifier: "test/repo#1", title: "t", body: "b" },
      mockResponses: [plainResponse("done")],
    })
    expect(hostPath.startsWith(dir)).toBe(true)
    expect(hostPath).toMatch(/scenario-[a-z0-9]+\.json$/)
    expect(containerPath).toMatch(/^\/tmp\/shared\/scenario-[a-z0-9]+\.json$/)

    const content = await readFile(hostPath, "utf8")
    const parsed = JSON.parse(content)
    expect(parsed).toEqual({
      kind: "opencode",
      issue: { id: "test-issue-1", identifier: "test/repo#1", title: "t", body: "b" },
      mockResponses: [{ kind: "respond", content: "done" }],
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
