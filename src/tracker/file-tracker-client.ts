import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises"
import { basename, dirname, join, relative } from "node:path"
import matter from "gray-matter"
import type { Issue, TrackerConfig } from "../domain/types"
import { isActiveState } from "../orchestrator/scheduling"
import type { IssueTrackerClient } from "./types"

type Frontmatter = {
  title?: string
  description?: string
  labels?: string[]
  priority?: string
  blockedBy?: string[]
  [key: string]: unknown
}

export class FileTrackerClient implements IssueTrackerClient {
  private readonly baseDir: string

  constructor(
    readonly config: TrackerConfig,
    private readonly writeLog?: (line: string) => void,
  ) {
    this.baseDir = config.file?.baseDir ?? ""
  }

  async fetchCandidateIssues(): Promise<Issue[]> {
    this.debugLog("tracker fetchCandidateIssues start")
    const issues: Issue[] = []
    const stateDirs = await this.scanStateDirectories()

    for (const stateDir of stateDirs) {
      const stateIssues = await this.scanIssueFiles(stateDir)
      issues.push(...stateIssues)
    }

    this.debugLog(`tracker fetchCandidateIssues done count=${issues.length}`)
    return issues
  }

  async fetchIssuesByStates(states: string[]): Promise<Issue[]> {
    this.debugLog(`tracker fetchIssuesByStates start states=${states.join(",")}`)
    const issues: Issue[] = []
    const stateDirs = await this.scanStateDirectories()

    for (const stateDir of stateDirs) {
      if (states.includes(stateDir)) {
        const stateIssues = await this.scanIssueFiles(stateDir)
        issues.push(...stateIssues)
      }
    }

    return issues
  }

  async fetchIssueStatesByIds(ids: string[]): Promise<Issue[]> {
    if (ids.length === 0) {
      this.debugLog("tracker fetchIssueStatesByIds ids=0")
      return []
    }

    this.debugLog(`tracker fetchIssueStatesByIds start ids=${ids.length}`)
    const idSet = new Set(ids)
    const all = await this.fetchCandidateIssues()
    return all.filter((item) => idSet.has(item.id))
  }

  async moveIssueToState(issueId: string, state: string): Promise<void> {
    this.debugLog(`tracker moveIssueToState issue=${issueId} state=${state}`)
    const all = await this.fetchCandidateIssues()
    const issue = all.find((i) => i.id === issueId)

    if (!issue) {
      throw new Error(`file_tracker_issue_not_found:${issueId}`)
    }

    const oldPath = this.getIssueFilePath(issueId, issue.state)
    const newId = basename(issueId)
    const newPath = join(this.baseDir, state, `${newId}.md`)

    await mkdir(dirname(newPath), { recursive: true })
    await rename(oldPath, newPath)
    this.debugLog(`tracker moveIssueToState done issue=${issueId} from=${issue.state} to=${state}`)
  }

  async updateItemDescription(issue: Issue, description: string): Promise<void> {
    const filePath = this.getIssueFilePath(issue.id, issue.state)
    const content = await readFile(filePath, "utf8")
    const parsed = matter(content)

    if (Object.keys(parsed.data).length === 0) {
      await writeFile(filePath, description, "utf8")
      return
    }

    const output = matter.stringify(`${description}\n`, parsed.data)
    await writeFile(filePath, output, "utf8")
  }

  async fetchIssueDescription(issue: Issue): Promise<string | null> {
    this.debugLog(`tracker fetchIssueDescription start issue=${issue.id}`)
    const filePath = this.getIssueFilePath(issue.id, issue.state)
    const issue2 = await this.parseIssueFile(filePath, issue.id, issue.state)
    this.debugLog(`tracker fetchIssueDescription done issue=${issue.id}`)
    return issue2.description
  }

  private async scanStateDirectories(): Promise<string[]> {
    this.debugLog("tracker scanStateDirectories start")
    const dirs: string[] = []

    try {
      const entries = await readdir(this.baseDir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory()) {
          dirs.push(entry.name)
        }
      }
    } catch {
      this.debugLog("tracker scanStateDirectories baseDir not found")
    }

