import {
  readFile as nodeReadFile,
  realpath as nodeRealpath,
  stat as nodeStat,
  readdir,
} from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type { ReportContext, ReportResolver, ReportResolverDeps } from "./types"

type JsonlLine = { type?: string; cwd?: string; timestamp?: string; message?: unknown }

type JsonlFile = { path: string; mtimeMs: number }

export class ClaudeReportResolver implements ReportResolver {
  constructor(private readonly deps: ReportResolverDeps = {}) {}

  async resolve(ctx: ReportContext): Promise<string | null> {
    const readDir = this.deps.readDir ?? ((p: string) => readdir(p))
    const readFile = this.deps.readFile ?? ((p: string) => nodeReadFile(p, "utf8"))
    const stat =
      this.deps.stat ?? ((p: string) => nodeStat(p).then((s) => ({ mtimeMs: s.mtimeMs })))
    const home = (this.deps.homeDir ?? homedir)()
    const projectsDir = join(home, ".claude", "projects")

    const workspaceReal = await this.realpathSafe(ctx.workspacePath)
    const started = Date.parse(ctx.startedAt)

    let projectDirs: string[]
    try {
      projectDirs = await readDir(projectsDir)
    } catch {
      return null
    }

    const files = await this.collectJsonlFiles(projectsDir, projectDirs, readDir, stat)
    files.sort((a, b) => b.mtimeMs - a.mtimeMs)

    for (const file of files) {
      let content: string
      try {
        content = await readFile(file.path)
      } catch {
        continue
      }
      const text = await this.scanLines(content, workspaceReal, started)
      if (text) return text
    }
    return null
  }

  private async collectJsonlFiles(
    projectsDir: string,
    projectDirs: string[],
    readDir: (p: string) => Promise<string[]>,
    stat: (p: string) => Promise<{ mtimeMs: number }>,
  ): Promise<JsonlFile[]> {
    const files: JsonlFile[] = []
    for (const dir of projectDirs) {
      const dirPath = join(projectsDir, dir)
      let entries: string[]
      try {
        entries = await readDir(dirPath)
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.endsWith(".jsonl")) continue
        const filePath = join(dirPath, entry)
        try {
          const s = await stat(filePath)
          files.push({ path: filePath, mtimeMs: s.mtimeMs })
        } catch {}
      }
    }
    return files
  }

  private async scanLines(
    content: string,
    workspaceReal: string,
    started: number,
  ): Promise<string | null> {
    const lines = content.split("\n")
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]?.trim()
      if (!line) continue
      const obj = parseJsonLine(line)
      if (obj?.type !== "assistant") continue
      if (typeof obj.cwd !== "string") continue
      const cwdReal = await this.realpathSafe(obj.cwd)
      if (cwdReal !== workspaceReal) continue
      const ts = typeof obj.timestamp === "string" ? Date.parse(obj.timestamp) : Number.NaN
      if (!Number.isNaN(started) && !Number.isNaN(ts) && ts < started) continue
      const text = extractContentText(obj.message)
      if (text) return text
    }
    return null
  }

  private async realpathSafe(path: string): Promise<string> {
    const realpath = this.deps.realpath ?? ((p: string) => nodeRealpath(p))
    try {
      return await realpath(path)
    } catch {
      return path
    }
  }
}

function parseJsonLine(line: string): JsonlLine | null {
  try {
    const parsed = JSON.parse(line)
    if (parsed && typeof parsed === "object") return parsed as JsonlLine
    return null
  } catch {
    return null
  }
}

function extractContentText(message: unknown): string | null {
  if (!message || typeof message !== "object") return null
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content)) return null
  const texts: string[] = []
  for (const part of content) {
    if (
      part &&
      typeof part === "object" &&
      (part as { type?: string }).type === "text" &&
      typeof (part as { text?: string }).text === "string"
    ) {
      texts.push((part as { text: string }).text)
    }
  }
  return texts.length > 0 ? texts.join("\n") : null
}
