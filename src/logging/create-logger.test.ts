import { describe, expect, test } from "bun:test"
import { createLogger } from "./create-logger"
import type { LogLevel } from "./types"

type Entry = { level: LogLevel; line: string }

function makeSink(): { entries: Entry[]; sink: (level: LogLevel, line: string) => void } {
  const entries: Entry[] = []
  return {
    entries,
    sink: (level, line) => entries.push({ level, line }),
  }
}

describe("createLogger", () => {
  test("minLevel=info で debug はフィルタされる", () => {
    const { entries, sink } = makeSink()
    const logger = createLogger({ minLevel: "info", sink })

    logger.debug("debug-line")

    expect(entries).toEqual([])
  })

  test("minLevel=info で info/warn/error は出力される", () => {
    const { entries, sink } = makeSink()
    const logger = createLogger({ minLevel: "info", sink })

    logger.info("info-line")
    logger.warn("warn-line")
    logger.error("error-line")

    expect(entries).toEqual([
      { level: "info", line: "info-line" },
      { level: "warn", line: "warn-line" },
      { level: "error", line: "error-line" },
    ])
  })

  test("minLevel=debug で全レベルが出力される", () => {
    const { entries, sink } = makeSink()
    const logger = createLogger({ minLevel: "debug", sink })

    logger.debug("d")
    logger.info("i")
    logger.warn("w")
    logger.error("e")

    expect(entries).toEqual([
      { level: "debug", line: "d" },
      { level: "info", line: "i" },
      { level: "warn", line: "w" },
      { level: "error", line: "e" },
    ])
  })

  test("minLevel=warn で warn/error のみ出力される", () => {
    const { entries, sink } = makeSink()
    const logger = createLogger({ minLevel: "warn", sink })

    logger.debug("d")
    logger.info("i")
    logger.warn("w")
    logger.error("e")

    expect(entries).toEqual([
      { level: "warn", line: "w" },
      { level: "error", line: "e" },
    ])
  })

  test("sink に level と line が正しく渡る", () => {
    const { entries, sink } = makeSink()
    const logger = createLogger({ minLevel: "debug", sink })

    logger.warn("multiline\nline")

    expect(entries).toEqual([{ level: "warn", line: "multiline\nline" }])
  })
})