    this.debugLog(`tracker scanStateDirectories done count=${dirs.length}`)
    return dirs
  }

  private async scanIssueFiles(state: string): Promise<Issue[]> {
    const issues: Issue[] = []
    const stateDir = join(this.baseDir, state)

    const scanDir = async (dir: string) => {
      try {
        const entries = await readdir(dir, { withFileTypes: true })
        for (const entry of entries) {
          const fullPath = join(dir, entry.name)

          if (entry.isDirectory()) {
            await scanDir(fullPath)
          } else if (entry.isFile() && entry.name.endsWith(".md")) {
            const relativePath = relative(stateDir, fullPath)
            const id = relativePath.replace(/\.md$/, "")
            const issue = await this.parseIssueFile(fullPath, id, state)
            issues.push(issue)
          }
        }
      } catch {
        // ignore
      }
    }

    await scanDir(stateDir)
    return issues
  }

  private async parseIssueFile(filePath: string, id: string, state: string): Promise<Issue> {
    const file = Bun.file(filePath)
    const content = await file.text()
    const { frontmatter, body } = this.parseFrontmatter(content)

    const title = frontmatter.title ?? id
    const identifier = typeof frontmatter.identifier === "string" ? frontmatter.identifier : id
    const description =
      typeof frontmatter.description === "string" ? frontmatter.description : body?.trim() || null
    const labels = this.parseLabels(frontmatter.labels)
    const priority = this.normalizePriority(frontmatter.priority)
    const blockedBy = this.parseBlockedBy(frontmatter.blockedBy)
    const fields = this.extractFields(frontmatter)

    const stats = await stat(filePath)

    return {
      id,
      identifier,
      title,
      description,
      priority,
      state,
      repository: null,
      fields,
      url: `file://${filePath}`,
      labels,
      blockedBy,
      createdAt: stats.birthtime?.toISOString() ?? null,
      updatedAt: stats.mtime?.toISOString() ?? null,
      issueNodeId: null,
    }
  }

  private parseFrontmatter(content: string): { frontmatter: Frontmatter; body: string | null } {
    try {
      const parsed = matter(content)
      const body = parsed.content.trim() || null
      return { frontmatter: parsed.data as Frontmatter, body }
    } catch {
      return { frontmatter: {}, body: content }
    }
  }

  private parseLabels(labels: unknown): string[] {
    if (!Array.isArray(labels)) return []
    return labels.map((l) => String(l).toLowerCase())
  }

  private parseBlockedBy(
    blockedBy: unknown,
  ): Array<{ id: string; identifier: string; state: null }> {
    if (!Array.isArray(blockedBy)) return []
    return blockedBy.map((id) => ({
      id: String(id),
      identifier: String(id),
      state: null,
    }))
  }

  private normalizePriority(value: unknown): number | null {
    if (typeof value !== "string") return null

    const normalized = value.trim().toUpperCase()
    if (normalized === "P0") return 1
    if (normalized === "P1") return 2
    if (normalized === "P2") return 3
    if (normalized === "P3") return 4
    return null
  }

  private extractFields(frontmatter: Frontmatter): Record<string, string | null> {
    const fields: Record<string, string | null> = {}
    const reservedKeys = ["title", "description", "labels", "priority", "blockedBy", "identifier"]

    for (const [key, value] of Object.entries(frontmatter)) {
      if (reservedKeys.includes(key)) continue
      if (value === null || value === undefined) continue
      fields[key] = typeof value === "string" ? value : JSON.stringify(value)
    }

    return fields
  }

  private getIssueFilePath(id: string, state: string): string {
    return join(this.baseDir, state, `${id}.md`)
  }

  private debugLog(line: string): void {
    this.writeLog?.(line)
  }

  shouldRun(issue: Issue, activeStates: string[]): boolean {
    return isActiveState(issue.state, activeStates)
  }
}
