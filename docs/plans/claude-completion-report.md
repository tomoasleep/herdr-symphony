# Claude の完了判定: 報告 sub command + リマインド方式

## 背景・現象

Claude Code をインタラクティブモード（`claude "prompt"`、`--print` なし）で herdr 上に起動すると、Claude が1ターン完了して ❯ プロンプトに戻った時、バックグラウンドシェル（dev server、watch build 等）がまだ動いていても herdr は `idle` 判定する（`live_prompt_box` ルールが `❯` にマッチ）。現状の `waitForAgentCompletion` は sawActive + idle で即完了するため、バックグラウンドシェルが残っているのに release → 再 dispatch されてしまう。

herdr の `pane.report_agent` で Claude の state を公式に報告する経路は存在しない（`source: "herdr:claude"` は reserved で state が無視される）。カスタム source の workaround は stale state リスクがある。

## 方針

Claude（`agentKind === "claude"`）の場合のみ、以下の仕組みで完了判定を行う:

1. **完了レポート送信を指示**: プロンプトで Claude に完了時に `herdr-symphony report` コマンドを実行させて報告
2. **未送信で idle 時はリマインド**: `waitForAgentCompletion` が idle を検知した時、報告が未送信なら `herdr agent send` で Claude に「完了か未完了か報告するよう」リマインドを送る
3. **報告送信で完了**: 報告ファイルを検知したら完了。未送信なら再度 idle になるまで待機し、リマインドを反復（上限なし、`turnTimeoutMs` で制御）

opencode は従来通り（idle/done 完了判定）。Claude 専用の仕組み。

## フロー

```
dispatch(issue)  [agentKind === "claude" の場合]
  ├─ 報告パスを生成: {workspacePath}/.herdr-symphony-report.json
  ├─ 前回の報告ファイルを削除（クリーンアップ）
  ├─ プロンプト末尾に完了報告指示を append
  ├─ herdr agent start で env: HERDR_SYMPHONY_REPORT_PATH=<報告パス> を注入
  ├─ runner.runIssue(issue, { reportPath, ... })
  │    ├─ Claude 起動（環境変数 HERDR_SYMPHONY_REPORT_PATH を持つ）
  │    ├─ waitForAgentCompletion [Claude 専用ロジック]:
  │    │    poll loop:
  │    │      getAgent → state 確認
  │    │      working/blocked → sawActive=true、継続
   │    │      idle → 報告ファイル確認:
   │    │        done/failed → 完了（return "idle"）
  │    │        pending → 待機継続（sawActive=false にリセット）
  │    │        報告なし → herdr agent send でリマインド送信、sawActive=false
  │    └─ 報告ファイルを読み、RunnerResult を生成
   │         status="done" → succeeded（summary を responseText に設定）
   │         status="failed" → failed（summary を error に設定）
  └─ release

Claude がタスクを完了した時:
  Claude が herdr-symphony report --status done --summary "<summary>" を実行
  → 報告ファイルが done で書き込まれる
  → 次の idle 判定で waitForAgentCompletion が完了

Claude がバックグラウンドシェルを残して ❯ に戻った時（pending 報告）:
  Claude 自ら herdr-symphony report --status pending --summary "<summary>" を実行
  → 報告ファイルが pending で書き込まれる
  → waitForAgentCompletion が idle + pending を検知 → 待機継続（リマインド不要）
   → バックグラウンドシェル完了後、Claude が --status done で再報告
  → waitForAgentCompletion が完了

Claude が報告せずに ❯ に戻った時（報告なし）:
  報告ファイルなし → waitForAgentCompletion がリマインド送信
   → Claude がリマインドを受けて done または pending で報告
```

**pending 報告のポイント**: Claude 側から能動的に待機状況を報告してもらうことで、リマインド無しで待機継続できる。報告なし（Claude が ❯ に戻ったが報告を忘れた）の場合のみリマインドが飛ぶ。

## 実装ステップ（TDD）

### 1. 報告モジュール作成（`src/report/write-report.ts`）

#### `src/report/write-report.ts` — 報告ファイル書き込み

```ts
import { readFileSync, writeFileSync } from "node:fs"

export type ReportStatus = "done" | "pending" | "failed"

export type ReportEntry = {
  status: ReportStatus
  summary: string  // 作業内容の要約（Claude が記入）
  timestamp: string
}

export function writeReport(path: string, status: ReportStatus, summary: string): void {
  const entry: ReportEntry = { status, summary, timestamp: new Date().toISOString() }
  writeFileSync(path, JSON.stringify(entry))
}

export function readReport(path: string): ReportEntry | null {
  try {
    const raw = readFileSync(path, "utf8")
    const parsed = JSON.parse(raw) as Partial<ReportEntry>
    if (
      parsed.status !== "done" &&
      parsed.status !== "failed" &&
      parsed.status !== "pending"
    ) {
      return null
    }
    if (typeof parsed.summary !== "string") {
      return null
    }
    return {
      status: parsed.status,
      summary: parsed.summary,
      timestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : "",
    }
  } catch {
    return null
  }
}
```

