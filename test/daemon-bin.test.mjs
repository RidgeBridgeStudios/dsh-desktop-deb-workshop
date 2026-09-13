import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { resolveDaemonBin } from "../usr/share/dsh-desktop/app/main.js"

test("resolveDaemonBin: returns valid daemon binary path without /usr/usr/", () => {
  const binPath = resolveDaemonBin()
  assert.ok(typeof binPath === "string" && binPath.length > 0)
  assert.match(binPath, /dsh-desktop-daemon/)
  assert.doesNotMatch(binPath, /\/usr\/usr\//)

  if (fs.existsSync("/usr/bin/dsh-desktop-daemon")) {
    assert.equal(binPath, "/usr/bin/dsh-desktop-daemon")
  }
})

test("resolveDaemonBin: no candidate in main.js contains /usr/usr/", () => {
  const mainContent = fs.readFileSync("usr/share/dsh-desktop/app/main.js", "utf8")
  assert.doesNotMatch(mainContent, /\/usr\/usr\//)
  assert.ok(mainContent.includes("path.resolve(__dirname, '../../../lib/dsh-desktop/bin/dsh-desktop-daemon')"))
  assert.ok(mainContent.includes("path.resolve(__dirname, '../../lib/dsh-desktop/bin/dsh-desktop-daemon')"))
})
