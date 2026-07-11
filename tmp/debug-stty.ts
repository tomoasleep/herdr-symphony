import { launchTerminal } from "tuistory"
import { spawn } from "node:child_process"

const timeout = setTimeout(() => {
  console.error("TIMEOUT: script did not complete in 30s")
  process.exit(1)
}, 30_000)

const containerId = spawn("docker", ["run", "-d", "--name", "e2e-debug-stty", "-v", `${process.cwd()}:/workspace`, "herdr-e2e:latest", "sleep", "infinity"], { stdio: ["ignore", "pipe", "pipe"] })
let id = ""
containerId.stdout.on("data", (chunk) => { id += chunk })
containerId.on("close", async () => {
  const container = id.trim()
  console.log("Container:", container)

  try {
    const session = await launchTerminal({
      command: "docker",
      args: ["exec", "-it", container, "bash", "-c", "stty size && echo COLS=$COLUMNS ROWS=$LINES && tput cols && tput lines && echo TERM=$TERM"],
      cwd: process.cwd(),
      cols: 160,
      rows: 40,
      env: {},
      waitForDataTimeout: 10_000,
    })

    await session.waitForText("TERM=", { timeout: 10_000 })
    const text = await session.text({ trimEnd: true })
    console.log("=== Experiment A: stty size inside container ===")
    console.log(text)

    session.close()
  } catch (e) {
    console.error("Error:", e)
  } finally {
    spawn("docker", ["rm", "-f", container], { stdio: "ignore" })
    clearTimeout(timeout)
    setTimeout(() => process.exit(0), 1000)
  }
})