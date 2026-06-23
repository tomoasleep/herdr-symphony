import path from "node:path"
import { type StartOptions, startHerdrSymphony } from "./app"
import { formatError } from "./utils/error"
import { loadWorkflow } from "./workflow/load-workflow"

type CliDependencies = {
  cwd?: string
  env?: Record<string, string | undefined>
  start?: (workflowPaths: string[], options: StartOptions) => Promise<void>
  write?: (chunk: string) => void
}

export async function runCli(argv: string[], deps: CliDependencies = {}): Promise<number> {
  const cwd = deps.cwd ?? process.cwd()
  const env = deps.env ?? process.env
  const start = deps.start ?? startHerdrSymphony
  const write = deps.write ?? ((chunk: string) => process.stderr.write(chunk))

  const parsed = parseArgs(argv)
  if (parsed.help) {
    write(`${usage()}\n`)
    return 0
  }

  const workflowPaths = resolveWorkflowPaths(
    parsed.workflowPaths,
    parsed.positionalPaths,
    env.WORKFLOW_PATH,
    cwd,
  )

  if (workflowPaths instanceof Error) {
    write(`${workflowPaths.message}\n`)
    return 1
  }

  try {
    if (parsed.validate) {
      const [workflowPath] = workflowPaths
      if (!workflowPath) {
        throw new Error("workflow path is required")
      }

      const workflow = await loadWorkflow(workflowPath)
      const { resolveConfig } = await import("./config/resolve-config")
      const config = resolveConfig(workflow.config)
      write(`✓ 検証完了\n`)
      write(`  tracker: ${config.tracker.kind}\n`)
      write(`  runner: ${config.work.runner}\n`)
      write(`  agent: ${config.work.herdrAgent.agent}\n`)
      write(`  workspace: ${config.work.workspace.provider}\n`)
      return 0
    }

    await start(workflowPaths, {})
    return 0
  } catch (error) {
    write(`${formatError(error)}\n`)
    return 1
  }
}

type ParsedArgs = {
  help: boolean
  validate: boolean
  workflowPaths: string[]
  positionalPaths: string[]
}

function parseArgs(argv: string[]): ParsedArgs {
  let help = false
  let validate = false
  const workflowPaths: string[] = []
  const positionalPaths: string[] = []

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg) {
      continue
    }

    if (arg === "--help" || arg === "-h") {
      help = true
      continue
    }

    if (arg === "validate") {
      validate = true
      continue
    }

    if (arg === "--workflow" || arg === "-w") {
      const workflowPath = argv[index + 1]
      if (workflowPath) {
        workflowPaths.push(workflowPath)
      }
      index += 1
      continue
    }

    if (arg.startsWith("--workflow=")) {
      workflowPaths.push(arg.slice("--workflow=".length))
      continue
    }

    if (arg.startsWith("-")) {
      continue
    }

    positionalPaths.push(arg)
  }

  return { help, validate, workflowPaths, positionalPaths }
}

function resolveWorkflowPaths(
  cliPaths: string[],
  positionalPaths: string[],
  envPath: string | undefined,
  cwd: string,
): string[] | Error {
  if (cliPaths.length > 0 && positionalPaths.length > 0) {
    return new Error("--workflow と位置引数は同時に指定できません")
  }

  if (cliPaths.length > 0) {
    return cliPaths.map((candidate) => path.resolve(candidate))
  }

  if (positionalPaths.length > 0) {
    return positionalPaths.map((candidate) => path.resolve(candidate))
  }

  const candidate = envPath ?? path.join(cwd, "WORKFLOW.md")
  return [path.resolve(candidate)]
}

function usage(): string {
  return [
    "Usage: herdr-symphony [options] [command] [workflow...]",
    "",
    "Commands:",
    "  validate               Validate workflow configuration",
    "",
    "Arguments:",
    "  workflow               Path to workflow file (can specify multiple)",
    "",
    "Options:",
    "  -w, --workflow <path>  Use a workflow file",
    "  -h, --help             Show help",
  ].join("\n")
}
