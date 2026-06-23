import path from "node:path"
import { resolveConfig } from "./config/resolve-config"
import { GlobalClaimRegistry } from "./orchestrator/global-claim-registry"
import { SymphonyService } from "./service"
import { createStorage, DEFAULT_STORAGE_CONFIG } from "./storage/create-storage"
import type { Storage } from "./storage/types"
import { loadWorkflow } from "./workflow/load-workflow"

export type StartOptions = {
  writeLog?: (line: string) => void
  storageConfig?: Partial<{
    databasePath: string
    completedRetention: number
    logRetention: number
  }>
}

type StartDependencies = {
  loadWorkflow?: typeof loadWorkflow
  createService?: (
    config: ReturnType<typeof resolveConfig>,
    promptTemplate: string,
    options: StartOptions,
    input: {
      workflowId: string
      workflowName: string
      issueRegistry: GlobalClaimRegistry
      storage: Storage | null
    },
  ) => SymphonyService
  schedule?: (callback: () => void, intervalMs: number) => () => void
}

export async function startHerdrSymphony(
  workflowPath: string | string[],
  options: StartOptions = {},
  deps: StartDependencies = {},
): Promise<void> {
  const workflowPaths = Array.isArray(workflowPath) ? workflowPath : [workflowPath]
  const loadWorkflowImpl = deps.loadWorkflow ?? loadWorkflow
  const issueRegistry = new GlobalClaimRegistry()

  const storageConfig = {
    ...DEFAULT_STORAGE_CONFIG,
    ...options.storageConfig,
  }
  let storage: Storage | null = null
  try {
    storage = createStorage(storageConfig)
  } catch {
    storage = null
  }

  const createService =
    deps.createService ??
    ((config, promptTemplate, runtimeOptions, input) =>
      new SymphonyService(config, promptTemplate, {
        ...runtimeOptions,
        workflowId: input.workflowId,
        workflowName: input.workflowName,
        storage: input.storage ?? undefined,
        claimIssue: (issueId: string) => issueRegistry.claim(issueId, input.workflowId),
        releaseIssue: (issueId: string) => issueRegistry.release(issueId, input.workflowId),
      }))
  const schedule =
    deps.schedule ??
    ((callback, intervalMs) => {
      const timer = setInterval(callback, intervalMs)
      return () => {
        clearInterval(timer)
      }
    })

  const runtimes = await Promise.all(
    workflowPaths.map(async (currentWorkflowPath) => {
      const workflow = await loadWorkflowImpl(currentWorkflowPath)
      const config = resolveConfig(workflow.config)

      return {
        workflowId: currentWorkflowPath,
        workflowName: path.basename(currentWorkflowPath),
        workflowPath: currentWorkflowPath,
        config,
        service: createService(config, workflow.promptTemplate, options, {
          workflowId: currentWorkflowPath,
          workflowName: path.basename(currentWorkflowPath),
          issueRegistry,
          storage,
        }),
        stopPolling: () => {},
      }
    }),
  )

  let stopped = false

  const shutdown = async (): Promise<void> => {
    if (stopped) {
      return
    }

    stopped = true
    for (const runtime of runtimes) {
      runtime.stopPolling()
      console.log(`shutting down ${runtime.workflowName}...`)
      runtime.service.shutdown()
    }
    storage?.close()
  }

  for (const runtime of runtimes) {
    await runtime.service.startupCleanup()
    await runtime.service.refresh()
    await runtime.service.waitForDispatches()
  }

  for (const runtime of runtimes) {
    runtime.stopPolling = schedule(() => {
      if (!stopped) {
        void runtime.service.refresh()
      }
    }, runtime.config.polling.intervalMs)
  }

  if (storage) {
    const pruneIntervalMs = 3_600_000
    schedule(() => {
      for (const runtime of runtimes) {
        storage.completed.deleteOlderThan(runtime.workflowId, storageConfig.completedRetention)
        storage.logs.pruneOlderThan(runtime.workflowId, storageConfig.logRetention)
      }
    }, pruneIntervalMs)
  }

  const handleSignal = async (): Promise<void> => {
    await shutdown()
    process.exit(0)
  }
  process.on("SIGINT", () => void handleSignal())
  process.on("SIGTERM", () => void handleSignal())
}
