# herdr-symphony

GitHub Project をポーリングし、Herdr 経由で Agent の起動・監視を行うヘッドレスオーケストレーター。Agent の動作状況は Herdr の Workspace 機能で管理・表示する。

## 概要

- [openai/symphony](https://github.com/openai/symphony) と [workaholic](https://github.com/tomoasleep/workaholic) の設計をベースにした Agent 管理ツール
- TUI・Web UI を持たず、Agent の動作ログ・状態はすべて Herdr 上で確認する
- GitHub Project（または file tracker / schedule tracker）を監視し、候補 Issue を検出する
- gwq で worktree を作成し、Herdr workspace で Agent を起動する
- OpenCode または Claude Code を Herdr pane 内で実行し、完了を検知する

## セットアップ

```bash
bun install
```

### 常に必須のツール

- `bun` — ランタイム
- `herdr` — Agent 起動・監視（`curl -fsSL https://herdr.dev/install.sh | sh`）
  - Herdr server 実行中（`herdr` を一度起動すればバックグラウンドで常駐）

### 設定により必要なツール

| ツール | 必要になる条件 | インストール・準備 |
|--------|---------------|-------------------|
| `opencode` | `herdr_agent.agent: opencode`（デフォルト）| [opencode](https://github.com/anomalyco/opencode) のインストール手順に従う |
| `claude` (Claude Code CLI) | `herdr_agent.agent: claude` | [Claude Code](https://docs.anthropic.com/en/docs/claude-code) のインストール手順に従う |
| `gwq` | `workspace.provider: gwq`（デフォルト）| [gwq](https://github.com/tomoasleep/gwq) のインストール手順に従う |
| `gh` | `tracker.kind: github_project` | `gh auth login` 後 `gh auth refresh -s project` で `project` scope を付与 |
| `agmsg` | `herdr_agent.agent: claude` + `claude.messenger: agmsg` | `~/.agents/skills/agmsg/scripts/send.sh` が存在すること。未インストール時は Claude runner が明確なエラーを返す |

### 環境変数

- `WORKFLOW_PATH` は `--workflow` 未指定時の fallback。さらに未指定なら `./WORKFLOW.md`
- `HERDR_SYMPHONY_REPORT_PATH` は `report` サブコマンドが report を書き込むファイルパス（`report_file` messenger 使用時に runner が Claude に注入する）

## 実行

### 基本実行

```bash
herdr-symphony
herdr-symphony /path/to/WORKFLOW.md
```

### CLI リファレンス

```
herdr-symphony [options] [workflow...]
herdr-symphony validate [workflow...]
herdr-symphony report --status <done|pending|failed> --summary <text>
herdr-symphony wrap --result <path> -- <command...>
```

**Commands:**

| コマンド | 説明 |
|----------|------|
| (default) | オーケストレーターを起動し、polling を開始する |
| `validate` | ワークフロー設定を検証する |
| `report` | `HERDR_SYMPHONY_REPORT_PATH` に完了 report を書き込む（`report_file` messenger 使用時に Claude が実行） |
| `wrap` | コマンドをラップし、終了コードと stdout を result file に保存する |

**Options:**

| オプション | 説明 |
|-----------|------|
| `-w, --workflow <path>` | ワークフローファイルを指定（複数指定可） |
| `--log-level <level>` | ログレベル（`debug` / `info` / `warn` / `error`） |
| `--status <status>` | `report` コマンドのステータス（`done` / `pending` / `failed`） |
| `--summary <text>` | `report` コマンドのサマリーテキスト |
| `--result <path>` | `wrap` コマンドの result file パス |
| `-h, --help` | ヘルプを表示 |

**Arguments:**

- 位置引数でワークフローを複数指定可能: `herdr-symphony /path/to/WORKFLOW.md /path/to/WORKFLOW.exec.md`
- `--workflow` と位置引数は同時に指定できない

例:

```bash
herdr-symphony --workflow /path/to/WORKFLOW.md
herdr-symphony --workflow /path/to/WORKFLOW.md --workflow /path/to/WORKFLOW.exec.md
herdr-symphony validate --workflow /path/to/WORKFLOW.md
herdr-symphony /path/to/WORKFLOW.md /path/to/WORKFLOW.exec.md
```

### 開発

```bash
bun run start         # リポジトリから一度だけ実行
bun run dev           # Hot reload
bun run link:dev      # CLI を ~/.local/bin/herdr-symphony に symlink
```

### テスト

```bash
bun test             # 全テスト
bun run typecheck    # tsc --noEmit
bun run check        # biome check . (lint + format)
bun run test:e2e     # E2E テスト（herdr binary がない場合は skip）
```

## 動作フロー

1. poll tick で tracker から候補 Issue を取得
2. `work.if` 条件で Issue をフィルタ（未設定時はすべて通過）
3. orchestrator が dispatchable な Issue を選出（concurrency / state / blocker を判定）
4. `gwq add` または `git worktree` で worktree を作成
5. `herdr workspace create` で Herdr workspace を作成
6. `herdr agent start` で OpenCode または Claude Code を Herdr pane 内で起動
   - agent name は `{issue.identifier}-{workflowName}-{timestamp}`（複数 workflow や再実行での name 衝突を回避）
7. opencode の場合は Herdr の agent 状態で完了を検知。Claude の場合は messenger（`agmsg` または `report_file`）で完了を検知
8. セッション履歴から Agent の最終報告を取得（opencode は `opencode export`、claude は messenger report。取得失敗時は pane 読み取りにフォールバック）
9. tracker の Status を success/failure state へ更新
10. reporter で結果を記録

Agent の実行状況は Herdr のサイドバーで確認できる。

## 設定リファレンス

`WORKFLOW.md` は frontmatter（設定） + body（Liquid プロンプトテンプレート）で構成される。Config キーは snake_case。プロンプト body は `issue` と `attempt` をスコープに持つ Liquid テンプレートとして per-issue でレンダリングされる。

Liquid エンジンは strict mode（`strictFilters`, `strictVariables`）で動作し、未定義変数や失敗したフィルタはエラーになる。プロンプトだけでなく `branch`, `model`, `workspace_label` などの設定値の文字列にも適用される。

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

### work（共通設定）

```yaml
work:
  if: '{{ issue.fields["Agent"] == "build" }}'
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

### work.if（条件付き dispatch）

`work.if` に Liquid テンプレートを指定すると、条件を満たす Issue のみ dispatch される。複数の workflow ファイルを運用し、Issue のフィールド値で実行する workflow を切り替えたい場合に便利。

```yaml
work:
  if: '{{ issue.fields["Agent"] == "build" }}'
```

テンプレートをレンダリングした結果が以下のいずれかの場合、dispatch されない（偽と判定）:

- 空文字列
- `"false"`（case-insensitive）
- `"0"`

それ以外の非空文字列は真と判定され、dispatch される。未指定時はすべての Issue が dispatch される（デフォルト）。

複数 workflow を切り替える例:

```yaml
# WORKFLOW.build.md — Agent が "build" の Issue のみ処理
work:
  if: '{{ issue.fields["Agent"] == "build" }}'
```

```yaml
# WORKFLOW.plan.md — Agent が "plan" の Issue のみ処理
work:
  if: '{{ issue.fields["Agent"] == "plan" }}'
```

### work.workspace

#### gwq (デフォルト)

```yaml
workspace:
  provider: gwq
  reuse_existing: true       # 既存 worktree を再利用 (デフォルト: true)
  create_if_missing: true    # 存在しない場合は作成 (デフォルト: true)
  branch: '...'              # branch 名 (Liquid 可)
  gwq:
    command: gwq             # gwq コマンド (デフォルト: gwq)
    create_branch: true      # gwq add -b を使う (デフォルト: true)
```

#### git

```yaml
workspace:
  provider: git
  branch: '...'
```

#### none

```yaml
workspace:
  provider: none
```

`provider: none` を指定すると worktree を作成せず、リポジトリルート（`git rev-parse --show-toplevel`）で直接作業する。ブランチの checkout 等は行わない。並列実行時は同じディレクトリで競合する可能性があるため警告が出力される。

### work.herdr_agent

agent 種別ごとに設定が分かれる。共通設定と OpenCode / Claude Code それぞれの設定、そして完了判定機構から構成される。

#### 共通設定

```yaml
herdr_agent:
  agent: opencode
  workspace_label: '{{ issue.identifier | replace: "/", "_" }}'
  turn_timeout_ms: 3600000
  close_pane_after_done_ms: null
  on_blocked: continue
```

| 設定 | 型 | デフォルト | 説明 |
|------|-----|-----------|------|
| `agent` | `"opencode"` \| `"claude"` | `"opencode"` | 起動する Agent 種別 |
| `workspace_label` | string (Liquid) | issue.identifier | Herdr workspace の label |
| `turn_timeout_ms` | number | null (無制限) | Agent 完了待ちタイムアウト |
| `close_pane_after_done_ms` | number | null (無効) | Agent 完了後に pane を自動クローズするまでの時間（ミリ秒）。succeeded / failed / timeout の全完了ステータスが対象 |
| `on_blocked` | `"continue"` \| `"fail"` | `"continue"` | Agent が blocked 状態になったときの挙動。`continue` は待機継続、`fail` は失敗扱いで終了 |

#### OpenCode

```yaml
herdr_agent:
  agent: opencode
  opencode:
    model: '{{ issue.fields["Model"] | default: "openai/gpt-5.4" }}'
    agent: '{{ issue.fields["Agent"] | default: "build" }}'
    interactive: false
```

| 設定 | 型 | デフォルト | 説明 |
|------|-----|-----------|------|
| `opencode.model` | string (Liquid) | null | `opencode --model` |
| `opencode.agent` | string (Liquid) | null | `opencode --agent` |
| `opencode.interactive` | boolean | `false` | `true` で TUI (interactive mode) で起動。完了判定は report 機構（後述）を使用 |

#### Claude Code

```yaml
herdr_agent:
  agent: claude
  claude:
    model: 'claude-sonnet-4-20250514'
    permission_mode: '{{ issue.fields["PermissionMode"] | default: "bypassPermissions" }}'
    messenger: report_file
```

| 設定 | 型 | デフォルト | 説明 |
|------|-----|-----------|------|
| `claude.model` | string (Liquid) | null | `claude --model` |
| `claude.permission_mode` | string (Liquid) | null | `claude --permission-mode` (`bypassPermissions` の場合は `--dangerously-skip-permissions` も付与) |

#### 完了判定機構

Claude および OpenCode interactive mode は、Herdr の `idle` だけでは完了扱いにしない。完了判定には以下のいずれかの機構を使う。

- **Claude**: `messenger` 設定で `agmsg` または `report_file` を選ぶ（デフォルト: `report_file`）
- **OpenCode interactive mode**: 常に `report_file` 機構を使う

```yaml
herdr_agent:
  claude:
    messenger: report_file
    pending_remind_interval_ms: 900000
    reminder_grace_period_ms: 180000
```

| 設定 | 型 | デフォルト | 説明 |
|------|-----|-----------|------|
| `messenger` | `"agmsg"` \| `"report_file"` | `"report_file"` | Claude との完了判定通信方式 |
| `pending_remind_interval_ms` | number | `900_000` (15分) | `report_file` モードで `pending` のまま再リマインドするまでの間隔 |
| `reminder_grace_period_ms` | number | `180_000` (3分) | `report_file` モードで起動直後の reminder 送信を抑制する時間。`0` で無効化 |

これらは `work.herdr_agent.claude` 配下の設定。OpenCode interactive mode ではデフォルト値が使われる。

##### `agmsg`

[agmsg](https://github.com/fujibee/agmsg) 経由で `herdr-symphony.task` JSON メッセージを送信する。agmsg が必要（`~/.agents/skills/agmsg/scripts/send.sh` が存在すること）。未インストール時は Claude runner が明確なエラーを返す。

```json
{"kind":"herdr-symphony.task","runId":"<agentName>","toAgent":"<agentName>","issueId":"<issueId>","prompt":"..."}
```

Claude は task を受け取ると `herdr-symphony.ack` (`ackOf=task`) を返す。ack が 180 秒以内に返らない場合は、agmsg monitor 配信未確立として失敗扱いにする。

完了時は Claude が `herdr-symphony.report` を送る。`done` は成功、`failed` は失敗として完了する。`pending` は待機継続。Claude が `idle` に戻っても report がない場合、herdr-symphony は agmsg で Claude に report を促すリマインドを送り、Claude は `ackOf=reminder` を返す。

##### `report_file` (デフォルト)

ファイルベースの report 機構。プロンプト末尾に `herdr-symphony report --status ... --summary ...` の実行指示を追加し、`HERDR_SYMPHONY_REPORT_PATH` 環境変数で report file パスを Agent に注入する。Agent が `.herdr-symphony-report.json` に `done` / `pending` / `failed` を書き、runner が report file をポーリングして完了判定する。report 未送信のまま idle になった場合は、`herdr agent send` と `pane send-keys Enter` で pane に直接リマインドを送る。`pending` のまま `pending_remind_interval_ms` (デフォルト15分) 経過した場合も同様にリマインドを再送する。起動直後（`reminder_grace_period_ms`、デフォルト3分）は Agent がタスクを受け取る前の idle と誤判定されるのを防ぐため、reminder 送信を抑制する。`0` を指定すれば無効化できる。

### 状態遷移

| 設定 | 型 | デフォルト | 説明 |
|------|-----|-----------|------|
| `active_states` | string \| string[] | `["Backlog", "Ready", "In progress", "In review"]` | dispatch 対象とする Status |
| `running_state` | string | null | dispatch 開始時に設定する Status |
| `success_state` | string | null | 実行成功時に設定する Status |
| `failure_state` | string | null | 実行失敗時に設定する Status |
| `terminal_states` | string \| string[] | `["Done"]` | これらの Status の Issue は dispatch 対象から除外 |
| `stopped_state` | string | null | リトライ停止時に設定する Status |
| `reporter` | array | `["file"]` | `file`（AGENTLOGS.local.md）または `tracker`（description）|

### polling

| 設定 | 型 | デフォルト | 説明 |
|------|-----|-----------|------|
| `polling.interval_ms` | number | `30000` | poll tick の間隔（ミリ秒）|

### hooks

| 設定 | 型 | デフォルト | 説明 |
|------|-----|-----------|------|
| `hooks.before_run` | string (Liquid) | null | dispatch 前に実行するコマンド |
| `hooks.after_run` | string (Liquid) | null | dispatch 後に実行するコマンド |
| `hooks.timeout_ms` | number | `60000` | hooks のタイムアウト（ミリ秒）|

### agent

| 設定 | 型 | デフォルト | 説明 |
|------|-----|-----------|------|
| `agent.max_concurrent_agents` | number | `10` | 同時実行可能な Agent 数の上限 |
| `agent.max_retry_backoff_ms` | number | `300000` | リトライの最大バックオフ間隔（ミリ秒）|
| `agent.max_concurrent_agents_by_state` | Record<string, number> | null | 状態別の同時実行数上限 |
