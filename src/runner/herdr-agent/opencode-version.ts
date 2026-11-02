import type { CommandRunner } from "../../herdr/herdr-client"

export type OpencodeVersionProbe = (cwd: string) => Promise<number | null>

export function parseOpencodeMajorVersion(output: string): number | null {
  const match = output.match(/v?(\d+)\./)
  return match ? Number(match[1]) : null
}

export function createOpencodeVersionProbe(runCommand: CommandRunner): OpencodeVersionProbe {
  let cached: Promise<number | null> | null = null

  return (cwd: string) => {
    cached ??= (async () => {
      try {
        const result = await runCommand("opencode", ["--version"], cwd)
        if (result.exitCode !== 0) return null
        return parseOpencodeMajorVersion(result.stdout)
      } catch {
        return null
      }
    })()
    return cached
  }
}
