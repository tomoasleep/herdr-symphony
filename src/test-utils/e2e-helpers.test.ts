import { expect, test } from "bun:test"
import {
  containerCommand,
  normalizeLogOutput,
  normalizeOutput,
  normalizeScreenOutput,
  stripHerdrEnv,
} from "./e2e-helpers"

test("containerCommand はTTYとコンテナ環境変数を指定する", () => {
  expect(
    containerCommand("container-id", ["bun", "run", "scenario.ts"], {
      SCENARIO_CONFIG_PATH: "/tmp/shared/scenario.json",
    }),
  ).toEqual({
    command: "docker",
    args: [
      "exec",
      "-it",
      "-e",
      "TERM=xterm-truecolor",
      "-e",
      "SCENARIO_CONFIG_PATH=/tmp/shared/scenario.json",
      "container-id",
      "bun",
      "run",
      "scenario.ts",
    ],
  })
})

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

test("normalizeScreenOutput は Claude footer の Worked for 0s の末尾余白だけを正規化する", () => {
  expect(
    normalizeScreenOutput(
      "  │✻ Worked for 0s          ▐\n│✻ Worked for 0s          │\n│❯ reminder: ✻ Pending for 0s          ▐\n│Bash(herdr-symphony report --status done)          ▐\n│● Completed after reminder.          ▐",
    ),
  ).toBe(
    "│✻ Worked for 0s ▐\n│✻ Worked for 0s │\n│❯ reminder: ✻ Pending for 0s          ▐\n│Bash(herdr-symphony report --status done)          ▐\n│● Completed after reminder.          ▐",
  )
})

test("normalizeScreenOutput は Claude footer の done タイムスタンプを除去する", () => {
  expect(
    normalizeScreenOutput(
      "  │✻ Worked for 0s · done 1:36 AM          ▐\n│✻ Sautéed for 10s · done 1:36 AM          ▐",
    ),
  ).toBe("│✻ Worked for 0s ▐\n│✻ Worked for TIME ▐")
})

test("normalizeScreenOutput は agent pane の上枠線を正規化する", () => {
  expect(normalizeScreenOutput("│┌ test-claude-ID-e2e-test-TS-TS ───┐")).toBe(
    "│┌ test-claude-ID-e2e-test-TS-TS ─┐",
  )
})

test("normalizeScreenOutput は Claude welcome画面を除外する", () => {
  expect(
    normalizeScreenOutput(
      "││╭─── Claude Code VERSION ───╮ │\n│││ Welcome back! │\n││╰────────────────────────────╯ │\n",
    ),
  ).toBe("")
})

test("normalizeScreenOutput は root pane を閉じた後の Claude welcome画面を除外する", () => {
  expect(normalizeScreenOutput("│╭─ Claude Code VERSION ─╮\r\n││ Welcome back! │\r\n│╰─╯")).toBe("")
})

test("normalizeScreenOutput は実際のClaude welcome banner全体を除外する", () => {
  for (const header of ["│╭─>Claude Code>VERSION ─╮▐", "│╭─>Claude Code VERSION ─╮▐"]) {
    expect(
      normalizeScreenOutput(
        `before\n${header}\n││ Welcome back! │▐\n│╰─╯▐\n│  ## 完了報告\n│      herdr-symphony report --status done --summary "やった作業の要約"\nafter`,
      ),
    ).toBe(
      'before\n│  ## 完了報告\n│      herdr-symphony report --status done --summary "やった作業の要約"\nafter',
    )
  }
})

test("normalizeScreenOutput は改行された Claude agent名の動的な断片を正規化する", () => {
  expect(normalizeScreenOutput("│ 7-e2e-test-TS-TS")).toBe("│ ID-e2e-test-TS-TS")
})

test("normalizeOutput は running reconciliation の繰り返しを畳む", () => {
  const line = "reconcile running=1 refreshed=1"
  expect(normalizeLogOutput(`${line}\n${line}`)).toBe(line)
})

test("normalizeLogOutput は各行の先頭スペースを除去する", () => {
  expect(normalizeLogOutput("  first\nsecond\n")).toBe("first\nsecond")
})
