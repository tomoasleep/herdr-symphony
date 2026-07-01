import { spawn } from "node:child_process"
import type { Issue, TrackerConfig } from "../domain/types"
import { isActiveState } from "../orchestrator/scheduling"
import { normalizeState } from "../utils/normalize"
import { withRetry } from "../utils/retry"
import type { IssueTrackerClient } from "./types"

type GraphqlPayload = {
  data?: {
    repositoryOwner?: { projectV2?: unknown } | null
    viewer?: { login?: string | null } | null
    nodes?: Array<unknown | null> | null
  } | null
  errors?: unknown[]
}

type ProjectItemsPayload = {
  data?: {
    repositoryOwner?: {
      projectV2?: ProjectPage | null
    } | null
  } | null
}

type ProjectFieldsPayload = {
  data?: {
    repositoryOwner?: {
      projectV2?: ProjectFieldPage | null
    } | null
  } | null
}

type ViewerPayload = {
  data?: {
    viewer?: {
      login?: string | null
    } | null
  } | null
}

type GraphqlRunner = (
  query: string,
  variables: Record<string, string | number | string[]>,
) => Promise<GraphqlPayload>

type ProjectItemNode = {
  id: string
  databaseId: number | null
  content:
    | {
        __typename: "DraftIssue"
        id: string
        title: string
        body: string | null
      }
    | {
        __typename: "Issue"
        id: string
        number: number
        title: string
        body: string
        state: string
        url: string
        createdAt: string
        updatedAt: string
        repository: { nameWithOwner: string }
        labels: { nodes: Array<{ name: string }> }
        blockedBy: {
          nodes: Array<{
            id: string
            number: number
            title: string
            state: string
            repository: { nameWithOwner: string }
          }>
        }
      }
    | null
  fieldValues: {
    nodes: Array<{
      name?: string
      text?: string
      date?: string
      field?: { name?: string }
    }>
  }
  project?: { url: string }
}

type ProjectPage = {
  url: string
  items: {
    pageInfo: {
      hasNextPage: boolean
      endCursor: string | null
    }
    nodes: ProjectItemNode[]
  }
}

type ProjectFieldPage = {
  id: string
  fields: {
    nodes: Array<{
      __typename: string
      id?: string
      name?: string
      options?: Array<{
        id: string
        name: string
      }>
    }>
  }
}

export type ProjectField = {
  id: string
  name: string
  type: string
  options?: Array<{ id: string; name: string }>
}

const PROJECT_ITEMS_QUERY = `query($owner:String!,$number:Int!,$after:String){
  repositoryOwner(login:$owner){
    __typename
    login
    ... on User {
      projectV2(number:$number){
        url
        items(first:20,after:$after){
          pageInfo{hasNextPage endCursor}
          nodes{
            id
            databaseId
            content{
              __typename
              ... on DraftIssue{
                id
                title
                body
              }
              ... on Issue{
                id
                number
                title
                body
                state
                url
                createdAt
                updatedAt
                repository{nameWithOwner}
                labels(first:50){nodes{name}}
                blockedBy(first:50){nodes{id number title state repository{nameWithOwner}}}
              }
            }
            fieldValues(first:20){
              nodes{
                ... on ProjectV2ItemFieldSingleSelectValue{
                  name
                  field{... on ProjectV2SingleSelectField{name}}
                }
                ... on ProjectV2ItemFieldTextValue{
                  text
                  field{... on ProjectV2FieldCommon{name}}
                }
                ... on ProjectV2ItemFieldDateValue{
                  date
                  field{... on ProjectV2FieldCommon{name}}
                }
              }
            }
          }
        }
      }
    }
    ... on Organization {
      projectV2(number:$number){
        url
        items(first:20,after:$after){
          pageInfo{hasNextPage endCursor}
          nodes{
            id
            databaseId
            content{
              __typename
              ... on DraftIssue{
                id
                title
                body
              }
              ... on Issue{
                id
                number
                title
                body
                state
                url
                createdAt
                updatedAt
                repository{nameWithOwner}
                labels(first:50){nodes{name}}
                blockedBy(first:50){nodes{id number title state repository{nameWithOwner}}}
              }
            }
            fieldValues(first:20){
              nodes{
                ... on ProjectV2ItemFieldSingleSelectValue{
                  name
                  field{... on ProjectV2SingleSelectField{name}}
                }
                ... on ProjectV2ItemFieldTextValue{
                  text
                  field{... on ProjectV2FieldCommon{name}}
                }
                ... on ProjectV2ItemFieldDateValue{
                  date
                  field{... on ProjectV2FieldCommon{name}}
                }
              }
            }
          }
        }
      }
    }
  }
}`

