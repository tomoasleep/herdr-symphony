import type { ServiceConfig } from "../domain/types"
import { createHcClient } from "../herdr/hc-client"
import { HerdrAgentRunner } from "./herdr-agent/herdr-agent-runner"
import type { Runner } from "./types"

export function createRunner(config: ServiceConfig): Runner {
  if (config.work.runner === "herdr_core") {
    return new HerdrAgentRunner(config, { herdrClient: createHcClient() })
  }
  return new HerdrAgentRunner(config)
}
