export function normalizeState(value: string): string {
  return value.trim().toLowerCase()
}

export function sanitizeWorkspaceKey(identifier: string): string {
  return identifier.replace(/[^A-Za-z0-9._-]/g, "_")
}

export function parseList(input: unknown, fallback: string[]): string[] {
  if (Array.isArray(input)) {
    return input.map((item) => String(item).trim()).filter((item) => item.length > 0)
  }

  if (typeof input === "string") {
    return input
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
  }

  return fallback
}

export function toInt(input: unknown, fallback: number): number {
  if (typeof input === "number" && Number.isFinite(input)) {
    return Math.trunc(input)
  }

  if (typeof input === "string" && input.trim().length > 0) {
    const parsed = Number.parseInt(input, 10)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }

  return fallback
}

export function resolveRunnerKind(runner: string | null | undefined, exec: unknown): string | null {
  if (typeof runner === "string" && runner.trim().length > 0) {
    return runner.trim()
  }
  if (exec !== null && exec !== undefined) {
    return "exec"
  }
  return null
}
