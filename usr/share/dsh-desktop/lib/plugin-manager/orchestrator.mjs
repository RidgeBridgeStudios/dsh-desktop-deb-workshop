import http from 'node:http'
import { existsSync } from 'node:fs'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { LIVE_PROFILE, profileDirectory } from './paths.mjs'
import { isProtectedPlugin, removalBackupRoot, removePluginSafely } from './plugin-removal.mjs'
import { disableGeneration, listGenerations, readDesired, writeDesired } from './registry.mjs'
import { projectGenerations, publishInstalledGeneration } from './projection.mjs'
import { installGeneration } from './installer.mjs'
import { upgradePlugin as baseUpgradePlugin } from './plugin-upgrade.mjs'

export { isProtectedPlugin }

export async function defaultVerifyNormalBoot(options = {}) {
  const {
    port = 3080,
    timeoutMs = 15000,
    checkIntervalMs = 250,
    url = `http://127.0.0.1:${port}`
  } = options

  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const ready = await new Promise((resolve) => {
      try {
        const req = http.get(url, { timeout: 1000 }, (res) => {
          res.resume()
          resolve(true)
        })
        req.on('error', () => resolve(false))
        req.on('timeout', () => {
          req.destroy()
          resolve(false)
        })
      } catch {
        resolve(false)
      }
    })
    if (ready) return true
    await new Promise((r) => setTimeout(r, checkIntervalMs))
  }
  return false
}

export async function uninstallPlugin(options = {}) {
  const {
    dshHome,
    packageName,
    profile = LIVE_PROFILE,
    dshEntryPath,
    nodeExecutablePath,
    now,
    operations = {}
  } = options

  if (isProtectedPlugin(packageName)) {
    throw new Error(`Refusing to remove core package ${packageName}`)
  }

  const realBackup = async ({ entry, removalId }) => {
    const backupDir = entry.backupDirectory || join(removalBackupRoot(dshHome), removalId)
    await mkdir(backupDir, { recursive: true })
    const profileDir = profileDirectory(dshHome, profile)
    const pluginModuleDir = join(profileDir, 'node_modules', packageName)
    if (existsSync(pluginModuleDir)) {
      await cp(pluginModuleDir, join(backupDir, 'package'), { recursive: true })
    }
  }

  const realDisable = async ({ entry, removalId }) => {
    await disableGeneration(dshHome, packageName)
  }

  const realDetach = async ({ entry, removalId }) => {
    await projectGenerations(dshHome, profile)

    const profileDir = profileDirectory(dshHome, profile)
    const manifestPath = join(profileDir, 'package.json')
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
        let modified = false
        if (manifest.dependencies && Object.hasOwn(manifest.dependencies, packageName)) {
          delete manifest.dependencies[packageName]
          modified = true
        }
        if (Array.isArray(manifest.dsh?.profile?.bundles)) {
          if (manifest.dsh.profile.bundles.includes(packageName)) {
            manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((b) => b !== packageName)
            modified = true
          }
        }
        if (modified) {
          await writeFile(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`, 'utf8')
        }
      } catch {}
    }

    const pluginModuleDir = join(profileDir, 'node_modules', packageName)
    if (existsSync(pluginModuleDir)) {
      await rm(pluginModuleDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  const activeOperations = {
    backup: operations.backup ?? realBackup,
    disable: operations.disable ?? realDisable,
    detach: operations.detach ?? realDetach
  }

  return removePluginSafely({
    dshHome,
    pluginName: packageName,
    now,
    operations: activeOperations
  })
}

export async function upgradePlugin(options = {}) {
  const {
    dshHome,
    pluginName,
    targetVersion,
    profile = LIVE_PROFILE,
    verifyNormalBoot,
    restartDaemon,
    install,
    publish,
    ...extraOptions
  } = options

  const installFn = install ?? (async ({ pluginName: pkg, targetVersion: ver }) => {
    const spec = ver ? `${pkg}@${ver}` : pkg
    const result = await installGeneration({
      dshHome,
      profile,
      pluginSpec: spec,
      expectedVersion: ver,
      ...extraOptions
    })
    if (!result.ok) throw new Error(result.detail ?? 'generation installation failed')

    const desired = await readDesired(dshHome)
    const generations = await listGenerations(dshHome)
    const byId = new Map(generations.map((generation) => [generation.id, generation]))
    const kept = desired.filter((id) => byId.get(id)?.pluginName !== result.generation.pluginName)
    await writeDesired(dshHome, [...kept, result.generation.id])
    return result
  })

  const publishFn = publish ?? (async ({ pluginName: pkg }) => {
    await publishInstalledGeneration(dshHome, pkg, profile, { syncBundles: true })
  })

  const verifyFn = verifyNormalBoot ?? (async () => {
    if (typeof restartDaemon === 'function') {
      await restartDaemon()
    }
    return defaultVerifyNormalBoot(options)
  })

  return baseUpgradePlugin({
    pluginName,
    targetVersion,
    install: installFn,
    publish: publishFn,
    verifyNormalBoot: verifyFn
  })
}
