import type { ServiceConfig } from "../domain/types"
import { resolveConfigFromSchema, validateDispatchConfig } from "./schema"

export function resolveConfig(input: Record<string, unknown>): ServiceConfig {
  return resolveConfigFromSchema(input)
}

export { validateDispatchConfig }
