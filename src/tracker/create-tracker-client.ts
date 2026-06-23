import type { TrackerConfig } from "../domain/types"
import { FileTrackerClient } from "./file-tracker-client"
import { GitHubProjectClient } from "./github-project-client"
import { ScheduleTrackerClient } from "./schedule-tracker-client"
import type { IssueTrackerClient } from "./types"

export function createTrackerClient(
  config: TrackerConfig,
  workflowPath: string,
  writeLog?: (line: string) => void,
): IssueTrackerClient {
  if (config.kind === "github_project") {
    return new GitHubProjectClient(config, undefined, writeLog)
  }

  if (config.kind === "file") {
    return new FileTrackerClient(config, writeLog)
  }

  if (config.kind === "schedule") {
    return new ScheduleTrackerClient(config, workflowPath, writeLog)
  }

  throw new Error(`unsupported_tracker_kind:${config.kind}`)
}