const VIEWER_QUERY = `query { viewer { login } }`

const PROJECT_FIELDS_QUERY = `query($owner:String!,$number:Int!){
  repositoryOwner(login:$owner){
    __typename
    ... on User {
      projectV2(number:$number){
        id
        fields(first:50){
          nodes{
            __typename
            ... on ProjectV2FieldCommon{
              id
              name
            }
            ... on ProjectV2SingleSelectField{
              options{
                id
                name
              }
            }
          }
        }
      }
    }
    ... on Organization {
      projectV2(number:$number){
        id
        fields(first:50){
          nodes{
            __typename
            ... on ProjectV2FieldCommon{
              id
              name
            }
            ... on ProjectV2SingleSelectField{
              options{
                id
                name
              }
            }
          }
        }
      }
    }
  }
}`

const UPDATE_ITEM_STATE_MUTATION = `mutation($projectId:ID!,$itemId:ID!,$fieldId:ID!,$optionId:String!){
  updateProjectV2ItemFieldValue(input:{
    projectId:$projectId
    itemId:$itemId
    fieldId:$fieldId
    value:{singleSelectOptionId:$optionId}
  }){
    projectV2Item{id}
  }
}`

const UPDATE_ISSUE_MUTATION = `mutation($issueId:ID!,$body:String){
  updateIssue(input:{id:$issueId,body:$body}){
    issue{id}
  }
}`

const UPDATE_DRAFT_ISSUE_MUTATION = `mutation($draftIssueId:ID!,$body:String){
  updateProjectV2DraftIssue(input:{draftIssueId:$draftIssueId,body:$body}){
    draftIssue{id}
  }
}`

const ISSUE_NODE_QUERY = `query($id:ID!){
  node(id:$id){
    ... on Issue{body}
  }
}`

const ITEMS_BY_IDS_QUERY = `query($ids:[ID!]!){
  nodes(ids:$ids){
    __typename
    ... on ProjectV2Item{
      id
      databaseId
      content{
        __typename
        ... on DraftIssue{
          id
          title
          body
        }
        ... on Issue{
          id
          number
          title
          body
          state
          url
          createdAt
          updatedAt
          repository{nameWithOwner}
          labels(first:50){nodes{name}}
          blockedBy(first:50){nodes{id number title state repository{nameWithOwner}}}
        }
      }
      fieldValues(first:20){
        nodes{
          ... on ProjectV2ItemFieldSingleSelectValue{
            name
            field{... on ProjectV2SingleSelectField{name}}
          }
          ... on ProjectV2ItemFieldTextValue{
            text
            field{... on ProjectV2FieldCommon{name}}
          }
          ... on ProjectV2ItemFieldDateValue{
            date
            field{... on ProjectV2FieldCommon{name}}
          }
        }
      }
      project{url}
    }
  }
}`

export class GitHubProjectClient implements IssueTrackerClient {
  private resolvedOwner: string | null = null
  private readonly runQuery: GraphqlRunner

  constructor(
    private readonly config: TrackerConfig,
    runQuery?: GraphqlRunner,
    private readonly writeLog?: (line: string) => void,
  ) {
    this.runQuery =
      runQuery ?? ((query, variables) => runGhGraphql(query, variables, this.writeLog))
  }

