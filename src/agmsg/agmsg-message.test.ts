import { describe, expect, test } from "bun:test"
import { formatAgmsgMessage, parseAgmsgMessage, parseInboxForMessages } from "./agmsg-message"

const expected = {
  issueId: "issue-1",
  runId: "TEST-1-WORKFLOW-ly02lc00",
  toAgent: "herdr-symphony",
}

describe("agmsg message", () => {
  test("task message を生成・パースできる", () => {
    const body = formatAgmsgMessage({
      kind: "herdr-symphony.task",
      issueId: "issue-1",
      runId: "TEST-1-WORKFLOW-ly02lc00",
      toAgent: "TEST-1-WORKFLOW-ly02lc00",
      prompt: '実装してください\n"quoted"',
    })

    expect(
      parseAgmsgMessage(body, {
        issueId: "issue-1",
        runId: "TEST-1-WORKFLOW-ly02lc00",
        toAgent: "TEST-1-WORKFLOW-ly02lc00",
      }),
    ).toEqual({
      kind: "herdr-symphony.task",
      issueId: "issue-1",
      runId: "TEST-1-WORKFLOW-ly02lc00",
      toAgent: "TEST-1-WORKFLOW-ly02lc00",
      prompt: '実装してください\n"quoted"',
    })
  })

  test("ackOf=task の ack を生成・パースできる", () => {
    const body = formatAgmsgMessage({
      kind: "herdr-symphony.ack",
      issueId: "issue-1",
      runId: "TEST-1-WORKFLOW-ly02lc00",
      toAgent: "herdr-symphony",
      ackOf: "task",
    })

    expect(parseAgmsgMessage(body, expected)).toEqual({
      kind: "herdr-symphony.ack",
      issueId: "issue-1",
      runId: "TEST-1-WORKFLOW-ly02lc00",
      toAgent: "herdr-symphony",
      ackOf: "task",
    })
  })

  test("ackOf=reminder の ack を生成・パースできる", () => {
    const body = formatAgmsgMessage({
      kind: "herdr-symphony.ack",
      issueId: "issue-1",
      runId: "TEST-1-WORKFLOW-ly02lc00",
      toAgent: "herdr-symphony",
      ackOf: "reminder",
    })

    expect(parseAgmsgMessage(body, expected)?.kind).toBe("herdr-symphony.ack")
  })

  test("report を生成・パースできる", () => {
    const body = formatAgmsgMessage({
      kind: "herdr-symphony.report",
      issueId: "issue-1",
      runId: "TEST-1-WORKFLOW-ly02lc00",
      toAgent: "herdr-symphony",
      status: "done",
      summary: "対応内容: 実装しました。検証: bun test が成功しました。",
    })

    expect(parseAgmsgMessage(body, expected)).toEqual({
      kind: "herdr-symphony.report",
      issueId: "issue-1",
      runId: "TEST-1-WORKFLOW-ly02lc00",
      toAgent: "herdr-symphony",
      status: "done",
      summary: "対応内容: 実装しました。検証: bun test が成功しました。",
    })
  })

  test("issueId runId toAgent が違う message は無視する", () => {
    const body = formatAgmsgMessage({
      kind: "herdr-symphony.ack",
      issueId: "issue-1",
      runId: "other-run",
      toAgent: "herdr-symphony",
      ackOf: "task",
    })

    expect(parseAgmsgMessage(body, expected)).toBeNull()
  })

  test("inbox 出力から対象 message だけを取り出す", () => {
    const ignored = formatAgmsgMessage({
      kind: "herdr-symphony.ack",
      issueId: "issue-1",
      runId: "other-run",
      toAgent: "herdr-symphony",
      ackOf: "task",
    })
    const accepted = formatAgmsgMessage({
      kind: "herdr-symphony.ack",
      issueId: "issue-1",
      runId: "TEST-1-WORKFLOW-ly02lc00",
      toAgent: "herdr-symphony",
      ackOf: "task",
    })

    const messages = parseInboxForMessages(
      [` [ts] OTHER: ${ignored}`, ` [ts] AGENT: ${accepted}`].join("\n"),
      expected,
    )

    expect(messages).toEqual([
      {
        kind: "herdr-symphony.ack",
        issueId: "issue-1",
        runId: "TEST-1-WORKFLOW-ly02lc00",
        toAgent: "herdr-symphony",
        ackOf: "task",
      },
    ])
  })
})
