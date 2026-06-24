export type OpencodeTestConfigOptions = {
  mockServerUrl: string
  agent?: string | null
  model?: string | null
}

export function createOpencodeTestConfig(options: OpencodeTestConfigOptions): string {
  const model = options.model ?? "agent-model"
  return JSON.stringify({
    model: `mock/${model}`,
    enabled_providers: ["mock"],
    share: "disabled",
    ...(options.agent ? { agent: options.agent } : {}),
    provider: {
      mock: {
        npm: "@ai-sdk/openai-compatible",
        name: "Mock",
        options: {
          baseURL: `${options.mockServerUrl}/v1`,
          apiKey: "mock",
        },
        models: {
          [model]: {
            name: "Agent Model",
            limit: {
              context: 128000,
              output: 8192,
            },
          },
        },
      },
    },
  })
}
