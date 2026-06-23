import type { ServiceConfig } from "../domain/types"
import { HerdrAgentRunner } from "./herdr-agent/herdr-agent-runner"
import type { Runner } from "./types"

export function createRunner(config: ServiceConfig): Runner {
  return new HerdrAgentRunner(config)
}
