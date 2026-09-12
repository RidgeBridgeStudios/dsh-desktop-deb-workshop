import { pathToFileURL } from 'node:url'

import { reportPluginStartupFailure } from './startup-failure.mjs'

const PACKAGE_FROM_MESSAGE =
  /(?:cannot find package|failed to resolve module|cannot find module)\s+['"]?((?:@[^/'"]+\/)?[^/'"]+)['"]?/iu

/**
 * Closest fit for this stack: upstream `@deepseek-ai/dsh` does not emit the
 * versioned structured report itself, so the desktop bootstrap wraps the entry
 * and emits one on import failure. Full owner/entry-chain provenance requires
 * upstream cooperation or a loader overlay; when the package cannot be
 * inferred the report is still emitted (and simply fails attribution).
 */
export function inferFailurePackage(message) {
  const match = PACKAGE_FROM_MESSAGE.exec(String(message ?? ''))
  return match === null ? undefined : match[1]
}

export async function runHarnessEntry(options) {
  const {
    entryPath,
    report = (failure) => reportPluginStartupFailure(failure)
  } = options
  try {
    await import(pathToFileURL(entryPath).href)
    return { ok: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const packageName = inferFailurePackage(message)
    // Emit only fields actually known. A fabricated "unknown" component or an
    // absent owner would invite callers to trust provenance we do not have.
    if (packageName !== undefined) {
      report({ stage: 'import', packageName, chain: [], message })
    }
    throw error
  }
}
