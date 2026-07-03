# agmsg を使った Claude リマインダ送信・完了報告への移行計画

## 背景

herdr-symphony は Claude Code を Herdr 上で対話モード実行する際、Herdr の `idle` だけでは完了判定できない。

現在は以下の自前方式で完了判定している。

- Claude へのプロンプト末尾に `herdr-symphony report --status ... --summary ...` の実行指示を追加する
- Claude 実行時に `HERDR_SYMPHONY_REPORT_PATH` を注入する
- Claude が `.herdr-symphony-report.json` に `done` / `pending` / `failed` を書く
- runner が report file をポーリングして完了判定する
- report 未送信のまま `idle` になった場合、`herdr agent send` と `pane send-keys Enter` で Claude pane に直接リマインドを送る

この自前方式を agmsg (`https://github.com/fujibee/agmsg`) のメッセージングに置き換える。

## 現状の実装箇所

- `src/service.ts`
  - `CLAUDE_REPORT_INSTRUCTION`
  - Claude の場合に `.herdr-symphony-report.json` を削除し、`reportPath` を runner に渡す処理
- `src/runner/herdr-agent/herdr-agent-runner.ts`
  - `CLAUDE_REPORT_REMINDER`
  - `readReport(reportPath)` による `done` / `pending` / `failed` 判定
  - `sendInput()` / `sendKeys("Enter")` による直接リマインダ送信
- `src/cli.ts`
  - `herdr-symphony report` subcommand
- `src/report/write-report.ts`
  - report file の読み書き
- `src/test-utils/e2e-fixture-claude.ts`
  - report file と直接リマインダ前提の fixture

## agmsg の利用方針

### 置き換え対象

以下の両方を agmsg に置き換える。

1. Claude から herdr-symphony への完了報告
2. herdr-symphony から Claude へのリマインダ送信

### 完了報告の形式

agmsg の body はプレーンテキストなので、本文に JSON を入れる。

```json
{
  "kind": "herdr-symphony.report",
  "runId": "TEST-1-WORKFLOW-ly02lc00",
  "toAgent": "herdr-symphony",
  "issueId": "issue-1",
  "status": "done",
  "summary": "対応内容: agmsg 経由で Claude の完了報告を送る実装に変更しました。検証: bun run typecheck と bun test が成功しました。補足: E2E は agmsg / herdr / claude が揃う環境で追加確認が必要です。"
}
```

`status` は以下の3種類。

- `done`: 成功として完了
- `pending`: 待機継続
- `failed`: 失敗として完了

JSON にする理由:

- summary に空白、改行、引用符、日本語を含められる
- `kind` / `issueId` で herdr-symphony 宛の該当 Issue 報告だけを安全に抽出できる
- 将来 `attempt` / `workflowName` などを追加しやすい

### タスク指示の形式

最初のタスク指示も agmsg body に JSON を入れる。argv には最小の bootstrap prompt だけを渡し、実タスクは agmsg で送る。これにより「monitor 配信が生きていなければタスクが始まらない」= 配信の生存がタスク遂行そのものに組み込まれる。

```json
{
  "kind": "herdr-symphony.task",
  "runId": "TEST-1-WORKFLOW-ly02lc00",
  "toAgent": "TEST-1-WORKFLOW-ly02lc00",
  "issueId": "issue-1",
  "prompt": "レンダリング済みの Liquid prompt 本文"
}
```

### リマインダの形式

リマインダも agmsg body に JSON を入れる。

```json
{
  "kind": "herdr-symphony.reminder",
  "runId": "TEST-1-WORKFLOW-ly02lc00",
  "toAgent": "TEST-1-WORKFLOW-ly02lc00",
  "issueId": "issue-1",
  "message": "タスクは完了しましたか？完了した場合は done、待機中なら pending、失敗なら failed を agmsg で報告してください。"
}
```

### ack の形式

