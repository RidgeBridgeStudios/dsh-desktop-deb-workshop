#!/usr/bin/env node
import { PROFILE_NAME_PATTERN, RESERVED_PROFILE_NAMES, activeProfileName } from './profiles.mjs'

const args = process.argv.slice(2)

let mode = null
let explicitProfile = null
let validateTarget = null

for (let i = 0; i < args.length; i++) {
  const arg = args[i]
  if (arg === '--resolve') {
    mode = 'resolve'
  } else if (arg.startsWith('--profile=')) {
    explicitProfile = arg.slice('--profile='.length)
  } else if (arg === '--profile') {
    explicitProfile = args[++i]
  } else if (arg === '--validate') {
    mode = 'validate'
    validateTarget = args[++i]
  } else if (arg.startsWith('--validate=')) {
    mode = 'validate'
    validateTarget = arg.slice('--validate='.length)
  } else {
    process.stderr.write(`profile-cli: unrecognized argument: ${arg}\n`)
    process.exit(2)
  }
}

function isValidName(name) {
  return typeof name === 'string' &&
    PROFILE_NAME_PATTERN.test(name) &&
    !RESERVED_PROFILE_NAMES.includes(name)
}

if (mode === 'validate') {
  if (validateTarget !== null && validateTarget !== undefined && isValidName(validateTarget)) {
    process.exit(0)
  }
  process.stderr.write(`profile-cli: invalid profile name: ${String(validateTarget)}\n`)
  process.exit(2)
}

if (mode === 'resolve') {
  if (explicitProfile !== null && explicitProfile !== undefined) {
    if (!isValidName(explicitProfile)) {
      process.stderr.write(`profile-cli: invalid profile name: ${explicitProfile}\n`)
      process.exit(2)
    }
    process.stdout.write(`${explicitProfile}\n`)
    process.exit(0)
  }

  const envProfile = process.env.DSH_PROFILE
  if (typeof envProfile === 'string' && envProfile.trim() !== '') {
    if (!isValidName(envProfile)) {
      process.stderr.write(`profile-cli: invalid profile name in DSH_PROFILE: ${envProfile}\n`)
      process.exit(2)
    }
    process.stdout.write(`${envProfile}\n`)
    process.exit(0)
  }

  try {
    const active = await activeProfileName()
    if (isValidName(active)) {
      process.stdout.write(`${active}\n`)
      process.exit(0)
    }
  } catch {}

  process.stdout.write('default\n')
  process.exit(0)
}

process.stderr.write('profile-cli: missing --resolve or --validate\n')
process.exit(2)
