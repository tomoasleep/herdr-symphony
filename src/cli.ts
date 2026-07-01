import path from "node:path"
import { type StartOptions, startHerdrSymphony } from "./app"
import { type ReportStatus, writeReport } from "./report/write-report"
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

  if (parsed.report) {
    if (!parsed.reportSummary) {
      write("--summary is required\n")
      return 1
    }
    if (!parsed.reportStatus) {
      write("--status must be one of: done / pending / failed\n")
      return 1
    }
    const reportPath = env.HERDR_SYMPHONY_REPORT_PATH
    if (!reportPath) {
      write("HERDR_SYMPHONY_REPORT_PATH is required\n")
      return 1
    }
    writeReport(reportPath, parsed.reportStatus, parsed.reportSummary)
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
  report: boolean
  reportStatus: ReportStatus | null
  reportSummary: string | null
  workflowPaths: string[]
  positionalPaths: string[]
}

function parseArgs(argv: string[]): ParsedArgs {
  let help = false
  let validate = false
  let report = false
  let reportStatus: ReportStatus | null = null
  let reportSummary: string | null = null
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

    if (arg === "report") {
      report = true
      continue
    }

    if (arg === "--status") {
      const status = argv[index + 1]
      if (status === "done" || status === "pending" || status === "failed") {
        reportStatus = status
      }
      index += 1
      continue
    }

    if (arg.startsWith("--status=")) {
      const status = arg.slice("--status=".length)
      if (status === "done" || status === "pending" || status === "failed") {
        reportStatus = status
      }
      continue
    }

    if (arg === "--summary") {
      reportSummary = argv[index + 1] ?? null
      index += 1
      continue
    }

    if (arg.startsWith("--summary=")) {
      reportSummary = arg.slice("--summary=".length)
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

  return { help, validate, report, reportStatus, reportSummary, workflowPaths, positionalPaths }
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
    "  report                 Write Claude completion report",
    "",
    "Arguments:",
    "  workflow               Path to workflow file (can specify multiple)",
    "",
    "Options:",
    "  -w, --workflow <path>  Use a workflow file",
    "  -h, --help             Show help",
  ].join("\n")
}
