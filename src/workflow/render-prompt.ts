import { Liquid } from "liquidjs"
import { ErrorCode, WorkflowError } from "../domain/errors"
import type { Issue } from "../domain/types"
import { formatError } from "../utils/error"

const engine = new Liquid({
  strictFilters: true,
  strictVariables: true,
})

export async function renderPrompt(
  template: string,
  issue: Issue,
  attempt: number | null,
): Promise<string> {
  const source =
    template.trim().length === 0 ? "You are working on an issue from GitHub Project." : template

  try {
    return await engine.parseAndRender(source, {
      issue,
      attempt,
    })
  } catch (error) {
    throw new WorkflowError(ErrorCode.TEMPLATE_RENDER_ERROR, formatError(error))
  }
}