Claude は herdr-symphony から `task` / `reminder` を受け取ったら、まず ack を返す。ack が配信の生存を証明する唯一の end-to-end 信号になる。

```json
{
  "kind": "herdr-symphony.ack",
  "runId": "TEST-1-WORKFLOW-ly02lc00",
  "toAgent": "herdr-symphony",
  "issueId": "issue-1",
  "ackOf": "task"
}
```

`ackOf` は `task` または `reminder`。

Claude Code の agmsg monitor により、これらのメッセージを Claude が受信して行動する想定。

## agmsg identity

固定 team は使わない。run ごとに team と agent を分離する。

- team: `herdr-symphony-${sanitizeWorkspaceKey(agentName)}`
- orchestrator agent: `herdr-symphony`
- Claude agent: 既存の `buildAgentName(issue.identifier, workflowName, now)` と同じ値
- runId: Claude agent name と同じ値

例:

```text
team=herdr-symphony-TEST-1-WORKFLOW-ly02lc00
from=herdr-symphony
to=TEST-1-WORKFLOW-ly02lc00
runId=TEST-1-WORKFLOW-ly02lc00
```

理由:

- agent name は既に issue/workflow/timestamp で一意
- agmsg の `to_agent` と `runId` としてそのまま使える
- team も run-scoped にすることで、他の herdr-symphony run と inbox が混ざらない
- 複数 workflow / 複数 issue の並列実行でも衝突しにくい

## agmsg delivery

Claude Code は `monitor` を使う。

Claude 起動前に以下を実行する。

```bash
~/.agents/skills/agmsg/scripts/join.sh "$agmsgTeam" herdr-symphony opencode "$workspacePath"
~/.agents/skills/agmsg/scripts/join.sh "$agmsgTeam" "$claudeAgentName" claude-code "$workspacePath"
~/.agents/skills/agmsg/scripts/delivery.sh set monitor claude-code "$workspacePath"
```

補足:

- orchestrator 自身は OpenCode プロセスなので `opencode` type で登録する
- 実際のメッセージ受信は runner が `inbox.sh` をポーリングするため、orchestrator 側 delivery mode は必須ではない
- Claude へのリマインダは monitor で即時配信する

## Claude が agmsg メッセージを受け取る担保

Claude が agmsg のメッセージを受け取ることは、以下の agmsg 側の delivery chain によって担保する。

```text
join.sh
  -> team config に claudeAgentName / type=claude-code / projectPath を登録

delivery.sh set monitor claude-code projectPath
  -> projectPath/.claude/settings.local.json に agmsg の SessionStart / SessionEnd hook を設定

Claude Code 起動
  -> SessionStart hook が scripts/session-start.sh を実行

session-start.sh
  -> identities.sh で projectPath + claude-code の登録済み identity を解決
  -> AGMSG-DIRECTIVE を出力し、Claude に Monitor tool 起動を指示

Claude の Monitor tool
  -> scripts/watch.sh sessionId projectPath claude-code を監視

watch.sh
  -> SQLite messages.db から team + to_agent=claudeAgentName の新規メッセージを stream
  -> Claude が monitor event として受信
```

したがって、herdr-symphony 側で担保すべき条件は以下。

1. Claude agent を起動する前に `join.sh` で `claudeAgentName` を `type=claude-code` として登録する。
2. Claude agent を起動する前に `delivery.sh set monitor claude-code "$workspacePath"` を実行する。
3. `herdr agent start` の cwd / projectPath が、`join.sh` と `delivery.sh` に渡した `workspacePath` と一致する。
4. リマインダ送信時の `to_agent` が、`join.sh` に渡した `claudeAgentName` と一致する。
5. agmsg が `~/.agents/skills/agmsg` にインストール済みで、Claude Code の SessionStart hook が有効である。

この chain は「Claude のプロンプトに agmsg を見てくださいと書く」だけでは担保されない。`delivery.sh set monitor` が `.claude/settings.local.json` に hook を入れ、SessionStart hook が Monitor 起動 directive を出すことが実際の担保になる。

