import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { launchTerminal } from "tuistory"
import {
  captureOutput,
  createHerdrIsolation,
  createSessionManager,
} from "../test-utils/e2e-helpers"

const { register } = createSessionManager()

const HERDR_AVAILABLE = spawnSync("herdr", ["--version"], { stdio: "ignore" }).status === 0
const NESTED_HERDR = Boolean(process.env.HERDR_SOCKET_PATH)
const RUN_NESTED_E2E = process.env.HERDR_SYMPHONY_RUN_NESTED_E2E === "1"

test.skipIf(!HERDR_AVAILABLE || (NESTED_HERDR && !RUN_NESTED_E2E))(
  "e2e: herdr TUI + service log — agent が herdr 上で実行されて succeeded になる",
  async () => {
    const projectRoot = path.resolve(import.meta.dir, "../..")
    const fixturePath = path.join(import.meta.dir, "../test-utils/e2e-fixture.ts")

    const herdr = await createHerdrIsolation("e2e-orchestration")
    const isolatedEnv = { ...process.env, ...herdr.env }

    try {
      const herdrSession = register(
        await launchTerminal({
          command: "herdr",
          args: [],
          cwd: projectRoot,
          cols: 160,
          rows: 40,
          env: isolatedEnv,
          waitForDataTimeout: 30_000,
        }),
      )

      await herdrSession.waitForText(/spaces|agents/i, { timeout: 15_000 })

      const fixtureSession = register(
        await launchTerminal({
          command: process.execPath,
          args: ["run", fixturePath],
          cwd: projectRoot,
          cols: 200,
          rows: 36,
          env: isolatedEnv,
        }),
      )

      await fixtureSession.waitForText("done test/repo#1 status=succeeded", { timeout: 60_000 })

      expect(await captureOutput(herdrSession)).toMatchInlineSnapshot(`
        "
         spaces                  │ 1       +
                                 │pointer display width should be up to 2
         · ~                     │
                                 │~ at DATETIME
         · test/repo#1           │(p _-)ノ
           main                  │
                                 │
                                 │
                                 │
                                 │
                                 │
                                 │
                                 │
                                 │
                                 │
                                 │
                                 │
                                 │
                                 │
         new               ● menu│
        ─────────────────────────│
         agents               all│
                                 │
                                 │
                                 │
                                 │
                                 │
                                 │
                                 │
                                 │
                                 │
                                 │
                                 │
                                 │
                                 │
                                 │
                                 │
                                 │
                                 │
                                «│"
      `)
      expect(await captureOutput(fixtureSession)).toMatchInlineSnapshot(`
        "
        reconcile running=0
        tracker fetchCandidateIssues start
        tracker fetchCandidateIssues start
        tracker scanStateDirectories start
        tracker scanStateDirectories done count=1
        tracker fetchCandidateIssues done count=1
        tracker fetchCandidateIssues done count=1
        refresh candidates=1 dispatchable=1 running=0 retrying=0
        start test/repo#1 state=Ready
        runtime resolved issue=test/repo#1 runner=herdr_agent workspaceProvider=git
        workspace ready path=TEMP_DIR createdNow=false branch=none
        runner start kind=herdr_agent workspace=TEMP_DIR model=mock/agent-model
        [test/repo#1] [agent_started] agent_started
        [test/repo#1] [agent_status] agent_status
        tracker moveIssueToState start issue=test-issue-1 state=Done
        tracker moveIssueToState issue=test-issue-1 state=Done
        tracker fetchCandidateIssues start
        tracker scanStateDirectories start
        tracker scanStateDirectories done count=1
        tracker fetchCandidateIssues done count=1
        tracker moveIssueToState done issue=test-issue-1 from=Ready to=Done
        tracker moveIssueToState done issue=test-issue-1 state=Done
        runner done issue=test/repo#1 status=succeeded error=none
        done test/repo#1 status=succeeded"
      `)
    } finally {
      spawnSync("herdr", ["server", "stop"], {
        env: isolatedEnv,
        stdio: "ignore",
      })
      await herdr.cleanup()
    }
  },
  90_000,
)
