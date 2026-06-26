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
const CLAUDE_AVAILABLE = spawnSync("claude", ["--version"], { stdio: "ignore" }).status === 0

test.skipIf(!HERDR_AVAILABLE || !CLAUDE_AVAILABLE)(
  "e2e: claude 対話モード — herdr agent send で prompt が送られ succeeded になる",
  async () => {
    const projectRoot = path.resolve(import.meta.dir, "../..")
    const fixturePath = path.join(import.meta.dir, "../test-utils/e2e-fixture-claude.ts")

    const herdr = await createHerdrIsolation("e2e-claude")
    const isolatedEnv = { ...process.env, ...herdr.env }

    spawnSync("herdr", ["server", "stop"], { env: isolatedEnv, stdio: "ignore" })

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

      await fixtureSession.waitForText("status=succeeded", { timeout: 90_000 })

      const output = await captureOutput(fixtureSession)
      expect(output).toContain("runner start kind=herdr_agent")
      expect(output).toContain("[agent_started] agent_started")
      expect(output).toContain("[agent_status] agent_status")
      expect(output).toContain("status=succeeded")
    } finally {
      spawnSync("herdr", ["server", "stop"], {
        env: isolatedEnv,
        stdio: "ignore",
      })
      await herdr.cleanup()
    }
  },
  120_000,
)
