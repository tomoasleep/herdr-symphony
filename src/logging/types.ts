export type LogLevel = "debug" | "info" | "warn" | "error"

export interface Logger {
  debug(line: string): void
  info(line: string): void
  warn(line: string): void
  error(line: string): void
}
