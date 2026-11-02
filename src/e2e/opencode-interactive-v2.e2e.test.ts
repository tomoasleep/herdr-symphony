import { expect, test } from "bun:test"
import { createSessionManager, OPENCODE_V2_IMAGE } from "../test-utils/e2e-helpers"
import { runOpencodeInteractiveE2E } from "./opencode-interactive-shared"

const { register } = createSessionManager()

test("e2e: opencode interactive (v2) — report file で完了報告する", async () => {
  const agentScreen = await runOpencodeInteractiveE2E(
    {
      prefix: "e2e-opencode-interactive-v2",
      image: OPENCODE_V2_IMAGE,
      buildArgs: ["--build-arg", "OPENCODE_VERSION=v2.2.5"],
    },
    register,
  )

  expect(agentScreen).toMatchInlineSnapshot(`
    "
    │   1      +
    │$ 'opencode' 'mini' '--model' 'mock/agent-model' '--prompt' 'Test prompt for test/repo#ID
    │## 完了報告
    │
    │ユーザーに依頼された作業が完了したら、以下のコマンドを実行してください。
    │
    │    herdr-symphony report --status done --summary "やった作業の要約"
    │
    │background task / subagent / task の完了待ちなら、以下のコマンドを実行してください。
    │
    │    herdr-symphony report --status pending --summary "待機中の内容"
    │
    │失敗した場合は、以下のコマンドを実行してください。
    │
    │    herdr-symphony report --status failed --summary "失敗理由"'
    │
    │▪ oc mini VERSION · TEMP_DIR
    │
    │› Test prompt for test/repo#ID
    │## 完了報告
    │
    │ユーザーに依頼された作業が完了したら、以下のコマンドを実行してください。
    │
    │    herdr-symphony report --status done --summary "やった作業の要約"
    │
    │background task / subagent / task の完了待ちなら、以下のコマンドを実行してください。
    │
    │    herdr-symphony report --status pending --summary "待機中の内容"
    │
    │失敗した場合は、以下のコマンドを実行してください。
    │
    │    herdr-symphony report --status failed --summary "失敗理由"
    │
    │Task completed successfully.
    │
    │Default · Agent Model · TIME
    │
    │┃
    │
    │Build · Agent Model · 2.3K (2%) · Mock · ctrl+p menu"
  `)
}, 120_000)
