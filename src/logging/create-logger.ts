import type { Logger, LogLevel } from "./types"

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

export function createLogger(options: {
  minLevel: LogLevel
  sink: (level: LogLevel, line: string) => void
}): Logger {
  const threshold = LEVEL_PRIORITY[options.minLevel]
  const gate = (level: LogLevel): boolean => LEVEL_PRIORITY[level] >= threshold

  return {
    debug: (line) => {
      if (gate("debug")) options.sink("debug", line)
    },
    info: (line) => {
      if (gate("info")) options.sink("info", line)
    },
    warn: (line) => {
      if (gate("warn")) options.sink("warn", line)
    },
    error: (line) => {
      if (gate("error")) options.sink("error", line)
    },
  }
}
