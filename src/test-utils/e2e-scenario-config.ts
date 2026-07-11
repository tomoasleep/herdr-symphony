import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import type { AgentReportStatus } from "../agmsg/agmsg-message"
import { formatAgmsgMessage } from "../agmsg/agmsg-message"
import { buildAgentName } from "../runner/herdr-agent/herdr-agent-runner"
import { sanitizeWorkspaceKey } from "../utils/normalize"

export const SCENARIO_NOW = 1_719_662_400_000
const CLAUDE_WORKFLOW_NAME = "e2e-test-claude.md"

export type AgmsgContext = {
  issueId: string
  agentName: string
  team: string
  scriptsDir: string
}

export function buildClaudeAgmsgContext(opts: {
  issueId: string
  identifier: string
}): AgmsgContext {
  const agentName = buildAgentName(opts.identifier, CLAUDE_WORKFLOW_NAME, SCENARIO_NOW)
  const team = `herdr-symphony-${sanitizeWorkspaceKey(agentName)}`
  const scriptsDir = process.env.AGMSG_SCRIPTS_DIR ?? "/opt/agmsg/scripts"
  return { issueId: opts.issueId, agentName, team, scriptsDir }
}

const toolCallSchema = z.object({
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()),
})

export const mockResponseSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("respond"),
    content: z.string(),
    toolCalls: z.array(toolCallSchema).optional(),
  }),
  z.object({
    kind: z.literal("wait"),
    ms: z.number().positive(),
    next: z.lazy((): z.ZodType => mockResponseSchema),
  }),
])

export const scenarioConfigSchema = z.object({
  kind: z.enum(["opencode", "claude"]),
  messenger: z.enum(["agmsg", "report_file"]).optional(),
  issue: z.object({
    id: z.string(),
    identifier: z.string(),
    title: z.string(),
    body: z.string(),
  }),
  mockResponses: z.array(mockResponseSchema).min(1),
})

export type ScenarioConfig = z.infer<typeof scenarioConfigSchema>
export type MockResponse = z.infer<typeof mockResponseSchema>

function randomId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

export async function writeScenarioConfig(
  sharedDir: string,
  config: ScenarioConfig,
): Promise<{ hostPath: string; containerPath: string }> {
  const filename = `scenario-${randomId()}.json`
  const hostPath = join(sharedDir, filename)
  const containerPath = hostPath
  await writeFile(hostPath, `${JSON.stringify(config)}\n`)
  return { hostPath, containerPath }
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

function buildSendCommand(ctx: AgmsgContext, body: string): string {
  return `${ctx.scriptsDir}/send.sh ${shellQuote(ctx.team)} ${shellQuote(ctx.agentName)} herdr-symphony ${shellQuote(body)}`
}

function ackBody(ctx: AgmsgContext): string {
  return formatAgmsgMessage({
    kind: "herdr-symphony.ack",
    issueId: ctx.issueId,
    runId: ctx.agentName,
    toAgent: "herdr-symphony",
    ackOf: "task",
  })
}

function reportBody(ctx: AgmsgContext, status: AgentReportStatus, summary: string): string {
  return formatAgmsgMessage({
    kind: "herdr-symphony.report",
    issueId: ctx.issueId,
    runId: ctx.agentName,
    toAgent: "herdr-symphony",
    status,
    summary,
  })
}

function bashToolCall(command: string): MockResponse {
  return {
    kind: "respond",
    content: "Sending agmsg command.",
    toolCalls: [{ name: "Bash", arguments: { command } }],
  }
}

export function claudeAckToolCall(ctx: AgmsgContext): MockResponse {
  return bashToolCall(buildSendCommand(ctx, ackBody(ctx)))
}

export function claudeReportToolCall(
  ctx: AgmsgContext,
  opts: { status: AgentReportStatus; summary: string },
): MockResponse {
  return bashToolCall(buildSendCommand(ctx, reportBody(ctx, opts.status, opts.summary)))
}

export function claudeAckThenReportToolCall(
  ctx: AgmsgContext,
  opts: { status: AgentReportStatus; summary: string; sleepMs?: number },
): MockResponse {
  const ack = buildSendCommand(ctx, ackBody(ctx))
  const report = buildSendCommand(ctx, reportBody(ctx, opts.status, opts.summary))
  const sleep = opts.sleepMs ? ` && sleep ${opts.sleepMs}` : ""
  return bashToolCall(`${ack} && ${report}${sleep}`)
}

export function claudeReportFileToolCall(opts: {
  status: AgentReportStatus
  summary: string
}): MockResponse {
  const quotedSummary = shellQuote(opts.summary)
  return {
    kind: "respond",
    content: "Writing report file.",
    toolCalls: [
      {
        name: "Bash",
        arguments: {
          command: `herdr-symphony report --status ${opts.status} --summary ${quotedSummary}`,
        },
      },
    ],
  }
}

export function plainResponse(content: string): MockResponse {
  return { kind: "respond", content }
}
