import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { resolveDaemonBin } from "../usr/share/dsh-desktop/app/main.js"

test("resolveDaemonBin: returns valid daemon binary path or null without /usr/usr/", () => {
  const binPath = resolveDaemonBin()
  assert.ok(binPath === null || (typeof binPath === "string" && binPath.endsWith("dsh-desktop-daemon")))
  if (binPath !== null) {
    assert.doesNotMatch(binPath, /\/usr\/usr\//)
  }

  if (fs.existsSync("/usr/bin/dsh-desktop-daemon")) {
    assert.equal(binPath, "/usr/bin/dsh-desktop-daemon")
  }
})

test("resolveDaemonBin: candidate list in main.js contains required paths and null fallback", () => {
  const mainContent = fs.readFileSync("usr/share/dsh-desktop/app/main.js", "utf8")
  assert.doesNotMatch(mainContent, /\/usr\/usr\//)
  assert.ok(mainContent.includes("'/usr/lib/dsh-desktop/bin/dsh-desktop-daemon'"))
  assert.ok(mainContent.includes("path.resolve(__dirname, '../../../lib/dsh-desktop/bin/dsh-desktop-daemon')"))
  assert.ok(mainContent.includes("path.resolve(__dirname, '../../lib/dsh-desktop/bin/dsh-desktop-daemon')"))
  assert.ok(mainContent.includes("?? null"))
})

