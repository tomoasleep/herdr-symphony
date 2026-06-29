export interface RetryOptions {
  times: number
  baseDelayMs: number
  onRetry?: (error: unknown, attempt: number) => void
}

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt <= options.times; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      if (attempt < options.times) {
        options.onRetry?.(error, attempt)
        const delay = options.baseDelayMs * 2 ** attempt
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }
  }
  throw lastError
}
