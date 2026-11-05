import { describe, expect, test } from "bun:test"
import { resolveConfig } from "../config/resolve-config"
import { createRunner } from "./create-runner"
import { HerdrAgentRunner } from "./herdr-agent/herdr-agent-runner"

function makeRawConfig(runner: string | undefined) {
  return {
    tracker: { kind: "file", file: { base_dir: "/issues" } },
    work: runner ? { runner } : undefined,
  } as const
}

describe("createRunner", () => {
  test("デフォルト (herdr_agent) で HerdrAgentRunner を返す", () => {
    const config = resolveConfig(makeRawConfig(undefined))
    const runner = createRunner(config)

    expect(runner).toBeInstanceOf(HerdrAgentRunner)
  })

  test("herdr_core を指定しても Runner 互換の HerdrAgentRunner を返す", () => {
    const config = resolveConfig(makeRawConfig("herdr_core"))
    const runner = createRunner(config)

    expect(runner).toBeInstanceOf(HerdrAgentRunner)
    expect(typeof runner.startIssue).toBe("function")
    expect(typeof runner.pollCompletion).toBe("function")
    expect(typeof runner.cancelRun).toBe("function")
    expect(typeof runner.sweep).toBe("function")
  })
})
