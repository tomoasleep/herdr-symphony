import { describe, expect, test } from "bun:test"
import { parseOpencodeMajorVersion } from "./opencode-version"

describe("parseOpencodeMajorVersion", () => {
  test("opencode v2.2.5 形式をパースできる", () => {
    expect(parseOpencodeMajorVersion("opencode v2.2.5\n")).toBe(2)
  })

  test("バージョンのみの形式をパースできる", () => {
    expect(parseOpencodeMajorVersion("1.17.13\n")).toBe(1)
  })

  test("パースできない場合は null を返す", () => {
    expect(parseOpencodeMajorVersion("command not found")).toBe(null)
  })
})
