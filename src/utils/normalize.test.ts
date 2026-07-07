import { describe, expect, test } from "bun:test"
import { sanitizeAgentName, sanitizeWorkspaceKey } from "./normalize"

describe("sanitizeWorkspaceKey", () => {
  test("alphanumeric と . _ - はそのまま残す", () => {
    expect(sanitizeWorkspaceKey("ABC-123_x.yml")).toBe("ABC-123_x.yml")
  })

  test("許容外の文字は _ に置換する", () => {
    expect(sanitizeWorkspaceKey("tomoasleep/herdr-symphony#1")).toBe("tomoasleep_herdr-symphony_1")
  })
})

describe("sanitizeAgentName", () => {
  test("agmsg が許容する文字 (A-Za-z0-9 _ -) はそのまま残す", () => {
    expect(sanitizeAgentName("TEST-1_workflow-ly02lc00")).toBe("TEST-1_workflow-ly02lc00")
  })

  test(". は _ に置換する", () => {
    expect(sanitizeAgentName("e2e.test.claude")).toBe("e2e_test_claude")
  })

  test('/ \\ " [ ] は _ に置換する', () => {
    expect(sanitizeAgentName('a/b\\c"d[e]f')).toBe("a_b_c_d_e_f")
  })

  test("制御文字は _ に置換する", () => {
    expect(sanitizeAgentName("a\tb\nc")).toBe("a_b_c")
  })

  test("先頭の - は _ に置換する", () => {
    expect(sanitizeAgentName("-agent")).toBe("_agent")
  })

  test("GitHub issue identifier を含む名前をサニタイズする (# は保持する)", () => {
    expect(sanitizeAgentName("tomoasleep/herdr-symphony#1-e2e.test.claude-ly02lc00")).toBe(
      "tomoasleep_herdr-symphony#1-e2e_test_claude-ly02lc00",
    )
  })
})