#### テスト（`src/report/write-report.test.ts`）

- `writeReport` が JSON ファイルを書き込む（done/pending/failed 各ステータス）
- `readReport` がファイル不存在で null を返す
- `readReport` が壊れた JSON で null を返す
- 上書き保存できる（2回目の writeReport で最新が読める）

### 2. CLI に `report` sub command を追加（`src/cli.ts`）

```ts
if (parsed.report) {
  const reportPath = env.HERDR_SYMPHONY_REPORT_PATH
  if (!reportPath) {
    write("HERDR_SYMPHONY_REPORT_PATH が設定されていません\n")
    return 1
  }
  if (!parsed.reportSummary) {
    write("--summary は必須です\n")
    return 1
  }
  writeReport(reportPath, parsed.reportStatus, parsed.reportSummary)
  return 0
}
```

`parseArgs` で `report` を判定。`--status`、`--summary` を解析。

#### テスト（`src/cli.test.ts` または新規ファイル）

- `herdr-symphony report --status done --summary "作業内容"` で HERDR_SYMPHONY_REPORT_PATH に summary を含む JSON が書き込まれる
- `--summary` 未指定時は exit code 1
- HERDR_SYMPHONY_REPORT_PATH 未設定時は exit code 1

### 3. `RunnerOptions` に `reportPath` を追加（`src/runner/types.ts`）

```ts
export type RunnerOptions = {
  // ...既存...
  reportPath?: string
}
```

### 4. `HerdrAgentRunner` の変更（`src/runner/herdr-agent/herdr-agent-runner.ts`）

#### `startAgent` に env 注入

```ts
const agent = await this.client.startAgent(agentName, {
  workspaceId: workspace.id,
  cwd: options.workspacePath,
  argv,
  env: options.reportPath
    ? { HERDR_SYMPHONY_REPORT_PATH: options.reportPath }
    : undefined,
})
```

#### `waitForAgentCompletion` に報告確認 + リマインドを追加（Claude の場合）

現在の idle 完了判定:
```ts
if (info.state === "idle") {
  if (sawActive) return "idle"
}
```

変更後（Claude で reportPath がある場合）:
```ts
if (info.state === "idle") {
  if (sawActive) {
    if (options.agentKind === "claude" && options.reportPath) {
      const report = readReport(options.reportPath)
      if (report?.status === "done" || report?.status === "failed") {
        return "idle"  // 完了 or 失敗
      }
      if (report?.status === "pending") {
        sawActive = false  // バックグラウンドタスク実行中、待機継続
        continue
      }
      // 報告なし → リマインド送信
      await this.client.sendInput(target, REMINDER_TEXT)
      sawActive = false
      continue
    }
    return "idle"  // opencode または reportPath なし → 従来通り
  }
}
```

`REMINDER_TEXT`:
```
タスクは完了しましたか？完了した場合は herdr-symphony report --status done --summary "やった作業の要約" を実行してください。バックグラウンドタスクがまだ動いている場合は herdr-symphony report --status pending --summary "やった作業の要約" を実行してください。失敗した場合は herdr-symphony report --status failed --summary "失敗理由" を実行してください。
```

#### `runIssue` で報告内容を RunnerResult に反映

```ts
const waitState = await this.waitForAgentCompletion(target, timeoutMs, onBlocked, options)

if (waitState === null) return { status: "timeout", error: `agent timed out after ${timeoutMs}ms`, responseText: null }
if (waitState === "blocked") return { status: "failed", error: "agent is blocked, needs operator input", responseText: null }

if (options.reportPath) {
  const report = readReport(options.reportPath)
  if (report?.status === "failed") {
    return { status: "failed", error: report.summary || "reported as failed", responseText: null }
  }
  if (report?.status === "done" && report.summary) {
    return { status: "succeeded", error: null, responseText: report.summary }
  }
}

// フォールバック: reportResolver / readAgent（報告に summary がない場合）
```

報告の `summary` を `RunnerResult.responseText` に設定。これにより既存の reporter フロー（`appendAgentLog` → AGENTLOGS.local.md、`updateItemDescription` → Issue description）に作業内容が記録される。報告に summary がない場合は従来の `reportResolver`（Claude の JSONL から最終 assistant message を抽出）にフォールバック。

#### テスト（`src/runner/herdr-agent/herdr-agent-runner.test.ts`）

- `reportPath があり報告ファイルが done + summary の場合、idle で完了し responseText に summary が入る`
- `reportPath があるが報告ファイルがない場合、idle でリマインドを送信し継続する`
- `報告ファイルが failed + summary の場合、failed ステータスで error に summary が入る`
- `reportPath がない（opencode）場合は従来通り idle で完了する`
- `pending の報告がある場合、リマインドせず待機継続する`

### 5. `service.ts` dispatch で報告パス生成・注入・プロンプト追加

