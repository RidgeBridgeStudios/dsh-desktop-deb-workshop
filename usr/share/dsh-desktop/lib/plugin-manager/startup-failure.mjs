export const PLUGIN_FAILURE_PREFIX = '[harness-node] plugin failures: '
export const PLUGIN_FAILURE_VERSION = 1

const SAFE_PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/iu

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeOwner(owner) {
  if (!isRecord(owner) || typeof owner.packageName !== 'string') return undefined
  if (!SAFE_PACKAGE_NAME_PATTERN.test(owner.packageName)) return undefined
  return {
    packageName: owner.packageName,
    ...(typeof owner.version === 'string' ? { version: owner.version } : {}),
    ...(typeof owner.packageDir === 'string' ? { packageDir: owner.packageDir } : {})
  }
}

function normalizeChain(chain) {
  if (!Array.isArray(chain)) return []
  return chain
    .filter((entry) => isRecord(entry) && typeof entry.packageName === 'string' && SAFE_PACKAGE_NAME_PATTERN.test(entry.packageName))
    .map((entry) => ({
      packageName: entry.packageName,
      ...(typeof entry.entryId === 'string' ? { entryId: entry.entryId } : {}),
      ...(typeof entry.baseUrl === 'string' ? { baseUrl: entry.baseUrl } : {})
    }))
}

function normalizeFailure(failure) {
  if (
    !isRecord(failure) ||
    typeof failure.stage !== 'string' ||
    failure.stage === '' ||
    typeof failure.packageName !== 'string' ||
    failure.packageName === '' ||
    typeof failure.message !== 'string'
  ) {
    return undefined
  }
  if (!SAFE_PACKAGE_NAME_PATTERN.test(failure.packageName)) return undefined
  const owner = normalizeOwner(failure.owner)
  return {
    stage: failure.stage,
    packageName: failure.packageName,
    ...(typeof failure.entryId === 'string' ? { entryId: failure.entryId } : {}),
    ...(owner === undefined ? {} : { owner }),
    chain: normalizeChain(failure.chain),
    message: failure.message
  }
}

export function isPluginFailureLine(line) {
  return typeof line === 'string' && line.startsWith(PLUGIN_FAILURE_PREFIX)
}

export function formatPluginStartupFailure(failure) {
  const normalized = normalizeFailure(failure)
  if (normalized === undefined) throw new Error('Plugin startup failure is not well formed.')
  const payload = { v: PLUGIN_FAILURE_VERSION, failures: [normalized] }
  return `${PLUGIN_FAILURE_PREFIX}${JSON.stringify(payload)}`
}

export function formatPluginStartupFailures(failures) {
  if (!Array.isArray(failures) || failures.length === 0) {
    throw new Error('At least one plugin startup failure is required.')
  }
  const normalized = failures.map((failure) => {
    const value = normalizeFailure(failure)
    if (value === undefined) throw new Error('Plugin startup failure is not well formed.')
    return value
  })
  return `${PLUGIN_FAILURE_PREFIX}${JSON.stringify({ v: PLUGIN_FAILURE_VERSION, failures: normalized })}`
}

export function parsePluginStartupFailures(text) {
  const line = String(text).split(/\r?\n/u).find(isPluginFailureLine)
  if (line === undefined) return undefined
  let payload
  try {
    payload = JSON.parse(line.slice(PLUGIN_FAILURE_PREFIX.length))
  } catch {
    return undefined
  }
  if (!isRecord(payload) || payload.v !== PLUGIN_FAILURE_VERSION || !Array.isArray(payload.failures)) {
    return undefined
  }
  const failures = []
  for (const failure of payload.failures) {
    const normalized = normalizeFailure(failure)
    if (normalized === undefined) return undefined
    failures.push(normalized)
  }
  return failures
}

export function reportPluginStartupFailure(failure, write = (line) => process.stderr.write(line)) {
  write(`${formatPluginStartupFailure(failure)}\n`)
}
