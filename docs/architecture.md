# Architecture

## reconciliation loop の基本原則

`SymphonyService.refresh()` は **短い micro task を高速に順次実行** する。各ポーリング tick（`polling.intervalMs`、デフォルト30秒）で以下を一巡する。

1. `processDueRetries()` — due になった retry を claim 解放
2. `reconcileRunning()` — tracker の state 再確認 + **起動中 dispatch の完了チェック**
3. `fetchCandidateIssues()` — tracker から候補取得
4. `dispatchable()` — concurrency / state / blocker で絞り込み
5. `dispatch()` — 各 issue を runner に **起動（送出）のみ**

各ステップは即座に戻る、あるいは tracker API 呼び出し程度の micro task で終わる。**いかなるステップも runner の実行完了を待ってはならない。**

## dispatch（起動）と完了監視の分離

### dispatch は起動のみ

`dispatch()` の責務は「issue を runner に送出すること」のみ。

- `moveToRunningState` → `markRunning` → `resolveRuntimeConfig` → `ensureWorkspace` → `beforeRun` hook → `renderPrompt` → messenger 設定 → `runner.startIssue()`
- `startIssue()` が `RunnerHandle` を返した時点で dispatch は完了（即座に戻る）
- finalize / reporter / state release / `afterRun` hook は **dispatch に含めない**

### 完了監視は reconcile に統合

タスクの完了検知・finalize・reporter・state release は `reconcileRunning()` が担う。

- 各 running entry の `RunnerHandle` に対して `runner.pollCompletion(handle)` を呼ぶ
- `pollCompletion` は1回の状態チェックをして即座に戻る（ループしない）
- `{ state: "running" }` なら維持、`{ state: "done", result }` なら完了後処理（finalize / reporter / release / afterRun）を実行

これにより、reconciliation loop はどの dispatch の完了待ちでもブロックされない。

### RunnerHandle / pollCompletion

```ts
type RunnerHandle = { sessionId: string; issueId: string }

type RunnerPollResult =
  | { state: "running" }
  | { state: "done"; result: RunnerResult }
```

`Runner.startIssue(issue, options)` は起動のみを担い、`RunnerHandle` を返す。`Runner.pollCompletion(handle)` は1回の状態チェックを行い、完了していなければ `{ state: "running" }`、完了していれば `{ state: "done", result }` を返す。report_file messenger の reminder 送信等も `pollCompletion` 内で行う。

## waitForDispatches の位置づけ

`waitForDispatches()` は `pendingDispatches`（起動中の dispatch Promise 群）が空になるまで待つ。dispatch が起動のみを担うため、これは「起動完了待ち」として軽量。起動時（`app.ts`）に dispatch が起動したことを確認する正当な用途で呼ばれ、ブロックしない。
