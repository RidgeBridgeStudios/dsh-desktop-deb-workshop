import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rootDir = path.resolve(__dirname, "..")

test("install.sh: removes dead install-electron, detects architecture for sharp", () => {
  const installShPath = path.join(rootDir, "install.sh")
  const installShContent = fs.readFileSync(installShPath, "utf8")

  assert.doesNotMatch(installShContent, /install-electron/, "install.sh must not contain install-electron")
  assert.match(installShContent, /dpkg-architecture -qDEB_HOST_ARCH/, "install.sh must query DEB_HOST_ARCH")
  assert.match(installShContent, /@img\/sharp-linux-x64/, "install.sh must reference sharp x64 package")
  assert.match(installShContent, /@img\/sharp-linux-arm64/, "install.sh must reference sharp arm64 package")
})

test("install.sh: dynamic deb architecture, SHA verification in both branches, dpkg-architecture check", () => {
  const installShPath = path.join(rootDir, "install.sh")
  const installShContent = fs.readFileSync(installShPath, "utf8")

  assert.match(installShContent, /DEB_ARCH=/)
  assert.match(installShContent, /dpkg-architecture -qDEB_HOST_ARCH/)

  const linesWithoutComments = installShContent
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n")
  assert.doesNotMatch(linesWithoutComments, /amd64\.deb/)

  const verifyShaMatches = installShContent.match(/verify_sha\b/g) || []
  assert.ok(verifyShaMatches.length >= 3, "verify_sha should be defined and called in both branches")

  assert.match(installShContent, /dpkg-architecture is required\. Install with: sudo apt install -y dpkg-dev/)
})

