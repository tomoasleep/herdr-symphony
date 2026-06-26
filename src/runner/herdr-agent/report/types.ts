import type { CommandRunner } from "../../../herdr/herdr-client"

export type ReportContext = {
  workspacePath: string
  startedAt: string
  agentKind: "opencode" | "claude"
}

export interface ReportResolver {
  resolve(ctx: ReportContext): Promise<string | null>
}

export type ReportResolverDeps = {
  commandRunner?: CommandRunner
  readFile?: (path: string) => Promise<string>
  readDir?: (path: string) => Promise<string[]>
  stat?: (path: string) => Promise<{ mtimeMs: number }>
  realpath?: (path: string) => Promise<string>
  homeDir?: () => string
  logger?: (msg: string) => void
  opencodeBin?: string
}
