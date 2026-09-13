#!/usr/bin/env node
import { dshHome, activeProfile } from './paths.mjs'
import { ensureDataDirs, ensureProfile, ensureMarketSeeded } from './bootstrap.mjs'

try {
  const { migrateLegacyLayout } = await import('./profiles.mjs')
  await migrateLegacyLayout(dshHome())
} catch (error) {
  process.stderr.write(`dsh-desktop bootstrap migration failed: ${error?.message || String(error)}\n`)
  process.exit(1)
}

const dirs = await ensureDataDirs()
if (!dirs.ok) {
  process.stderr.write(`dsh-desktop bootstrap: data dirs: ${dirs.detail}\n`)
  process.exit(1)
}
const name = await activeProfile()
const profile = await ensureProfile(undefined, name)
if (!profile.ok) {
  process.stderr.write(`dsh-desktop bootstrap: profile: ${profile.detail}\n`)
  process.exit(1)
}
const market = await ensureMarketSeeded({ profile: name })
if (!market.ok) {
  process.stderr.write(`dsh-desktop bootstrap: ${market.detail}\n`)
}
