import { createRequire } from 'node:module'
import { join } from 'node:path'

import { translate } from './locales.mjs'
import { dshHome, installationClosureDir } from './paths.mjs'

const REMOVED_DEPENDENCIES = new Set(['@deepseek-ai/dsh-host-apiproxy'])
const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u

export function parseSemver(input) {
  const match = SEMVER.exec(String(input ?? ''))
  if (match === null) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split('.')
  }
}

function comparePrerelease(a, b) {
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    const left = a[index]
    const right = b[index]
    if (left === undefined) return -1
    if (right === undefined) return 1
    const leftNumeric = /^\d+$/u.test(left)
    const rightNumeric = /^\d+$/u.test(right)
    if (leftNumeric && rightNumeric) {
      if (Number(left) !== Number(right)) return Number(left) < Number(right) ? -1 : 1
    } else if (leftNumeric) {
      return -1
    } else if (rightNumeric) {
      return 1
    } else if (left !== right) {
      return left < right ? -1 : 1
    }
  }
  return 0
}

export function compareSemver(a, b) {
  const left = parseSemver(a)
  const right = parseSemver(b)
  if (left === null || right === null) return String(a).localeCompare(String(b))
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }
  if (left.prerelease.length === 0 && right.prerelease.length > 0) return 1
  if (left.prerelease.length > 0 && right.prerelease.length === 0) return -1
  return comparePrerelease(left.prerelease, right.prerelease)
}

function satisfiesComparator(version, comparator) {
  const parsed = parseSemver(version)
  if (parsed === null) return false
  const text = comparator.trim()
  if (text === '' || text === '*' || /^[xX]$/u.test(text)) return true

  const match = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/u.exec(text)
  if (match === null) return false
  const operator = match[1] ?? '='
  const target = parseSemver(match[2])
  if (target === null) return false

  const tuple = (value) => [value.major, value.minor, value.patch]
  const same = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2]
  const comparison = compareSemver(version, match[2])

  if (parsed.prerelease.length > 0) {
    const sameTuple = same(tuple(parsed), tuple(target))
    const targetPrerelease = target.prerelease.length > 0
    if (!(sameTuple && targetPrerelease)) return false
  }

  switch (operator) {
    case '>': return comparison > 0
    case '>=': return comparison >= 0
    case '<': return comparison < 0
    case '<=': return comparison <= 0
    case '=': return comparison === 0
    case '~':
      return parsed.major === target.major && parsed.minor === target.minor && comparison >= 0
    case '^': {
      if (comparison < 0) return false
      if (target.major > 0) return parsed.major === target.major
      if (target.minor > 0) return parsed.major === 0 && parsed.minor === target.minor
      return parsed.major === 0 && parsed.minor === 0 && parsed.patch === target.patch
    }
    default: return comparison === 0
  }
}

export function satisfiesRange(version, range) {
  if (typeof range !== 'string') return false
  const alternatives = range.split('||')
  return alternatives.some((alternative) => {
    const comparators = alternative.trim().split(/\s+/u).filter(Boolean)
    if (comparators.length === 0) return true
    return comparators.every((comparator) => satisfiesComparator(version, comparator))
  })
}

export function resolveHostCordisVersion(options = {}) {
  const { home = dshHome() } = options
  const closure = installationClosureDir(home)
  try {
    const req = createRequire(join(closure, 'dummy.js'))
    const manifest = req('@deepseek-ai/cordis/package.json')
    if (typeof manifest?.version === 'string') return manifest.version
  } catch {}

  try {
    const req = createRequire(import.meta.url)
    const manifest = req('@deepseek-ai/cordis/package.json')
    if (typeof manifest?.version === 'string') return manifest.version
  } catch {}

  throw new Error('Host @deepseek-ai/cordis package is missing from closure; cannot resolve version.')
}

let cachedHostCordisVersion = null

export function getHostCordisVersion(options = {}) {
  if (cachedHostCordisVersion === null) {
    cachedHostCordisVersion = resolveHostCordisVersion(options)
  }
  return cachedHostCordisVersion
}

export function resetHostCordisVersionCache() {
  cachedHostCordisVersion = null
}

