import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_WINDOW_MS = 60_000;
export const DEFAULT_MAX_ATTEMPTS = 3;
export const CIRCUIT_OPEN_EXIT_CODE = 75;

export function pruneAttempts(attempts = [], now = Date.now(), windowMs = DEFAULT_WINDOW_MS) {
  if (!Array.isArray(attempts)) return [];
  const cutoff = now - windowMs;
  return attempts
    .filter((t) => typeof t === 'number' && Number.isFinite(t) && t > cutoff && t <= now)
    .sort((a, b) => a - b);
}

export function isCircuitOpen(state = {}, now = Date.now(), options = {}) {
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  if (state.circuitOpen === true) {
    return true;
  }

  const validAttempts = pruneAttempts(state.attempts || [], now, windowMs);
  if (validAttempts.length < maxAttempts) {
    return false;
  }

  const lastReady = typeof state.lastReady === 'number' && Number.isFinite(state.lastReady)
    ? state.lastReady
    : null;

  // If no ready signal ever, or last ready occurred before the first attempt in this failure window
  if (lastReady === null || lastReady < validAttempts[0]) {
    return true;
  }

  // Count attempts that occurred after lastReady
  const attemptsSinceReady = validAttempts.filter((t) => t > lastReady);
  return attemptsSinceReady.length >= maxAttempts;
}

export function recordAttempt(state = {}, now = Date.now(), options = {}) {
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  const validAttempts = pruneAttempts(state.attempts || [], now, windowMs);
  validAttempts.push(now);

  const updatedState = {
    ...state,
    attempts: validAttempts,
    circuitOpen: false
  };

  if (isCircuitOpen(updatedState, now, { windowMs, maxAttempts })) {
    updatedState.circuitOpen = true;
  }

  return updatedState;
}

export function recordReady(state = {}, now = Date.now()) {
  return {
    ...state,
    attempts: [],
    lastReady: now,
    circuitOpen: false
  };
}

export function resetCircuit(state = {}) {
  return {
    ...state,
    attempts: [],
    circuitOpen: false
  };
}

export function resolveStateDir(customDir) {
  return customDir ||
    process.env.DSH_STATE_DIR ||
    path.join(process.env.HOME || os.homedir(), '.local/share/dsh-desktop');
}

export function resolveStatePath(options = {}) {
  if (options.statePath) return options.statePath;
  const dir = resolveStateDir(options.stateDir);
  return path.join(dir, 'boot-attempts.json');
}

export function readState(statePath) {
  try {
    if (fs.existsSync(statePath)) {
      const content = fs.readFileSync(statePath, 'utf8');
      const parsed = JSON.parse(content);
      return {
        attempts: Array.isArray(parsed.attempts) ? parsed.attempts : [],
        lastReady: typeof parsed.lastReady === 'number' ? parsed.lastReady : null,
        circuitOpen: Boolean(parsed.circuitOpen)
      };
    }
  } catch {}
  return {
    attempts: [],
    lastReady: null,
    circuitOpen: false
  };
}

export function writeState(statePath, state) {
  const dir = path.dirname(statePath);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
  const tempPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tempPath, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tempPath, statePath);
  } catch {
    // Fallback direct write
    try {
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
    } catch {}
  }
}

export function recordDaemonBoot(options = {}) {
  const clock = options.clock || (() => Date.now());
  const now = clock();
  const statePath = resolveStatePath(options);
  const currentState = readState(statePath);
  const nextState = recordAttempt(currentState, now, options);
  writeState(statePath, nextState);
  return nextState;
}

export function markReady(options = {}) {
  const clock = options.clock || (() => Date.now());
  const now = clock();
  const statePath = resolveStatePath(options);
  const currentState = readState(statePath);
  const nextState = recordReady(currentState, now);
  writeState(statePath, nextState);
  return nextState;
}

export function isSystemCircuitOpen(options = {}) {
  const clock = options.clock || (() => Date.now());
  const now = clock();
  const statePath = resolveStatePath(options);
  const currentState = readState(statePath);
  return isCircuitOpen(currentState, now, options);
}

export function resetCircuitState(options = {}) {
  const statePath = resolveStatePath(options);
  const currentState = readState(statePath);
  const nextState = resetCircuit(currentState);
  writeState(statePath, nextState);
  return nextState;
}
