import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { delimiter, dirname, join } from 'node:path'

export function resolvePnpmEntry(requireFrom = import.meta.url) {
  const require = createRequire(requireFrom)
  // pnpm intentionally maps its package root export to package.json instead of
  // exporting the package.json subpath. Resolving the root therefore gives us
  // the stable package anchor without reaching through an unexported path.
  const manifest = require.resolve('pnpm')
  const root = dirname(manifest)
  const candidates = [join(root, 'bin', 'pnpm.cjs'), join(root, 'bin', 'pnpm.mjs')]
  const entry = candidates.find((candidate) => existsSync(candidate))
  if (!entry) throw new Error('The packaged pnpm entry was not found.')
  return entry
}

function processPath(environment) {
  return environment.PATH ?? ''
}

export function buildPnpmEnvironment(
  binDirectory,
  environment = process.env,
  executablePath = process.execPath
) {
  // Platform note: Historical reference context explaining upstream ELECTRON_RUN_AS_NODE passthrough behavior; no runtime platform branching.
  // The child is spawned as `process.execPath`, which on macOS is the Electron
  // helper binary: it only runs the dsh CLI as Node when ELECTRON_RUN_AS_NODE
  // is set. The harness entry (harness-node-entry.mjs) declares that flag in
  // its own environment so that children spawned here inherit Node mode —
  // deleting it here makes the helper exit 0 without ever running the CLI,
  // which the market then mistakes for a successful pnpm run. Pass it through;
  // the bundled-Node hosts (Windows, Linux) never set it and are unaffected.
  const result = { ...environment }

  const seen = new Set()
  const paths = [binDirectory, dirname(executablePath), ...processPath(environment).split(delimiter)]
    .map((entry) => entry.trim())
    .filter((entry) => {
      if (!entry) return false
      if (seen.has(entry)) return false
      seen.add(entry)
      return true
    })
  result.PATH = paths.join(delimiter)
  result.CI = 'true'
  result.NO_COLOR = '1'
  result.npm_config_side_effects_cache = 'false'
  result.PNPM_CONFIG_SIDE_EFFECTS_CACHE = 'false'
  return result
}