export function inferRuntimeCompatibility(manifest, runtimeVersion, options = {}) {
  const cordisVersion = options.cordisVersion ?? getHostCordisVersion(options)
  const peers = manifest?.peerDependencies ?? {}
  for (const [packageName, range] of Object.entries(peers)) {
    if (!packageName.startsWith('@deepseek-ai/')) continue
    if (typeof range !== 'string') continue
    const targetVersion = packageName === '@deepseek-ai/cordis' ? cordisVersion : runtimeVersion
    if (!satisfiesRange(targetVersion, range)) {
      return {
        compatible: false,
        reason: `Declares peer ${packageName} (${range}), incompatible with runtime ${targetVersion}`
      }
    }
  }

  const constraints = []
  if (typeof manifest?.engines?.dsh === 'string') constraints.push(manifest.engines.dsh)
  const minVersion = manifest?.dsh?.minVersion
  if (typeof minVersion === 'string') {
    constraints.push(parseSemver(minVersion) === null ? minVersion : `>=${minVersion}`)
  }
  for (const constraint of constraints) {
    if (!satisfiesRange(runtimeVersion, constraint)) {
      return { compatible: false, reason: `Requires DSH (${constraint}), incompatible with runtime ${runtimeVersion}` }
    }
  }

  const dependencies = { ...(manifest?.dependencies ?? {}), ...(manifest?.optionalDependencies ?? {}) }
  for (const removed of REMOVED_DEPENDENCIES) {
    if (Object.hasOwn(dependencies, removed)) {
      return { compatible: false, reason: `Requires deprecated module ${removed}` }
    }
  }
  return { compatible: true }
}

export function selectCompatibleUpgrade(metadata, installedVersion, runtimeVersion, options = {}) {
  const latest = metadata?.['dist-tags']?.latest
  const installed = parseSemver(installedVersion)
  if (typeof latest !== 'string' || parseSemver(latest) === null || installed === null) {
    return { status: 'none' }
  }

  const installedIsPrerelease = installed.prerelease.length > 0
  const candidates = Object.values(metadata.versions ?? {})
    .filter((manifest) => {
      if (typeof manifest?.version !== 'string' || parseSemver(manifest.version) === null) return false
      if (manifest.deprecated) return false
      if (compareSemver(manifest.version, installedVersion) <= 0) return false
      if (compareSemver(manifest.version, latest) > 0) return false
      if (!installedIsPrerelease && parseSemver(manifest.version).prerelease.length > 0) return false
      return true
    })
    .sort((a, b) => compareSemver(b.version, a.version))

  for (const manifest of candidates) {
    if (inferRuntimeCompatibility(manifest, runtimeVersion, options).compatible) {
      return { status: 'upgrade', version: manifest.version, manifest }
    }
  }

  if (compareSemver(latest, installedVersion) > 0) {
    const latestManifest = metadata.versions?.[latest]
    const reason = latestManifest === undefined
      ? undefined
      : inferRuntimeCompatibility(latestManifest, runtimeVersion, options).reason
    return { status: 'latest-anyway', version: latest, reason }
  }
  return { status: 'none' }
}

export function evaluatePluginUpgrade(options = {}) {
  const { metadata, installedVersion, runtimeVersion, hasLocalIssue = false, cordisVersion } = options
  if (metadata === undefined || metadata === null) {
    return { healthStatus: 'check-failed', upgradeReady: false, label: translate('en', 'statusFailed') }
  }
  if (parseSemver(installedVersion) === null) {
    return { healthStatus: 'check-failed', upgradeReady: false, label: translate('en', 'statusFailed') }
  }

  const selection = selectCompatibleUpgrade(metadata, installedVersion, runtimeVersion, { cordisVersion })
  const latest = metadata?.['dist-tags']?.latest

  if (selection.status === 'upgrade') {
    return {
      healthStatus: hasLocalIssue ? 'incompatible-upgrade-available' : 'upgrade-available',
      upgradeReady: true,
      upgradeVersion: selection.version
    }
  }
  if (selection.status === 'latest-anyway') {
    return {
      healthStatus: 'incompatible-upgrade-available',
      upgradeReady: true,
      upgradeVersion: selection.version,
      unconfirmed: true,
      reason: selection.reason
    }
  }
  if (hasLocalIssue && compareSemver(installedVersion, latest) >= 0) {
    return { healthStatus: 'incompatible-no-fix', upgradeReady: false, removalRecommended: true }
  }
  return {
    healthStatus: hasLocalIssue ? 'incompatible-no-fix' : 'up-to-date',
    upgradeReady: false
  }
}

export function describeNoCompatibleUpdate(options = {}) {
  const { locale = 'en' } = options
  return {
    healthStatus: 'incompatible-no-fix',
    canUninstall: true,
    canCheckAgain: true,
    canDowngrade: false,
    canReinstall: false,
    message: translate(locale, 'noCompatibleUpdate')
  }
}
