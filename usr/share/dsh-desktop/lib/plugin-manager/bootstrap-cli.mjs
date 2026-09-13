#!/usr/bin/env node
import { ensureDataDirs, ensureDefaultProfile } from './bootstrap.mjs'

const dirs = await ensureDataDirs()
if (!dirs.ok) {
  process.stderr.write(`dsh-desktop bootstrap: data dirs: ${dirs.detail}\n`)
  process.exit(1)
}
const profile = await ensureDefaultProfile()
if (!profile.ok) {
  process.stderr.write(`dsh-desktop bootstrap: profile: ${profile.detail}\n`)
  process.exit(1)
}