```ts
// dispatch 内
let content = await this.renderPromptFn(this.template, runtimeConfig.issue, null)

let reportPath: string | undefined
if (runtimeConfig.runner.agent === "claude") {
  reportPath = path.join(workspace.path, ".herdr-symphony-report.json")
  fs.rmSync(reportPath, { force: true })  // クリーンアップ
  content = `${content}\n\n${REPORT_INSTRUCTION}`
}

const result = await this.runner.runIssue(runtimeConfig.issue, {
  content,
  // ...既存...
  reportPath,
})
```

`REPORT_INSTRUCTION`:
```
## 完了報告

タスクが完了したら、以下のコマンドを実行してください（<summary> にはやった作業の要約を入れてください）:

    herdr-symphony report --status done --summary "<summary>"

バックグラウンドタスク（dev server、watch build 等）がまだ動いている場合は、代わりに以下を実行してください:

    herdr-symphony report --status pending --summary "<summary>"

バックグラウンドタスクが完了したら、改めて done で要約を添えて報告してください。
```

**summary の活用**: 報告された summary は `RunnerResult.responseText` に設定され、既存の reporter フロー（`work.reporter` 設定に応じて `appendAgentLog` → AGENTLOGS.local.md、`updateItemDescription` → tracker の description）に流れる。Claude の作業内容が Issue ログとして記録される。

#### テスト（`src/service.test.ts`）

- Claude の場合、reportPath が RunnerOptions に渡る
- Claude の場合、プロンプトに報告指示が append される
- opencode の場合、reportPath が undefined

### 6. HerdrClient の `sendInput` の動作確認

`herdr agent send <target> <text>` が pane にテキストを送信することを確認。Claude が ❯ 待機中なら新しいユーザー入力として処理される。既存の `sendInput` メソッド（`herdr-client.ts:262`）を使用。

## 影響範囲

- **Claude（`agentKind === "claude"`）の場合のみ新ロジック**: opencode は従来通り
- **プロンプトに報告指示が追加**: Claude の場合のみ。プロンプト末尾に append
- **環境変数 `HERDR_SYMPHONY_REPORT_PATH`**: `herdr agent start --env` で Claude プロセスに注入
- **報告ファイル**: `{workspacePath}/.herdr-symphony-report.json`。dispatch 開始時にクリーンアップ
- **新 CLI sub command**: `herdr-symphony report --status done|pending|failed --summary <text>`。`bin/herdr-symphony` 経由で実行可能
- **waitForAgentCompletion の挙動変更**: Claude + reportPath の場合のみ。idle で即完了せず、報告確認 + リマインド
- **RunnerResult.responseText**: 報告の summary を優先。フォールバックとして reportResolver / readAgent

## スコープ外

- **opencode の完了判定**: 従来通り（idle/done 完了）。opencode は lifecycle plugin で正確に状態報告するため
- **paneId 保持（setSessionId 復活）**: 別件。今回は完了判定のみ対応
- **agent name の timestamp 付与の見直し**: 別件。完了判定が正しくなれば、release 後の再 dispatch で重複しなくなる可能性が高い
- **リマインドの反復回数上限**: なし（`turnTimeoutMs` で制御）。必要になれば別途追加

## 受け入れ基準

1. `herdr-symphony report --status done --summary "..."` で報告ファイルが書き込まれる
2. Claude の場合、報告ファイルがある時のみ idle 完了する
3. Claude の場合、報告ファイルがない時は idle でリマインドを送信し継続する
4. Claude の場合、pending 報告がある時はリマインドせず待機継続する
5. 報告の summary が RunnerResult.responseText に設定される
6. opencode は従来通り idle/done で完了する
7. `bun test` が通る
8. `bun run typecheck` が通る
9. `bun run check` が通る

### 検証コマンド

```bash
bun test src/report/
bun test src/runner/herdr-agent/herdr-agent-runner.test.ts
bun test src/service.test.ts
bun run typecheck
bun run check
bun test
```

### シナリオ例（手動確認用）

**シナリオ1: バックグラウンドシェル残しで ❯ に戻る（pending 報告）**
1. Claude が `bun run dev` 等をバックグラウンド起動して ❯ に戻る
2. Claude が `herdr-symphony report --status pending --summary "dev server 起動中"` を実行
3. waitForAgentCompletion が idle + pending を検知 → 待機継続（リマインドなし）
4. バックグラウンドシェル完了後、Claude が `herdr-symphony report --status done --summary "実装完了"` を実行
5. waitForAgentCompletion が完了 → release。summary が Issue ログに記録される

**シナリオ2: 報告せずに ❯ に戻る（リマインド）**
1. Claude が報告せずに ❯ に戻る
2. waitForAgentCompletion が idle + 報告なし を検知 → リマインド送信
3. Claude がリマインドを受けて done または pending で報告
4. 報告に応じて完了または待機継続

**シナリオ3: 即完了**
1. Claude がタスクを完了して `herdr-symphony report --status done --summary "実装完了"` を実行
2. waitForAgentCompletion が idle + done を検知 → 完了。summary が Issue ログに記録される

いずれのシナリオでも、Claude が working 中に別 agent が起動されないことを確認。
