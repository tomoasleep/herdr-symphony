# AGENTS.md

herdr-symphony — a Bun + TypeScript headless orchestrator that polls GitHub Projects (or file/schedule trackers), dispatches issues to `opencode` agents via the Herdr CLI, and manages worktrees via `gwq`.

## Commands

```bash
bun install             # Setup
bun run dev             # Hot reload (runs src/index.ts)
bun run start           # Run once

bun test                # All unit/integration tests
bun test <pattern>      # Specific test(s), e.g. `bun test src/orchestrator`
bun test --watch        # Watch mode
bun run test:e2e        # E2E tests only (bun test src/e2e)

bun run typecheck       # tsc --noEmit
bun run lint            # biome lint .
bun run check           # biome check . (lint + format)
bun run check:fix       # Auto-fix all

bun run link:dev        # Symlink CLI to ~/.local/bin/herdr-symphony
```

**Verification before claiming work is complete:**

```bash
bun run typecheck && bun test && bun run check
```

Run all three. E2E tests (`bun run test:e2e`) are optional — they auto-skip when the `herdr` binary is absent, and require `tuistory` + `@copilotkit/aimock` to run.

## Architecture

Entry chain: `bin/herdr-symphony` → `src/cli.ts` (`runCli`) → `src/app.ts` (`startHerdrSymphony`) → `src/service.ts` (`SymphonyService`).

Per poll tick, `SymphonyService.refresh()`:
1. Processes due retries → reconciles running issues against tracker
2. Fetches candidate issues from tracker
3. `OrchestratorState.dispatchable()` filters by concurrency, state, blockers
4. Dispatches each via `SymphonyService.dispatch()`: move to running state → resolve runtime config → ensure workspace → render Liquid prompt → `Runner.runIssue()` → finalize state → report

**Key modules:**
- `src/orchestrator/` — `OrchestratorState` (running/retry/stopped tracking), `GlobalClaimRegistry` (prevents double-dispatch across multiple workflow files), `scheduling.ts` (retry backoff)
- `src/config/schema.ts` — Zod schema resolving WORKFLOW.md frontmatter into `ServiceConfig`
- `src/tracker/` — `github_project` (via `gh`), `file`, `schedule` (cron) tracker implementations behind `IssueTrackerClient`
- `src/runner/herdr-agent/` — `HerdrAgentRunner` shells out to `herdr agent start` → `opencode run`, polls `herdr agent get` until done/blocked
- `src/herdr/herdr-client.ts` — wraps all `herdr` CLI subcommands; injectable via `CommandRunner` for tests
- `src/workspace/workspace-manager.ts` — `gwq` or `git` worktree providers
- `src/storage/` — SQLite persistence at `.workaholic/db.sqlite3` (path is historical, not a typo)
- `src/workflow/` — `loadWorkflow` (gray-matter frontmatter + prompt body), `render-prompt` (Liquid), `render-frontmatter` (Liquid for config values)

## Workflow Configuration

`WORKFLOW.md` is frontmatter (config) + body (Liquid prompt template). Config keys use snake_case (`active_states`, `max_concurrent_agents`, `turn_timeout_ms`). Prompt body is rendered per-issue with `issue` and `attempt` in scope.

**Liquid engine runs in strict mode** (`strictFilters`, `strictVariables`): undefined variables and failed filters throw `WorkflowError`. This applies to both prompt rendering and config string values like `branch`, `model`, `workspace_label`.

## TypeScript Constraints

- **`verbatimModuleSyntax: true`** — always use `import type` for type-only imports. `typecheck` will fail otherwise.
- **`noUncheckedIndexedAccess: true`** — array/object index access returns `T | undefined`.
- **`noImplicitOverride: true`** — use `override` keyword.
- Biome scope is limited to `src/**/*.ts` and `package.json` (see `biome.jsonc`). Files outside `src/` are not linted/formatted.
- `style/noNonNullAssertion` is **off** — non-null assertions (`!`) are allowed.

## Testing & Dependency Injection

Test files (`*.test.ts`) sit alongside source. Most classes accept a `deps` object for overriding collaborators:

```typescript
constructor(config: ServiceConfig, deps: ServiceDependencies = {}) {
  this.tracker = deps.tracker ?? createTrackerClient(config.tracker)
}
```

When adding a class that touches external CLIs or I/O, follow this pattern. Mock the boundary (`HerdrClient`, `CommandRunner`, `IssueTrackerClient`), never internal logic. Use factory functions (`makeConfig()`, `makeHerdrClient()`) in tests.

E2E tests (`src/e2e/`) drive a real Herdr server via `tuistory` terminal automation and use `@copilotkit/aimock` as a mock LLM endpoint. They create isolated Herdr instances under `/tmp/hdr-*` with custom socket paths. Snapshot output is normalized via `normalizeOutput()` (replaces timestamps, temp paths, pane IDs).

## Development Workflow

Follow **t-wada style TDD**: write a failing test first, implement the minimum to pass, then refactor.

**Do not add comments** explaining code intent or describing work. Code should be self-documenting. Only comment when strictly necessary (e.g., linking to external docs).

Avoid unnecessary defensive code. Ask before adding extra null checks or validation layers beyond what the contract requires.

## External Dependencies

The orchestrator shells out to several CLIs at runtime: `herdr` (agent multiplexer), `opencode` (AI agent), `gwq` (worktree manager), `gh` (GitHub). Tests mock these via DI. The `herdr` CLI returns JSON envelopes on stdout — see `parseEnvelope()` in `herdr-client.ts`.