  async fetchProjectFields(): Promise<ProjectField[]> {
    this.debugLog("tracker fetchProjectFields start")
    const owner = await this.resolveOwner()

    const payload = await this.runQuery(PROJECT_FIELDS_QUERY, {
      owner,
      number: this.config.github_project?.number ?? 0,
    })

    const project = (payload as ProjectFieldsPayload).data?.repositoryOwner?.projectV2 ?? null
    if (!project) {
      throw new Error("github_project_not_found")
    }

    const fields: ProjectField[] = []
    for (const node of project.fields.nodes) {
      if (node.id && node.name) {
        fields.push({
          id: node.id,
          name: node.name,
          type: node.__typename,
          options: node.options,
        })
      }
    }

    this.debugLog(`tracker fetchProjectFields done count=${fields.length}`)
    return fields
  }

  async fetchCandidateIssues(): Promise<Issue[]> {
    this.debugLog("tracker fetchCandidateIssues start")
    return this.fetchAllItems()
  }

  async fetchIssuesByStates(states: string[]): Promise<Issue[]> {
    this.debugLog(`tracker fetchIssuesByStates start states=${states.join(",")}`)
    const all = await this.fetchAllItems()
    return all.filter((item) =>
      states.some((state) => normalizeState(state) === normalizeState(item.state)),
    )
  }

  async fetchIssueStatesByIds(ids: string[]): Promise<Issue[]> {
    if (ids.length === 0) {
      this.debugLog("tracker fetchIssueStatesByIds ids=0")
      return []
    }

    this.debugLog(`tracker fetchIssueStatesByIds start ids=${ids.length}`)
    const payload = await this.runQuery(ITEMS_BY_IDS_QUERY, { ids })
    const rawNodes =
      (payload as { data?: { nodes?: Array<ProjectItemNode | null> | null } | null }).data?.nodes ??
      []
    const issues: Issue[] = []
    for (const node of rawNodes) {
      if (!node || typeof node !== "object" || !("id" in node)) {
        continue
      }
      const projectUrl = node.project?.url ?? ""
      issues.push(normalizeProjectItem(node, projectUrl))
    }

    this.debugLog(`tracker fetchIssueStatesByIds done count=${issues.length}`)
    return issues
  }

  async moveIssueToState(issueId: string, state: string): Promise<void> {
    this.debugLog(`tracker moveIssueToState issue=${issueId} state=${state}`)
    const owner = await this.resolveOwner()
    const payload = await this.runQuery(PROJECT_FIELDS_QUERY, {
      owner,
      number: this.config.github_project?.number ?? 0,
    })

    const project = (payload as ProjectFieldsPayload).data?.repositoryOwner?.projectV2 ?? null
    if (!project) {
      throw new Error("github_project_not_found")
    }

    const statusField = project.fields.nodes.find(
      (field) =>
        field.__typename === "ProjectV2SingleSelectField" && field.name === "Status" && field.id,
    )
    if (!statusField?.id) {
      throw new Error("github_project_status_field_not_found")
    }

    const normalizedTarget = normalizeState(state)
    const option = statusField.options?.find(
      (item) => normalizeState(item.name) === normalizedTarget,
    )
    if (!option) {
      throw new Error(`github_project_status_option_not_found:${state}`)
    }

    await this.runQuery(UPDATE_ITEM_STATE_MUTATION, {
      projectId: project.id,
      itemId: issueId,
      fieldId: statusField.id,
      optionId: option.id,
    })
    this.debugLog(`tracker moveIssueToState done issue=${issueId} option=${option.id}`)
  }

  async updateItemDescription(issue: Issue, description: string): Promise<void> {
    if (!issue.issueNodeId) {
      this.debugLog(
        `tracker updateItemDescription skipped issue=${issue.id} reason=no_issue_node_id`,
      )
      return
    }

    const isDraftIssue = issue.identifier.startsWith("draft:")
    this.debugLog(`tracker updateItemDescription start issue=${issue.id} isDraft=${isDraftIssue}`)

    if (isDraftIssue) {
      await this.runQuery(UPDATE_DRAFT_ISSUE_MUTATION, {
        draftIssueId: issue.issueNodeId,
        body: description,
      })
    } else {
      await this.runQuery(UPDATE_ISSUE_MUTATION, {
        issueId: issue.issueNodeId,
        body: description,
      })
    }

    this.debugLog(`tracker updateItemDescription done issue=${issue.id}`)
  }

