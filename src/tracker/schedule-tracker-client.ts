import { createHash } from "node:crypto"
import { basename } from "node:path"
import { CronExpressionParser } from "cron-parser"
import type { Issue, TrackerConfig } from "../domain/types"
import type { IssueTrackerClient } from "./types"

export class ScheduleTrackerClient implements IssueTrackerClient {
  private readonly workflowPath: string
  private readonly cron: string
  private lastCheckTime: Date | null = null
  private readonly writeLog?: (line: string) => void

  constructor(
    readonly config: TrackerConfig,
    workflowPath: string,
    writeLog?: (line: string) => void,
  ) {
    this.workflowPath = workflowPath
    this.cron = config.schedule?.cron ?? ""
    this.writeLog = writeLog
  }

  async fetchCandidateIssues(): Promise<Issue[]> {
    this.debugLog("tracker fetchCandidateIssues start")

    const now = new Date()
    const matchTime = this.findCronMatch(this.lastCheckTime, now)

    if (matchTime) {
      this.lastCheckTime = now
      this.debugLog(`tracker fetchCandidateIssues done count=1`)
      return [this.createIssue(matchTime)]
    }

    this.lastCheckTime = now
    this.debugLog("tracker fetchCandidateIssues done count=0")
    return []
  }

  async fetchIssuesByStates(_states: string[]): Promise<Issue[]> {
    return []
  }

  async fetchIssueStatesByIds(ids: string[]): Promise<Issue[]> {
    if (ids.length === 0) {
      return []
    }

    this.debugLog(`tracker fetchIssueStatesByIds start ids=${ids.length}`)
    const all = await this.fetchCandidateIssues()
    const idSet = new Set(ids)
    return all.filter((item) => idSet.has(item.id))
  }

  async moveIssueToState(_issueId: string, _state: string): Promise<void> {
    this.debugLog("tracker moveIssueToState (no-op for schedule)")
  }

  private createIssue(matchTime: Date): Issue {
    const id = this.generateId()
    const filename = basename(this.workflowPath, ".md")

    return {
      id,
      identifier: id,
      title: filename,
      description: null,
      priority: null,
      state: "",
      repository: null,
      fields: {},
      url: `file://${this.workflowPath}`,
      labels: [],
      blockedBy: [],
      createdAt: matchTime.toISOString(),
      updatedAt: new Date().toISOString(),
      scheduledAt: matchTime.toISOString(),
    }
  }

  private generateId(): string {
    const hash = createHash("md5").update(this.workflowPath).digest("hex").slice(0, 6)
    const filename = basename(this.workflowPath, ".md")
    return `schedule-${hash}-${filename}`
  }

  private findCronMatch(lastCheckTime: Date | null, now: Date): Date | null {
    if (!lastCheckTime) {
      return null
    }

    try {
      const interval = CronExpressionParser.parse(this.cron, {
        currentDate: now,
        tz: undefined,
      })

      const prev = interval.prev()
      const prevTime = prev.toDate()

      if (prevTime.getTime() > lastCheckTime.getTime() && prevTime.getTime() <= now.getTime()) {
        return prevTime
      }

      return null
    } catch {
      return null
    }
  }

  private debugLog(line: string): void {
    this.writeLog?.(line)
  }

  shouldRun(_issue: Issue, _activeStates: string[]): boolean {
    return true
  }
}
