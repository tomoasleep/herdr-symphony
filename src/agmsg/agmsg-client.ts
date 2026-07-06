import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { CommandRunner } from "../herdr/herdr-client"

const AGMSG_SCRIPTS_DIR =
  process.env.AGMSG_SCRIPTS_DIR ?? join(homedir(), ".agents", "skills", "agmsg", "scripts")

export type AgmsgAgentType = "claude-code" | "opencode"

export type AgmsgDeliveryMode = "monitor" | "turn" | "both" | "off"

export type AgmsgClient = {
  join(team: string, agent: string, type: AgmsgAgentType, projectPath: string): Promise<void>
  setDelivery(mode: AgmsgDeliveryMode, type: AgmsgAgentType, projectPath: string): Promise<void>
  send(team: string, from: string, to: string, body: string): Promise<void>
  inbox(team: string, agent: string): Promise<string>
}

export type AgmsgClientDeps = {
  runCommand?: CommandRunner
  scriptsDir?: string
}

export type RecordedCall = {
  command: string
  args: string[]
  cwd: string
}

export function getAgmsgScriptsDir(): string {
  return AGMSG_SCRIPTS_DIR
}

export function isAgmsgAvailable(scriptsDir: string = AGMSG_SCRIPTS_DIR): boolean {
  return existsSync(join(scriptsDir, "send.sh"))
}

export function createAgmsgClient(deps: AgmsgClientDeps = {}): AgmsgClient {
  const scriptsDir = deps.scriptsDir ?? AGMSG_SCRIPTS_DIR
  const runCommand = deps.runCommand ?? defaultAgmsgRunner

  function scriptPath(name: string): string {
    return join(scriptsDir, name)
  }

  return {
    async join(team, agent, type, projectPath) {
      const result = await runCommand(
        scriptPath("join.sh"),
        [team, agent, type, projectPath],
        projectPath,
      )
      if (result.exitCode !== 0) {
        throw new Error(result.stderr.trim() || `agmsg join failed: ${agent}`)
      }
    },

    async setDelivery(mode, type, projectPath) {
      const result = await runCommand(
        scriptPath("delivery.sh"),
        ["set", mode, type, projectPath],
        projectPath,
      )
      if (result.exitCode !== 0) {
        throw new Error(result.stderr.trim() || `agmsg delivery set failed: ${mode}`)
      }
    },

    async send(team, from, to, body) {
      const result = await runCommand(scriptPath("send.sh"), [team, from, to, body], process.cwd())
      if (result.exitCode !== 0) {
        throw new Error(result.stderr.trim() || `agmsg send failed: ${from} -> ${to}`)
      }
    },

    async inbox(team, agent) {
      const result = await runCommand(
        scriptPath("inbox.sh"),
        [team, agent, "--quiet"],
        process.cwd(),
      )
      if (result.exitCode !== 0) {
        throw new Error(result.stderr.trim() || `agmsg inbox failed: ${agent}`)
      }
      return result.stdout
    },
  }
}

function defaultAgmsgRunner(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk)
    })
    child.on("close", (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr })
    })
    child.on("error", reject)
  })
}