ただし重要な注意点として、`delivery.sh set monitor` は Claude Code の SessionStart hook に依存する。そのため、既に起動済みの Claude Code セッションに対して後から `delivery.sh set monitor` を実行しても、そのセッションで Monitor が確実に起動するとは限らない。herdr-symphony が動的に起動する Claude agent では、必ず Claude 起動前に `join.sh` と `delivery.sh set monitor` を済ませる。

受信ができていることをテストで担保するには、unit test だけでは不十分。unit test では herdr-symphony が `join.sh` / `delivery.sh set monitor` / `send.sh` を正しく呼ぶことを検証し、E2E で実 agmsg + Claude Code に対して `to_agent=claudeAgentName` のメッセージが Claude に届くことを確認する。

## 配信が機能していることの保証と検知

前述の delivery chain は「設定が正しければ届くはず」を示すだけで、実行時に本当に届いているかは保証しない。ここでは別経路のフォールバックを持たず、agmsg 単一経路のまま handshake(ack) で self-verify する。

### なぜ ack が必要か（調査事実）

- `watch.sh`（monitor の実体）は受信してもメッセージの `read_at` を更新しない。既読で受信検知はできない。
- `watch.sh` は起動時に `MAX(id)` を watermark に設定し、それ以降の新規行だけを stream する。つまり Monitor 起動より前に送ったメッセージは取りこぼす。
- したがって「herdr-symphony が send した」ことと「Claude が受信した」ことの間には実行時ギャップがあり、これを埋められるのは Claude からの返信（ack）だけ。
- ack は Claude→herdr-symphony 方向の送信だが、その ack が「herdr-symphony→Claude のメッセージを受けて」返ってくることで、初めて herdr-symphony→Claude 方向（= reminder が通る方向）の monitor 生存が検証される。

### タスク指示を agmsg で送る（自然な monitor 化）

argv の prompt には最小の bootstrap だけを渡し、実タスクは agmsg の `herdr-symphony.task` で送る。

bootstrap prompt（argv）に含める指示:

- あなたは herdr-symphony 配下の agent である
- これから herdr-symphony がタスクを agmsg で送る
- タスク（`herdr-symphony.task`）を受け取ったら、まず `herdr-symphony.ack`（`ackOf=task`）を send し、その後タスクを実行する
- 完了したら `herdr-symphony.report` を send する
- reminder（`herdr-symphony.reminder`）を受け取ったら `herdr-symphony.ack`（`ackOf=reminder`）を send する

この設計の利点:

- タスク遂行そのものが monitor 配信の生存に依存するため、配信が死んでいればタスクが始まらず、fail が自然に顕在化する。
- Claude 起動と Monitor 起動の順序ギャップは、後述の「ack が来るまで task を再送」で吸収できる。

### handshake フロー

```text
runner:
  join(orchestrator, opencode) / join(claudeAgent, claude-code)
  delivery.sh set monitor claude-code workspacePath
  herdr agent start（argv は bootstrap prompt のみ）

runner: waitForTaskAck ループ
  send(herdr-symphony.task) を送る
  ackDeadline まで inbox を poll
    herdr-symphony.ack(ackOf=task) が来た -> handshake 成立、実行フェーズへ
    来ない -> 一定間隔で task を再送（Monitor 起動前の取りこぼしを吸収）
  handshakeTimeout を超えても ack が来ない
    -> RunnerResult を failed にする（error に配信未確立の理由）
    -> 明確な warning をログする

runner: 実行フェーズ（完了判定）
  working/blocked -> sawActive=true
  idle/agent null after sawActive:
    inbox に report があるか
      done    -> succeeded
      failed  -> failed
      pending -> sawActive=false; 待機継続
      なし    -> reminder を send、reminderAck を待つ
  reminder を送ったのに reminderAck も report も来ない状態が続く:
    -> 配信断とみなし、warning をログ
    -> turnTimeout で timeout として終了
```

