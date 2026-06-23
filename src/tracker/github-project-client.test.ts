import { expect, test } from "bun:test"
import { GitHubProjectClient, normalizeProjectItem } from "./github-project-client"

test("DraftIssue は project item URL を生成する", () => {
  const normalized = normalizeProjectItem(
    {
      id: "PVTI_x",
      databaseId: 162101853,
      content: {
        __typename: "DraftIssue",
        id: "DI_x",
        title: "Draft Task",
        body: "draft body",
      },
      fieldValues: {
        nodes: [{ field: { name: "Status" }, name: "Backlog" }],
      },
    },
    "https://github.com/users/tomoasleep/projects/4",
  )

  expect(normalized.url).toBe(
    "https://github.com/users/tomoasleep/projects/4?pane=issue&itemId=162101853",
  )
  expect(normalized.identifier).toBe("draft:162101853")
})

test("Issue は labels と blockedBy を取り込む", () => {
  const normalized = normalizeProjectItem(
    {
      id: "PVTI_y",
      databaseId: 200,
      content: {
        __typename: "Issue",
        id: "I_123",
        number: 77,
        title: "Implement",
        body: "desc",
        state: "OPEN",
        url: "https://github.com/tomoasleep/fairy/issues/77",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-02T00:00:00Z",
        repository: { nameWithOwner: "tomoasleep/fairy" },
        labels: { nodes: [{ name: "Bug" }, { name: "P0" }] },
        blockedBy: {
          nodes: [
            {
              id: "I_9",
              number: 9,
              title: "deps",
              state: "OPEN",
              repository: { nameWithOwner: "tomoasleep/fairy" },
            },
          ],
        },
      },
      fieldValues: {
        nodes: [
          { field: { name: "Status" }, name: "In progress" },
          { field: { name: "Priority" }, name: "P1" },
          { field: { name: "Repository" }, text: "/repos/fairy" },
          { field: { name: "Worktree" }, text: "issue-77" },
          { field: { name: "Team" }, text: "Core" },
          { field: { name: "Target date" }, date: "2026-04-01" },
        ],
      },
    },
    "https://github.com/users/tomoasleep/projects/4",
  )

  expect(normalized.identifier).toBe("tomoasleep/fairy#77")
  expect(normalized.labels).toEqual(["bug", "p0"])
  expect(normalized.blockedBy).toEqual([
    {
      id: "I_9",
      identifier: "tomoasleep/fairy#9",
      state: "OPEN",
    },
  ])
  expect(normalized.priority).toBe(2)
  expect(normalized.repository).toBe("tomoasleep/fairy")
  expect(normalized.fields).toEqual({
    Status: "In progress",
    Priority: "P1",
    Repository: "/repos/fairy",
    Worktree: "issue-77",
    Team: "Core",
    "Target date": "2026-04-01",
  })
})

test("DraftIssue でも追加 field を issue.fields から参照できる", () => {
  const normalized = normalizeProjectItem(
    {
      id: "PVTI_z",
      databaseId: 201,
      content: {
        __typename: "DraftIssue",
        id: "DI_z",
        title: "Task",
        body: null,
      },
      fieldValues: {
        nodes: [
          { field: { name: "Status" }, name: "Backlog" },
          { field: { name: "Repository" }, text: "/tmp/repo" },
          { field: { name: "Worktree" }, text: "wt-1" },
          { field: { name: "Target date" }, date: "2026-05-20" },
        ],
      },
    },
    "https://github.com/users/tomoasleep/projects/4",
  )

  expect(normalized.repository).toBeNull()
  expect(normalized.fields).toEqual({
    Status: "Backlog",
    Repository: "/tmp/repo",
    Worktree: "wt-1",
    "Target date": "2026-05-20",
  })
})

