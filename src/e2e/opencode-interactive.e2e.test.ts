import { expect, test } from "bun:test"
import { createSessionManager } from "../test-utils/e2e-helpers"
import { runOpencodeInteractiveE2E } from "./opencode-interactive-shared"

const { register } = createSessionManager()

test("e2e: opencode interactive — report file で完了報告する", async () => {
  const agentScreen = await runOpencodeInteractiveE2E(
    { prefix: "e2e-opencode-interactive", image: "herdr-e2e:latest", buildArgs: [] },
    register,
  )

  expect(agentScreen).toMatchInlineSnapshot(`
    "
    │   1      +
    │
    │  ┃                                                                                           E2E Test
    │  ┃  Test prompt for test/repo#ID
    │  ┃  ## 完了報告                                                                              Context
    │  ┃                                                                                           2,509 tokens
    │  ┃  ユーザーに依頼された作業が完了したら、以下のコマンドを実行してください。                 2% used
    │  ┃                                                                                           $0.00 spent
    │  ┃      herdr-symphony report --status done --summary "やった作業の要約"
    │  ┃                                                                                           LSP
    │  ┃  background task / subagent / task の完了待ちなら、以下のコマンドを実行してください。     LSPs are disabled
    │  ┃
    │  ┃      herdr-symphony report --status pending --summary "待機中の内容"
    │  ┃
    │  ┃  失敗した場合は、以下のコマンドを実行してください。
    │  ┃
    │  ┃      herdr-symphony report --status failed --summary "失敗理由"
    │  ┃
    │
    │     Writing report file.
    │
    │  ┃
    │  ┃  $ herdr-symphony report --status done --summary 'Task completed successfully.'
    │  ┃
    │  ┃  (no output)
    │  ┃
    │
    │     Task completed successfully.
    │
    │     ▣  Build · Agent Model · TIME
    │
    │
    │
    │  ┃
    │  ┃
    │  ┃                                                                                           TEMP_DIR
    │  ┃  Build auto · Agent Model Mock                                                            opencode:master
    │  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
    │                                                                2.5K (2%)  ctrl+p commands    • OpenCode 1.17.13
    │"
  `)
}, 120_000)
