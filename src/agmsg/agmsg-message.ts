export type AgentReportStatus = "done" | "pending" | "failed"

export type TaskMessage = {
  kind: "herdr-symphony.task"
  issueId: string
  runId: string
  toAgent: string
  prompt: string
}

export type AckMessage = {
  kind: "herdr-symphony.ack"
  issueId: string
  runId: string
  toAgent: string
  ackOf: "task" | "reminder"
}

export type ReminderMessage = {
  kind: "herdr-symphony.reminder"
  issueId: string
  runId: string
  toAgent: string
  message: string
}

export type AgentReportMessage = {
  kind: "herdr-symphony.report"
  issueId: string
  runId: string
  toAgent: string
  status: AgentReportStatus
  summary: string
}

export type AgmsgMessage = TaskMessage | AckMessage | ReminderMessage | AgentReportMessage

export type ExpectedAgmsgMessage = {
  issueId: string
  runId: string
  toAgent: string
}

export function formatAgmsgMessage(input: AgmsgMessage): string {
  return JSON.stringify(input)
}

export function parseAgmsgMessage(
  body: string,
  expected: ExpectedAgmsgMessage,
): AgmsgMessage | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }

  if (typeof parsed !== "object" || parsed === null) {
    return null
  }

  const obj = parsed as Record<string, unknown>
  if (obj.issueId !== expected.issueId) return null
  if (obj.runId !== expected.runId) return null
  if (obj.toAgent !== expected.toAgent) return null

  if (obj.kind === "herdr-symphony.task") {
    if (typeof obj.prompt !== "string") return null
    return {
      kind: "herdr-symphony.task",
      issueId: expected.issueId,
      runId: expected.runId,
      toAgent: expected.toAgent,
      prompt: obj.prompt,
    }
  }

  if (obj.kind === "herdr-symphony.ack") {
    if (obj.ackOf !== "task" && obj.ackOf !== "reminder") return null
    return {
      kind: "herdr-symphony.ack",
      issueId: expected.issueId,
      runId: expected.runId,
      toAgent: expected.toAgent,
      ackOf: obj.ackOf,
    }
  }

  if (obj.kind === "herdr-symphony.reminder") {
    if (typeof obj.message !== "string") return null
    return {
      kind: "herdr-symphony.reminder",
      issueId: expected.issueId,
      runId: expected.runId,
      toAgent: expected.toAgent,
      message: obj.message,
    }
  }

  if (obj.kind === "herdr-symphony.report") {
    if (obj.status !== "done" && obj.status !== "pending" && obj.status !== "failed") return null
    if (typeof obj.summary !== "string") return null
    return {
      kind: "herdr-symphony.report",
      issueId: expected.issueId,
      runId: expected.runId,
      toAgent: expected.toAgent,
      status: obj.status,
      summary: obj.summary,
    }
  }

  return null
}

export function parseInboxForMessages(
  inboxOutput: string,
  expected: ExpectedAgmsgMessage,
): AgmsgMessage[] {
  const messages: AgmsgMessage[] = []
  for (const line of inboxOutput.split("\n")) {
    const jsonStart = line.indexOf("{")
    if (jsonStart === -1) continue
    const message = parseAgmsgMessage(line.slice(jsonStart), expected)
    if (message) messages.push(message)
  }
  return messages
}