test("fetchCandidateIssues は state でフィルタせず全件返す", async () => {
  const client = new GitHubProjectClient(
    {
      kind: "github_project",
      github_project: {
        owner: "@me",
        number: 4,
      },
      file: null,
      schedule: null,
    },
    async (query) => {
      if (query.includes("viewer")) {
        return {
          data: {
            viewer: { login: "tomoasleep" },
          },
        }
      }

      return {
        data: {
          repositoryOwner: {
            projectV2: {
              url: "https://github.com/users/tomoasleep/projects/4",
              items: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    id: "PVTI_a",
                    databaseId: 1,
                    content: { __typename: "DraftIssue", title: "A", body: null },
                    fieldValues: { nodes: [{ field: { name: "Status" }, name: "Backlog" }] },
                  },
                  {
                    id: "PVTI_b",
                    databaseId: 2,
                    content: { __typename: "DraftIssue", title: "B", body: null },
                    fieldValues: { nodes: [{ field: { name: "Status" }, name: "Done" }] },
                  },
                ],
              },
            },
          },
        },
      }
    },
  )

  const issues = await client.fetchCandidateIssues()
  expect(issues.map((item) => item.id)).toEqual(["PVTI_a", "PVTI_b"])
})

test("fetchCandidateIssues は noTui ログに tracker 操作を出す", async () => {
  const writes: string[] = []
  const client = new GitHubProjectClient(
    {
      kind: "github_project",
      github_project: {
        owner: "@me",
        number: 4,
      },
      file: null,
      schedule: null,
    },
    async (query) => {
      if (query.includes("viewer")) {
        return {
          data: {
            viewer: { login: "tomoasleep" },
          },
        }
      }

      return {
        data: {
          repositoryOwner: {
            projectV2: {
              url: "https://github.com/users/tomoasleep/projects/4",
              items: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [],
              },
            },
          },
        },
      }
    },
    (line: string) => {
      writes.push(line)
    },
  )

  await client.fetchCandidateIssues()

  expect(writes.join("\n")).toContain("tracker resolveOwner @me")
  expect(writes.join("\n")).toContain("tracker query operation=viewer")
  expect(writes.join("\n")).toContain("tracker query operation=project_items after=start")
  expect(writes.join("\n")).toContain("tracker items page count=0 hasNextPage=false")
})

test("organization owner でも project items を取得できる", async () => {
  const client = new GitHubProjectClient(
    {
      kind: "github_project",
      github_project: {
        owner: "my-org",
        number: 7,
      },
      file: null,
      schedule: null,
    },
    async () => ({
      data: {
        repositoryOwner: {
          projectV2: {
            url: "https://github.com/orgs/my-org/projects/7",
            items: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  id: "PVTI_org",
                  databaseId: 9,
                  content: { __typename: "DraftIssue", title: "Org Task", body: null },
                  fieldValues: { nodes: [{ field: { name: "Status" }, name: "Backlog" }] },
                },
              ],
            },
          },
        },
      },
    }),
  )

  const issues = await client.fetchCandidateIssues()
  expect(issues[0]?.url).toBe("https://github.com/orgs/my-org/projects/7?pane=issue&itemId=9")
})

test("moveIssueToState は Status option を解決して project item を更新する", async () => {
  const calls: Array<{ query: string; variables: Record<string, string | number> }> = []
  const client = new GitHubProjectClient(
    {
      kind: "github_project",
      github_project: {
        owner: "@me",
        number: 4,
      },
      file: null,
      schedule: null,
    },
    async (query, variables) => {
      calls.push({ query, variables })

      if (query.includes("viewer")) {
        return {
          data: {
            viewer: { login: "tomoasleep" },
          },
        }
      }

      if (query.includes("fields(first:50)")) {
        return {
          data: {
            repositoryOwner: {
              projectV2: {
                id: "PVT_project",
                fields: {
                  nodes: [
                    {
                      __typename: "ProjectV2SingleSelectField",
                      id: "PVTSSF_status",
                      name: "Status",
                      options: [
                        { id: "todo", name: "Todo" },
                        { id: "in_progress", name: "In progress" },
                      ],
                    },
                  ],
                },
              },
            },
          },
        }
      }

      if (query.includes("updateProjectV2ItemFieldValue")) {
        return {
          data: {
            updateProjectV2ItemFieldValue: {
              projectV2Item: {
                id: "PVTI_123",
              },
            },
          },
        }
      }

      throw new Error(`unexpected_query:${query}`)
    },
  )

  await client.moveIssueToState("PVTI_123", "In progress")

  expect(calls).toHaveLength(3)
  expect(calls[1]).toEqual({
    query: expect.stringContaining("fields(first:50)"),
    variables: {
      owner: "tomoasleep",
      number: 4,
    },
  })
  expect(calls[2]).toEqual({
    query: expect.stringContaining("updateProjectV2ItemFieldValue"),
    variables: {
      projectId: "PVT_project",
      itemId: "PVTI_123",
      fieldId: "PVTSSF_status",
      optionId: "in_progress",
    },
  })
})

