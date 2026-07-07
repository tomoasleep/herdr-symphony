import { readFileSync, writeFileSync } from "node:fs"

export type ReportStatus = "done" | "pending" | "failed"

export type ReportEntry = {
  status: ReportStatus
  summary: string
  timestamp: string
}

export function writeReport(path: string, status: ReportStatus, summary: string): void {
  writeFileSync(path, JSON.stringify({ status, summary, timestamp: new Date().toISOString() }))
}

export function readReport(path: string): ReportEntry | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ReportEntry>
    if (parsed.status !== "done" && parsed.status !== "pending" && parsed.status !== "failed") {
      return null
    }
    if (typeof parsed.summary !== "string") {
      return null
    }
    return {
      status: parsed.status,
      summary: parsed.summary,
      timestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : "",
    }
  } catch {
    return null
  }
}
