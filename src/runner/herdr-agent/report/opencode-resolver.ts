import { realpath as nodeRealpath } from "node:fs/promises"
import type { ReportContext, ReportResolver, ReportResolverDeps } from "./types"

const RECENT_SESSION_LIMIT = 50

type SessionLike = { id?: string; directory?: string; updated?: number }
type PartLike = { type?: string; text?: string }
type ExportMessage = { info?: { role?: string }; parts?: PartLike[] }

export class OpenCodeReportResolver implements ReportResolver {
  constructor(private readonly deps: ReportResolverDeps = {}) {}

  async resolve(ctx: ReportContext): Promise<string | null> {
    const run = this.deps.commandRunner
    if (!run) return null

    const bin = this.deps.opencodeBin ?? "opencode"

    const listResult = await run(
      bin,
      ["session", "list", "--format", "json", "-n", String(RECENT_SESSION_LIMIT)],
      ctx.workspacePath,
    )
    if (listResult.exitCode !== 0) {
      this.log(
        `opencode session list failed exitCode=${listResult.exitCode} stderr=${listResult.stderr}`,
      )
      return null
    }

    const sessions = parseArray<SessionLike>(listResult.stdout)
    if (sessions.length === 0) return null

    const workspaceReal = await this.realpathSafe(ctx.workspacePath)
    const started = Date.parse(ctx.startedAt)

    const candidates: SessionLike[] = []
    for (const s of sessions) {
      if (s.directory === undefined || s.updated === undefined) continue
      if (!Number.isNaN(started) && s.updated < started) continue
      const dirReal = await this.realpathSafe(s.directory)
      if (dirReal === workspaceReal) candidates.push(s)
    }
    if (candidates.length === 0) return null

    candidates.sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))
    const id = candidates[0]?.id
    if (!id) return null

    const exportResult = await run(bin, ["export", id], ctx.workspacePath)
    if (exportResult.exitCode !== 0) {
      this.log(
        `opencode export failed id=${id} exitCode=${exportResult.exitCode} stderr=${exportResult.stderr}`,
      )
      return null
    }

    const messages = parseExport(exportResult.stdout)
    return extractLastAssistantText(messages)
  }

  private async realpathSafe(path: string): Promise<string> {
    const realpath = this.deps.realpath ?? ((p: string) => nodeRealpath(p))
    try {
      return await realpath(path)
    } catch {
      return path
    }
  }

  private log(msg: string): void {
    this.deps.logger?.(msg)
  }
}

function parseArray<T>(stdout: string): T[] {
  try {
    const parsed = JSON.parse(stdout)
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}

function parseExport(stdout: string): ExportMessage[] {
  try {
    const parsed = JSON.parse(stdout) as { messages?: unknown }
    return Array.isArray(parsed.messages) ? (parsed.messages as ExportMessage[]) : []
  } catch {
    return []
  }
}

function extractLastAssistantText(messages: ExportMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.info?.role !== "assistant") continue
    const texts = (message.parts ?? [])
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string)
    if (texts.length > 0) return texts.join("\n")
  }
  return null
}