test("moveIssueToState は Status option が見つからないと失敗する", async () => {
  const client = new GitHubProjectClient(
    {
      kind: "github_project",
      github_project: {
        owner: "@me",
        number: 4,
      },
      file: null,
      schedule: null,
    },
    async (query) => {
      if (query.includes("viewer")) {
        return {
          data: {
            viewer: { login: "tomoasleep" },
          },
        }
      }

      return {
        data: {
          repositoryOwner: {
            projectV2: {
              id: "PVT_project",
              fields: {
                nodes: [
                  {
                    __typename: "ProjectV2SingleSelectField",
                    id: "PVTSSF_status",
                    name: "Status",
                    options: [{ id: "todo", name: "Todo" }],
                  },
                ],
              },
            },
          },
        },
      }
    },
  )

  expect(client.moveIssueToState("PVTI_123", "In progress")).rejects.toThrow(
    "github_project_status_option_not_found:In progress",
  )
})

test("updateItemDescription は Issue を更新する", async () => {
  const calls: Array<{ query: string; variables: Record<string, string | number> }> = []
  const client = new GitHubProjectClient(
    {
      kind: "github_project",
      github_project: {
        owner: "@me",
        number: 4,
      },
      file: null,
      schedule: null,
    },
    async (query, variables) => {
      calls.push({ query, variables })

      if (query.includes("viewer")) {
        return {
          data: {
            viewer: { login: "tomoasleep" },
          },
        }
      }

      if (query.includes("updateIssue")) {
        return {
          data: {
            updateIssue: {
              issue: {
                id: "I_123",
              },
            },
          },
        }
      }

      throw new Error(`unexpected_query:${query}`)
    },
  )

  await client.updateItemDescription(
    {
      id: "PVTI_123",
      identifier: "tomoasleep/fairy#77",
      title: "Implement",
      description: "old",
      priority: 1,
      state: "Backlog",
      repository: "tomoasleep/fairy",
      fields: {},
      url: "https://github.com/tomoasleep/fairy/issues/77",
      labels: [],
      blockedBy: [],
      createdAt: null,
      updatedAt: null,
      issueNodeId: "I_123",
    },
    "new description",
  )

  expect(calls).toHaveLength(1)
  expect(calls[0]).toEqual({
    query: expect.stringContaining("updateIssue"),
    variables: {
      issueId: "I_123",
      body: "new description",
    },
  })
})

test("updateItemDescription は DraftIssue を更新する", async () => {
  const calls: Array<{ query: string; variables: Record<string, string | number> }> = []
  const client = new GitHubProjectClient(
    {
      kind: "github_project",
      github_project: {
        owner: "@me",
        number: 4,
      },
      file: null,
      schedule: null,
    },
    async (query, variables) => {
      calls.push({ query, variables })

      if (query.includes("viewer")) {
        return {
          data: {
            viewer: { login: "tomoasleep" },
          },
        }
      }

      if (query.includes("updateProjectV2DraftIssue")) {
        return {
          data: {
            updateProjectV2DraftIssue: {
              draftIssue: {
                id: "DI_123",
              },
            },
          },
        }
      }

      throw new Error(`unexpected_query:${query}`)
    },
  )

  await client.updateItemDescription(
    {
      id: "PVTI_123",
      identifier: "draft:77",
      title: "Implement",
      description: "old",
      priority: 1,
      state: "Backlog",
      repository: null,
      fields: {},
      url: null,
      labels: [],
      blockedBy: [],
      createdAt: null,
      updatedAt: null,
      issueNodeId: "DI_123",
    },
    "new description",
  )

  expect(calls).toHaveLength(1)
  expect(calls[0]).toEqual({
    query: expect.stringContaining("updateProjectV2DraftIssue"),
    variables: {
      draftIssueId: "DI_123",
      body: "new description",
    },
  })
})

