import { spawn } from "node:child_process"
import path from "node:path"
import type { Issue, WorkspaceConfig } from "../domain/types"
import { formatError } from "../utils/error"
import { sanitizeWorkspaceKey } from "../utils/normalize"

export type WorkspaceResult = {
  key: string
  branch: string | null
  path: string
  repositoryRoot: string
  createdNow: boolean
}

export type CommandResult = {
  exitCode: number
  stdout: string
  stderr: string
}

export type CommandRunner = (command: string, args: string[], cwd: string) => Promise<CommandResult>
export type GitCommandRunner = CommandRunner

type EnsureWorkspaceDependencies = {
  runCommand?: CommandRunner
  runGit?: GitCommandRunner
  onLog?: (line: string) => void
}

type WorktreeEntry = {
  path: string
  branch: string | null
}

type WorkspacePlan = {
  key: string
  branch: string
  path: string
  repositoryRoot: string
}

type GwqWorkspacePlan = {
  key: string
  branch: string
  repositoryRoot: string
}

type WorkspaceSeed = {
  rawWorktree: string
  key: string
  branch: string
}

const emittedWorkspaceWarnings = new Set<string>()

export function buildWorktreePlan(
  issue: Issue,
  repositoryRoot: string,
): Omit<WorkspaceResult, "createdNow"> {
  const seed = buildWorkspaceSeed(issue)

  return {
    key: seed.key,
    branch: seed.branch,
    path: resolveWorkspacePath(repositoryRoot, seed.rawWorktree, null),
    repositoryRoot,
  }
}

export async function ensureWorkspace(
  issue: Issue,
  config: WorkspaceConfig,
  deps: EnsureWorkspaceDependencies = {},
): Promise<WorkspaceResult> {
  const onLog = deps.onLog
  const runCommandBase = deps.runCommand ?? runShellCommand
  const runGitBase = deps.runGit ?? runCommandBase
  const runCommand = createLoggedRunner("workspace shell", runCommandBase, onLog)
  const runGit = createLoggedRunner("workspace git", runGitBase, onLog)
  logLine(onLog, `workspace ensure start issue=${issue.identifier} provider=${config.provider}`)
  const repositoryRoot =
    config.provider === "gwq"
      ? await resolveRepositoryRootForGwq(issue.repository, runCommand, runGit)
      : await resolveRepositoryRoot(issue.repository, runGit)

  if (config.provider === "gwq") {
    const result = await ensureGwqWorkspace(issue, config, repositoryRoot, runCommand, onLog)
    logLine(
      onLog,
      `workspace ready key=${result.key} created=${result.createdNow} path=${result.path} branch=${result.branch ?? "none"}`,
    )
    return result
  }

  const result = await ensureGitWorkspace(issue, config, repositoryRoot, runGit)
  logLine(
    onLog,
    `workspace ready key=${result.key} created=${result.createdNow} path=${result.path} branch=${result.branch ?? "none"}`,
  )
  return result
}

function buildWorkspaceSeed(issue: Issue): WorkspaceSeed {
  const rawWorktree = issue.fields.Worktree?.trim() || issue.identifier
  const key = sanitizeWorkspaceKey(rawWorktree)

  return {
    rawWorktree,
    key,
    branch: `herdr/${key}`,
  }
}

async function ensureGitWorkspace(
  issue: Issue,
  config: WorkspaceConfig,
  repositoryRoot: string,
  runGit: GitCommandRunner,
): Promise<WorkspaceResult> {
  const plan = buildGitWorkspacePlan(issue, repositoryRoot, config)

  if (config.reuseExisting) {
    const worktrees = await listGitWorktrees(repositoryRoot, runGit)
    if (worktrees.some((entry) => path.resolve(entry.path) === path.resolve(plan.path))) {
      return { ...plan, createdNow: false }
    }
  }

  if (!config.createIfMissing) {
    throw new Error(`workspace not found for branch: ${plan.branch}`)
  }

  const branchExists = await hasLocalBranch(repositoryRoot, plan.branch, runGit)
  const args = branchExists
    ? ["worktree", "add", plan.path, plan.branch]
    : ["worktree", "add", "-b", plan.branch, plan.path]

  const result = await runGit("git", args, repositoryRoot)
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `git worktree add failed: ${plan.path}`)
  }

  return { ...plan, createdNow: true }
}

function buildGitWorkspacePlan(
  issue: Issue,
  repositoryRoot: string,
  config: WorkspaceConfig,
): WorkspacePlan {
  const seed = buildWorkspaceSeed(issue)

  return {
    key: seed.key,
    branch: normalizeTemplateString(config.branch) ?? seed.branch,
    path: resolveWorkspacePath(
      repositoryRoot,
      normalizeTemplateString(config.path) ?? seed.rawWorktree,
      config.baseDir,
    ),
    repositoryRoot,
  }
}

