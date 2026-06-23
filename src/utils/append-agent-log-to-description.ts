import type { Element, Parent, Root, RootContent } from "hast"
import rehypeRaw from "rehype-raw"
import remarkParse from "remark-parse"
import remarkRehype from "remark-rehype"
import { unified } from "unified"

const AGENT_LOGS_HEADER = "## Agent Logs"

const markdownProcessor = unified()
  .use(remarkParse)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw)

export function appendAgentLogToDescription(
  description: string | null,
  workflowName: string,
  timestamp: string,
  content: string,
): string {
  const logBlock = formatLogBlock(workflowName, timestamp, content)

  if (!description) {
    return `${AGENT_LOGS_HEADER}\n\n${logBlock}`
  }

  const sectionRange = findAgentLogsSectionRange(description)

  if (!sectionRange) {
    return `${description}\n\n${AGENT_LOGS_HEADER}\n\n${logBlock}`
  }

  const beforeLogs = description.slice(0, sectionRange.start)
  const existingLogs = description.slice(sectionRange.start, sectionRange.end).trim()
  const afterLogs = description.slice(sectionRange.end)
  const updatedLogs = existingLogs ? `${existingLogs}\n\n${logBlock}` : logBlock

  if (!afterLogs) {
    return `${beforeLogs}\n\n${updatedLogs}`
  }

  return `${beforeLogs}\n\n${updatedLogs}\n\n${afterLogs.trimStart()}`
}

function formatLogBlock(workflowName: string, timestamp: string, content: string): string {
  return `<details><summary>${workflowName} ${timestamp}</summary>

${content}

</details>`
}

function findAgentLogsSectionRange(description: string): { start: number; end: number } | null {
  const root = markdownProcessor.runSync(markdownProcessor.parse(description)) as Root
  const headingIndex = root.children.findIndex(isAgentLogsHeading)

  if (headingIndex === -1) {
    return null
  }

  const heading = root.children[headingIndex]

  if (!heading || !isHeadingElement(heading)) {
    return null
  }

  const headingLevel = getHeadingLevel(heading)
  const headingEnd = heading.position?.end.offset

  if (headingEnd === undefined) {
    return null
  }

  const nextBoundary = root.children
    .slice(headingIndex + 1)
    .find(
      (node) =>
        isHeadingElement(node) &&
        getHeadingLevel(node) <= headingLevel &&
        node.position?.start.offset !== undefined,
    )

  return {
    start: headingEnd,
    end: nextBoundary?.position?.start.offset ?? description.length,
  }
}

function isAgentLogsHeading(node: RootContent): boolean {
  return isHeadingElement(node) && getTextContent(node).trim() === "Agent Logs"
}

function isHeadingElement(node: RootContent): node is Element {
  return node.type === "element" && /^h[1-6]$/.test(node.tagName)
}

function getHeadingLevel(node: Element): number {
  return Number(node.tagName[1])
}

function getTextContent(node: RootContent): string {
  if (node.type === "text") {
    return node.value
  }

  if (node.type !== "element") {
    return ""
  }

  return getChildrenTextContent(node)
}

function getChildrenTextContent(node: Parent): string {
  return node.children
    .map((child) => {
      if (child.type === "text") {
        return child.value
      }

      if (child.type !== "element") {
        return ""
      }

      return getChildrenTextContent(child)
    })
    .join("")
}
