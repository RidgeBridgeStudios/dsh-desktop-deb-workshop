import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  pruneAttempts,
  isCircuitOpen,
  recordAttempt,
  recordReady,
  resetCircuit,
  recordDaemonBoot,
  markReady,
  isSystemCircuitOpen,
  resetCircuitState,
  CIRCUIT_OPEN_EXIT_CODE
} from '../usr/share/dsh-desktop/lib/plugin-manager/circuit-breaker.mjs';

test('circuit-breaker: closed -> open on 3 fast failures within 60s', () => {
  let now = 1000000;
  let state = { attempts: [], lastReady: null, circuitOpen: false };

  // 1st start
  state = recordAttempt(state, now);
  assert.equal(state.circuitOpen, false);
  assert.equal(isCircuitOpen(state, now), false);

  // 2nd start (+10s)
  now += 10000;
  state = recordAttempt(state, now);
  assert.equal(state.circuitOpen, false);
  assert.equal(isCircuitOpen(state, now), false);

  // 3rd start (+10s)
  now += 10000;
  state = recordAttempt(state, now);
  assert.equal(state.circuitOpen, true);
  assert.equal(isCircuitOpen(state, now), true);
  assert.equal(CIRCUIT_OPEN_EXIT_CODE, 75);
});

test('circuit-breaker: stays closed on slow restarts (>60s apart)', () => {
  let now = 1000000;
  let state = { attempts: [], lastReady: null, circuitOpen: false };

  // 1st start
  state = recordAttempt(state, now);
  assert.equal(state.circuitOpen, false);

  // 2nd start (+70s later)
  now += 70000;
  state = recordAttempt(state, now);
  assert.equal(state.circuitOpen, false);
  // Previous attempt older than 60s should have been pruned
  assert.equal(state.attempts.length, 1);

  // 3rd start (+70s later)
  now += 70000;
  state = recordAttempt(state, now);
  assert.equal(state.circuitOpen, false);
  assert.equal(state.attempts.length, 1);
});

test('circuit-breaker: ready signal resets failure count and keeps circuit closed', () => {
  let now = 1000000;
  let state = { attempts: [], lastReady: null, circuitOpen: false };

  // 2 fast starts
  state = recordAttempt(state, now);
  now += 5000;
  state = recordAttempt(state, now);
  assert.equal(state.circuitOpen, false);

  // Ready signal arrives
  now += 5000;
  state = recordReady(state, now);
  assert.equal(state.attempts.length, 0);
  assert.equal(state.lastReady, now);
  assert.equal(state.circuitOpen, false);

  // Next 2 starts
  now += 5000;
  state = recordAttempt(state, now);
  now += 5000;
  state = recordAttempt(state, now);
  assert.equal(state.circuitOpen, false);
});

test('circuit-breaker: reset works and clears circuit', () => {
  let now = 1000000;
  let state = { attempts: [], lastReady: null, circuitOpen: false };

  // Trigger circuit open
  state = recordAttempt(state, now);
  state = recordAttempt(state, now + 1000);
  state = recordAttempt(state, now + 2000);
  assert.equal(state.circuitOpen, true);

  // Reset circuit
  state = resetCircuit(state);
  assert.equal(state.circuitOpen, false);
  assert.equal(state.attempts.length, 0);
  assert.equal(isCircuitOpen(state, now + 2000), false);
});

test('circuit-breaker: persistent storage with injectable clock', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cb-test-'));
  try {
    let fakeTime = 2000000;
    const clock = () => fakeTime;

    const opt = { stateDir: tmp, clock };

    // Boot 1
    let s = recordDaemonBoot(opt);
    assert.equal(s.circuitOpen, false);
    assert.equal(isSystemCircuitOpen(opt), false);

    // Boot 2
    fakeTime += 5000;
    s = recordDaemonBoot(opt);
    assert.equal(s.circuitOpen, false);
    assert.equal(isSystemCircuitOpen(opt), false);

    // Boot 3 within 60s
    fakeTime += 5000;
    s = recordDaemonBoot(opt);
    assert.equal(s.circuitOpen, true);
    assert.equal(isSystemCircuitOpen(opt), true);

    // Verify boot-attempts.json contents on disk
    const file = path.join(tmp, 'boot-attempts.json');
    assert.ok(fs.existsSync(file));
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.circuitOpen, true);
    assert.equal(saved.attempts.length, 3);

    // Reset circuit
    const resetRes = resetCircuitState(opt);
    assert.equal(resetRes.circuitOpen, false);
    assert.equal(isSystemCircuitOpen(opt), false);
    const savedAfterReset = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(savedAfterReset.circuitOpen, false);
    assert.equal(savedAfterReset.attempts.length, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('circuit-breaker: main.js recovery:action retry calls resetCircuit', async () => {
  const { registerIpcHandlers } = await import('../usr/share/dsh-desktop/app/main.js');
  let resetCalled = false;
  let restarted = false;

  const fakeIpc = {
    handlers: {},
    handle(channel, fn) {
      this.handlers[channel] = fn;
    }
  };

  registerIpcHandlers(fakeIpc, {
    resetCircuitState: () => { resetCalled = true; },
    restartDsh: () => { restarted = true; }
  });

  const handler = fakeIpc.handlers['recovery:action'];
  assert.ok(handler);

  const fakeEvent = {
    senderFrame: { url: 'http://127.0.0.1:3080' }
  };

  await handler(fakeEvent, 'retry');
  assert.equal(resetCalled, true);
  assert.equal(restarted, true);
});