async function ensureGwqWorkspace(
  issue: Issue,
  config: WorkspaceConfig,
  repositoryRoot: string,
  runCommand: CommandRunner,
  onLog?: (line: string) => void,
): Promise<WorkspaceResult> {
  const plan = buildGwqWorkspacePlan(issue, repositoryRoot, config, onLog)

  if (config.reuseExisting) {
    const existing = await findGwqWorkspace(plan, config, repositoryRoot, runCommand)
    if (existing) {
      return {
        ...plan,
        path: existing.path,
        branch: existing.branch ?? plan.branch,
        createdNow: false,
      }
    }
  }

  if (!config.createIfMissing) {
    throw new Error(`workspace not found for branch: ${plan.branch}`)
  }

  const args = ["add"]
  if (config.gwq.createBranch) {
    args.push("-b")
  }
  args.push(plan.branch)

  const result = await runCommand(config.gwq.command, args, repositoryRoot)
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `gwq add failed: ${plan.branch}`)
  }

  const created = await findGwqWorkspace(plan, config, repositoryRoot, runCommand)
  if (!created) {
    throw new Error(`gwq workspace not found after add: ${plan.branch}`)
  }

  return {
    ...plan,
    path: created.path,
    branch: created.branch ?? plan.branch,
    createdNow: true,
  }
}

function buildGwqWorkspacePlan(
  issue: Issue,
  repositoryRoot: string,
  config: WorkspaceConfig,
  onLog?: (line: string) => void,
): GwqWorkspacePlan {
  const seed = buildWorkspaceSeed(issue)

  warnDeprecatedGwqPathConfig(config, onLog)

  return {
    key: seed.key,
    branch: normalizeTemplateString(config.branch) ?? seed.branch,
    repositoryRoot,
  }
}

async function findGwqWorkspace(
  plan: GwqWorkspacePlan,
  config: WorkspaceConfig,
  repositoryRoot: string,
  runCommand: CommandRunner,
): Promise<WorktreeEntry | null> {
  const entries = await listGwqWorkspaces(config.gwq.command, repositoryRoot, runCommand)

  return entries.find((entry) => entry.branch === plan.branch) ?? null
}

function warnDeprecatedGwqPathConfig(
  config: WorkspaceConfig,
  onLog?: (line: string) => void,
): void {
  if (config.provider !== "gwq") {
    return
  }

  if (!normalizeTemplateString(config.path) && !normalizeTemplateString(config.baseDir)) {
    return
  }

  const message =
    "gwq provider ignores deprecated work.workspace.path/work.workspace.base_dir; configure path in gwq instead"
  if (!emittedWorkspaceWarnings.has(message)) {
    emittedWorkspaceWarnings.add(message)
    process.emitWarning(message, {
      code: "HDR_GWQ_PATH_DEPRECATED",
      type: "DeprecationWarning",
    })
  }
  logLine(onLog, `workspace warning ${message}`)
}

async function resolveRepositoryRoot(
  repository: string | null,
  runGit: GitCommandRunner,
): Promise<string> {
  const basePath =
    repository && repository.trim().length > 0 ? path.resolve(repository) : process.cwd()
  const result = await runGit("git", ["rev-parse", "--show-toplevel"], basePath)
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `git repository not found: ${basePath}`)
  }

  return path.resolve(result.stdout.trim())
}

async function resolveRepositoryRootForGwq(
  repository: string | null,
  runCommand: CommandRunner,
  runGit: GitCommandRunner,
): Promise<string> {
  const basePath = await resolveRepositoryPathForGwq(repository, runCommand)
  const result = await runGit("git", ["rev-parse", "--show-toplevel"], basePath)
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `git repository not found: ${basePath}`)
  }

  return path.resolve(result.stdout.trim())
}

async function resolveRepositoryPathForGwq(
  repository: string | null,
  runCommand: CommandRunner,
): Promise<string> {
  const normalized = normalizeTemplateString(repository)
  if (!normalized) {
    return process.cwd()
  }

  if (path.isAbsolute(normalized)) {
    return path.resolve(normalized)
  }

  if (!looksLikeRepositorySlug(normalized)) {
    return path.resolve(normalized)
  }

  const result = await runCommand("ghq", ["list", "-p", "-e", normalized], process.cwd())
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `ghq repository lookup failed: ${normalized}`)
  }

  const resolved = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0)

  if (!resolved) {
    throw new Error(`ghq repository not found: ${normalized}`)
  }

  return path.resolve(resolved)
}

function looksLikeRepositorySlug(value: string): boolean {
  return value.includes("/") && !value.startsWith(".")
}

async function listGitWorktrees(
  repositoryRoot: string,
  runGit: GitCommandRunner,
): Promise<WorktreeEntry[]> {
  const result = await runGit("git", ["worktree", "list", "--porcelain"], repositoryRoot)
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || "git worktree list failed")
  }

  return parseGitWorktreeList(result.stdout)
}

