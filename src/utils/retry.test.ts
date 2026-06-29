import { describe, expect, mock, test } from "bun:test"
import { withRetry } from "./retry"

describe("withRetry", () => {
  test("初回成功なら1回だけ fn を呼ぶ", async () => {
    const fn = mock(() => Promise.resolve("ok"))
    const result = await withRetry(fn, { times: 3, baseDelayMs: 0 })
    expect(result).toBe("ok")
    expect(fn).toHaveBeenCalledTimes(1)
  })

  test("一時エラー後にリトライで成功する", async () => {
    let calls = 0
    const fn = mock(() => {
      calls++
      if (calls === 1) return Promise.reject(new Error("transient"))
      return Promise.resolve("recovered")
    })
    const onRetry = mock(() => {})
    const result = await withRetry(fn, { times: 2, baseDelayMs: 0, onRetry })
    expect(result).toBe("recovered")
    expect(fn).toHaveBeenCalledTimes(2)
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  test("指定回数リトライして全部失敗したら最後のエラーを throw する", async () => {
    const fn = mock(() => Promise.reject(new Error("always fail")))
    await expect(withRetry(fn, { times: 2, baseDelayMs: 0 })).rejects.toThrow("always fail")
    expect(fn).toHaveBeenCalledTimes(3)
  })

  test("バックオフ間隔が指数的に増える", async () => {
    const delays: number[] = []
    const original = globalThis.setTimeout
    globalThis.setTimeout = ((callback: () => void, delay?: number) => {
      delays.push(delay ?? 0)
      callback()
      return 0 as never
    }) as unknown as typeof globalThis.setTimeout
    try {
      const fn = mock(() => Promise.reject(new Error("fail")))
      await expect(withRetry(fn, { times: 2, baseDelayMs: 1000 })).rejects.toThrow("fail")
    } finally {
      globalThis.setTimeout = original
    }
    expect(delays).toEqual([1000, 2000])
  })

  test("onRetry が各リトライで attempt 番号とともに呼ばれる", async () => {
    let calls = 0
    const fn = mock(() => {
      calls++
      return Promise.reject(new Error(`fail-${calls}`))
    })
    const attempts: number[] = []
    const errors: unknown[] = []
    await expect(
      withRetry(fn, {
        times: 2,
        baseDelayMs: 0,
        onRetry: (error, attempt) => {
          attempts.push(attempt)
          errors.push(error)
        },
      }),
    ).rejects.toThrow("fail-3")
    expect(attempts).toEqual([0, 1])
    expect((errors[0] as Error).message).toBe("fail-1")
    expect((errors[1] as Error).message).toBe("fail-2")
  })
})
