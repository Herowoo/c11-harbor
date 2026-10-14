import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSession, diagnosticFetch } from '../src/session-check.mjs';
import { GLOBAL } from '../src/protocol.mjs';

test('diagnostic request whitelist rejects vehicle commands before sending', async () => {
  let calls = 0;
  const send = diagnosticFetch(async () => { calls++; return new Response('{}'); });
  await assert.rejects(send(new URL('/app/app-control-service/v3/api/appremotectl', GLOBAL), { method: 'POST' }));
  assert.equal(calls, 0);
  await send(new URL('/base/base-user/token/v1/refresh', GLOBAL), { method: 'POST' });
  assert.equal(calls, 1);
});

test('rotated credentials survive a subsequent status failure', async () => {
  const saved = [];
  const client = { s: { old: { token: 'before' }, gateway: {} },
    async refreshOld() { this.s.old.token = 'after'; },
    async status() { throw new Error('simulated offline'); } };
  await assert.rejects(checkSession(client, 'refresh-old', s => saved.push(structuredClone(s))));
  assert.equal(saved.at(-1).old.token, 'after');
});

test('probe only reads status and persists session without forcing renewal', async () => {
  let read = 0;
  const client = { s: { old: {}, gateway: {} }, async status() { read++; return {}; } };
  assert.deepEqual(await checkSession(client, 'probe', () => {}), { ok: true, statusReadable: true });
  assert.equal(read, 1);
});
