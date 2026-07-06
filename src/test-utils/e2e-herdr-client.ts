import type { HerdrAgentInfo, HerdrClient, StartAgentOptions } from "../herdr/herdr-client"

export function wrapHerdrClientWithEnv(
  client: HerdrClient,
  env: Record<string, string>,
  onStart?: (info: HerdrAgentInfo) => void,
): HerdrClient & { startedPaneId: string | null } {
  let paneId: string | null = null
  return {
    ...client,
    startAgent: async (name: string, opts: StartAgentOptions): Promise<HerdrAgentInfo> => {
      const info = await client.startAgent(name, { ...opts, env: { ...opts.env, ...env } })
      paneId = info.paneId
      onStart?.(info)
      return info
    },
    get startedPaneId(): string | null {
      return paneId
    },
  }
}