  async fetchIssueDescription(issue: Issue): Promise<string | null> {
    if (!issue.issueNodeId) {
      return issue.description
    }

    const isDraftIssue = issue.identifier.startsWith("draft:")
    if (isDraftIssue) {
      this.debugLog(`tracker fetchIssueDescription fallback draft issue=${issue.id}`)
      const issues = await this.fetchIssueStatesByIds([issue.id])
      const found = issues.find((item) => item.id === issue.id)
      return found?.description ?? issue.description
    }

    this.debugLog(`tracker fetchIssueDescription start issue=${issue.id}`)
    const payload = await this.runQuery(ISSUE_NODE_QUERY, { id: issue.issueNodeId })
    const body = (payload as { data?: { node?: { body?: string | null } | null } | null }).data
      ?.node?.body
    this.debugLog(`tracker fetchIssueDescription done issue=${issue.id} hasBody=${body != null}`)
    return body ?? null
  }

  private async fetchAllItems(): Promise<Issue[]> {
    const issues: Issue[] = []
    let after = ""
    const owner = await this.resolveOwner()

    while (true) {
      this.debugLog(`tracker query operation=project_items after=${after || "start"}`)
      const payload = await this.runQuery(PROJECT_ITEMS_QUERY, {
        owner,
        number: this.config.github_project?.number ?? 0,
        after,
      })

      const project = (payload as ProjectItemsPayload).data?.repositoryOwner?.projectV2 ?? null
      if (!project) {
        throw new Error("github_project_not_found")
      }

      issues.push(...project.items.nodes.map((node) => normalizeProjectItem(node, project.url)))
      this.debugLog(
        `tracker items page count=${project.items.nodes.length} hasNextPage=${project.items.pageInfo.hasNextPage}`,
      )

      if (!project.items.pageInfo.hasNextPage) {
        break
      }

      const cursor = project.items.pageInfo.endCursor
      if (!cursor) {
        throw new Error("github_project_missing_cursor")
      }
      after = cursor
    }

    this.debugLog(`tracker fetchAllItems done count=${issues.length}`)
    return issues
  }

  private async resolveOwner(): Promise<string> {
    if (this.resolvedOwner) {
      this.debugLog(`tracker resolveOwner cached=${this.resolvedOwner}`)
      return this.resolvedOwner
    }

    const configOwner = this.config.github_project?.owner
    if (configOwner && configOwner !== "@me") {
      this.resolvedOwner = configOwner
      this.debugLog(`tracker resolveOwner configured=${this.resolvedOwner}`)
      return this.resolvedOwner
    }

    this.debugLog("tracker resolveOwner @me")
    this.debugLog("tracker query operation=viewer")
    const payload = await this.runQuery(VIEWER_QUERY, {})
    const login = String((payload as ViewerPayload).data?.viewer?.login ?? "").trim()
    if (!login) {
      throw new Error("github_viewer_login_not_found")
    }
    this.resolvedOwner = login
    this.debugLog(`tracker resolveOwner resolved=${this.resolvedOwner}`)
    return this.resolvedOwner
  }

  private debugLog(line: string): void {
    this.writeLog?.(line)
  }

  shouldRun(issue: Issue, activeStates: string[]): boolean {
    return isActiveState(issue.state, activeStates)
  }
}

