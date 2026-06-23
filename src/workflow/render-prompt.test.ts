import { expect, test } from "bun:test"
import type { Issue } from "../domain/types"
import { renderPrompt } from "./render-prompt"

function makeIssue(): Issue {
  return {
    id: "1",
    identifier: "tomoasleep/fairy#77",
    title: "Implement feature",
    description: "desc",
    priority: 1,
    state: "Backlog",
    repository: "tomoasleep/fairy",
    fields: {
      Team: "Core",
      "Target date": "2026-04-01",
    },
    url: null,
    labels: ["bug"],
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
    issueNodeId: "I_1",
  }
}

function makeScheduleIssue(): Issue {
  return {
    id: "schedule-daily-report",
    identifier: "schedule-daily-report",
    title: "Daily Report",
    description: "Generate daily report",
    priority: null,
    state: "scheduled",
    repository: null,
    fields: {},
    url: null,
    labels: [],
    blockedBy: [],
    createdAt: "2026-03-22T06:00:00.000Z",
    updatedAt: "2026-03-22T07:00:00.000Z",
    scheduledAt: "2026-03-22T06:00:00.000Z",
  }
}

test("prompt から issue.fields の追加 field を参照できる", async () => {
  const rendered = await renderPrompt(
    '{{ issue.identifier }} {{ issue.fields["Team"] }} {{ issue.fields["Target date"] }}',
    makeIssue(),
    1,
  )

  expect(rendered).toBe("tomoasleep/fairy#77 Core 2026-04-01")
})

test("prompt から issue.scheduledAt を参照できる", async () => {
  const rendered = await renderPrompt("{{ issue.scheduledAt }}", makeScheduleIssue(), null)

  expect(rendered).toBe("2026-03-22T06:00:00.000Z")
})