### 検知ポイントの整理

- **task ack タイムアウト**: `herdr agent start` 後、handshakeTimeout 以内に `ackOf=task` が返らない → 配信未確立として `failed` で早期終了。Claude を idle のまま放置しない。
- **reminder ack タイムアウト**: reminder 送信後、reminderAckDeadline 以内に `ackOf=reminder` も report も返らない → 配信断とみなし warning。最終的に turnTimeout で timeout。
- どちらも別経路にフォールバックせず、agmsg 経路の失敗として上位（retry / state 遷移）に委ねる。

### タイムアウト定数（初期値、いずれ config 化を検討）

- `ackResendIntervalMs`: task ack 待ちの再送間隔（例: 5s）
- `handshakeTimeoutMs`: task ack の最終期限。デフォルトは 180s
- `reminderAckDeadlineMs`: reminder ack の期限（例: 30s）

## 他の Claude が誤って task を受け取るリスクへの対策

agmsg の monitor は projectPath + type から identity を解決する。したがって、同じ projectPath で複数の Claude Code セッションが動いている場合、単に同じ team に join するだけでは「別の Claude が task を見てしまう」リスクがある。

対策は三層にする。

1. **run-scoped team**: team は固定 `herdr-symphony` ではなく `herdr-symphony-${sanitizeWorkspaceKey(agentName)}` にする。別 issue / 別 workflow / 別 retry の message を同じ room に置かない。
2. **message-level 宛先検証**: 全 message に `runId` と `toAgent` を入れる。Claude bootstrap prompt には「`runId` と `toAgent` が自分の値と一致しない message は無視する」と明記する。runner 側の parser も `runId` / `toAgent` / `issueId` が一致しない ack/report を無視する。
3. **actas exclusivity**: Claude bootstrap の最初の行動として、agmsg の `actas-claim.sh "$workspacePath" claude-code "$agentName" "$CLAUDE_CODE_SESSION_ID"` を実行させる。claim に失敗した場合は task ack を返さず、runner は handshake timeout で failed にする。これにより、同じ projectPath の別 Claude セッションが同じ agent identity を購読する状態を避ける。

この三層により、通常ケースでは run-scoped team で分離し、同一 projectPath で複数 Claude が存在するケースでは actas lock と message-level 宛先検証で誤動作を防ぐ。

補足: actas claim は Claude セッション自身の `CLAUDE_CODE_SESSION_ID` が必要なので、runner から事前に完全実行することはできない。runner ができる担保は、bootstrap prompt に actas claim を必須手順として入れ、`ackOf=task` を actas claim 後にだけ返すよう要求すること。E2E では、同一 workspace に別 Claude を起動した状態で、対象 agent 以外が task を実行しないことを確認する。

## 新規モジュール

### `src/agmsg/agmsg-client.ts`

agmsg CLI を呼び出す外部境界を追加する。

```ts
export type AgmsgClient = {
  join(team: string, agent: string, type: "claude-code" | "opencode", projectPath: string): Promise<void>
  setDelivery(mode: "monitor" | "turn" | "both" | "off", type: "claude-code" | "opencode", projectPath: string): Promise<void>
  send(team: string, from: string, to: string, body: string): Promise<void>
  inbox(team: string, agent: string): Promise<string>
}
```

実装は `CommandRunner` 注入可能にする。

対象 script:

- `~/.agents/skills/agmsg/scripts/join.sh`
- `~/.agents/skills/agmsg/scripts/delivery.sh`
- `~/.agents/skills/agmsg/scripts/send.sh`
- `~/.agents/skills/agmsg/scripts/inbox.sh`

agmsg が未インストールの場合は明確な error にする。

```text
agmsg is not installed: ~/.agents/skills/agmsg/scripts/send.sh not found
```

自動インストールはしない。

### `src/agmsg/agmsg-message.ts`

agmsg body の生成・パースを担当する。report 専用ではなく、task / ack / reminder / report を扱う。

