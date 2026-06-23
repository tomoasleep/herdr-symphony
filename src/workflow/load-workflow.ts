import fs from "node:fs/promises"
import matter from "gray-matter"
import { z } from "zod"
import { ErrorCode, WorkflowError } from "../domain/errors"
import type { WorkflowDefinition } from "../domain/types"
import { formatError } from "../utils/error"

const FrontMatterSchema = z.record(z.string(), z.unknown())

export async function loadWorkflow(path: string): Promise<WorkflowDefinition> {
  let raw: string
  try {
    raw = await fs.readFile(path, "utf8")
  } catch (error) {
    throw new WorkflowError(
      ErrorCode.MISSING_WORKFLOW_FILE,
      `failed to read ${path}: ${formatError(error)}`,
    )
  }

  let parsed: matter.GrayMatterFile<string>
  try {
    parsed = matter(raw)
  } catch (error) {
    throw new WorkflowError(ErrorCode.WORKFLOW_PARSE_ERROR, formatError(error))
  }

  if (parsed.data !== null && typeof parsed.data !== "object") {
    throw new WorkflowError(ErrorCode.WORKFLOW_FRONT_MATTER_NOT_A_MAP, "front matter must be map")
  }

  const configResult = FrontMatterSchema.safeParse(parsed.data ?? {})
  if (!configResult.success) {
    throw new WorkflowError(
      ErrorCode.INVALID_FRONT_MATTER,
      `front matter is not a valid object: ${configResult.error.message}`,
    )
  }

  return {
    config: configResult.data,
    promptTemplate: parsed.content.trim(),
  }
}