async function listGwqWorkspaces(
  command: string,
  repositoryRoot: string,
  runCommand: CommandRunner,
): Promise<WorktreeEntry[]> {
  const result = await runCommand(command, ["list", "--json"], repositoryRoot)
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || "gwq list failed")
  }

  try {
    const parsed = JSON.parse(result.stdout) as Array<{ path?: unknown; branch?: unknown }>
    return parsed
      .filter((entry) => typeof entry.path === "string")
      .map((entry) => ({
        path: String(entry.path),
        branch: typeof entry.branch === "string" ? entry.branch : null,
      }))
  } catch (error) {
    throw new Error(`failed to parse gwq list output: ${formatError(error)}`)
  }
}

async function hasLocalBranch(
  repositoryRoot: string,
  branch: string,
  runGit: GitCommandRunner,
): Promise<boolean> {
  const result = await runGit(
    "git",
    ["show-ref", "--verify", `refs/heads/${branch}`],
    repositoryRoot,
  )
  return result.exitCode === 0
}

function parseGitWorktreeList(stdout: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = []
  const blocks = stdout
    .split("\n\n")
    .map((block) => block.trim())
    .filter((block) => block.length > 0)

  for (const block of blocks) {
    let currentPath: string | null = null
    let branch: string | null = null

    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) {
        currentPath = line.slice("worktree ".length).trim()
      }
      if (line.startsWith("branch refs/heads/")) {
        branch = line.slice("branch refs/heads/".length).trim()
      }
    }

    if (currentPath) {
      entries.push({ path: currentPath, branch })
    }
  }

  return entries
}

function resolveWorkspacePath(
  repositoryRoot: string,
  rawWorkspace: string,
  baseDir: string | null,
): string {
  if (path.isAbsolute(rawWorkspace)) {
    return rawWorkspace
  }

  const resolvedBaseDir = normalizeTemplateString(baseDir)
    ? path.resolve(normalizeTemplateString(baseDir) as string)
    : path.join(path.dirname(repositoryRoot), `${path.basename(repositoryRoot)}.worktrees`)

  return path.resolve(path.join(resolvedBaseDir, rawWorkspace))
}

function normalizeTemplateString(value: string | null | undefined): string | null {
  if (value == null) {
    return null
  }

  const normalized = value.trim()
  return normalized.length > 0 ? normalized : null
}

export function runHook(
  script: string,
  cwd: string,
  timeoutMs: number,
  failOnError: boolean,
  onLog?: (line: string) => void,
): Promise<void> {
  return runHookWithLogging(script, cwd, timeoutMs, failOnError, onLog)
}

export function runHookWithLogging(
  script: string,
  cwd: string,
  timeoutMs: number,
  failOnError: boolean,
  onLog?: (line: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-lc", script], { cwd, stdio: ["ignore", "pipe", "pipe"] })

    logLine(
      onLog,
      `hook command=bash args=-lc ${JSON.stringify(script)} cwd=${cwd} failOnError=${failOnError}`,
    )

    let stdout = ""
    child.stdout.on("data", (chunk) => {
      const text = String(chunk)
      stdout += text
      for (const line of chunkToLines(text)) {
        logLine(onLog, `hook stdout ${line}`)
      }
    })

    let stderr = ""
    child.stderr.on("data", (chunk) => {
      const text = String(chunk)
      stderr += text
      for (const line of chunkToLines(text)) {
        logLine(onLog, `hook stderr ${line}`)
      }
    })

    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      logLine(onLog, `hook result exit=124 timeoutMs=${timeoutMs}`)
      if (failOnError) {
        reject(new Error(`hook timeout: ${timeoutMs}`))
        return
      }
      resolve()
    }, timeoutMs)

    child.on("close", (code) => {
      clearTimeout(timer)
      logLine(
        onLog,
        `hook result exit=${code ?? 1} stdout=${summarizeOutput(stdout)} stderr=${summarizeOutput(stderr)}`,
      )
      if (code === 0 || !failOnError) {
        resolve()
        return
      }
      reject(new Error(`hook failed with exit code ${code}: ${stderr.slice(0, 500)}`))
    })

    child.on("error", (error) => {
      clearTimeout(timer)
      logLine(onLog, `hook error ${String(error)}`)
      if (failOnError) {
        reject(error)
        return
      }
      resolve()
    })
  })
}

function runShellCommand(command: string, args: string[], cwd: string): Promise<CommandResult> {
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
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
      })
    })

    child.on("error", (error) => {
      reject(error)
    })
  })
}

function createLoggedRunner(
  label: string,
  runner: CommandRunner,
  onLog?: (line: string) => void,
): CommandRunner {
  return async (command: string, args: string[], cwd: string) => {
    logLine(onLog, `${label} command=${command} args=${args.join(" ")} cwd=${cwd}`)
    const result = await runner(command, args, cwd)
    logLine(
      onLog,
      `${label} result exit=${result.exitCode} stdout=${summarizeOutput(result.stdout)} stderr=${summarizeOutput(result.stderr)}`,
    )
    return result
  }
}

function logLine(onLog: ((line: string) => void) | undefined, line: string): void {
  onLog?.(line)
}

function summarizeOutput(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim()
  if (normalized.length === 0) {
    return "-"
  }
  return normalized.slice(0, 200)
}

function chunkToLines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}