```ts
export type AgentReportStatus = "done" | "pending" | "failed"

export type TaskMessage = {
  kind: "herdr-symphony.task"
  runId: string
  toAgent: string
  issueId: string
  prompt: string
}

export type AckMessage = {
  kind: "herdr-symphony.ack"
  runId: string
  toAgent: string
  issueId: string
  ackOf: "task" | "reminder"
}

export type ReminderMessage = {
  kind: "herdr-symphony.reminder"
  runId: string
  toAgent: string
  issueId: string
  message: string
}

export type AgentReportMessage = {
  kind: "herdr-symphony.report"
  runId: string
  toAgent: string
  issueId: string
  status: AgentReportStatus
  summary: string
}

export type AgmsgMessage = TaskMessage | AckMessage | ReminderMessage | AgentReportMessage

export function formatAgmsgMessage(input: AgmsgMessage): string
export function parseAgmsgMessage(
  body: string,
  expected: { issueId: string; runId: string; toAgent: string },
): AgmsgMessage | null
```

`parseAgmsgMessage` の仕様:

- JSON でない本文は `null`
- `kind` が herdr-symphony の既知 kind 以外なら `null`
- `issueId` が対象 Issue と違うなら `null`
- `runId` が対象 run と違うなら `null`
- `toAgent` が期待する宛先と違うなら `null`
- report は `status` が `done` / `pending` / `failed` 以外なら `null`
- ack は `ackOf` が `task` / `reminder` 以外なら `null`
- task は `prompt` が string でないなら `null`
- reminder は `message` が string でないなら `null`
- report は `summary` が string でないなら `null`

## RunnerOptions の変更

`reportPath` を削除し、agmsg 設定を追加する。`content` は Claude では bootstrap prompt ではなく「agmsg で送る実タスク prompt」として使う。runner が argv に渡すのは bootstrap prompt、`content` は `herdr-symphony.task` の本文になる。

```ts
export type RunnerOptions = {
  content: string
  attempt: number | null
  workspacePath: string
  agentKind: "opencode" | "claude"
  agent?: string | null
  model?: string | null
  permissionMode?: string | null
  onBlocked?: "continue" | "fail" | null
  timeoutMs?: number | null
  workflowName?: string
  agmsg?: {
    team: string
    orchestratorAgent: string
  }
  onEvent?: (event: RunnerEvent) => void
}
```

補足: opencode では従来通り `content` を argv に渡す。agmsg handshake は Claude のときだけ有効。

## `src/service.ts` の変更

### 削除するもの

- `rm` import
- `join` import
- `CLAUDE_REPORT_INSTRUCTION`
- `.herdr-symphony-report.json` の削除
- `reportPath` の生成
- runner option の `reportPath`

### 追加するもの

Claude の場合に runner option へ agmsg 設定を渡す。

```ts
const agmsg = runtimeConfig.runner.agent === "claude"
  ? {
      team: "herdr-symphony",
      orchestratorAgent: "herdr-symphony",
    }
  : undefined
```

runner が agentName 生成後に最終的な agmsg command 例を prompt に追記できるようにする。

## `src/runner/herdr-agent/herdr-agent-runner.ts` の変更

### 起動前処理

Claude かつ `options.agmsg` がある場合:

1. `agentName` を生成する
2. orchestrator を agmsg team に join する
3. Claude agent を agmsg team に join する
4. Claude Code delivery を monitor にする
5. bootstrap prompt を argv 用に生成する
6. `herdr agent start` する
7. `herdr-symphony.task` を agmsg で送る
8. `herdr-symphony.ack`（`ackOf=task`）を待つ

### bootstrap prompt

Claude の argv に渡す prompt は、実タスクではなく agmsg bootstrap にする。

内容:

