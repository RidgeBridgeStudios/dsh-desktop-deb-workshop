import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const LAUNCHER = new URL('../usr/local/bin/dsh-desktop', import.meta.url)

test('launcher passes --ozone-platform-hint=auto to Electron', async () => {
  const launcher = await readFile(LAUNCHER, 'utf8')
  const match = /exec\s+"\$ELECTRON_BIN"\s+"\$ELECTRON_APP_DIR"\s+([^\n]+)/u.exec(launcher)
  assert.ok(match, 'launcher must execute Electron binary with arguments')
  const args = match[1].split(/\s+/u)
  assert.ok(
    args.includes('--ozone-platform-hint=auto'),
    'Electron launch arguments must contain --ozone-platform-hint=auto'
  )
  assert.ok(
    !args.some((arg) => arg.includes('WaylandWindowDecorations')),
    'Must not include WaylandWindowDecorations policy flag'
  )
})
