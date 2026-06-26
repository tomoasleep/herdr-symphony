import { ClaudeReportResolver } from "./claude-resolver"
import { OpenCodeReportResolver } from "./opencode-resolver"
import type { ReportContext, ReportResolver, ReportResolverDeps } from "./types"

export function createReportResolver(deps: ReportResolverDeps = {}): ReportResolver {
  const opencode = new OpenCodeReportResolver(deps)
  const claude = new ClaudeReportResolver(deps)
  return {
    async resolve(ctx: ReportContext): Promise<string | null> {
      if (ctx.agentKind === "claude") return claude.resolve(ctx)
      return opencode.resolve(ctx)
    },
  }
}

export type { ReportContext, ReportResolver, ReportResolverDeps } from "./types"
