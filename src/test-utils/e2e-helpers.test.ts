import { expect, test } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mirrorXdgExcludingHerdr, stripHerdrEnv } from "./e2e-helpers"

test("stripHerdrEnv は HERDR_ プレフィックスの変数だけ除去する", () => {
  const src = {
    PATH: "/usr/bin",
    HOME: "/home/u",
    HERDR_SOCKET_PATH: "/parent.sock",
    HERDR_CONFIG_PATH: "/parent/config.toml",
    HERDR_FOO: "x",
  } as NodeJS.ProcessEnv
  const got = stripHerdrEnv(src)
  expect(got).toEqual({ PATH: "/usr/bin", HOME: "/home/u" })
})

test("stripHerdrEnv は HERDR_ 以外をすべて残す", () => {
  const got = stripHerdrEnv({ PATH: "/usr/bin", FOO: "bar", ANTHROPIC_BASE_URL: "http://x" })
  expect(got).toEqual({ PATH: "/usr/bin", FOO: "bar", ANTHROPIC_BASE_URL: "http://x" })
})

test("mirrorXdgExcludingHerdr は herdr 以外をシンボリックリンク化し herdr は含めない", async () => {
  const root = join(tmpdir(), `e2e-helpers-test-${Date.now().toString(36)}`)
  const realXdg = join(root, "real")
  const isolatedXdg = join(root, "isolated")
  await mkdir(join(realXdg, "herdr"), { recursive: true })
  await mkdir(join(realXdg, "opencode"), { recursive: true })
  await mkdir(join(realXdg, "git"), { recursive: true })
  await writeFile(join(realXdg, "opencode", "config.json"), "{}")

  await mirrorXdgExcludingHerdr(realXdg, isolatedXdg)

  const { readdir } = await import("node:fs/promises")
  const entries = await readdir(isolatedXdg, { withFileTypes: true })
  const names = entries.map((e) => e.name).sort()
  expect(names).toEqual(["git", "opencode"])
  const isSymlink = entries.every((e) => e.isSymbolicLink())
  expect(isSymlink).toBe(true)
  const isolatedContents = await readdir(join(isolatedXdg, "opencode"))
  expect(isolatedContents).toEqual(["config.json"])

  await rm(root, { recursive: true, force: true })
})

test("mirrorXdgExcludingHerdr は realXdg が存在しなくてもエラーにならない", async () => {
  const root = join(tmpdir(), `e2e-helpers-test-missing-${Date.now().toString(36)}`)
  await mirrorXdgExcludingHerdr(join(root, "missing"), join(root, "isolated"))
  await rm(root, { recursive: true, force: true })
})
