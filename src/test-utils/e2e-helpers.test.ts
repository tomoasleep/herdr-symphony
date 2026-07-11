import { expect, test } from "bun:test"
import {
  normalizeLogOutput,
  normalizeOutput,
  normalizeScreenOutput,
  stripHerdrEnv,
} from "./e2e-helpers"

test("stripHerdrEnv は HERDR_ プレフィックスの変数だけ除去する", () => {
  const src = {
    PATH: "/usr/bin",
    HOME: "/home/u",
    HERDR_SOCKET_PATH: "/parent.sock",
    HERDR_CONFIG_PATH: "/parent/config.toml",
    HERDR_FOO: "x",
  } as NodeJS.ProcessEnv
  const got = stripHerdrEnv(src)
  expect(got).toEqual({ PATH: "/usr/bin", HOME: "/home/u" })
})

test("stripHerdrEnv は HERDR_ 以外をすべて残す", () => {
  const got = stripHerdrEnv({ PATH: "/usr/bin", FOO: "bar", ANTHROPIC_BASE_URL: "http://x" })
  expect(got).toEqual({ PATH: "/usr/bin", FOO: "bar", ANTHROPIC_BASE_URL: "http://x" })
})

test("normalizeOutput は new と menu の間の可変スペースを正規化する", () => {
  expect(normalizeOutput("new                 menu│")).toBe("new menu│")
})

test("normalizeScreenOutput は agent pane の上枠線を正規化する", () => {
  expect(normalizeScreenOutput("│┌ test-claude-ID-e2e-test-TS-TS ───┐")).toBe(
    "│┌ test-claude-ID-e2e-test-TS-TS ─┐",
  )
})

test("normalizeOutput は running reconciliation の繰り返しを畳む", () => {
  const reconciliation = [
    "tracker fetchIssueStatesByIds start ids=1",
    "tracker fetchCandidateIssues start",
    "tracker scanStateDirectories start",
    "tracker scanStateDirectories done count=1",
    "tracker fetchCandidateIssues done count=1",
    "reconcile running=1 refreshed=1",
  ].join("\n")
  expect(normalizeLogOutput(`${reconciliation}\n${reconciliation}`)).toBe(reconciliation)
})

test("normalizeLogOutput は各行の先頭スペースを除去する", () => {
  expect(normalizeLogOutput("  first\nsecond\n")).toBe("first\nsecond")
})