```text
あなたは herdr-symphony の agent です。
実タスクは agmsg で届きます。
`herdr-symphony.task` を受け取ったら、まず `herdr-symphony.ack` (`ackOf=task`) を herdr-symphony 宛に送ってから、task.prompt を実行してください。
`herdr-symphony.reminder` を受け取ったら、まず `herdr-symphony.ack` (`ackOf=reminder`) を送ってから、現在の状態を `herdr-symphony.report` で報告してください。
完了時は `done`、待機中は `pending`、失敗時は `failed` を `herdr-symphony.report` として送ってください。
```

### task message 送信

runner は Claude 起動後、実タスクを agmsg で送る。

```json
{
  "kind": "herdr-symphony.task",
  "issueId": "<issue.id>",
  "prompt": "<options.content>"
}
```

その後 `ackOf=task` を待つ。ack が来ない場合は `ackResendIntervalMs` ごとに task message を再送する。これは `watch.sh` が起動時 watermark より前のメッセージを読まないため。

`handshakeTimeoutMs` を超えても ack が来ない場合、runner は以下を返す。

```ts
{
  status: "failed",
  error: "agmsg delivery handshake timed out",
  responseText: null,
}
```

### 完了判定

Claude の場合、Herdr state だけでは完了しない。

```text
handshake:
  task を agmsg send
  ackOf=task を待つ
  ack が来ない -> task を再送
  handshakeTimeout -> failed

working / blocked:
  sawActive = true

idle または agent null after sawActive:
  inbox(team, orchestratorAgent) を読む
  対象 issue の herdr-symphony.report を探す
    done    -> return done
    failed  -> return done（後続で failed result に変換）
    pending -> sawActive = false; continue
    なし    -> agmsg send で reminder; reminder ack を待つ; sawActive = false; continue

opencode:
  従来通り idle / done で完了
```

### リマインダ送信

削除する処理:

```ts
await this.client.sendInput(target, CLAUDE_REPORT_REMINDER)
await this.client.sendKeys(target, "Enter")
```

置き換え:

```ts
await this.agmsg.send(team, orchestratorAgent, agentName, reminderBody)
```

reminder 送信後は `ackOf=reminder` または `report` を待つ。`reminderAckDeadlineMs` 以内にどちらも来ない場合、配信断の warning をログに出す。別経路にはフォールバックしない。

### report result 変換

`inbox` から最後に受け取った report を保持し、`runIssue` の結果に反映する。

- `done`: `status: "succeeded"`, `responseText: summary`
- `failed`: `status: "failed"`, `error: summary`
- `pending`: 完了しない

## inbox 出力の扱い

`inbox.sh` は概ね以下の形式で出力する。

```text
1 new message(s):

 [2026-07-03T12:00:00Z] TEST-1-WORKFLOW-ly02lc00: {"kind":"herdr-symphony.report","issueId":"issue-1","status":"done","summary":"完了"}
```

最小実装では、各行の最初の `: ` 以降を body 候補として取り出し、`parseAgmsgMessage()` に渡す。

## CLI の変更

`herdr-symphony report` subcommand は削除する。

削除対象:

- `src/cli.ts` の `report` parsing / handling
- usage の `report` 行
- `src/cli.test.ts` の report command テスト
- `src/report/write-report.ts`
- `src/report/write-report.test.ts`

## README 更新

`README.md` の Claude 完了報告セクションを agmsg 方式へ更新する。

記載する内容:

- agmsg が必要
- Claude への実タスク指示は argv ではなく `herdr-symphony.task` として agmsg で送る
- Claude は `herdr-symphony.task` / `herdr-symphony.reminder` を受け取ったら `herdr-symphony.ack` を返す
- Claude は `herdr-symphony.report` JSON を agmsg で送る
- `done` は成功、`failed` は失敗、`pending` は待機継続
- report 未送信で idle になった場合、herdr-symphony は agmsg でリマインドする
- task ack が返らなければ、agmsg monitor 配信未確立として failed になる
- `.herdr-symphony-report.json` / `herdr-symphony report` は使わない

動作フローも更新する。

変更前:

```text
Agent 完了を検知（opencode は Herdr の状態、claude は `herdr-symphony report`）
```

変更後:

```text
Agent 完了を検知（opencode は Herdr の状態、claude は agmsg の `herdr-symphony.report`）
```

## テスト計画

### parser

`src/agmsg/agmsg-message.test.ts`

- `task` message を生成・パースできる
- `ackOf=task` の ack を生成・パースできる
- `ackOf=reminder` の ack を生成・パースできる
- `done` を生成・パースできる
- `pending` をパースできる
- `failed` をパースできる
- issueId が違う message は無視する
- kind が違う JSON は無視する
- JSON でない本文は無視する
- prompt / summary に改行・引用符・日本語を含められる

### agmsg client

`src/agmsg/agmsg-client.test.ts`

- `join()` が `join.sh` を呼ぶ
- `setDelivery()` が `delivery.sh set` を呼ぶ
- `send()` が `send.sh` を呼ぶ
- `inbox()` が `inbox.sh <team> <agent> --quiet` を呼び stdout を返す
- exit code 非 0 で Error

### runner

`src/runner/herdr-agent/herdr-agent-runner.test.ts`

- Claude 起動前に orchestrator と Claude agent が join される
- Claude delivery が monitor に設定される
- Claude の argv には実タスクではなく bootstrap prompt が渡る
- Claude 起動後に `herdr-symphony.task` が agmsg で送られる
- `ackOf=task` が来るまで task message を再送する
- `handshakeTimeoutMs` まで `ackOf=task` が来なければ failed になる
- `ackOf=task` が来たら実行フェーズに進む
- `done` report で succeeded になる
- `failed` report で failed になる
- `pending` report では完了せず、リマインダも送らない
- idle で report がない場合、agmsg で reminder を送る
- reminder 送信後に `ackOf=reminder` が来れば配信断 warning を出さない
- reminder 送信後に `ackOf=reminder` も report も来なければ warning を出す
- idle で report がない場合、`herdr agent send` / `pane send-keys` を使わない
- `getAgent()` が null でも sawActive 後なら inbox 確認と reminder 送信を行う
- opencode は agmsg を使わず従来通り

### service

`src/service.test.ts`

- Claude の場合は `agmsg` option を runner に渡す
- Claude の場合でも `reportPath` は渡さない
- opencode の場合は agmsg option を渡さない

### e2e

`src/e2e/claude-interactive.e2e.test.ts`

- agmsg 未インストール環境では skip
- 既存の report file 前提 fixture を agmsg 前提に更新
- 表示確認文言を `claude reminder sent` から `agmsg reminder sent` に変更

## 受け入れ条件

- Claude 完了判定で `.herdr-symphony-report.json` を使わない
- `HERDR_SYMPHONY_REPORT_PATH` を runner に渡さない
- `herdr-symphony report` subcommand を完了報告経路として使わない
- Claude の実タスク指示は argv 直接渡しではなく `herdr-symphony.task` として agmsg で送る
- `herdr-symphony.task` に対する `ackOf=task` が返るまで task を再送する
- `handshakeTimeoutMs` まで `ackOf=task` が返らない場合は、agmsg 配信未確立として failed になる
- 未報告 idle 時のリマインダ送信が `herdr agent send` ではなく `agmsg send.sh` になる
- reminder 送信後は `ackOf=reminder` または report を待ち、どちらも返らなければ配信断 warning を出す
- Claude からの `done` / `pending` / `failed` が agmsg inbox 経由で解釈される
- `pending` は完了扱いにならず、リマインドも送らず待機継続する
- opencode の完了判定は従来通り Herdr state ベースのまま
- agmsg 未インストール時は Claude runner が明確なエラーを返す

## 検証コマンド

実装後に必ず実行する。

```bash
bun run typecheck && bun test && bun run check
```

agmsg / herdr / claude が揃っている環境では追加で実行する。

```bash
bun run test:e2e
```