test("fetchIssueDescription は Issue の最新 body を取得する", async () => {
  const calls: Array<{ query: string; variables: Record<string, string | number> }> = []
  const client = new GitHubProjectClient(
    {
      kind: "github_project",
      github_project: { owner: "@me", number: 4 },
      file: null,
      schedule: null,
    },
    async (query, variables) => {
      calls.push({ query, variables })

      if (query.includes("viewer")) {
        return { data: { viewer: { login: "tomoasleep" } } }
      }

      if (query.includes("node(")) {
        return {
          data: {
            node: { body: "Updated by agent during execution" },
          },
        }
      }

      throw new Error(`unexpected_query:${query}`)
    },
  )

  const description = await client.fetchIssueDescription({
    id: "PVTI_123",
    identifier: "tomoasleep/fairy#77",
    title: "Implement",
    description: "Original description",
    priority: 1,
    state: "Backlog",
    repository: "tomoasleep/fairy",
    fields: {},
    url: "https://github.com/tomoasleep/fairy/issues/77",
    labels: [],
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
    issueNodeId: "I_123",
  })

  expect(description).toBe("Updated by agent during execution")
  expect(calls).toHaveLength(1)
  expect(calls[0]?.variables).toEqual({ id: "I_123" })
})

test("fetchIssueDescription は DraftIssue の最新 body を fetchIssueStatesByIds 経由で取得する", async () => {
  const client = new GitHubProjectClient(
    {
      kind: "github_project",
      github_project: { owner: "@me", number: 4 },
      file: null,
      schedule: null,
    },
    async (query) => {
      if (query.includes("viewer")) {
        return { data: { viewer: { login: "tomoasleep" } } }
      }

      if (query.includes("projectV2")) {
        return {
          data: {
            repositoryOwner: {
              __typename: "User",
              projectV2: {
                url: "https://github.com/users/tomoasleep/projects/4",
                items: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: "PVTI_123",
                      databaseId: 77,
                      content: {
                        __typename: "DraftIssue",
                        id: "DI_123",
                        title: "Draft Task",
                        body: "Updated draft body",
                      },
                      fieldValues: {
                        nodes: [{ field: { name: "Status" }, name: "Backlog" }],
                      },
                    },
                  ],
                },
              },
            },
          },
        }
      }

      throw new Error(`unexpected_query:${query}`)
    },
  )

  const description = await client.fetchIssueDescription({
    id: "PVTI_123",
    identifier: "draft:77",
    title: "Draft Task",
    description: "Original draft body",
    priority: null,
    state: "Backlog",
    repository: null,
    fields: {},
    url: null,
    labels: [],
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
    issueNodeId: "DI_123",
  })

  expect(description).toBe("Updated draft body")
})

test("fetchIssueDescription は issueNodeId がない場合は元の description を返す", async () => {
  const client = new GitHubProjectClient(
    {
      kind: "github_project",
      github_project: { owner: "@me", number: 4 },
      file: null,
      schedule: null,
    },
    async () => {
      throw new Error("should_not_call_graphql")
    },
  )

  const description = await client.fetchIssueDescription({
    id: "PVTI_123",
    identifier: "tomoasleep/fairy#77",
    title: "Implement",
    description: "Fallback description",
    priority: 1,
    state: "Backlog",
    repository: "tomoasleep/fairy",
    fields: {},
    url: "https://github.com/tomoasleep/fairy/issues/77",
    labels: [],
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
    issueNodeId: null,
  })

  expect(description).toBe("Fallback description")
})
