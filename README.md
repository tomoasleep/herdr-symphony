# herdr-symphony

GitHub Project をポーリングし、Herdr 経由で Agent の起動・監視を行うヘッドレスオーケストレーター。Agent の動作状況は Herdr の Workspace 機能で管理・表示する。

## 概要

- [openai/symphony](https://github.com/openai/symphony) と [workaholic](https://github.com/tomoasleep/workaholic) の設計をベースにした Agent 管理ツール
- TUI・Web UI を持たず、Agent の動作ログ・状態はすべて Herdr 上で確認する
- GitHub Project（または file tracker）を監視し、候補 Issue を検出する
- gwq で worktree を作成し、Herdr workspace で Agent を起動する
- `opencode run` を Herdr pane 内で実行し、`herdr agent wait` で完了を検知する

## セットアップ

```bash
bun install
```

前提:

- `bun` インストール済み
- `herdr` インストール済み（`curl -fsSL https://herdr.dev/install.sh | sh`）
- Herdr server 実行中（`herdr` を一度起動すればバックグラウンドで常駐）
- `opencode` CLI インストール済み
- `gwq` CLI インストール済み
- `gh` CLI でログイン済み、`project` scope 付与済み（`gh auth refresh -s project`）

環境変数:

- `WORKFLOW_PATH` は `--workflow` 未指定時の fallback。さらに未指定なら `./WORKFLOW.md`

## 実行

```bash
bun run start
```

CLI として実行:

```bash
herdr-symphony
herdr-symphony --workflow /path/to/WORKFLOW.md
herdr-symphony --workflow /path/to/WORKFLOW.md --workflow /path/to/WORKFLOW.exec.md
herdr-symphony validate --workflow /path/to/WORKFLOW.md
```

開発用 symlink:

```bash
bun run link:dev
```

テスト:

```bash
bun test
bun run typecheck
bun run check
```

## 設定リファレンス

### tracker 設定

#### GitHub Project Tracker

```yaml
tracker:
  kind: github_project
  owner: "@me"
  number: 4
  repository: '{{ issue.fields["Repository"] }}'
```

#### File Tracker

ディレクトリベースの Issue 管理。state ディレクトリ配下の `.md` ファイルをスキャンする。

```yaml
tracker:
  kind: file
  file:
    base_dir: /path/to/issues
```

#### Schedule Tracker

cron ベースのスケジュール実行。

```yaml
tracker:
  kind: schedule
  schedule:
    cron: "0 9 * * *"
```

### work 設定

```yaml
work:
  active_states: [Ready]
  running_state: "In progress"
  success_state: "In review"
  failure_state: "Blocked"
  reporter: [file, tracker]

  workspace:
    provider: gwq
    branch: '{{ issue.fields["Branch"] | default: "herdr/" | append: issue.identifier | replace: "/", "_" }}'
    gwq:
      command: gwq
      create_branch: true

  runner: herdr_agent
  herdr_agent:
    agent: opencode
    opencode:
      model: '{{ issue.fields["Model"] | default: "openai/gpt-5.4" }}'
      agent: '{{ issue.fields["Agent"] | default: "build" }}'
    claude:
      model: 'claude-sonnet-4-20250514'
      permission_mode: '{{ issue.fields["PermissionMode"] | default: "bypassPermissions" }}'
    workspace_label: '{{ issue.identifier | replace: "/", "_" }}'
    turn_timeout_ms: 3600000
```

### work.herdr_agent

| 設定 | 型 | デフォルト | 説明 |
|------|-----|-----------|------|
| `agent` | `"opencode"` | `"opencode"` | 起動する Agent 種別（将来拡張予定）|
| `opencode.model` | string (Liquid) | null | `opencode run --model` |
| `opencode.agent` | string (Liquid) | null | `opencode run --agent` |
| `claude.model` | string (Liquid) | null | `claude --model` |
| `claude.permission_mode` | string (Liquid) | null | `claude --permission-mode` (`bypassPermissions` の場合は `--dangerously-skip-permissions` も付与) |
| `claude.messenger` | `"agmsg"` \| `"report_file"` | `"agmsg"` | Claude との完了判定通信方式 |
| `claude.pending_remind_interval_ms` | number | `900_000` (15分) | `report_file` モードで `pending` のまま再リマインドするまでの間隔 |
| `claude.reminder_grace_period_ms` | number | `180_000` (3分) | `report_file` モードで起動直後の reminder 送信を抑制する時間。`0` で無効化 |
| `workspace_label` | string (Liquid) | issue.identifier | Herdr workspace の label |
| `turn_timeout_ms` | number | null (無制限) | Agent 完了待ちタイムアウト |
| `close_pane_after_done_ms` | number | null (無効) | Agent 完了後に pane を自動クローズするまでの時間（ミリ秒）。succeeded / failed / timeout の全完了ステータスが対象 |

Claude は Herdr の `idle` だけでは完了扱いにしません。`claude.messenger` 設定で完了判定通信方式を選べます。

#### `agmsg` (デフォルト)

[agmsg](https://github.com/fujibee/agmsg) 経由で `herdr-symphony.task` JSON メッセージを送信します。agmsg が必要です（`~/.agents/skills/agmsg/scripts/send.sh` が存在すること）。未インストール時は Claude runner が明確なエラーを返します。

```json
{"kind":"herdr-symphony.task","runId":"<agentName>","toAgent":"<agentName>","issueId":"<issueId>","prompt":"..."}
```

Claude は task を受け取ると `herdr-symphony.ack` (`ackOf=task`) を返します。ack が 180 秒以内に返らない場合は、agmsg monitor 配信未確立として失敗扱いにします。

完了時は Claude が `herdr-symphony.report` を送ります。`done` は成功、`failed` は失敗として完了します。`pending` は待機継続です。Claude が `idle` に戻っても report がない場合、herdr-symphony は agmsg で Claude に report を促すリマインドを送り、Claude は `ackOf=reminder` を返します。

agmsg が必要です（`~/.agents/skills/agmsg/scripts/send.sh` が存在すること）。未インストール時は Claude runner が明確なエラーを返します。

#### `report_file`

ファイルベースの report 機構。プロンプト末尾に `herdr-symphony report --status ... --summary ...` の実行指示を追加し、`HERDR_SYMPHONY_REPORT_PATH` 環境変数で report file パスを Claude に注入します。Claude が `.herdr-symphony-report.json` に `done` / `pending` / `failed` を書き、runner が report file をポーリングして完了判定します。report 未送信のまま idle になった場合は、`herdr agent send` と `pane send-keys Enter` で Claude pane に直接リマインドを送ります。`pending` のまま `claude.pending_remind_interval_ms` (デフォルト15分) 経過した場合も同様にリマインドを再送します。起動直後（`claude.reminder_grace_period_ms`、デフォルト3分）は Claude Code がタスクを受け取る前の idle と誤判定されるのを防ぐため、reminder 送信を抑制します。`0` を指定すれば無効化できます。

### work.workspace

```yaml
workspace:
  provider: gwq              # "gwq" または "git" (デフォルト: gwq)
  reuse_existing: true       # 既存 worktree を再利用 (デフォルト: true)
  create_if_missing: true    # 存在しない場合は作成 (デフォルト: true)
  branch: '...'              # branch 名 (Liquid 可)
  gwq:
    command: gwq             # gwq コマンド (デフォルト: gwq)
    create_branch: true      # gwq add -b を使う (デフォルト: true)
```

### 状態遷移

- `work.running_state` を設定すると、dispatch 開始時に tracker の Status を更新する
- `work.success_state` / `work.failure_state` で実行結果に応じて終了時に Status を更新する
- `work.reporter` で `file`（AGENTLOGS.local.md）または `tracker`（description）に出力

## 動作フロー

1. poll tick で tracker から候補 Issue を取得
2. orchestrator が dispatchable な Issue を選出
3. `gwq add` で worktree を作成
4. `herdr workspace create` で Herdr workspace を作成
5. `herdr agent start` で `opencode run` または Claude bootstrap prompt を Herdr pane 内で起動
   - agent name は `{issue.identifier}-{workflowName}-{timestamp}`（複数 workflow や再実行での name 衝突を回避）
6. Claude の場合は agmsg で `herdr-symphony.task` を送り、`ackOf=task` を待つ
7. Agent 完了を検知（opencode は Herdr の状態、claude は agmsg の `herdr-symphony.report`）
8. セッション履歴から Agent の最終報告を取得（opencode は `opencode export`、claude は agmsg report。取得失敗時は pane 読み取りにフォールバック）
9. tracker の Status を success/failure state へ更新
10. reporter で結果を記録

Agent の実行状況は Herdr のサイドバーで確認できる。
