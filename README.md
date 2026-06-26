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
| `workspace_label` | string (Liquid) | issue.identifier | Herdr workspace の label |
| `turn_timeout_ms` | number | null (無制限) | Agent 完了待ちタイムアウト |

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
5. `herdr agent start` で `opencode run` を Herdr pane 内で起動
6. `herdr agent wait --status done` で完了を検知
7. セッション履歴から Agent の最終報告を取得（opencode は `opencode export`、claude は `~/.claude/projects` の JSONL。取得失敗時は pane 読み取りにフォールバック）
8. tracker の Status を success/failure state へ更新
9. reporter で結果を記録

Agent の実行状況は Herdr のサイドバーで確認できる。