export function normalizeProjectItem(node: ProjectItemNode, projectUrl: string): Issue {
  const fields = collectFields(node.fieldValues.nodes)
  const status = fields.Status ?? "Backlog"
  const priority = normalizePriority(fields.Priority ?? null)

  if (node.content?.__typename === "Issue") {
    const issue = node.content
    return {
      id: node.id,
      identifier: `${issue.repository.nameWithOwner}#${issue.number}`,
      title: issue.title,
      description: issue.body || null,
      priority,
      state: status,
      repository: issue.repository.nameWithOwner,
      fields,
      url: issue.url,
      labels: issue.labels.nodes.map((label) => label.name.toLowerCase()),
      blockedBy: issue.blockedBy.nodes.map((dependency) => ({
        id: dependency.id,
        identifier: `${dependency.repository.nameWithOwner}#${dependency.number}`,
        state: dependency.state,
      })),
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
      issueNodeId: issue.id,
    }
  }

  const draftTitle = node.content?.__typename === "DraftIssue" ? node.content.title : node.id
  const draftBody = node.content?.__typename === "DraftIssue" ? node.content.body : null
  const draftId = node.databaseId ?? 0
  const draftIssueNodeId = node.content?.__typename === "DraftIssue" ? node.content.id : null

  return {
    id: node.id,
    identifier: `draft:${draftId}`,
    title: draftTitle,
    description: draftBody,
    priority,
    state: status,
    repository: null,
    fields,
    url: `${projectUrl}?pane=issue&itemId=${draftId}`,
    labels: [],
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
    issueNodeId: draftIssueNodeId,
  }
}

function collectFields(
  nodes: Array<{ name?: string; text?: string; date?: string; field?: { name?: string } }>,
): Record<string, string | null> {
  const fields: Record<string, string | null> = {}

  for (const node of nodes) {
    const fieldName = node.field?.name?.trim()
    if (!fieldName) {
      continue
    }

    const value = readFieldValue(node)
    if (value !== null) {
      fields[fieldName] = value
    }
  }

  return fields
}

function readFieldValue(node: { name?: string; text?: string; date?: string }): string | null {
  const candidates = [node.text, node.name, node.date]
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim()
    }
  }

  return null
}

function normalizePriority(value: string | null): number | null {
  if (!value) {
    return null
  }

  const normalized = value.trim().toUpperCase()
  if (normalized === "P0") {
    return 1
  }
  if (normalized === "P1") {
    return 2
  }
  if (normalized === "P2") {
    return 3
  }
  if (normalized === "P3") {
    return 4
  }
  return null
}

async function runGhGraphqlOnce(
  query: string,
  variables: Record<string, string | number | string[]>,
  writeLog?: (line: string) => void,
): Promise<GraphqlPayload> {
  const args = ["api", "graphql", "-f", `query=${query}`]
  for (const [key, value] of Object.entries(variables)) {
    if (typeof value === "string" && value.length === 0) {
      continue
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        args.push("-F", `${key}=${item}`)
      }
    } else {
      args.push("-F", `${key}=${value}`)
    }
  }

  writeLog?.(
    `tracker gh command=gh args=${args.filter((arg) => !arg.startsWith("query=")).join(" ")}`,
  )

  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, { stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk)
    })

    child.on("close", (code) => {
      if (code !== 0) {
        writeLog?.(`tracker gh result exit=${code ?? 1} stderr=${stderr.trim() || "-"}`)
        reject(new Error(`gh_graphql_failed:${stderr.trim()}`))
        return
      }

      try {
        writeLog?.(`tracker gh result exit=0 stderr=${stderr.trim() || "-"}`)
        const parsed = JSON.parse(stdout) as GraphqlPayload
        if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
          reject(new Error(`gh_graphql_errors:${JSON.stringify(parsed.errors)}`))
          return
        }
        resolve(parsed)
      } catch (error) {
        reject(error)
      }
    })

    child.on("error", (error) => {
      writeLog?.(`tracker gh error ${String(error)}`)
      reject(error)
    })
  })
}

async function runGhGraphql(
  query: string,
  variables: Record<string, string | number | string[]>,
  writeLog?: (line: string) => void,
): Promise<GraphqlPayload> {
  return withRetry(() => runGhGraphqlOnce(query, variables, writeLog), {
    times: 2,
    baseDelayMs: 1000,
    onRetry: (error, attempt) => {
      writeLog?.(
        `tracker gh retry attempt=${attempt + 1} error=${error instanceof Error ? error.message : String(error)}`,
      )
    },
  })
}
