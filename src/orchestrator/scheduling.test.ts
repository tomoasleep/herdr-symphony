import { describe, expect, test } from "bun:test"
import { computeFailureBackoffMs, hasOpenTodoBlocker, sortIssues } from "./scheduling"

describe("computeFailureBackoffMs", () => {
  test("retry backoff を指数で計算する", () => {
    expect(computeFailureBackoffMs(1, 300_000)).toBe(10_000)
    expect(computeFailureBackoffMs(2, 300_000)).toBe(20_000)
    expect(computeFailureBackoffMs(10, 300_000)).toBe(300_000)
  })
})

describe("hasOpenTodoBlocker", () => {
  test("todo の blocker が未完了なら dispatch 不可", () => {
    const blocked = hasOpenTodoBlocker(
      {
        id: "1",
        identifier: "A-1",
        title: "t",
        description: null,
        priority: 1,
        state: "Todo",
        repository: null,
        fields: {},
        url: null,
        labels: [],
        blockedBy: [{ id: "b", identifier: "B-1", state: "In Progress" }],
        createdAt: null,
        updatedAt: null,
      },
      ["Todo"],
      "In Progress",
    )

    expect(blocked).toBeTrue()
  })
})

describe("sortIssues", () => {
  test("issue を priority -> created_at -> identifier でソートする", () => {
    const sorted = sortIssues([
      {
        id: "2",
        identifier: "B-2",
        title: "b",
        description: null,
        priority: 2,
        state: "Todo",
        repository: null,
        fields: {},
        url: null,
        labels: [],
        blockedBy: [],
        createdAt: "2026-01-02T00:00:00Z",
        updatedAt: null,
      },
      {
        id: "1",
        identifier: "A-1",
        title: "a",
        description: null,
        priority: 1,
        state: "Todo",
        repository: null,
        fields: {},
        url: null,
        labels: [],
        blockedBy: [],
        createdAt: "2026-01-03T00:00:00Z",
        updatedAt: null,
      },
    ])

    expect(sorted.map((item) => item.identifier)).toEqual(["A-1", "B-2"])
  })
})
