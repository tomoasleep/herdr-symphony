import type { Issue } from "../domain/types"
import { normalizeState } from "../utils/normalize"

export function isTerminalState(state: string, terminalStates: string[]): boolean {
  const normalized = normalizeState(state)
  return terminalStates.some((item) => normalizeState(item) === normalized)
}

export function isActiveState(state: string, activeStates: string[]): boolean {
  const normalized = normalizeState(state)
  return activeStates.some((item) => normalizeState(item) === normalized)
}

export function isManagedState(
  state: string,
  activeStates: string[],
  runningState: string | null,
): boolean {
  return (
    isActiveState(state, activeStates) ||
    (runningState !== null && normalizeState(runningState) === normalizeState(state))
  )
}

export function hasOpenTodoBlocker(
  issue: Issue,
  activeStates: string[],
  runningState: string | null,
): boolean {
  const state = normalizeState(issue.state)
  if (state !== "todo" && state !== "backlog") {
    return false
  }

  return issue.blockedBy.some((blocker) => {
    if (!blocker.state) {
      return true
    }
    return isManagedState(blocker.state, activeStates, runningState)
  })
}

export function sortIssues(issues: Issue[]): Issue[] {
  return [...issues].sort((a, b) => {
    const ap = a.priority ?? Number.MAX_SAFE_INTEGER
    const bp = b.priority ?? Number.MAX_SAFE_INTEGER
    if (ap !== bp) {
      return ap - bp
    }

    const at = a.createdAt ? Date.parse(a.createdAt) : Number.MAX_SAFE_INTEGER
    const bt = b.createdAt ? Date.parse(b.createdAt) : Number.MAX_SAFE_INTEGER
    if (at !== bt) {
      return at - bt
    }

    return a.identifier.localeCompare(b.identifier)
  })
}

export function computeFailureBackoffMs(attempt: number, maxRetryBackoffMs: number): number {
  const base = 10_000 * 2 ** Math.max(attempt - 1, 0)
  return Math.min(base, maxRetryBackoffMs)
}

export function computeAvailableStateSlots(
  targetState: string,
  runningStates: string[],
  globalLimit: number,
  perState: Record<string, number>,
): number {
  const normalized = normalizeState(targetState)
  const limit = perState[normalized] ?? globalLimit
  const used = runningStates.filter((state) => normalizeState(state) === normalized).length
  return Math.max(limit - used, 0)
}
