import { existsSync } from "node:fs"
import { appendFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

export async function appendAgentLog(workspacePath: string, text: string): Promise<void> {
  const logPath = join(workspacePath, "AGENTLOGS.local.md")
  const timestamp = formatTimestamp(new Date())
  const content = `## ${timestamp}\n\n${text}\n\n`

  if (existsSync(logPath)) {
    await appendFile(logPath, content, "utf8")
  } else {
    await writeFile(logPath, content, "utf8")
  }
}

function formatTimestamp(date: Date): string {
  return date.toISOString().replace("T", " ").slice(0, 19)
}
