import test from 'node:test';
import assert from 'node:assert/strict';
import { PairingGate } from '../src/pairing.mjs';

test('pairing code has a five-minute lifetime and can be used once', () => {
  let now = 1000;
  const gate = new PairingGate(() => now, () => '12345678');
  assert.deepEqual(gate.start(), { code: '12345678', expiresAt: 301000 });
  assert.equal(gate.claim('12345678'), true);
  assert.equal(gate.claim('12345678'), false);
  gate.finish(true);
  assert.equal(gate.claim('12345678'), false);
  gate.start(); now = 301001;
  assert.equal(gate.claim('12345678'), false);
});

test('five wrong attempts exhaust the code; failed import releases the claim', () => {
  const gate = new PairingGate(() => 0, () => '12345678');
  gate.start();
  for (let i = 0; i < 5; i++) assert.equal(gate.claim('00000000'), false);
  assert.equal(gate.claim('12345678'), false);
  gate.start();
  assert.equal(gate.claim('12345678'), true);
  gate.finish(false);
  assert.equal(gate.claim('12345678'), true);
});
