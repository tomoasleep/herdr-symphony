import type { Issue } from "../domain/types"

export interface IssueTrackerClient {
  fetchCandidateIssues(): Promise<Issue[]>
  fetchIssuesByStates(states: string[]): Promise<Issue[]>
  fetchIssueStatesByIds(ids: string[]): Promise<Issue[]>
  moveIssueToState(issueId: string, state: string): Promise<void>
  updateItemDescription?(issue: Issue, description: string): Promise<void>
  fetchIssueDescription?(issue: Issue): Promise<string | null>
  shouldRun?(issue: Issue, activeStates: string[]): boolean
}
