# AGENTS.md

Automation agent for herdr-symphony - a Bun + TypeScript headless orchestrator around GitHub Projects and Herdr agent multiplexer.

## Project Overview

- Entry: `src/index.ts`
- CLI entry: `src/cli.ts`, bootstrap: `src/app.ts`
- Key modules: `src/config/`, `src/workflow/`, `src/orchestrator/`, `src/tracker/`, `src/runner/`, `src/herdr/`, `src/workspace/`
- Config file: `WORKFLOW.md` controls tracker fields, polling, agent concurrency, hooks, and work settings
- Agent execution and display are delegated to Herdr (no TUI)

## Commands

```bash
# Development
bun run dev              # Hot reload development
bun run start            # Run application

# Testing
bun test                 # Run all tests
bun test <pattern>       # Run specific test file(s)
bun test --watch         # Watch mode

# Type checking
bun run typecheck        # TypeScript type check (bunx tsc --noEmit)

# Linting & Formatting
bun run lint             # Check for linting issues
bun run lint:fix         # Auto-fix linting issues
bun run format           # Format code with Biome
bun run check            # Combined lint + format check
bun run check:fix        # Auto-fix all issues

# CLI (linked)
bun run link:dev         # Link CLI to ~/.local/bin/herdr-symphony
herdr-symphony --help    # Show CLI help
```

## Code Style

### TypeScript Configuration

- Target: ESNext, Module: Preserve (bundler mode)
- Strict mode enabled with `noUncheckedIndexedAccess`, `noImplicitOverride`

### Formatting (Biome)

- Indent: 2 spaces
- Line width: 100 characters
- Quotes: double quotes (`"`)
- Semicolons: as needed (omit when unnecessary)
- Use `biome format --write .` before commits

### Import Order

1. Node built-in modules (`import path from "node:path"`)
2. External packages (`import { describe, expect, test } from "bun:test"`)
3. Internal modules (`import { ... } from "../relative/path"`)
4. Type imports: always use `import type { ... }` for type-only imports

### Naming Conventions

- **Types/Interfaces**: PascalCase (`IssueTrackerClient`, `ServiceConfig`)
- **Classes**: PascalCase (`OrchestratorState`, `SymphonyService`)
- **Functions/Methods**: camelCase (`fetchCandidateIssues`, `moveIssueToState`)
- **Constants**: SCREAMING_SNAKE_CASE for true constants, camelCase otherwise
- **Private members**: prefix with underscore (`_private`) or use `#private`
- **Files**: kebab-case (`orchestrator.ts`, `herdr-client.ts`)

### Type Definitions

- Prefer `type` over `interface` for simple object shapes
- Use `interface` when defining contract-like structures
- Use `readonly` for immutable properties where appropriate
- Prefer explicit return types for public functions

### Error Handling

- Use custom error classes for domain errors (`WorkflowError` in `src/domain/errors.ts`)
- Always handle errors with try/catch in async functions
- Use `error instanceof Error` for type-safe error messages
- Let infrastructure errors propagate; catch at boundaries

### Testing (Bun Test)

- Test files: `*.test.ts` alongside source files
- Use `describe` for grouping, `test` for individual cases
- Use `expect(...).toBe(...)`, `expect(...).toEqual(...)` assertions
- Test helpers/fixtures go in `src/test-utils/`
- Mock external dependencies (Herdr CLI, gh CLI), not internal logic
- Create factory functions for test data (`makeConfig()`, `makeHerdrClient()`)

### Async Patterns

- Prefer async/await over `.then()` chains
- Use `Promise<void>` for fire-and-forget operations that should not block
- For concurrent operations: use `void` prefix for fire-and-forget: `void this.dispatch(issue)`

### Code Organization

- Domain types: `src/domain/types.ts`
- Domain errors: `src/domain/errors.ts`
- One module per file; group related modules in subdirectories
- Export all public API through index files when appropriate
- Keep functions small and focused; extract to helpers when needed

## Development Workflow

### TDD (Test-Driven Development)

This project follows t-wada style TDD. When implementing features or fixing bugs:

1. **Write failing test first** - Before implementation
2. **Write minimal code** - Just enough to pass the test
3. **Refactor** - Clean up while keeping tests green

### Comments

- **Do NOT leave comments explaining code intent or describing work**
- Code should be self-documenting through clear naming and structure
- Only use comments when strictly necessary (e.g. linking to external documentation)

### Defensive Coding

- Avoid unnecessary defensive code patterns
- Ask before adding extra null checks or validation layers
- Prefer explicit contracts over overly defensive programming

## Dependency Injection

Many modules accept a `deps` object for testability. Example:

```typescript
type ServiceDependencies = {
  tracker?: IssueTrackerClient
  runner?: Runner
  writeLog?: (line: string) => void
}

constructor(config: ServiceConfig, deps: ServiceDependencies = {}) {
  this.tracker = deps.tracker ?? createTrackerClient(config.tracker)
}
```

## Important Patterns

- **State management**: `Map` and `Set` for tracking state (see `OrchestratorState`)
- **Configuration**: Resolved at runtime from WORKFLOW.md (see `resolve-config.ts`)
- **Runners**: Abstracted via `Runner` interface; HerdrAgentRunner delegates to Herdr CLI
- **HerdrClient**: Wraps `herdr` CLI commands via `CommandRunner` DI for testability

## Running Verification

Before claiming work is complete:

```bash
bun run typecheck
bun test
bun run check
```

Verify all pass successfully before submitting changes.
